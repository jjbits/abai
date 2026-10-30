// Discovery records for the wire endpoint: a program writes one next to its
// socket in a run directory, and a client finds the program through it.
import { Buffer } from "node:buffer";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Discovery record a program with a wire endpoint writes next to its socket. */
export interface WireDescriptor {
	pid: number;
	socket: string;
	cwd: string;
	/** The program's name; "unknown" when a foreign descriptor has none. */
	name: string;
	mode: string;
	/** ISO timestamp. */
	startedAt: string;
}

/** Longest socket path accepted (macOS sun_path is 104 bytes including the NUL). */
export const MAX_SOCKET_PATH_BYTES = 103;

/** Path of the descriptor file for a pid. */
export function descriptorPath(runDir: string, pid: number): string {
	return join(runDir, `${pid}.json`);
}

/** Default Unix socket path for a pid. */
export function defaultSocketPath(runDir: string, pid: number): string {
	return join(runDir, `${pid}.sock`);
}

/** Throw when a socket path exceeds MAX_SOCKET_PATH_BYTES. */
export function assertSocketPathLength(socketPath: string): void {
	const bytes = Buffer.byteLength(socketPath);
	if (bytes > MAX_SOCKET_PATH_BYTES) {
		throw new Error(`socket path is too long (${bytes} bytes, max ${MAX_SOCKET_PATH_BYTES}): ${socketPath}`);
	}
}

/** Create the run dir with mode 0o700 (tightening an existing one) and return it. */
export function ensureRunDir(runDir: string): string {
	mkdirSync(runDir, { recursive: true, mode: 0o700 });
	chmodSync(runDir, 0o700);
	return runDir;
}

/** True when the path exists and is a Unix socket. */
export function isSocketFile(path: string): boolean {
	try {
		return lstatSync(path).isSocket();
	} catch {
		return false;
	}
}

/** True when a process with this pid exists (including ones we may not signal). */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM") return true;
		return false;
	}
}

/** Atomically write a descriptor file (mode 0o600) via a temp file and rename. */
export function writeDescriptor(runDir: string, descriptor: WireDescriptor): void {
	const target = descriptorPath(runDir, descriptor.pid);
	const tmp = `${target}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
		renameSync(tmp, target);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// ignore
		}
		throw error;
	}
}

/**
 * Read all valid descriptors in filename order; a missing dir yields []. A
 * descriptor needs a numeric `pid` and a string `socket`; extra fields (a
 * foreign program's) are kept, and a missing `name` reads as "unknown".
 */
export function readDescriptors(runDir: string): WireDescriptor[] {
	let names: string[];
	try {
		names = readdirSync(runDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const result: WireDescriptor[] = [];
	for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(join(runDir, name), "utf8"));
		} catch {
			continue;
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof (parsed as { pid?: unknown }).pid !== "number" ||
			typeof (parsed as { socket?: unknown }).socket !== "string"
		) {
			continue;
		}
		const record = parsed as WireDescriptor;
		if (typeof record.name !== "string") record.name = "unknown";
		result.push(record);
	}
	return result;
}

/** Remove a descriptor file; a missing file is not an error. */
export function removeDescriptor(runDir: string, pid: number): void {
	try {
		unlinkSync(descriptorPath(runDir, pid));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
}

/** Delete descriptors (and their sockets) of dead processes; return the live descriptors. */
export function pruneDescriptors(runDir: string): WireDescriptor[] {
	const live: WireDescriptor[] = [];
	for (const descriptor of readDescriptors(runDir)) {
		if (isPidAlive(descriptor.pid)) {
			live.push(descriptor);
			continue;
		}
		try {
			unlinkSync(descriptorPath(runDir, descriptor.pid));
		} catch {
			// ignore
		}
		// Only a default-path socket is known to belong to the dead pid. An explicit
		// path may have been reclaimed by a live process since, so prune never touches it.
		if (descriptor.socket === defaultSocketPath(runDir, descriptor.pid) && isSocketFile(descriptor.socket)) {
			try {
				unlinkSync(descriptor.socket);
			} catch {
				// ignore
			}
		}
	}
	return live;
}
