// The region (abaigrammar section 5, common rules): the memory the two halves
// share. This is the in-process layout: scalar cells, versions, counters and
// flags live in typed arrays so a write is one store and a read is one load
// (sections 11.1 and 11.2); sized cells and event payloads live in
// preallocated slot objects, whose copies allocate (a declared deviation).
// A shared-buffer layout for thread mode can implement the same shape over a
// SharedArrayBuffer later; nothing here reaches outside the process.

/** Flag slots in `Region.flags`. */
export const FLAG_ATTACHED = 0;
export const FLAG_PARKED = 1;
export const FLAG_PAUSED = 2;
export const FLAG_QUEUE = 3;
/** Nonzero when a safepoint has anything to do: work queued or a pause in effect. One load decides. */
export const FLAG_WORK = 4;
export const FLAG_COUNT = 8;

/** Event slots the ring holds; the oldest unread slot is overwritten when it wraps. */
export const RING_CAPACITY = 256;

export interface EventSlot {
	/** Sequence number, from 1; 0 means never written. */
	seq: number;
	/** The event's ordinal in the manifest's `events` list (library events are negative, see `LIBRARY_EVENT_BASE`). */
	event: number;
	/** The copied payload. */
	payload: Record<string, unknown> | undefined;
	/** A sized field was cut to its `max`. */
	truncated: boolean;
	/** `Date.now()` at emit. */
	ts: number;
}

/** Ordinal of library event `i` (the index into `LIBRARY_EVENTS`) is `LIBRARY_EVENT_BASE - i`. */
export const LIBRARY_EVENT_BASE = -1;

export interface RegionLayout {
	/** How many cells are scalar (bool, int, float, enum); they occupy `values[0..scalars)`. */
	scalars: number;
	/** How many cells are sized (string, object, list); they occupy `sized[0..sizedCount)`. */
	sized: number;
	/** Counters: one per decision, one per turn, then one for the mode fallback. */
	counters: number;
}

export interface ReadEvents {
	slots: EventSlot[];
	/** Events overwritten before they were read, between `after` and the first slot returned. */
	dropped: number;
	/** The sequence number to pass next time. */
	next: number;
}

/**
 * The in-process region. Cells are addressed by ordinal: a scalar cell by
 * its index into `values`, a sized cell by its index into `sized`; both share
 * `versions`, indexed by the cell's position in the manifest.
 */
export class Region {
	readonly values: Float64Array;
	readonly versions: Int32Array;
	readonly counters: Int32Array;
	readonly flags: Int32Array;
	/** Sized cell values; a slot is replaced, never mutated in place. */
	readonly sized: unknown[];
	private readonly ring: EventSlot[];
	/** The next sequence number to assign. */
	private head = 1;

	constructor(layout: RegionLayout, capacity = RING_CAPACITY) {
		this.values = new Float64Array(Math.max(1, layout.scalars));
		this.versions = new Int32Array(Math.max(1, layout.scalars + layout.sized));
		this.counters = new Int32Array(Math.max(1, layout.counters));
		this.flags = new Int32Array(FLAG_COUNT);
		this.sized = new Array<unknown>(layout.sized).fill(undefined);
		this.ring = [];
		for (let i = 0; i < capacity; i++) {
			this.ring.push({ seq: 0, event: 0, payload: undefined, truncated: false, ts: 0 });
		}
	}

	get attached(): boolean {
		return this.flags[FLAG_ATTACHED] !== 0;
	}

	get capacity(): number {
		return this.ring.length;
	}

	/** The last sequence number assigned (0 before the first emit). */
	get lastSeq(): number {
		return this.head - 1;
	}

	/**
	 * Claim the next slot and publish an event into it: one sequence
	 * assignment, four stores. The payload is the caller's copy; the region
	 * does not copy again. Returns the sequence number.
	 */
	emit(event: number, payload: Record<string, unknown> | undefined, truncated: boolean, ts: number): number {
		const seq = this.head++;
		const slot = this.ring[(seq - 1) % this.ring.length];
		slot.seq = seq;
		slot.event = event;
		slot.payload = payload;
		slot.truncated = truncated;
		slot.ts = ts;
		return seq;
	}

	/**
	 * Every event with a sequence number above `after` that is still in the
	 * ring, in order, with the count of those already overwritten.
	 */
	readEvents(after: number): ReadEvents {
		const last = this.head - 1;
		if (last <= after) return { slots: [], dropped: 0, next: after };
		const oldest = Math.max(1, last - this.ring.length + 1);
		const from = Math.max(after + 1, oldest);
		const dropped = from - (after + 1);
		const slots: EventSlot[] = [];
		for (let seq = from; seq <= last; seq++) {
			const slot = this.ring[(seq - 1) % this.ring.length];
			if (slot.seq !== seq) continue; // lapped while reading; the next read reports it as dropped
			slots.push(slot);
		}
		return { slots, dropped, next: last };
	}
}
