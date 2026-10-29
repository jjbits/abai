// A manifest event's `wakes` is `always`, `never`, or a condition on the
// payload (abaigrammar section 5.1). The condition's form is this
// instantiation's: `<field> <op> <literal>` with `eq`, `ne`, `gt`, `lt`,
// and a JSON literal, such as `attempt gt 2` or `reason eq "quota"`.
// An unparsable condition never wakes, and `doctor` reports it.
export interface WakeCondition {
	field: string;
	op: "eq" | "ne" | "gt" | "lt";
	value: unknown;
}

export function parseWakeCondition(wakes: string): WakeCondition | undefined {
	const match = /^([a-z][a-z0-9_]*)\s+(eq|ne|gt|lt)\s+(.+)$/.exec(wakes.trim());
	if (!match) return undefined;
	try {
		return { field: match[1], op: match[2] as WakeCondition["op"], value: JSON.parse(match[3]) };
	} catch {
		return undefined;
	}
}

/** Whether an event with this payload wakes the agent under its declared `wakes`. */
export function wakesFor(wakes: string | undefined, payload: Record<string, unknown> | undefined): boolean {
	if (wakes === undefined || wakes === "never") return false;
	if (wakes === "always") return true;
	const condition = parseWakeCondition(wakes);
	if (!condition) return false;
	const actual = payload?.[condition.field];
	if (actual === undefined) return false;
	switch (condition.op) {
		case "eq":
			return actual === condition.value;
		case "ne":
			return actual !== condition.value;
		case "gt":
			return typeof actual === "number" && typeof condition.value === "number" && actual > condition.value;
		case "lt":
			return typeof actual === "number" && typeof condition.value === "number" && actual < condition.value;
	}
}
