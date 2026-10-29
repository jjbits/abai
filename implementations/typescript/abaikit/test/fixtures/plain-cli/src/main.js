#!/usr/bin/env node
// plain-cli: a small Node program with no abai in it, the repository a
// retrofit starts from. It processes a number of items and says how many.
const arg = process.argv[2];
const count = arg === undefined ? 3 : Number(arg);
if (!Number.isInteger(count) || count < 0) {
	console.error(`plain-cli: not a count: ${arg}`);
	process.exit(2);
}
console.log(`plain-cli: ${count} items processed`);
process.exit(0);
