// A run's network (abaigrammar section 7, `network`): the daemon it talks
// to and the memberships it holds. The harness connects it at attach: the
// state directory for the run, the binary, the daemon found or started, a
// join when the environment hands the run an invite, then the memberships.
// `required` turns every failure into a refusal to attach; otherwise the
// run goes on without a network and the prompt says why. abai decides none
// of the meaning: which network, who joins and how members relate to the
// program's own names are the program's (its `doc`) and its operator's.
//
// Who stops the daemon: a run owns its state directory only when
// `ABAI_NET_DIR` names it (the arena gives each ship one); then the daemon
// this run started goes with the run. The shared per-program directory
// keeps its daemon for the next run, as the aiip CLI leaves its daemons,
// so two runs of one program never end each other's daemon.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "@abaigram/abai-stub";
import { abaiHome, readConfig } from "../config.ts";
import { AiipClient, type AiipMembership, isAlreadyMember } from "./client.ts";
import { type AiipDaemon, ensureAiipDaemon, type SpawnFn, socketPathFor } from "./daemon.ts";
import { aiipBinaryFor, ENV_AIIP_BIN, ENV_NET_DIR, ENV_NET_TOKEN, networkDirFor } from "./dir.ts";
import { type MailHandler, MailLoop, type MailLoopOptions } from "./mail.ts";

export type NetworkDeclaration = NonNullable<Manifest["network"]>;

export interface NetworkMembership {
	/** The network's name, as the authority named it. */
	network: string;
	id: string;
	/** This run's member name on it, issued by the authority. */
	member: string;
	addr: string;
	authority: boolean;
	/** Slots the authority issued besides this one. */
	peers: number;
}

export interface NetworkStatus {
	dir: string;
	daemon: "spawned" | "found";
	/** This run ends the daemon it started at shutdown: the directory is the run's own (`ABAI_NET_DIR`). */
	owned: boolean;
	version: string;
	versionSkew?: string;
	memberships: NetworkMembership[];
}

export interface NetworkMemberView {
	/** The name the network's authority issued; absent for a peer the roster does not list. */
	name?: string;
	/** A name the member declared about itself, not issued by the authority: a display hint that does not route. */
	claimedName?: string;
	addr: string;
	/**
	 * An authenticated frame from this member has been seen: by the authority when the roster came from it
	 * (`source: "authority"`), else by this run's own daemon.
	 */
	enrolled: boolean;
	self: boolean;
	/** A tunnel from this run to the member exists now. */
	established: boolean;
}

export interface NetworkPeers {
	network: string;
	member: string;
	addr: string;
	/** `authority` when the roster came fresh from the authority, `cached` otherwise, `unavailable` when it could not be read. */
	source: string;
	members: NetworkMemberView[];
	/** Why the roster or the live view could not be read, when it could not. */
	error?: string;
}

function toMembership(m: AiipMembership): NetworkMembership {
	return {
		network: m.networkName,
		id: m.networkID,
		member: m.selfName,
		addr: m.selfAddr,
		authority: m.authority,
		peers: m.peers,
	};
}

/** How long a roster read for naming a sender may take, and how long a roster serves before an unknown address makes it fetch again. */
export const ROSTER_LOOKUP_TIMEOUT_MS = 5_000;
export const ROSTER_REFRESH_MIN_MS = 10_000;

/**
 * This run's network: the daemon, the memberships as last listed, the
 * snapshot the prompt was composed from, and the mail loops that read the
 * memberships' mailboxes while a harness is attached.
 */
export class RunNetwork {
	readonly daemon: AiipDaemon;
	readonly owned: boolean;
	readonly mail: MailLoop;
	private memberships: NetworkMembership[];
	private snapshot: NetworkMembership[];
	private readonly rosters = new Map<string, { at: number; byAddr: Map<string, string> }>();
	private readonly now: () => number;

	constructor(
		daemon: AiipDaemon,
		memberships: AiipMembership[],
		owned: boolean,
		note: (text: string) => void = () => {},
		options: { mail?: MailLoopOptions; now?: () => number } = {},
	) {
		this.daemon = daemon;
		this.owned = owned;
		this.memberships = memberships.map(toMembership);
		this.snapshot = [...this.memberships];
		this.now = options.now ?? Date.now;
		this.mail = new MailLoop(daemon.client, note, {
			...options.mail,
			onDropped: (m) => {
				options.mail?.onDropped?.(m);
				void this.refresh().catch(() => {});
			},
		});
	}

	/** Read every membership's mailbox, handing each message to `handler`, until `stopMail` or `stop`. */
	startMail(handler: MailHandler): void {
		this.mail.start(handler, this.memberships);
	}

	/** Stop reading the mailboxes; what arrives next waits in the daemon. */
	stopMail(): Promise<void> {
		return this.mail.stop();
	}

