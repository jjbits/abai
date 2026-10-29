// Fitting cell values to their declared sizes and validating knob writes
// (abaigrammar section 5.2).
import { type CellDecl, cutUtf8, encodedBytes, type FieldSchema, fieldOf, matchesType } from "../manifest/manifest.ts";

/** Cut a string to at most `max` bytes without splitting a code point (one encode, one decode). */
function cutString(value: string, max: number): string {
	return cutUtf8(value, max);
}

/** Fit a value to its cell: strings cut to `max` bytes, lists cut to the items whose JSON fits. */
export function fitValue(value: unknown, decl: CellDecl): unknown {
	if (decl.type === "string" && typeof value === "string") {
		return cutString(value, decl.max ?? 256);
	}
	if (decl.type === "object" && typeof value === "object" && value !== null) {
		const max = decl.max ?? 1024;
		const bytes = encodedBytes(value);
		if (bytes > max) return { truncated: true, bytes };
		return JSON.parse(JSON.stringify(value));
	}
	if (decl.type === "list" && Array.isArray(value)) {
		const max = decl.max ?? 1024;
		const items = decl.items === undefined ? undefined : fieldOf(decl.items);
		const kept: unknown[] = [];
		for (const item of value) {
			const fitted = items?.type === "string" && typeof item === "string" ? cutString(item, items.max ?? 256) : item;
			if (encodedBytes([...kept, fitted]) > max) break;
			kept.push(fitted);
		}
		return kept;
	}
	return value;
}

/** Whether a value can be written to a knob: the declared type, enum and range. */
export function validateKnobValue(decl: CellDecl, value: unknown): string | undefined {
	if (!matchesType(value, decl as unknown as FieldSchema)) {
		return decl.type === "enum" ? `value must be one of: ${decl.enum?.join(", ")}` : `value must be a ${decl.type}`;
	}
	if (decl.range && typeof value === "number" && (value < decl.range[0] || value > decl.range[1])) {
		return `value must be within ${decl.range[0]} and ${decl.range[1]}`;
	}
	return undefined;
}
