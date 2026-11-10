// A fake aiipd on a Unix socket, for the harness's network tests. Modelled
// on agents-cowork's internal/aiipclient/fake.go: an in-memory overlay
// links several fakes into one network, the first member is the authority,
// and every route answers with the shapes and status codes of aiip's
// internal/daemon/api.go. Membership routes, peers and leave, and mail:
// send into another fake's mailbox and a long-polling recv, modelled on
// handleSend, handleRecv and mailbox.go. Its wire shapes are written out by
// hand on purpose, so a field name the client gets wrong fails here. Where
// the fake simplifies: a send to a member that left answers 502 "mailbox
// gone" (the real daemon, whose node is gone, most likely 503 or 504), the
// recv wait accepts only `Nms`, `Ns` or `Nm`, and a member that left keeps
// its endpoints in `peers`.
import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

interface Slot {
	name: string;
	addr: string;
	/** An authenticated frame reached the authority (the real roster's fact). */
	enrolled: boolean;
}

interface Invite {
	name: string;
	addr: string;
}

export class FakeOverlay {
	readonly networkID: string;
	networkName: string;
	readonly prefix = "100.107.0.0/16";
	readonly slots: Slot[] = [];
	readonly byAddr = new Map<string, FakeAiipd>();
	authority: FakeAiipd | undefined;
	readonly invites = new Map<string, Invite>();
	private nextHost = 2;
	private nextPort = 4242;

	constructor(networkID = "0123456789abcdef0123456789abcdef", networkName = "fake") {
		this.networkID = networkID;
		this.networkName = networkName;
	}

	allocAddr(): string {
		const n = this.nextHost++;
		return `100.107.${Math.floor(n / 256)}.${n % 256}`;
	}

	allocPort(): number {
		return this.nextPort++;
	}

	slotByName(name: string): Slot | undefined {
		return this.slots.find((s) => s.name === name);
	}

	/** A fake already enrolled as `name`; the first one is the network's authority. */
	async newMember(name: string, socketPath: string): Promise<FakeAiipd> {
		const fake = new FakeAiipd(this, socketPath);
		const addr = this.allocAddr();
		this.slots.push({ name, addr, enrolled: true });
		this.byAddr.set(addr, fake);
		const authority = this.authority === undefined;
		if (authority) this.authority = fake;
		fake.member = { name, addr, authority, lighthouse: false };
		await fake.start();
		return fake;
	}

	/** A fake that is not on the network yet. */
	async newOutsider(socketPath: string): Promise<FakeAiipd> {
		const fake = new FakeAiipd(this, socketPath);
		await fake.start();
		return fake;
	}
}

/** One message in a fake's mailbox (aiip's mailbox.go Message). */
export interface StoredMessage {
	from: { name: string; addr: string };
	payload: Buffer;
	sentAt: string;
	receivedAt: string;
	broadcast: boolean;
}

/** aiip's per-membership mailbox cap. */
export const MAILBOX_CAP = 1024;
/** aiip's maxPayload: decoded bytes. */
const MAX_PAYLOAD = 1024 * 1024;
/** aiip's maxRecvWait. */
const MAX_RECV_WAIT_MS = 60_000;

interface Waiter {
	res: ServerResponse;
	timer: NodeJS.Timeout;
}

interface Membership {
	name: string;
	addr: string;
	authority: boolean;
	lighthouse: boolean;
}

export class FakeAiipd {
	readonly overlay: FakeOverlay;
	readonly socketPath: string;
	readonly port: number;
	readonly startedAt = new Date().toISOString();
	version = "aiip-m8";
	rosterSource = "authority";
	/** When set, every request answers this status with a `{error, reason}` envelope. */
	fault: { status: number; error: string; reason?: string } | undefined;
	/** When set, every answer waits this long first (a slow daemon). */
	delayMs = 0;
	member: Membership | undefined;
	running = false;
	/** This membership's mailbox, oldest first. */
	readonly mailbox: StoredMessage[] = [];
	/** When set, a send to this fake times its dial out (504). */
	unreachable = false;
	private server: Server | undefined;
	/** Pending long-poll recvs, in arrival order. */
	private waiters: Waiter[] = [];

	constructor(overlay: FakeOverlay, socketPath: string) {
		this.overlay = overlay;
		this.socketPath = socketPath;
		this.port = overlay.allocPort();
	}

	get name(): string | undefined {
		return this.member?.name;
	}

