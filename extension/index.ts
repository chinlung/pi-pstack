/**
 * pi-pstack: the pstack engineering workflow, packaged for Pi.
 *
 * The skills are plain Pi skills. The runtime adds what they cannot carry themselves:
 *
 * 1. `poteto-agent` and `comment-sicko` as pi-subagents runtime agents, with the absolute paths
 *    of the skills they must read, because those skills are hidden from the skill list.
 * 2. The per-role model map that upstream keeps in an always-applied Cursor rule, managed by
 *    `/setup-pstack`, shown by `/pstack-models`, and readable by the model through the
 *    `pstack_models` tool.
 * 3. `/poteto-mode <task>`, a shortcut for `/skill:poteto-mode <task>`.
 */
import { readFile } from "node:fs/promises";
import { readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerRuntimeAgent, type RuntimeRegistration } from "./runtime-agents.ts";
import { completeRoles, defaultRoleMap, detectModels, normalizeEntry, resolveRoleMap, resolveValue, type CatalogModel, type ResolvedRole, type ResolvedSeat } from "./models.ts";
import { mergeRoleMaps, readRoleMap, writeRoleMap } from "./store.ts";
import { BUDGET_EFFORT, BUDGETS, isBudget, ROLES, seatsOf, type BudgetLabel, type RoleEntry, type RoleMap } from "./roles.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = join(PACKAGE_ROOT, "skills");
const skillPath = (name: string): string => join(SKILLS_DIR, name, "SKILL.md");

const BUDGET_DETAIL: Readonly<Record<BudgetLabel, string>> = {
	unlimited: "max reasoning",
	large: "xhigh reasoning",
	medium: "high reasoning",
	small: "medium reasoning",
};

/** Where a role map came from: the user's stored file, or defaults built from detected models. */
type MapSource = "stored" | "default";

interface LoadedMap {
	readonly map: RoleMap;
	readonly source: MapSource;
	readonly warnings: readonly string[];
}

/** The agents this package registers, with the skills each one's prompt names. */
const AGENTS = [
	{
		name: "poteto-agent",
		description:
			"Delegate subagent for code-writing and helper tasks spawned during a /poteto-mode run. Reads the poteto-mode skill in full before any work.",
		tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
		skills: ["poteto-mode"],
		// Upstream marks it `is_background: true`.
		defaultAsync: true,
	},
	{
		name: "comment-sicko",
		description:
			"A deranged comment-hater that savors deletion and condemns workaround code. Reports only; never writes application code.",
		tools: ["read", "grep", "find", "ls", "contact_supervisor"],
		skills: ["how", "why"],
		defaultAsync: false,
	},
] as const;

