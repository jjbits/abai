// The harness's options (abaigrammar section 4.4). Shared by every front
// end: the in-process session form, the MCP form, and the sidecar binary.
// The command-line parser that fills them lives with the binary.
export type HarnessForm = "session" | "mcp";

export interface HarnessOptions {
	form: HarnessForm;
	/** Sidecar: a socket path or a pid; undefined means the one running program. In-process: unused. */
	target: string | number | undefined;
	/** Decisions to claim at attach; empty means every declared decision. */
	claims: string[];
	/** The claim's timeout where the stub lets a harness shorten the manifest's (sidecar); undefined keeps the manifest's. */
	claimTimeoutMs: number | undefined;
	/** Event names that wake the agent beyond the manifest's `wakes`. */
	wakes: string[];
	/** Wakes per minute; undefined means the manifest's budget. */
	budget: number | undefined;
	/** Allow mutate calls without a user channel. */
	auto: boolean;
	/** Refuse mutate calls regardless of the user channel. */
	denyMutate: boolean;
	/** MCP form: the longest `abai_wait`. */
	waitMaxMs: number;
}

export const DEFAULT_WAIT_MAX_S = 55;
export const MAX_WAIT_MAX_S = 600;

export function defaultOptions(form: HarnessForm, overrides: Partial<HarnessOptions> = {}): HarnessOptions {
	return {
		form,
		target: undefined,
		claims: [],
		claimTimeoutMs: undefined,
		wakes: [],
		budget: undefined,
		auto: false,
		denyMutate: false,
		waitMaxMs: DEFAULT_WAIT_MAX_S * 1000,
		...overrides,
	};
}
