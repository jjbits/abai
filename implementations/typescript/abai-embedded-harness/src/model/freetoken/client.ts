// Client for a FreeToken (ft2) server. ft2 serves an OpenAI-compatible
// /v1/chat/completions plus /health and /v1/models; abai talks to it only
// through the openai-completions wire API.

export interface FreeTokenServedModel {
	id: string;
	/** Servable context window as reported by /v1/models, when the server reports one. */
	contextLength?: number;
}

export type FreeTokenHealth =
	| { status: "ok" }
	| { status: "loading"; phase?: string }
	| { status: "error"; message?: string }
	| { status: "unreachable"; message: string };

const REQUEST_TIMEOUT_MS = 5_000;

export function normalizeFreeTokenServerUrl(value: string): string {
	const url = new URL(value.trim());
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Server URL must use http or https");
	}
	url.hash = "";
	url.search = "";
	url.pathname = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "") || "/";
	return url.toString().replace(/\/$/u, "");
}

export function freetokenInferenceUrl(serverUrl: string): string {
	return `${normalizeFreeTokenServerUrl(serverUrl)}/v1`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readContextLength(entry: Record<string, unknown>): number | undefined {
	for (const key of ["context_length", "max_model_len", "max_context_length"]) {
		const value = entry[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	}
	return undefined;
}

export class FreeTokenClient {
	readonly serverUrl: string;
	private readonly apiKey: string | undefined;

	constructor(serverUrl: string, apiKey?: string) {
		this.serverUrl = normalizeFreeTokenServerUrl(serverUrl);
		this.apiKey = apiKey;
	}

	private async request(path: string, signal?: AbortSignal): Promise<{ status: number; payload: unknown }> {
		const headers = new Headers();
		if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const response = await fetch(`${this.serverUrl}${path}`, {
			headers,
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			payload = undefined;
		}
		return { status: response.status, payload };
	}

	/** Never throws: an unreachable server is a health state, not an error. */
	async health(options: { signal?: AbortSignal } = {}): Promise<FreeTokenHealth> {
		let result: { status: number; payload: unknown };
		try {
			result = await this.request("/health", options.signal);
		} catch (error) {
			return { status: "unreachable", message: error instanceof Error ? error.message : String(error) };
		}
		const payload = isRecord(result.payload) ? result.payload : {};
		const reported = typeof payload.status === "string" ? payload.status : undefined;
		if (result.status === 200 && (reported === undefined || reported === "ok")) return { status: "ok" };
		if (reported === "loading") {
			return { status: "loading", phase: typeof payload.phase === "string" ? payload.phase : undefined };
		}
		return {
			status: "error",
			message:
				typeof payload.message === "string"
					? payload.message
					: reported
						? `status ${reported} (HTTP ${result.status})`
						: `HTTP ${result.status}`,
		};
	}

	async models(options: { signal?: AbortSignal } = {}): Promise<FreeTokenServedModel[]> {
		const result = await this.request("/v1/models", options.signal);
		if (result.status !== 200) throw new Error(`FreeToken returned HTTP ${result.status} for /v1/models`);
		const data = isRecord(result.payload) ? result.payload.data : undefined;
		if (!Array.isArray(data)) throw new Error("FreeToken returned an invalid model list");
		const served: FreeTokenServedModel[] = [];
		for (const entry of data) {
			if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) continue;
			served.push({ id: entry.id, contextLength: readContextLength(entry) });
		}
		return served;
	}
}
