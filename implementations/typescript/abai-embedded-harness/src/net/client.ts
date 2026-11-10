// A client of aiipd, the aiip daemon, over its Unix-socket HTTP/JSON API
// (abaigrammar section 7, `network`; aiip's internal/daemon/api.go). The
// harness uses the membership half of the API: who this run is on which
// network, who else is enrolled, and who is reachable now. Messaging is
// not here: aiip's mailbox is memory-only and a read removes the message,
// so send and receive belong to the layer that owns durability.
import { request } from "node:http";

/** The daemon's socket, under its state directory. */
export const AIIP_SOCKET_NAME = "aiipd.sock";
/** The API version string this harness was written against (`GET /v1/status`). */
export const KNOWN_AIIP_API = "aiip-m8";
/** The daemon refuses a longer socket path (macOS allows about 104 bytes; aiip stops at 100). */
export const AIIP_SOCKET_PATH_MAX = 100;
/** The daemon caps request bodies at 2 MiB; responses are read to the same cap. */
export const AIIP_BODY_CAP = 2 * 1024 * 1024;

export const AIIP_REQUEST_TIMEOUT_MS = 10_000;
/** A plain join returns after a hello round trip to the inviter; the aiip CLI allows a minute. */
export const AIIP_JOIN_TIMEOUT_MS = 60_000;
/** A member fetches the roster from the authority, bounded to 35 s on the daemon's side. */
export const AIIP_MEMBERS_TIMEOUT_MS = 40_000;
/** A send dials the member and waits for its daemon's ack, within the daemon's 30 s dial budget; the aiip CLI allows a minute. */
export const AIIP_SEND_TIMEOUT_MS = 60_000;
/** One long-poll of the mailbox; the daemon caps a wait at 60 s. */
export const AIIP_RECV_WAIT_MS = 45_000;
export const AIIP_RECV_WAIT_MAX_MS = 60_000;
/** The daemon caps a mail payload at 1 MiB of decoded bytes. */
export const AIIP_PAYLOAD_CAP = 1024 * 1024;

export interface AiipStatus {
	version: string;
	pid: number;
	stateDir: string;
	startedAt: string;
	memberships: number;
}

/** One membership of the daemon's state dir (aiip's MembershipInfo). */
export interface AiipMembership {
	networkID: string;
	networkName: string;
	prefix: string;
	selfName: string;
	selfAddr: string;
	underlayPort: number;
	authority: boolean;
	lighthouse?: boolean;
	peers: number;
	pendingEstablish?: boolean;
	renewalStopped?: boolean;
	renewalVerdict?: string;
}

/** What a join answers: the new membership, plus a pairing session for a punch token (not used here). */
export interface AiipJoinResult extends AiipMembership {
	pairing?: unknown;
}

export interface AiipInvite {
	/** A bearer secret carrying the invitee's private key: keep it out of argv, logs and files. */
	token: string;
	name: string;
	addr: string;
}

/** A slot the authority issued; `enrolled` is the authority's fact, `self` marks the answering daemon. */
export interface AiipMember {
	name?: string;
	addr: string;
	enrolled: boolean;
	self?: boolean;
}

export interface AiipMembers {
	members: AiipMember[];
	/** `authority` when fetched fresh, `cached` when the authority was unreachable. */
	source: string;
}

/** A peer as this daemon knows it; a `nameClaimed` name was declared by the peer itself and does not route. */
export interface AiipPeer {
	name?: string;
	addr: string;
	nameClaimed?: boolean;
	endpoints?: string[];
	enrolled?: boolean;
}

/** A peer with live tunnel evidence from this node. */
export interface AiipPeerDetail extends AiipPeer {
	established: boolean;
	currentRemote?: string;
	relaysToMe?: string[];
	peerCertFingerprint?: string;
}

export interface AiipPeers {
	self: AiipPeer;
	peers: AiipPeerDetail[];
}

export interface CreateNetworkRequest {
	name: string;
	as: string;
	/** Serve the network as lighthouse and relay; needs an address other members can reach. */
	lighthouse?: boolean;
}

/** `POST /v1/networks/{net}/send`: the member the message reached. */
export interface AiipSendResult {
	to: AiipPeer;
}

interface AiipWireMessage {
	from: { name?: string; addr: string };
	payloadB64?: string;
	sentAt: string;
	receivedAt: string;
	broadcast?: boolean;
}

