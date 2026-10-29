// What every verb shares: where the binary writes, and the error that
// means "the arguments were wrong" (exit 2, the usage follows).

/** Where the binary writes; the stub's entry io, so `abaikit abai ...` shares it. Injectable for tests. */
export interface AbaikitIo {
	out(text: string): void;
	err(text: string): void;
	env: NodeJS.ProcessEnv;
	cwd: string;
}

export const processIo: AbaikitIo = {
	out: (text) => {
		process.stdout.write(text);
	},
	err: (text) => {
		process.stderr.write(`${text}\n`);
	},
	env: process.env,
	get cwd() {
		return process.cwd();
	},
};

export class UsageError extends Error {}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
