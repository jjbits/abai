// abaikit run: sidecar launch of a repository's program from outside the
// repository. It is the program's own `<entry> run -- ARGS`, run by the
// shell in the repository root with this terminal, so everything M8 built
// (the launcher, the lifecycle channel, outside observation) serves it;
// nothing is added here. The exit code is the entry's.
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import type { ParsedArgs } from "./bin.ts";
import { type AbaikitIo, UsageError } from "./io.ts";
import { entryCommand, loadSubject } from "./subject.ts";

export async function runRun(parsed: Extract<ParsedArgs, { verb: "run" }>, io: AbaikitIo): Promise<number> {
	const subject = loadSubject(parsed.repo, io.cwd);
	// run is sidecar launch (4.4): a program that declares no sidecar mode would refuse at its entry; say it here
	if (!subject.manifest.modes.includes("sidecar")) {
		throw new UsageError(
			`run is sidecar launch, and ${subject.manifest.name} declares ${subject.manifest.modes.join(", ")} only`,
		);
	}
	const command = entryCommand(subject.manifest, "run", "--", ...parsed.args);
	// POSIX sh is the contract for the entry's command line; a compound entry (`cd x && node ...`) keeps the
	// shell alive, so a forwarded signal reaches the shell, not what it runs: keep the entry one command
	const child = spawn("sh", ["-c", command], { cwd: subject.root, stdio: "inherit", env: io.env });
	// whoever ends this process ends the launch behind it
	const forward = (signal: NodeJS.Signals): void => {
		if (child.exitCode === null && child.signalCode === null) child.kill(signal);
	};
	const forwarded: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
	for (const signal of forwarded) process.on(signal, forward);
	try {
		return await new Promise<number>((resolve) => {
			child.once("error", (error) => {
				io.err(`abaikit run: the shell could not be started: ${error.message}`);
				resolve(1);
			});
			child.once("exit", (code, signal) => {
				if (code !== null) resolve(code);
				else resolve(128 + (signal ? (osConstants.signals[signal] ?? 0) : 0));
			});
		});
	} finally {
		for (const signal of forwarded) process.off(signal, forward);
	}
}