	/**
	 * The name the network's authority issued to an address, from the roster
	 * (fetched again when an address is unknown and the roster, or the last
	 * try for it, is older than `ROSTER_REFRESH_MIN_MS`); undefined when none
	 * is known, so the caller shows the address.
	 */
	async nameFor(networkId: string, addr: string): Promise<string | undefined> {
		const own = this.memberships.find((m) => m.id === networkId);
		if (own && own.addr === addr) return own.member;
		let roster = this.rosters.get(networkId);
		if (!roster?.byAddr.has(addr) && (roster === undefined || this.now() - roster.at >= ROSTER_REFRESH_MIN_MS)) {
			try {
				const read = await this.daemon.client.members(networkId, { timeoutMs: ROSTER_LOOKUP_TIMEOUT_MS });
				roster = {
					at: this.now(),
					byAddr: new Map(read.members.flatMap((s) => (s.name ? [[s.addr, s.name]] : []))),
				};
				this.rosters.set(networkId, roster);
			} catch {
				// the last roster, or none, stands; the failed try counts as the last, so an authority that is down
				// costs one wait per refresh period, not one per message
				this.rosters.set(networkId, { at: this.now(), byAddr: roster?.byAddr ?? new Map() });
				roster = this.rosters.get(networkId);
			}
		}
		return roster?.byAddr.get(addr);
	}

	get status(): NetworkStatus {
		return {
			dir: this.daemon.dir,
			daemon: this.daemon.spawned ? "spawned" : "found",
			owned: this.owned,
			version: this.daemon.version,
			...(this.daemon.versionSkew === undefined ? {} : { versionSkew: this.daemon.versionSkew }),
			memberships: [...this.memberships],
		};
	}

	/** The memberships at attach: what the prompt names, byte-stable for the run. */
	get promptMemberships(): NetworkMembership[] {
		return [...this.snapshot];
	}

	/** List the memberships again (a `config net` run in another process may have changed them); the mail loops follow. */
	async refresh(): Promise<NetworkMembership[]> {
		this.memberships = (await this.daemon.client.networks()).map(toMembership);
		this.mail.sync(this.memberships);
		return [...this.memberships];
	}

	/** A reattach took this network up again: the prompt's snapshot follows the current list. */
	async retake(): Promise<void> {
		await this.refresh();
		this.snapshot = [...this.memberships];
	}