	async start(): Promise<void> {
		if (this.running) return;
		if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
		const server = createServer((req, res) => this.handle(req, res));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.socketPath, () => resolve());
		});
		this.server = server;
		this.running = true;
	}

	async stop(): Promise<void> {
		if (!this.running) return;
		this.running = false;
		for (const waiter of this.waiters.splice(0)) clearTimeout(waiter.timer);
		const server = this.server;
		this.server = undefined;
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
	}

	/** A message arriving over the overlay, as if a peer sent it; wakes a waiting recv. */
	inject(from: { name?: string; addr: string }, payload: Uint8Array, broadcast = false): void {
		const now = new Date().toISOString();
		this.deliver({
			from: { name: from.name ?? "", addr: from.addr },
			payload: Buffer.from(payload),
			sentAt: now,
			receivedAt: now,
			broadcast,
		});
	}

	/** Answer the oldest waiting recv with the message, or keep it in the mailbox. */
	private deliver(message: StoredMessage): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			clearTimeout(waiter.timer);
			writeJSON(waiter.res, 200, messageJSON(message));
			return;
		}
		this.mailbox.push(message);
	}

	private membershipJSON(): Record<string, unknown> {
		const m = this.member as Membership;
		return {
			networkID: this.overlay.networkID,
			networkName: this.overlay.networkName,
			prefix: this.overlay.prefix,
			selfName: m.name,
			selfAddr: m.addr,
			underlayPort: this.port,
			authority: m.authority,
			...(m.lighthouse ? { lighthouse: true } : {}),
			peers: Math.max(0, this.overlay.slots.length - 1),
		};
	}

	/** aiip's resolveNet: the id, a unique name, or an id prefix of 8 or more characters. */
	private resolvesNet(ref: string): boolean {
		if (!this.member) return false;
		const { networkID, networkName } = this.overlay;
		return ref === networkID || ref === networkName || (ref.length >= 8 && networkID.startsWith(ref));
	}

	private handle(req: IncomingMessage, res: ServerResponse): void {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const answer = () => {
				try {
					this.route(req.method ?? "GET", new URL(req.url ?? "/", "http://aiipd"), Buffer.concat(chunks), res);
				} catch (error) {
					writeJSON(res, 500, { error: error instanceof Error ? error.message : String(error) });
				}
			};
			if (this.delayMs > 0) setTimeout(answer, this.delayMs);
			else answer();
		});
	}

	private route(method: string, url: URL, body: Buffer, res: ServerResponse): void {
		const path = url.pathname;
		if (this.fault) {
			writeJSON(res, this.fault.status, {
				error: this.fault.error,
				...(this.fault.reason === undefined ? {} : { reason: this.fault.reason }),
			});
			return;
		}
		if (method === "GET" && path === "/v1/status") {
			writeJSON(res, 200, {
				version: this.version,
				pid: process.pid,
				stateDir: "(fake)",
				startedAt: this.startedAt,
				memberships: this.member ? 1 : 0,
			});
			return;
		}
		if (method === "GET" && path === "/v1/networks") {
			writeJSON(res, 200, this.member ? [this.membershipJSON()] : []);
			return;
		}
		if (method === "POST" && path === "/v1/networks") {
			this.create(body, res);
			return;
		}
		if (method === "POST" && path === "/v1/join") {
			this.join(body, res);
			return;
		}
		const net = /^\/v1\/networks\/([^/]+)(?:\/(invites|members|peers|send|recv))?$/.exec(path);
		if (net) {
			const ref = decodeURIComponent(net[1] ?? "");
			const sub = net[2];
			if (!this.resolvesNet(ref)) {
				writeJSON(res, 404, { error: `no membership matches ${JSON.stringify(ref)}` });
				return;
			}
			if (sub === "invites" && method === "POST") {
				this.invite(body, res);
				return;
			}
			if (sub === "members" && method === "GET") {
				this.members(res);
				return;
			}
			if (sub === "peers" && method === "GET") {
				this.peers(res);
				return;
			}
			if (sub === "send" && method === "POST") {
				this.send(body, res);
				return;
			}
			if (sub === "recv" && method === "GET") {
				this.recv(url.searchParams.get("wait"), res);
				return;
			}
			if (sub === undefined && method === "DELETE") {
				// leave is local: the authority is not told, the slot stays as it was; the daemon stays at its
				// address and refuses mail for the gone membership (502 mailbox gone)
				this.member = undefined;
				this.mailbox.length = 0;
				for (const waiter of this.waiters.splice(0)) {
					clearTimeout(waiter.timer);
					writeJSON(waiter.res, 410, { error: "membership removed" });
				}
				res.writeHead(204);
				res.end();
				return;
			}
		}
		writeJSON(res, 404, { error: "404 page not found" });
	}

	private create(body: Buffer, res: ServerResponse): void {
		const req = parse<{ name?: string; as?: string; lighthouse?: boolean }>(body, res);
		if (!req) return;
		if (!req.name || !req.as) {
			writeJSON(res, 400, { error: "name and as are required" });
			return;
		}
		if (this.member) {
			writeJSON(res, 409, { error: "already a member of this network" });
			return;
		}
		if (this.overlay.authority) {
			// a simplification of the fake, which carries one network: aiipd mints a fresh network id on every
			// create and holds the new membership beside the old ones; no test relies on this 409
			writeJSON(res, 409, { error: "fake overlay already carries its one network" });
			return;
		}
		const addr = this.overlay.allocAddr();
		this.overlay.networkName = req.name;
		this.overlay.slots.push({ name: req.as, addr, enrolled: true });
		this.overlay.byAddr.set(addr, this);
		this.overlay.authority = this;
		this.member = { name: req.as, addr, authority: true, lighthouse: req.lighthouse === true };
		writeJSON(res, 201, this.membershipJSON());
	}

	private invite(body: Buffer, res: ServerResponse): void {
		const req = parse<{ for?: string }>(body, res);
		if (!req) return;
		if (!req.for) {
			writeJSON(res, 400, { error: "for is required" });
			return;
		}
		const m = this.member as Membership;
		if (!m.authority) {
			writeJSON(res, 403, { error: "this daemon is not the network's authority" });
			return;
		}
		if (req.for === m.name) {
			writeJSON(res, 409, {
				error: `${JSON.stringify(req.for)} is this member's own name: already a member of this network`,
			});
			return;
		}
		let addr: string;
		const slot = this.overlay.slotByName(req.for);
		if (slot) {
			if (slot.enrolled) {
				writeJSON(res, 409, {
					error: `${JSON.stringify(req.for)} is already a member: already a member of this network`,
				});
				return;
			}
			addr = slot.addr;
		} else {
			addr = this.overlay.allocAddr();
			this.overlay.slots.push({ name: req.for, addr, enrolled: false });
		}
		const token = `fake-invite-${randomBytes(12).toString("hex")}`;
		this.overlay.invites.set(token, { name: req.for, addr });
		writeJSON(res, 201, { token, name: req.for, addr });
	}

	private join(body: Buffer, res: ServerResponse): void {
		const req = parse<{ token?: string }>(body, res);
		if (!req) return;
		if (!req.token) {
			writeJSON(res, 400, { error: "token is required" });
			return;
		}
		const invite = this.overlay.invites.get(req.token);
		if (!invite) {
			writeJSON(res, 400, { error: "token: unrecognized invite token" });
			return;
		}
		if (this.member) {
			writeJSON(res, 409, { error: "already a member of this network" });
			return;
		}
		// aiipd refuses a join only when this daemon already holds that network; a slot another daemon enrolled
		// is not checked here (the real check is the tunnel's certificate), so the fake does not refuse it either
		const slot = this.overlay.slotByName(invite.name);
		const authority = this.overlay.authority;
		if (authority && !(authority.running && authority.member)) {
			writeJSON(res, 502, {
				error: `could not reach inviter ${authority.name ?? "?"} at [fake]: context deadline exceeded`,
			});
			return;
		}
		if (slot) slot.enrolled = true;
		this.overlay.byAddr.set(invite.addr, this);
		this.member = { name: invite.name, addr: invite.addr, authority: false, lighthouse: false };
		writeJSON(res, 201, this.membershipJSON());
	}

	private members(res: ServerResponse): void {
		const self = (this.member as Membership).addr;
		writeJSON(res, 200, {
			members: this.overlay.slots.map((s) => ({
				name: s.name,
				addr: s.addr,
				enrolled: s.enrolled,
				...(s.addr === self ? { self: true } : {}),
			})),
			source: this.rosterSource,
		});
	}

	private peers(res: ServerResponse): void {
		const m = this.member as Membership;
		const peers = this.overlay.slots
			.filter((s) => s.addr !== m.addr)
			.map((s) => {
				const other = this.overlay.byAddr.get(s.addr);
				const live = other?.running === true && other.member !== undefined;
				return {
					name: s.name,
					addr: s.addr,
					...(other ? { endpoints: [`127.0.0.1:${other.port}`] } : {}),
					...(s.enrolled ? { enrolled: true } : {}),
					established: live,
					...(live ? { currentRemote: `127.0.0.1:${other.port}` } : {}),
				};
			});
		writeJSON(res, 200, {
			self: { name: m.name, addr: m.addr, endpoints: [`127.0.0.1:${this.port}`] },
			peers,
		});
	}

	private send(body: Buffer, res: ServerResponse): void {
		const req = parse<{ to?: string; payloadB64?: string }>(body, res);
		if (!req) return;
		if (!req.to) {
			writeJSON(res, 400, { error: "to is required" });
			return;
		}
		const b64 = req.payloadB64 ?? "";
		if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) {
			writeJSON(res, 400, { error: "bad payloadB64: illegal base64 data" });
			return;
		}
		const payload = Buffer.from(b64, "base64");
		if (payload.byteLength > MAX_PAYLOAD) {
			writeJSON(res, 400, {
				error: `payload of ${payload.byteLength} bytes exceeds the ${MAX_PAYLOAD} byte cap`,
			});
			return;
		}
		const slot = this.overlay.slots.find((s) => s.name === req.to || s.addr === req.to);
		if (!slot) {
			writeJSON(res, 404, { error: `no known peer named ${JSON.stringify(req.to)}` });
			return;
		}
		const target = this.overlay.byAddr.get(slot.addr);
		if (!target) {
			writeJSON(res, 503, { error: `no known endpoints for ${slot.name}`, reason: "no-known-endpoints" });
			return;
		}
		if (target.unreachable || !target.running) {
			writeJSON(res, 504, { error: `dial ${slot.addr}:4747: context deadline exceeded` });
			return;
		}
		if (!target.member) {
			writeJSON(res, 502, { error: "peer refused message: mailbox gone" });
			return;
		}
		if (target.mailbox.length >= MAILBOX_CAP) {
			writeJSON(res, 502, { error: "peer refused message: mailbox full" });
			return;
		}
		const m = this.member as Membership;
		const now = new Date().toISOString();
		target.deliver({
			from: { name: m.name, addr: m.addr },
			payload,
			sentAt: now,
			receivedAt: now,
			broadcast: false,
		});
		writeJSON(res, 200, {
			to: { name: slot.name, addr: slot.addr, enrolled: true, endpoints: [`127.0.0.1:${target.port}`] },
		});
	}

	private recv(raw: string | null, res: ServerResponse): void {
		let waitMs = 1;
		if (raw !== null && raw !== "") {
			const m = /^(\d+)(ms|s|m)$/.exec(raw);
			if (!m) {
				writeJSON(res, 400, { error: `bad wait duration ${JSON.stringify(raw)}` });
				return;
			}
			const unit = m[2] === "ms" ? 1 : m[2] === "s" ? 1_000 : 60_000;
			waitMs = Math.min(Number(m[1]) * unit, MAX_RECV_WAIT_MS);
		}
		const next = this.mailbox.shift();
		if (next) {
			writeJSON(res, 200, messageJSON(next));
			return;
		}
		const waiter: Waiter = {
			res,
			timer: setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w !== waiter);
				res.writeHead(204);
				res.end();
			}, waitMs),
		};
		this.waiters.push(waiter);
		// a reader that hangs up stops waiting, so a later message is not written to a closed response
		res.on("close", () => {
			if (!this.waiters.includes(waiter)) return;
			clearTimeout(waiter.timer);
			this.waiters = this.waiters.filter((w) => w !== waiter);
		});
	}
}

function messageJSON(m: StoredMessage): Record<string, unknown> {
	return {
		from: { name: m.from.name, addr: m.from.addr },
		payloadB64: m.payload.toString("base64"),
		sentAt: m.sentAt,
		receivedAt: m.receivedAt,
		...(m.broadcast ? { broadcast: true } : {}),
	};
}

function parse<T>(body: Buffer, res: ServerResponse): T | undefined {
	try {
		return JSON.parse(body.toString("utf8") || "{}") as T;
	} catch (error) {
		writeJSON(res, 400, { error: `bad request body: ${error instanceof Error ? error.message : String(error)}` });
		return undefined;
	}
}

function writeJSON(res: ServerResponse, status: number, value: unknown): void {
	const text = JSON.stringify(value);
	res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
	res.end(text);
}