/** One message taken from the mailbox. `from.name` is only what the sender claimed; `from.addr` is authenticated. */
export interface AiipMessage {
	from: { name?: string; addr: string };
	payload: Uint8Array;
	sentAt: string;
	receivedAt: string;
	broadcast: boolean;
}

/**
 * A request the daemon refused or could not be made. `status` is the HTTP
 * status, 0 when no daemon answered at the socket; `reason` is the daemon's
 * stable code where it gives one (`no-known-endpoints`).
 */
export class AiipError extends Error {
	readonly status: number;
	readonly reason: string | undefined;
	constructor(status: number, message: string, reason?: string) {
		super(message);
		this.name = "AiipError";
		this.status = status;
		this.reason = reason;
	}
	/** No daemon answered at the socket (a timeout or a caller's abort is not this). */
	get unreachable(): boolean {
		return this.reason === "unreachable";
	}
}

/** The daemon's 409 for an identity already enrolled: a join of a network this state dir is on, or an invite for a member's own name. */
export function isAlreadyMember(error: unknown): boolean {
	return error instanceof AiipError && error.status === 409 && /already a member/i.test(error.message);
}

export class AiipClient {
	readonly socketPath: string;

	constructor(socketPath: string) {
		this.socketPath = socketPath;
	}

	status(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<AiipStatus> {
		return this.call<AiipStatus>("GET", "/v1/status", undefined, options.timeoutMs ?? 2_000, options.signal);
	}

	networks(): Promise<AiipMembership[]> {
		return this.call<AiipMembership[]>("GET", "/v1/networks");
	}

	create(req: CreateNetworkRequest): Promise<AiipMembership> {
		return this.call<AiipMembership>("POST", "/v1/networks", {
			name: req.name,
			as: req.as,
			lighthouse: req.lighthouse === true,
		});
	}

	invite(net: string, forName: string): Promise<AiipInvite> {
		return this.call<AiipInvite>("POST", `/v1/networks/${encodeURIComponent(net)}/invites`, { for: forName });
	}

	/** Join with an invite token. Synchronous on the daemon's side: it returns after the hello to the inviter. */
	join(token: string): Promise<AiipJoinResult> {
		return this.call<AiipJoinResult>("POST", "/v1/join", { token }, AIIP_JOIN_TIMEOUT_MS);
	}

	members(net: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<AiipMembers> {
		return this.call<AiipMembers>(
			"GET",
			`/v1/networks/${encodeURIComponent(net)}/members`,
			undefined,
			options.timeoutMs ?? AIIP_MEMBERS_TIMEOUT_MS,
			options.signal,
		);
	}

	peers(net: string): Promise<AiipPeers> {
		return this.call<AiipPeers>("GET", `/v1/networks/${encodeURIComponent(net)}/peers`);
	}

	/** Leave a network: local only, the authority is not told. */
	async leave(net: string): Promise<void> {
		await this.call<undefined>("DELETE", `/v1/networks/${encodeURIComponent(net)}`);
	}

	/**
	 * Send a payload to a member, by the name the authority issued or by
	 * address. Synchronous on the daemon's side: a result means the member's
	 * daemon took the message into its mailbox and acked. Refusals come as
	 * `AiipError`: 404 no such member or network, 409 an ambiguous name, 502
	 * the member's daemon refused it (mailbox full or gone), 503 no route to
	 * the member, 504 the dial budget ran out.
	 */
	send(net: string, to: string, payload: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<AiipSendResult> {
		if (payload.byteLength > AIIP_PAYLOAD_CAP) {
			return Promise.reject(
				new AiipError(
					0,
					`payload of ${payload.byteLength} bytes exceeds the daemon's ${AIIP_PAYLOAD_CAP} byte cap`,
				),
			);
		}
		return this.call<AiipSendResult>(
			"POST",
			`/v1/networks/${encodeURIComponent(net)}/send`,
			{ to, payloadB64: Buffer.from(payload).toString("base64") },
			AIIP_SEND_TIMEOUT_MS,
			options.signal,
		);
	}

	/**
	 * Take the next message from the membership's mailbox, waiting up to
	 * `waitMs` (capped at the daemon's 60 s) for one; undefined when none
	 * arrived. The read removes the message: whoever calls this owns it. 410
	 * when the membership was removed meanwhile.
	 */
	async recv(net: string, options: { waitMs?: number; signal?: AbortSignal } = {}): Promise<AiipMessage | undefined> {
		const waitMs = Math.min(Math.max(1, Math.floor(options.waitMs ?? AIIP_RECV_WAIT_MS)), AIIP_RECV_WAIT_MAX_MS);
		const raw = await this.call<AiipWireMessage | undefined>(
			"GET",
			`/v1/networks/${encodeURIComponent(net)}/recv?wait=${waitMs}ms`,
			undefined,
			waitMs + 15_000,
			options.signal,
		);
		if (raw === undefined) return undefined;
		// the daemon leaves the name out when the sender claimed none; a fake may write it empty
		const name = raw.from.name === undefined || raw.from.name === "" ? undefined : raw.from.name;
		return {
			from: { ...(name === undefined ? {} : { name }), addr: raw.from.addr },
			payload: new Uint8Array(Buffer.from(raw.payloadB64 ?? "", "base64")),
			sentAt: raw.sentAt,
			receivedAt: raw.receivedAt,
			broadcast: raw.broadcast === true,
		};
	}

	private call<T>(
		method: string,
		path: string,
		body?: unknown,
		timeoutMs = AIIP_REQUEST_TIMEOUT_MS,
		signal?: AbortSignal,
	): Promise<T> {
		const limit = AbortSignal.timeout(timeoutMs);
		const abort = signal ? AbortSignal.any([signal, limit]) : limit;
		const classify = (error: unknown) => this.transportError(error, signal, limit);
		return new Promise<T>((resolve, reject) => {
			const payload = body === undefined ? undefined : JSON.stringify(body);
			const req = request(
				{
					socketPath: this.socketPath,
					method,
					path,
					headers: {
						host: "aiipd",
						accept: "application/json",
						...(payload === undefined
							? {}
							: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }),
					},
					signal: abort,
				},
				(res) => {
					const chunks: Buffer[] = [];
					let size = 0;
					res.on("data", (chunk: Buffer) => {
						size += chunk.length;
						if (size > AIIP_BODY_CAP) {
							res.destroy();
							reject(new AiipError(res.statusCode ?? 0, `the daemon's answer exceeded ${AIIP_BODY_CAP} bytes`));
							return;
						}
						chunks.push(chunk);
					});
					res.on("error", (error) => reject(classify(error)));
					res.on("end", () => {
						const status = res.statusCode ?? 0;
						const text = Buffer.concat(chunks).toString("utf8");
						if (status >= 200 && status < 300) {
							if (status === 204 || text === "") {
								resolve(undefined as T);
								return;
							}
							try {
								resolve(JSON.parse(text) as T);
							} catch {
								reject(new AiipError(status, `the daemon answered ${status} with a body that is not JSON`));
							}
							return;
						}
						reject(errorFrom(status, text));
					});
				},
			);
			req.on("error", (error) => reject(classify(error)));
			if (payload !== undefined) req.write(payload);
			req.end();
		});
	}

	/** Node raises the same abort error for the caller's signal and for the timeout; the signals say which. */
	private transportError(error: unknown, signal: AbortSignal | undefined, limit: AbortSignal): AiipError {
		if (signal?.aborted) return new AiipError(0, `the request to ${this.socketPath} was aborted`, "aborted");
		if (limit.aborted) return new AiipError(0, `the daemon at ${this.socketPath} did not answer in time`, "timeout");
		const e = error as NodeJS.ErrnoException;
		return new AiipError(
			0,
			`no daemon at ${this.socketPath}: ${e?.code ?? e?.message ?? String(error)}`,
			"unreachable",
		);
	}
}

/** The daemon's `{error, reason}` envelope, or the raw text when it is not one. */
function errorFrom(status: number, text: string): AiipError {
	try {
		const parsed = JSON.parse(text) as { error?: unknown; reason?: unknown };
		if (parsed && typeof parsed.error === "string") {
			return new AiipError(status, parsed.error, typeof parsed.reason === "string" ? parsed.reason : undefined);
		}
	} catch {
		// not the envelope
	}
	return new AiipError(status, text.trim() === "" ? `the daemon answered ${status}` : text.trim());
}