	/**
	 * Every member of every network this run is on, with whether each is enrolled and reachable now. The
	 * memberships are listed afresh first; a network whose roster cannot be read is reported with its error.
	 */
	async peers(): Promise<NetworkPeers[]> {
		try {
			await this.refresh();
		} catch {
			// the last list stands
		}
		const out: NetworkPeers[] = [];
		for (const m of this.memberships) {
			try {
				out.push(await this.peersOf(m));
			} catch (error) {
				out.push({
					network: m.network,
					member: m.member,
					addr: m.addr,
					source: "unavailable",
					members: [],
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return out;
	}

	private async peersOf(m: NetworkMembership): Promise<NetworkPeers> {
		const [roster, live] = await Promise.all([this.daemon.client.members(m.id), this.daemon.client.peers(m.id)]);
		const byAddr = new Map(live.peers.map((p) => [p.addr, p]));
		// the roster's names are the authority's: issued, never claimed
		const members: NetworkMemberView[] = roster.members.map((slot) => ({
			...(slot.name === undefined ? {} : { name: slot.name }),
			addr: slot.addr,
			enrolled: slot.enrolled,
			self: slot.self === true || slot.addr === m.addr,
			established: byAddr.get(slot.addr)?.established === true,
		}));
		// a peer this daemon knows that the roster does not list (a roster read from cache): its name, if any,
		// is what it said about itself
		for (const peer of live.peers) {
			if (members.some((x) => x.addr === peer.addr)) continue;
			members.push({
				...(peer.name === undefined ? {} : peer.nameClaimed ? { claimedName: peer.name } : { name: peer.name }),
				addr: peer.addr,
				enrolled: peer.enrolled === true,
				self: false,
				established: peer.established,
			});
		}
		return { network: m.network, member: m.member, addr: m.addr, source: roster.source, members };
	}

	/** Stop reading mail; end the daemon when this run started it and owns the directory, else it stays for the next run. */
	async stop(): Promise<void> {
		await this.mail.stop();
		if (this.owned) await this.daemon.stop();
	}
}

/** The memberships a state directory holds, read from its records without a daemon (names and addresses only). */
export function membershipsOnDisk(dir: string): NetworkMembership[] {
	const out: NetworkMembership[] = [];
	let files: string[];
	try {
		files = readdirSync(join(dir, "memberships")).filter((f) => f.endsWith(".json"));
	} catch {
		return out;
	}
	for (const file of files) {
		try {
			const record = JSON.parse(readFileSync(join(dir, "memberships", file), "utf8")) as {
				networkID?: unknown;
				networkName?: unknown;
				identity?: { name?: unknown; addr?: unknown };
				authority?: unknown;
				peers?: unknown;
			};
			if (typeof record.networkID !== "string" || typeof record.identity?.name !== "string") continue;
			out.push({
				network: typeof record.networkName === "string" ? record.networkName : record.networkID,
				id: record.networkID,
				member: record.identity.name,
				addr: typeof record.identity.addr === "string" ? record.identity.addr : "",
				authority: record.authority !== undefined && record.authority !== null,
				peers: Array.isArray(record.peers) ? record.peers.length : 0,
			});
		} catch {
			// a record this harness cannot read is not a membership it can name
		}
	}
	return out;
}

export interface ConnectNetworkInput {
	env: NodeJS.ProcessEnv;
	/** The program's name: its place under abai's home when `ABAI_NET_DIR` is unset. */
	program: string;
	declared: NetworkDeclaration | undefined;
	/** The network of the previous attach, reused when its directory is the same, stopped otherwise. */
	current?: RunNetwork;
	spawn?: SpawnFn;
	/** A line for the harness's transcript. */
	note: (text: string) => void;
}

export type ConnectNetworkOutcome =
	| { network: RunNetwork; absent?: undefined; declared: boolean }
	| { network?: undefined; absent: string | undefined; declared: boolean };

export const NO_BINARY = `no aiip binary found: set ${ENV_AIIP_BIN}, run "abai config set aiip-bin <path>", or put aiip on the PATH`;

export function noMembership(dir: string): string {
	return `no membership in ${dir} (set ${ENV_NET_TOKEN} to an invite, or run: <prog> abai config net join --token -)`;
}

/**
 * The network for a run, or the reason it has none. Nothing declared and
 * nothing in the environment means no network and no reason. A declared
 * `required` network turns every failure into a thrown error; the caller
 * then attaches nothing. A daemon this call started is ended on failure
 * only when the run owns the directory.
 */
export async function connectNetwork(input: ConnectNetworkInput): Promise<ConnectNetworkOutcome> {
	const { env, program, declared, current, note } = input;
	const token = env[ENV_NET_TOKEN]?.trim() || undefined;
	const explicitDir = env[ENV_NET_DIR]?.trim() || undefined;
	const isDeclared = declared !== undefined;
	if (!isDeclared && token === undefined && explicitDir === undefined) {
		if (current) await current.stop();
		return { absent: undefined, declared: false };
	}
	const required = declared?.required === true;
	const owned = explicitDir !== undefined;

	let daemon: AiipDaemon | undefined;
	let reuse: RunNetwork | undefined;
	const fail = async (reason: string): Promise<ConnectNetworkOutcome> => {
		// what this run started and owns goes with the failure; a shared directory's daemon stays
		if (owned && daemon?.spawned) await daemon.stop();
		if (required) throw new Error(`the program requires a network: ${reason}`);
		note(`# network: none (${reason})`);
		return { absent: reason, declared: isDeclared };
	};

	let dir: string;
	try {
		dir = networkDirFor(env, program) as string;
	} catch (error) {
		if (current) await current.stop();
		return fail(errorMessage(error));
	}
	reuse = current !== undefined && current.daemon.dir === dir ? current : undefined;
	if (current && !reuse) await current.stop();
	daemon = reuse?.daemon;

	// no invite, no membership on disk and no daemon answering: nothing to run a daemon for
	if (token === undefined && daemon === undefined && membershipsOnDisk(dir).length === 0) {
		let answering = false;
		try {
			await new AiipClient(socketPathFor(dir)).status();
			answering = true;
		} catch {
			// no daemon there, or a socket path the daemon would refuse (ensureAiipDaemon says which)
		}
		if (!answering) return fail(noMembership(dir));
	}

	if (daemon === undefined) {
		const bin = aiipBinaryFor(env, readConfig(abaiHome(env)));
		if (bin === undefined) return fail(NO_BINARY);
		try {
			daemon = await ensureAiipDaemon(dir, { bin, spawn: input.spawn, env });
		} catch (error) {
			return fail(errorMessage(error));
		}
		if (daemon.versionSkew !== undefined) note(`# network: ${daemon.versionSkew}`);
	}

	if (token !== undefined) {
		try {
			const joined = await daemon.client.join(token);
			note(`# network: joined ${joined.networkName} as ${joined.selfName} (${joined.selfAddr})`);
		} catch (error) {
			if (!isAlreadyMember(error)) {
				const reason = `the invite could not be used: ${errorMessage(error)}`;
				if (required) return fail(reason);
				note(`# network: ${reason}`);
			}
		}
	}

	let memberships: AiipMembership[];
	try {
		memberships = await daemon.client.networks();
	} catch (error) {
		return fail(`the daemon could not list memberships: ${errorMessage(error)}`);
	}
	if (memberships.length === 0) return fail(noMembership(dir));

	let network: RunNetwork;
	if (reuse) {
		network = reuse;
		await reuse.retake();
	} else {
		network = new RunNetwork(daemon, memberships, owned, note);
	}
	for (const m of memberships) note(`# network: ${m.selfName} (${m.selfAddr}) on ${m.networkName}`);
	return { network, declared: isDeclared };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
