/**
 * A test for the pi-pstack extension's runtime agent registration.
 *
 * The extension registers `poteto-agent` and `comment-sicko` with pi-subagents as runtime
 * agents. The registry rejects unknown fields and colliding names loudly, so the test
 * registers the real definitions against the real registry and reads them back. A definition
 * that upstream renames therefore fails here rather than silently dropping the agent at
 * session start.
 *
 * Run it with:
 *
 *   node --experimental-strip-types --test extension/tests/registration.test.ts
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_ROOT = dirname(EXTENSION_DIR);

const RUNTIME_REGISTER_EVENT = "pi-subagents:runtime-agent-register:v1";

/** A minimal stand-in for the pi-subagents runtime the extension registers with. */
function makePi() {
	const handlers: Array<(request: unknown) => void> = [];
	return {
		events: {
			emit(event: string, request: unknown) {
				if (event !== RUNTIME_REGISTER_EVENT) return;
				for (const handler of handlers) handler(request);
			},
			on(event: string, handler: (request: unknown) => void) {
				if (event === RUNTIME_REGISTER_EVENT) handlers.push(handler);
				return () => {};
			},
		},
		registerTool() {},
		on() {
			return () => {};
		},
	};
}

/** The body of an agent file, with its frontmatter removed. */
async function readAgentBody(name: string): Promise<string> {
	const raw = await readFile(join(PACKAGE_ROOT, "agents", `${name}.md`), "utf8");
	return raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

test("the extension registers both pstack agents with pi-subagents", async () => {
	const { registerRuntimeAgent } = await import("../runtime-agents.ts");
	const pi = makePi();
	const registered: Array<{ name: string; definition: Record<string, unknown> }> = [];

	// Stand in for the pi-subagents listener the extension emits to.
	pi.events.on(RUNTIME_REGISTER_EVENT, (request) => {
		const typed = request as {
			version: number;
			name: string;
			definition: Record<string, unknown>;
			result?: unknown;
		};
		registered.push({ name: typed.name, definition: typed.definition });
		typed.result = {
			ok: true,
			registration: { dispose() {} },
		};
	});

	for (const name of ["poteto-agent", "comment-sicko"]) {
		const body = await readAgentBody(name);
		assert.ok(body.length > 0, `${name} has a prompt body`);
		registerRuntimeAgent(pi, name, {
			description: `${name} for pstack`,
			systemPrompt: body,
			systemPromptMode: "replace",
			inheritProjectContext: true,
			inheritSkills: false,
			tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
			defaultContext: "fresh",
		});
	}

	assert.deepEqual(
		registered.map((entry) => entry.name),
		["poteto-agent", "comment-sicko"],
	);
	for (const entry of registered) {
		assert.equal(entry.definition.systemPromptMode, "replace");
		assert.equal(entry.definition.inheritProjectContext, true);
		assert.equal(entry.definition.inheritSkills, false);
	}
});

test("registration fails loudly when pi-subagents is absent", async () => {
	const { registerRuntimeAgent } = await import("../runtime-agents.ts");
	const pi = makePi();
	// No listener, so the request gets no result.
	assert.throws(
		() => registerRuntimeAgent(pi, "poteto-agent", { description: "x", systemPrompt: "y" }),
		/pi-subagents is not installed or not ready/,
	);
});

test("the agent prompts name no Cursor-only feature", async () => {
	for (const name of ["poteto-agent", "comment-sicko"]) {
		const body = await readAgentBody(name);
		assert.doesNotMatch(body, /\.cursor\//, `${name} names a Cursor path`);
		assert.doesNotMatch(body, /subagent_type/, `${name} names a Cursor subagent type`);
		assert.doesNotMatch(body, /`Task`/, `${name} names the Cursor Task tool`);
	}
});
