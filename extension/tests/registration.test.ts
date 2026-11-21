/**
 * Tests for what the extension registers: the two runtime agents, the commands, and the tool.
 *
 * The extension is loaded against a fake `ExtensionAPI` that records every registration and
 * answers pi-subagents' registration event, so the test sees the exact definitions a real
 * session would send.
 *
 * Run it with:
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { useAgentDir } from "./agent-dir.ts";
import { dirname, join } from "node:path";
import { ROLES } from "../roles.ts";
import { registerAgent } from "pi-subagents/agents";
import { test, type TestContext } from "node:test";
import piPstack from "../index.ts";
import { registerRuntimeAgent } from "../runtime-agents.ts";

const RUNTIME_REGISTER_EVENT = "pi-subagents:runtime-agent-register:v1";

interface Recorded {
	agents: Map<string, Record<string, unknown>>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	tools: Map<string, Record<string, unknown>>;
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	sent: Array<{ content: unknown; options: unknown }>;
}

async function load(): Promise<Recorded> {
	const recorded: Recorded = { agents: new Map(), commands: new Map(), tools: new Map(), handlers: new Map(), sent: [] };
	const pi = {
		events: {
			emit(event: string, request: { name: string; definition: Record<string, unknown>; result?: unknown }) {
				if (event !== RUNTIME_REGISTER_EVENT) return;
				recorded.agents.set(request.name, request.definition);
				request.result = { ok: true, registration: { dispose() {} } };
			},
			on() {
				return () => {};
			},
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			recorded.handlers.set(event, [...(recorded.handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			recorded.commands.set(name, options);
		},
		registerTool(tool: Record<string, unknown>) {
			recorded.tools.set(tool.name as string, tool);
		},
		sendUserMessage(content: unknown, options: unknown) {
			recorded.sent.push({ content, options });
		},
	};
	await piPstack(pi as never);
	const ctx = { hasUI: true, ui: { notify() {} } };
	for (const handler of recorded.handlers.get("session_start") ?? []) await handler({}, ctx);
	return recorded;
}

test("both agents register with the absolute paths of the skills they read", async () => {
	const { agents } = await load();
	assert.deepEqual([...agents.keys()], ["poteto-agent", "comment-sicko"]);
	const expected: Record<string, string[]> = { "poteto-agent": ["poteto-mode"], "comment-sicko": ["how", "why"] };
	for (const [name, definition] of agents) {
		const prompt = definition.systemPrompt as string;
		for (const skill of expected[name]) {
			const path = new RegExp(`\`${skill}\` skill: (\\S+/skills/${skill}/SKILL\\.md)`).exec(prompt)?.[1];
			assert.ok(path, `${name} names the ${skill} skill's path`);
			assert.ok(existsSync(path), `${path} exists`);
		}
	}
});

test("both agents can fan out, and only poteto-agent runs in the background by default", async () => {
	const { agents } = await load();
	for (const definition of agents.values()) {
		assert.equal(definition.allowNestedSubagents, true);
		assert.equal(definition.systemPromptMode, "replace");
		assert.equal(definition.inheritSkills, false);
	}
	assert.equal(agents.get("poteto-agent")?.defaultAsync, true);
	assert.equal(agents.get("comment-sicko")?.defaultAsync, false);
	// comment-sicko reports and never edits.
	assert.deepEqual(
		(agents.get("comment-sicko")?.tools as string[]).filter((tool) => ["edit", "write", "bash"].includes(tool)),
		[],
	);
});

test("the agent prompts name no Cursor-only feature", async () => {
	const { agents } = await load();
	for (const [name, definition] of agents) {
		const prompt = definition.systemPrompt as string;
		assert.doesNotMatch(prompt, /\.cursor|subagent_type|`Task`|\bCursor\b/, name);
	}
});

test("the package manifest declares no agent files that would collide with the runtime agents", () => {
	const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
	assert.equal(manifest.pi?.subagents, undefined);
	assert.equal(manifest["pi-subagents"], undefined);
});

test("the extension registers its commands and its read-only tool", async () => {
	const { commands, tools } = await load();
	const names = [...commands.keys()];
	for (const own of ["poteto-mode", "pstack-models", "setup-pstack"]) assert.ok(names.includes(own), own);
	// Upstream's examples type these short forms.
	for (const alias of ["how", "tdd", "automate-me", "poteto-help"]) assert.ok(names.includes(alias), alias);
	assert.ok(!names.some((name) => name.startsWith("principle-")));
	const tool = tools.get("pstack_models");
	assert.ok(tool?.outputSchema, "pstack_models declares an output schema");
	assert.deepEqual(tool?.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
});

test("/poteto-mode expands the hidden skill through /skill:", async () => {
	const { commands, sent } = await load();
	await commands.get("poteto-mode")?.handler("fix the flaky test", { hasUI: true, isIdle: () => true, ui: { notify() {} } });
	assert.deepEqual(sent, [{ content: "/skill:poteto-mode fix the flaky test", options: { expandPromptTemplates: true } }]);
});

test("/poteto-mode does not queue a run while the agent is busy", async () => {
	const { commands, sent } = await load();
	await commands.get("poteto-mode")?.handler("fix it", { hasUI: true, isIdle: () => false, ui: { notify() {} } });
	assert.deepEqual(sent, []);
});

test("registration fails loudly when pi-subagents is absent", () => {
	assert.throws(
		() => registerRuntimeAgent({ events: { emit() {} } }, "poteto-agent", { description: "x", systemPrompt: "y" }),
		/pi-subagents is not installed or not ready/,
	);
});

test("pi-subagents' real registry accepts both agent definitions", async () => {
	const { agents } = await load();
	const host = { on() {}, registerTool() {} };
	for (const [name, definition] of agents) {
		const registration = registerAgent({ pi: host as never, name, definition: definition as never });
		registration.dispose();
	}
});

test("pstack_models returns one parent seat per seat for a panel role missing from the map", async (t) => {
	useAgentDir(t);
	const { tools } = await load();
	const tool = tools.get("pstack_models") as { execute: (...args: unknown[]) => Promise<{ structuredContent: { roles: Array<{ role: string; seats: unknown[] }> } }> };
	const ctx = { scopedModels: [], modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => false } };
	const result = await tool.execute("id", { role: "arena runners" }, undefined, undefined, ctx);
	assert.deepEqual(result.structuredContent.roles, [{ role: "arena runners", seats: [{ kind: "parent" }, { kind: "parent" }] }]);
	await assert.rejects(tool.execute("id", { role: "no such role" }, undefined, undefined, ctx), /unknown pstack role/);
});

test("a skill alias sends the long form, with and without arguments", async () => {
	const { commands, sent } = await load();
	const ctx = { hasUI: true, isIdle: () => true, ui: { notify() {} } };
	await commands.get("how")?.handler("does the cache expire?", ctx);
	await commands.get("poteto-help")?.handler("", ctx);
	assert.deepEqual(
		sent.map((message) => message.content),
		["/skill:how does the cache expire?", "/skill:poteto-help"],
	);
});

test("pstack_models without a role returns every role, parents included, and carries warnings in its text", async (t) => {
	useAgentDir(t);
	const { tools } = await load();
	const tool = tools.get("pstack_models") as { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; structuredContent: { roles: Array<{ role: string; seats: unknown[] }> } }> };
	const ctx = { scopedModels: [], modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => false } };
	const result = await tool.execute("id", {}, undefined, undefined, ctx);
	assert.equal(result.structuredContent.roles.length, 17);
	assert.deepEqual(result.structuredContent.roles.find((entry) => entry.role === "interrogate reviewers")?.seats, [{ kind: "parent" }, { kind: "parent" }]);
	assert.match(result.content[0].text, /interrogate reviewers: parent model, parent model/);
});

test("a skill alias does not queue a run while the agent is busy", async () => {
	const { commands, sent } = await load();
	await commands.get("how")?.handler("why?", { hasUI: true, isIdle: () => false, ui: { notify() {} } });
	assert.deepEqual(sent, []);
});

function writeStoredMap(t: TestContext, map: unknown): void {
	const dir = useAgentDir(t);
	const file = join(dir, "state", "pi-pstack", "models.json");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(map));
}

test("pstack_models puts store warnings in the text the model reads", async (t) => {
	writeStoredMap(t, { budget: "large", roles: { "no such role": "inherit-parent" } });
	const { tools } = await load();
	const tool = tools.get("pstack_models") as { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; structuredContent: { warnings: string[] } }> };
	const ctx = { scopedModels: [], modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => false } };
	const result = await tool.execute("id", {}, undefined, undefined, ctx);
	assert.equal(result.structuredContent.warnings.length, 1);
	assert.match(result.content[0].text, /^warning: dropped retired role "no such role"/);
});

test("/setup-pstack reports a stored :level suffix as ignored", async (t) => {
	writeStoredMap(t, { budget: "large", roles: { [ROLES[0].name]: "openai/gpt-x:xhigh" } });
	const { commands } = await load();
	const notes: Array<{ message: string; level: string }> = [];
	const hostModel = { provider: "openai", id: "gpt-x", reasoning: true, thinkingLevels: ["high", "xhigh"], cost: { input: 1, output: 1 } };
	const ctx = {
		hasUI: false,
		ui: { notify: (message: string, level: string) => notes.push({ message, level }) },
		scopedModels: [{ model: hostModel }],
		modelRegistry: { getAvailable: () => [hostModel], hasConfiguredAuth: () => true },
	};
	const stderr = process.stderr.write.bind(process.stderr);
	process.stderr.write = (() => true) as never;
	try {
		await commands.get("setup-pstack")?.handler("", ctx);
	} finally {
		process.stderr.write = stderr;
	}
	assert.ok(notes.some((note) => note.level === "warning" && /:xhigh suffix is ignored/.test(note.message)), JSON.stringify(notes));
});

test("/setup-pstack refuses a stale save and a retry keeps both sessions' choices", { timeout: 5000 }, async (t) => {
	const dir = useAgentDir(t);
	const path = join(dir, "state", "pi-pstack", "models.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({
		budget: "large",
		roles: { "bug-fix": "inherit-parent", "perf-issue": "inherit-parent" },
	}));
	const { commands } = await load();
	const setup = commands.get("setup-pstack")!.handler;
	const models = ["gpt-first", "gpt-second"].map((id) => ({
		provider: "openai", id, reasoning: true, thinkingLevels: ["high", "xhigh"], cost: { input: 1, output: 1 },
	}));
	function deferred() {
		let resolve!: () => void;
		const promise = new Promise<void>((done) => { resolve = done; });
		return { promise, resolve };
	}
	const reached = deferred();
	const resume = deferred();
	function session(role: string, choice: string, pause?: () => Promise<void>) {
		let selecting = true;
		const notes: Array<{ message: string; level: string }> = [];
		return {
			notes,
			context: {
				hasUI: true,
				scopedModels: models.map((model) => ({ model })),
				modelRegistry: { getAvailable: () => models, hasConfiguredAuth: () => true },
				ui: {
					notify: (message: string, level: string) => notes.push({ message, level }),
					async select(title: string, options: string[]) {
						if (title === "Which role?") return options.find((value) => value.startsWith(role + ":"));
						if (title === role) return choice;
						assert.equal(title, "pstack roles");
						if (selecting) {
							selecting = false;
							return "Change a role";
						}
						await pause?.();
						return "Accept and write the role map";
					},
				},
			},
		};
	}
	const first = session("bug-fix", "openai/gpt-first", () => {
		reached.resolve();
		return resume.promise;
	});
	const second = session("perf-issue", "openai/gpt-second");
	const stale = setup("large", first.context);
	try {
		await Promise.race([reached.promise, stale.then(() => { throw new Error("first setup did not reach confirmation"); })]);
		await setup("large", second.context);
	} finally {
		resume.resolve();
		await stale;
	}
	const stored = () => JSON.parse(readFileSync(path, "utf8")).roles;
	assert.equal(stored()["perf-issue"].value, "openai/gpt-second");
	assert.equal(stored()["bug-fix"].value, "inherit-parent");
	assert.ok(first.notes.some(({ level, message }) => level === "warning" && /run \/setup-pstack again/i.test(message)));
	assert.ok(first.notes.some(({ message }) => /source: proposed/.test(message)));
	assert.ok(!first.notes.some(({ message }) => /wrote the role map|source: stored/i.test(message)));
	assert.ok(second.notes.some(({ message }) => /wrote the role map/i.test(message)));

	const retry = session("bug-fix", "openai/gpt-first");
	await setup("large", retry.context);
	assert.equal(stored()["bug-fix"].value, "openai/gpt-first");
	assert.equal(stored()["perf-issue"].value, "openai/gpt-second");
	assert.ok(retry.notes.some(({ message }) => /wrote the role map/i.test(message)));
});
