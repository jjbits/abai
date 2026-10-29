// abaikit's own abaigram, built once for a run of the binary, whichever verb
// runs (section 13: main hands control to the harness at once), with every
// capability bound: learnabai, new, check and the repo.* set. Its in-process
// harness is attached through a factory whose options a verb may set before
// attaching, which is how abaify gives its agent auto consent and its own
// channel; the harness package is loaded only when an attach happens.
import type { Abaigram } from "abai";
import type { Embedded, EmbeddedOptions } from "abai-embedded-harness";
import { createAbaikit } from "./abaigram.ts";
import { checkHandler } from "./check.ts";
import type { AbaikitIo } from "./io.ts";
import { learnabaiHandler } from "./learnabai.ts";
import { newHandler } from "./new.ts";
import { type Change, type RepoContext, repoHandlers } from "./repo.ts";

export interface Embedding {
	/** What the next attach passes to `attachEmbedded`, beyond the environment. */
	options: EmbeddedOptions;
	/** The harness and form of the current attach, once there is one. */
	current: Embedded | undefined;
}

export interface AbaikitApp {
	app: Abaigram;
	embedding: Embedding;
	/** Every change the repo.* capabilities made in this process, for a report. */
	changes: Change[];
	repo: RepoContext;
}

export function createApp(io: AbaikitIo): AbaikitApp {
	const embedding: Embedding = { options: {}, current: undefined };
	const changes: Change[] = [];
	const app = createAbaikit(
		{ learnabai: learnabaiHandler, new: newHandler(io) },
		{
			env: io.env,
			harness: async (binding) => {
				const { attachEmbedded } = await import("abai-embedded-harness");
				embedding.current = await attachEmbedded(binding, { env: io.env, ...embedding.options });
			},
		},
	);
	// check and the repo.* capabilities report into the abaigram itself, so they are bound after it exists
	app.capability("check", checkHandler(app, io));
	const repo: RepoContext = { cwd: io.cwd, env: io.env, app, changes, created: new Set() };
	for (const [name, handler] of Object.entries(repoHandlers(repo))) app.capability(name, handler);
	return { app, embedding, changes, repo };
}
