#!/usr/bin/env node
// One act on a running abaigram from a shell, through the abai harness's own
// MCP server: attach, one tool call, print the answer, exit. For a coding
// agent that has a shell but cannot add an MCP server to its running
// session. Every act goes through the program's declared channels, policy
// and audit, exactly as from an MCP client; the shell's permission prompt
// is the consent.
//
//   node supervise.mjs [--target <pid|socket>] prompt
//   node supervise.mjs [--target T] cells [name ...]
//   node supervise.mjs [--target T] set <knob> <value> <reason...>
//   node supervise.mjs [--target T] call <capability> [{json params}] <reason...>
//   node supervise.mjs [--target T] wait [seconds]
//   node supervise.mjs [--target T] status | transcript | audit
//   node supervise.mjs [--target T] abai_<tool> [{json arguments}]      any tool, raw
//
// Without --target the harness attaches to the one running program in the
// run directory (~/.abai/run, or $ABAI_RUN_DIR). Exit 0 with the tool's
// text on stdout; 1 with the error on stdout when the tool failed; 2 on
// usage or protocol trouble.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const USAGE = `usage: node supervise.mjs [--target <pid|socket>] <prompt|cells|set|call|wait|status|transcript|audit|abai_*> ...`;

function parse(argv) {
	let target;
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--target") {
			target = argv[++i];
			if (target === undefined) throw new Error("--target needs a pid or a socket path");
		} else rest.push(argv[i]);
	}
	const [verb, ...args] = rest;
	if (!verb) throw new Error(USAGE);
	const json = (text) => {
		try {
			return JSON.parse(text);
		} catch {
			throw new Error(`not JSON: ${text}`);
		}
	};
	// a number, a literal, or JSON lands as such; anything else is the string it is
	const value = (text) => {
		if (/^(-?\d+(\.\d+)?|true|false|null)$/.test(text)) return JSON.parse(text);
		if (/^[[{"]/.test(text)) {
			try {
				return JSON.parse(text);
			} catch {
				return text;
			}
		}
		return text;
	};
	switch (verb) {
		case "prompt":
			return { target, name: "abai_prompt", arguments: {} };
		case "cells":
			return { target, name: "abai_cells", arguments: args.length ? { names: args } : {} };
		case "set": {
			const [cell, raw, ...reason] = args;
			if (!cell || raw === undefined || reason.length === 0) throw new Error("set <knob> <value> <reason...>");
			return { target, name: "abai_set", arguments: { cell, value: value(raw), reason: reason.join(" ") } };
		}
		case "call": {
			const [capability, ...more] = args;
			if (!capability) throw new Error("call <capability> [{json params}] <reason...>");
			const params = more[0]?.startsWith("{") ? json(more.shift()) : {};
			if (more.length === 0) throw new Error("call needs a reason after the capability (and its params)");
			return { target, name: "abai_call", arguments: { capability, params, reason: more.join(" ") } };
		}
		case "wait": {
			if (args[0] === undefined) return { target, name: "abai_wait", arguments: {} };
			const seconds = Number(args[0]);
			if (!(seconds > 0)) throw new Error("wait [seconds] needs a positive number");
			return { target, name: "abai_wait", arguments: { wait_s: seconds } };
		}
		case "status":
		case "transcript":
		case "audit":
			return { target, name: `abai_${verb}`, arguments: args[0] ? json(args[0]) : {} };
		default:
			if (verb.startsWith("abai_")) return { target, name: verb, arguments: args[0] ? json(args[0]) : {} };
			throw new Error(`unknown verb ${verb}\n${USAGE}`);
	}
}

/** The harness binary beside the installed package's entry. */
function harnessBin() {
	return fileURLToPath(new URL("./bin.js", import.meta.resolve("@abaigram/embedded-harness")));
}

async function main() {
	let request;
	let bin;
	try {
		request = parse(process.argv.slice(2));
		bin = harnessBin();
	} catch (error) {
		console.error(
			`supervise: ${error.code === "ERR_MODULE_NOT_FOUND" ? "the @abaigram/embedded-harness package is not installed here; run npm install in this directory after building the workspace" : error.message}`,
		);
		return 2;
	}
	const args = ["mcp"];
	if (request.target !== undefined) args.push("--target", request.target);
	// the stub honours ABAI_RUN_DIR; the harness binary takes the directory as an argument
	if (process.env.ABAI_RUN_DIR) args.push("--run-dir", process.env.ABAI_RUN_DIR);
	const child = spawn(process.execPath, [bin, ...args], { stdio: ["pipe", "pipe", "inherit"] });
	const waitS = request.name === "abai_wait" ? (request.arguments.wait_s ?? 25) : 0;
	const deadline = setTimeout(
		() => {
			console.error(`supervise: no answer within ${waitS + 30} s`);
			child.kill();
			process.exitCode = 2;
		},
		(waitS + 30) * 1000,
	);

	const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
	const lines = createInterface({ input: child.stdout });
	let code = 2;
	send({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "supervise", version: "0.1.0" } },
	});
	for await (const line of lines) {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			continue;
		}
		if (message.id === 1) {
			send({ jsonrpc: "2.0", method: "notifications/initialized" });
			send({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: request.name, arguments: request.arguments },
			});
		} else if (message.id === 2) {
			if (message.error) {
				console.log(`error: ${message.error.message}`);
				code = 2;
			} else {
				const text = (message.result?.content ?? []).map((c) => c.text ?? "").join("\n");
				console.log(text);
				code = message.result?.isError ? 1 : 0;
			}
			break;
		}
	}
	clearTimeout(deadline);
	child.stdin.end();
	await new Promise((done) => child.once("exit", done));
	return code;
}

process.exitCode = await main();