export default async function piPstack(pi: ExtensionAPI): Promise<void> {
	const registrations: RuntimeRegistration[] = [];

	/**
	 * Reports a command's output. `ctx.ui.notify` is a toast, and Pi's no-op UI context drops it
	 * in a print or JSON run. Without UI the text goes to stderr: in print mode Pi redirects
	 * `process.stdout` to stderr anyway and keeps stdout for the model's final reply, and in JSON
	 * mode stdout carries the event stream, which raw text would corrupt.
	 */
	const report = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void => {
		ctx.ui.notify(message, level);
		if (!ctx.hasUI) process.stderr.write(`${message}\n`);
	};

	/**
	 * Registers pstack's agents. Each prompt starts with the absolute paths of the skills it
	 * reads, because those skills are hidden from the skill list and a child does not inherit
	 * hidden skills. Each agent is registered on its own, so one failure does not cost the other.
	 */
	const registerAgents = async (): Promise<string[]> => {
		for (const registration of registrations.splice(0)) registration.dispose();
		const failures: string[] = [];
		for (const agent of AGENTS) {
			const prompt = await readAgentPrompt(agent.name);
			if (!prompt) {
				failures.push(`${agent.name}: agents/${agent.name}.md is missing or empty`);
				continue;
			}
			const paths = agent.skills.map((skill) => `- the \`${skill}\` skill: ${skillPath(skill)}`).join("\n");
			try {
				registrations.push(
					registerRuntimeAgent(pi, agent.name, {
						description: agent.description,
						systemPrompt: `These pstack skills are hidden from your skill list. Read them by path:\n${paths}\n\n${prompt}`,
						systemPromptMode: "replace",
						inheritProjectContext: true,
						inheritSkills: false,
						tools: [...agent.tools],
						allowNestedSubagents: true,
						defaultAsync: agent.defaultAsync,
						defaultContext: "fresh",
					}),
				);
			} catch (error) {
				failures.push(`${agent.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return failures;
	};

	// pi-subagents may load after this extension, so registration runs at every session start.
	pi.on("session_start", async (_event, ctx) => {
		const failures = await registerAgents();
		if (failures.length > 0) report(ctx, `pi-pstack: agents not registered: ${failures.join("; ")}`, "warning");
	});

	pi.on("session_shutdown", () => {
		for (const registration of registrations.splice(0)) registration.dispose();
	});

	/**
	 * `/poteto-mode <task>` sends `/skill:poteto-mode <task>`. Pi expands that into the skill's
	 * full text with its absolute location, which a plain "read the poteto-mode skill" cannot do:
	 * the skill is hidden from the model's skill list.
	 */
	pi.registerCommand("poteto-mode", {
		description: "Run a task with the pstack engineering workflow (expands the poteto-mode skill)",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				report(ctx, "poteto-mode: give a task, for example /poteto-mode fix the flaky upload test");
				return;
			}
			if (!ctx.isIdle()) {
				report(ctx, "poteto-mode: the agent is busy. Wait for it to finish, then run the command again.", "warning");
				return;
			}
			pi.sendUserMessage(`/skill:poteto-mode ${task}`, { expandPromptTemplates: true });
		},
	});

	// Upstream's examples type `/how`, `/tdd` and the like. Pi expands only `/skill:<name>`, so each
	// skill gets a command of its own name that sends the long form. Principles stay long-form.
	for (const name of listAliasSkills()) {
		pi.registerCommand(name, {
			description: `Run the ${name} skill (same as /skill:${name})`,
			handler: async (args, ctx) => {
				if (!ctx.isIdle()) {
					report(ctx, `${name}: the agent is busy. Wait for it to finish, then run the command again.`, "warning");
					return;
				}
				const task = args.trim();
				pi.sendUserMessage(task ? `/skill:${name} ${task}` : `/skill:${name}`, { expandPromptTemplates: true });
			},
		});
	}

	pi.registerCommand("setup-pstack", {
		description: "Choose which model pstack uses per role, and at what reasoning budget",
		getArgumentCompletions: (prefix) =>
			BUDGETS.filter((budget) => budget.startsWith(prefix)).map((budget) => ({ value: budget, label: `${budget} — ${BUDGET_DETAIL[budget]}` })),
		handler: async (args, ctx) => {
			await runSetup(ctx, args.trim(), report);
		},
	});

	pi.registerCommand("pstack-models", {
		description: "Show the pstack role-to-model map, resolved against the models this session can launch",
		handler: async (_args, ctx) => {
			const models = detectModels(ctx);
			const loaded = await loadRoleMap(models);
			for (const warning of loaded.warnings) report(ctx, `pstack-models: ${warning}`, "warning");
			report(ctx, formatRoleMap(loaded, completeRoles(resolveRoleMap(models, loaded.map))).join("\n"));
		},
	});

	pi.registerTool({
		name: "pstack_models",
		label: "pstack models",
		description:
			"Resolve the model a pstack role should run on. Returns the budget, whether the map is the user's stored map or defaults, and per seat either a `model` spec to pass to the subagent tool (budget level applied), `parent` (omit `model`), or `unresolved`. Omit `role` to get every role.",
		promptSnippet: "Resolve the model for a pstack role (pstack_models)",
		parameters: Type.Object({
			role: Type.Optional(Type.String({ description: "A pstack role name, such as `bug-fix` or `interrogate reviewers`" })),
		}),
		outputSchema: Type.Object({
			budget: Type.String(),
			level: Type.String(),
			source: Type.String(),
			roles: Type.Array(Type.Object({ role: Type.String(), seats: Type.Array(Type.Unknown()) })),
			warnings: Type.Array(Type.String()),
		}),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const models = detectModels(ctx);
			const loaded = await loadRoleMap(models);
			// A role missing from the map has no stored or default model, so it gets parent seats.
			let roles = completeRoles(resolveRoleMap(models, loaded.map));
			if (params.role !== undefined) {
				if (!ROLES.some((role) => role.name === params.role)) {
					const names = ROLES.map((role) => role.name).join(", ");
					throw new Error(`unknown pstack role "${params.role}". Roles: ${names}`);
				}
				roles = roles.filter((entry) => entry.role === params.role);
			}
			const result = {
				budget: loaded.map.budget,
				level: BUDGET_EFFORT[loaded.map.budget],
				source: loaded.source,
				roles: roles.map((entry) => ({ role: entry.role, seats: entry.seats.map(describeSeat) })),
				warnings: [...loaded.warnings],
			};
			return {
				content: [{ type: "text", text: [...loaded.warnings.map((warning) => `warning: ${warning}`), ...formatRoleMap(loaded, roles)].join("\n") }],
				details: undefined,
				structuredContent: result,
			};
		},
	});
}

/** The skills that get a short command: every skill but the principles and the three real commands. */
function listAliasSkills(): string[] {
	const own = new Set(["poteto-mode", "setup-pstack", "pstack-models"]);
	return readdirSync(SKILLS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("principle-") && !own.has(entry.name))
		.filter((entry) => existsSync(skillPath(entry.name)))
		.map((entry) => entry.name)
		.sort();
}

/** A seat as plain JSON for the tool's structured result. */
function describeSeat(seat: ResolvedSeat): Record<string, string | boolean> {
	if (seat.kind === "parent") return { kind: "parent" };
	if (seat.kind === "unresolved") return { kind: "unresolved", value: seat.value };
	return {
		kind: "model",
		model: seat.spec,
		aboveBudget: seat.aboveBudget,
		...(seat.strippedSuffix ? { strippedSuffix: seat.strippedSuffix } : {}),
	};
}

/** Reads an agent prompt from the package's `agents/` directory, without its frontmatter. */
async function readAgentPrompt(name: string): Promise<string | undefined> {
	try {
		const raw = await readFile(join(PACKAGE_ROOT, "agents", `${name}.md`), "utf8");
		const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
		return body === "" ? undefined : body;
	} catch {
		return undefined;
	}
}

/**
 * The role map in force: the stored one when it parses, otherwise defaults built from the
 * detected models at the `large` budget, which matches upstream's defaults.
 */
async function loadRoleMap(models: readonly CatalogModel[]): Promise<LoadedMap> {
	const stored = await readRoleMap();
	if (stored.map) return { map: stored.map, source: "stored", warnings: stored.warnings };
	return { map: defaultRoleMap(models, "large"), source: "default", warnings: stored.warnings };
}

function formatSeat(seat: ResolvedSeat): string {
	if (seat.kind === "parent") return "parent model";
	if (seat.kind === "unresolved") return `needs a choice (${seat.value} is not a model this session can launch)`;
	const notes = [seat.aboveBudget ? "above budget" : "", seat.strippedSuffix ? `ignored :${seat.strippedSuffix}` : ""].filter(Boolean);
	return notes.length > 0 ? `${seat.spec} (${notes.join(", ")})` : seat.spec;
}

/** Formats a resolved map, one line per role. A role missing from the map runs on the parent. */
function formatRoleMap(loaded: LoadedMap, resolved: readonly ResolvedRole[]): string[] {
	const lines = [`budget: ${loaded.map.budget} (${BUDGET_DETAIL[loaded.map.budget]}), source: ${loaded.source}`, ""];
	for (const entry of resolved) lines.push(`${entry.role}: ${entry.seats.map(formatSeat).join(", ")}`);
	return lines;
}

/**
 * The setup flow: pick a budget, build the map, keep the user's earlier choices, let the user
 * confirm or change roles, and write the map. Every model written is one the session can launch.
 */
async function runSetup(
	ctx: ExtensionContext,
	requested: string,
	report: (ctx: ExtensionContext, message: string, level?: "info" | "warning" | "error") => void,
): Promise<void> {
	if (requested !== "" && !isBudget(requested)) {
		report(ctx, `setup-pstack: "${requested}" is not a budget. Use one of: ${BUDGETS.join(", ")}.`, "error");
		return;
	}
	const models = detectModels(ctx);
	if (models.length === 0) {
		report(ctx, "setup-pstack: no models with working credentials were found", "error");
		return;
	}
	const stored = await readRoleMap();
	for (const warning of stored.warnings) report(ctx, `setup-pstack: ${warning}`, "warning");

	for (const [role, entry] of Object.entries(stored.map?.roles ?? {})) {
		for (const value of seatsOf(entry)) {
			const resolved = resolveValue(models, value);
			if (resolved.kind === "model" && resolved.strippedSuffix) {
				report(ctx, `setup-pstack: "${role}" named ${value}; the :${resolved.strippedSuffix} suffix is ignored because the budget sets the level`, "warning");
			}
		}
	}

	const budget = isBudget(requested) ? requested : await askBudget(ctx, stored.map?.budget ?? "large");
	if (!budget) {
		report(ctx, "setup-pstack: cancelled");
		return;
	}

	const merged = mergeRoleMaps(defaultRoleMap(models, budget), stored.map, (entry) => normalizeEntry(models, entry));
	for (const role of merged.replaced) {
		report(ctx, `setup-pstack: "${role}" named a model this session cannot launch; it was re-resolved`, "warning");
	}
	let map = merged.map;
	if (ctx.hasUI) {
		const confirmed = await confirmRoles(ctx, models, map);
		if (!confirmed) {
			report(ctx, "setup-pstack: cancelled; the role map was not changed");
			return;
		}
		map = confirmed;
	}

	report(ctx, formatRoleMap({ map, source: "stored", warnings: [] }, resolveRoleMap(models, map)).join("\n"));
	await writeRoleMap(map);
	report(ctx, `setup-pstack: wrote the role map for budget ${budget}. It applies to new subagent launches.`);
}

async function askBudget(ctx: ExtensionContext, current: BudgetLabel): Promise<BudgetLabel | undefined> {
	// A session without dialog UI cannot answer, so the current budget stands.
	if (!ctx.hasUI) return current;
	const options = BUDGETS.map((budget) => `${budget} — ${BUDGET_DETAIL[budget]}`);
	const choice = await ctx.ui.select(`pstack reasoning budget (current: ${current})`, options);
	return BUDGETS.find((budget) => choice?.startsWith(`${budget} `));
}

const ACCEPT = "Accept and write the role map";
const CHANGE = "Change a role";
const CANCEL = "Cancel";
const PARENT = "inherit-parent (run on the parent chat model)";

/**
 * Shows the resolved roles and lets the user change any of them to a detected model or the
 * parent model, one seat at a time. Returns the confirmed map, or undefined when cancelled.
 */
async function confirmRoles(ctx: ExtensionContext, models: readonly CatalogModel[], start: RoleMap): Promise<RoleMap | undefined> {
	let map = start;
	for (;;) {
		const resolved = resolveRoleMap(models, map);
		ctx.ui.notify(formatRoleMap({ map, source: "stored", warnings: [] }, resolved).join("\n"), "info");
		const action = await ctx.ui.select("pstack roles", [ACCEPT, CHANGE, CANCEL]);
		if (action === ACCEPT) return map;
		if (action !== CHANGE) return undefined;

		const labels = ROLES.map((role) => {
			const entry = resolved.find((candidate) => candidate.role === role.name);
			return `${role.name}: ${entry ? entry.seats.map(formatSeat).join(", ") : "parent model"}`;
		});
		const picked = await ctx.ui.select("Which role?", labels);
		const role = ROLES[labels.indexOf(picked ?? "")];
		if (!role) continue;

		const seats: string[] = [];
		for (let seat = 0; seat < role.seats; seat++) {
			const title = role.seats > 1 ? `${role.name}, seat ${seat + 1} of ${role.seats}` : role.name;
			const choice = await ctx.ui.select(title, [PARENT, ...models.map((model) => model.id)]);
			if (choice === undefined) break;
			seats.push(choice === PARENT ? "inherit-parent" : choice);
		}
		if (seats.length !== role.seats) continue;
		const entry: RoleEntry = role.seats === 1 ? { value: seats[0] } : { value: seats };
		map = { budget: map.budget, roles: { ...map.roles, [role.name]: entry } };
	}
}
