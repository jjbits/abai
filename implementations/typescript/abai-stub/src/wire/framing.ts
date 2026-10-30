// Line framing for the wire protocol.
import type { Readable } from "node:stream";

/** The default line cap on both ends: a large payload fits. */
export const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * LF-only line reader with a byte cap. Modeled on `attachJsonlLineReader`
 * Chunks stay
 * buffers and only the newest one is scanned for the newline, so a large
 * line costs one concatenation instead of a rescan per chunk.
 */
export function attachCappedLineReader(
	socket: Readable,
	maxLineBytes: number,
	onLine: (line: string) => void,
	onOverflow: () => void,
): () => void {
	let chunks: Buffer[] = [];
	let pendingBytes = 0;
	const onData = (data: string | Buffer) => {
		let chunk = typeof data === "string" ? Buffer.from(data, "utf8") : data;
		while (true) {
			const newlineIndex = chunk.indexOf(10);
			if (newlineIndex === -1) break;
			const head = chunk.subarray(0, newlineIndex);
			const line = (chunks.length === 0 ? head : Buffer.concat([...chunks, head])).toString("utf8");
			chunks = [];
			pendingBytes = 0;
			chunk = chunk.subarray(newlineIndex + 1);
			onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
			if (socket.destroyed) return;
		}
		if (chunk.length > 0) {
			chunks.push(chunk);
			pendingBytes += chunk.length;
			if (pendingBytes > maxLineBytes) {
				chunks = [];
				pendingBytes = 0;
				onOverflow();
			}
		}
	};
	socket.on("data", onData);
	return () => {
		socket.off("data", onData);
	};
}
