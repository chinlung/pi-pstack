/**
 * pi-pstack: the pstack engineering workflow, packaged for Pi.
 *
 * Upstream pstack is a Cursor plugin of Markdown skills. Pi runs the same skills, but two
 * things need a runtime:
 *
 * 1. The two pstack agents (`poteto-agent`, `comment-sicko`) become pi-subagents runtime
 *    agents, so a delegate can be spawned with `subagent({ agent: "poteto-agent" })`.
 * 2. The per-role model map that upstream keeps in an always-applied Cursor rule becomes a JSON
 *    file in the Pi agent directory, managed by the `/pstack-setup` command.
 *
 * The skills themselves are plain Pi skills and need no runtime at all.
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerRuntimeAgent, type RuntimeRegistration } from "./runtime-agents.ts";
import { modelChoices, nearestAtOrBelow, resolveRoleMap, usableModels, type CatalogModel } from "./models.ts";
import { defaultRoleMap, mergeRoleMaps, readRoleMap, writeRoleMap } from "./store.ts";
import {
	BUDGET_EFFORT,
	EFFORT_LADDER,
	familyOf,
	isAtOrBelowBudget,
	strongestDeclaredLevel,
	type Effort,
	type RoleMap,
	type RoleValue,
} from "./roles.ts";
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
/** The package root, so the skills directory can be located no matter how Pi loaded the package. */
const PACKAGE_ROOT = resolve(EXTENSION_DIR, "..");

/** Where the packaged skills live, relative to the package root. */
const SKILLS_DIR = join(PACKAGE_ROOT, "skills");

const BUDGETS = [
	{ label: "unlimited", detail: "max reasoning" },
	{ label: "large", detail: "xhigh reasoning" },
	{ label: "medium", detail: "high reasoning" },
	{ label: "small", detail: "medium reasoning" },
] as const;

/**
 * The prompt a `/poteto-mode` run starts from. The skill itself carries the full rules; this
 * only points the model at the right files so a fresh session does not have to rediscover them.
 */
const POTETO_PROMPT = [
	"Use the pstack workflow for this task.",
	"",
	"Read the `poteto-mode` skill in full before doing any work. It lists the non-negotiables, the principles, and the playbooks.",
	"Match the task to a playbook, open that playbook's file, and follow its steps in order.",
	"",
	"Task:",
].join("\n");

export default async function piPstack(pi: ExtensionAPI): Promise<void> {
	const registrations: RuntimeRegistration[] = [];

	/**
	 * Reports a command's output.
	 *
	 * `ctx.ui.notify` is a toast, and Pi's no-op UI context drops it entirely in a print or
	 * JSON run, so a command whose whole output is a report would print nothing. The text
	 * therefore also goes to stdout when the session has no UI, which is where a print run
	 * reads its result from.
	 */
	const report = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void => {
		ctx.ui.notify(message, level);
		if (!ctx.hasUI) {
			const stream = level === "error" ? process.stderr : process.stdout;
			stream.write(`${message}\n`);
		}
	};

	/**
	 * Registers pstack's agents with pi-subagents. The agent prompts are read from the package's
	 * `agents/` directory so a user can read and edit them like any other pstack file.
	 *
	 * Each agent is registered on its own, so one failure does not cost the other. A name
	 * collision or a renamed field fails loudly, and the message names the agent that failed.
	 */
	const registerAgents = async (): Promise<void> => {
		for (const registration of registrations.splice(0)) registration.dispose();

		const agents: Array<{
			name: string;
			description: string;
			tools: readonly string[];
		}> = [
			{
				name: "poteto-agent",
				description:
					"Delegate subagent for code-writing and helper tasks spawned during a /poteto-mode run. Reads the poteto-mode skill in full before any work.",
				tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
			},
			{
				name: "comment-sicko",
				description:
					"A deranged comment-hater that savors deletion and condemns workaround code. Reports only; never writes application code.",
				tools: ["read", "grep", "find", "ls", "contact_supervisor"],
			},
		];

		for (const agent of agents) {
			const prompt = await readAgentPrompt(agent.name);
			if (!prompt) continue;
			try {
				registrations.push(
					registerRuntimeAgent(pi, agent.name, {
						description: agent.description,
						systemPrompt: prompt,
						systemPromptMode: "replace",
						inheritProjectContext: true,
						inheritSkills: false,
						tools: [...agent.tools],
						defaultContext: "fresh",
					}),
				);
			} catch (error) {
				// One agent's failure must not cost the other, so the loop continues.
				console.error(
					`[pi-pstack] could not register ${agent.name}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	};

	// pi-subagents may load after this extension, so registration is retried on every session
	// start rather than only at load time.
	pi.on("session_start", async (_event, ctx) => {
		try {
			await registerAgents();
		} catch (error) {
			report(
				ctx,
				`pi-pstack: agents not registered: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	});

	/**
	 * `/poteto-mode` starts a pstack run. The argument is the task; with no argument the model
	 * asks what to work on, which matches upstream's "pick it from the / menu before you type
	 * your task" flow.
	 */
	pi.registerCommand("poteto-mode", {
		description: "Run a task with the pstack engineering workflow (reads the poteto-mode skill)",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				report(ctx, "poteto-mode: give a task, for example /poteto-mode fix the flaky upload test");
				return;
			}
			// The run has to start a turn. `sendUserMessage` does that when the agent is idle,
			// and a queued message does not, so the delivery is left unset. A queued delivery
			// would also leave the message waiting for a turn that never comes.
			if (!ctx.isIdle()) {
				report(ctx, "poteto-mode: the agent is busy. Wait for it to finish, then run the command again.", "warning");
				return;
			}
			pi.sendUserMessage(`${POTETO_PROMPT}\n${task}`);
		},
	});

	/**
	 * `/setup-pstack` picks the per-role models. It shows the models Pi can actually launch,
	 * asks for a reasoning budget, and writes the role map to the Pi agent directory.
	 *
	 * The name matches upstream pstack's command, so the skills that tell a model to run
	 * `/setup-pstack` name a command that exists.
	 */
	pi.registerCommand("setup-pstack", {
		description: "Choose which model pstack uses per role, and at what reasoning budget",
		handler: async (args, ctx) => {
			await runSetup(ctx, args.trim(), report);
		},
	});

	/**
	 * `/pstack-models` shows the current role map and which roles resolve to a usable model.
	 * It is the read-only half of setup, and the way to check a stale map after a model change.
	 */
	pi.registerCommand("pstack-models", {
		description: "Show the current pstack role-to-model map and which roles resolve",
		handler: async (_args, ctx) => {
			const map = await loadRoleMap(ctx);
			const lines = formatRoleMap(ctx, map);
			report(ctx, lines.join("\n"));
		},
	});
}

/** Reads an agent prompt from the package's `agents/` directory. */
async function readAgentPrompt(name: string): Promise<string | undefined> {
	try {
		const raw = await readFile(join(PACKAGE_ROOT, "agents", `${name}.md`), "utf8");
		const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "");
		return body.trim() === "" ? undefined : body.trim();
	} catch {
		return undefined;
	}
}

/**
 * The role map in force for this session: the stored one when it parses, otherwise a default
 * map resolved against the models this session can launch.
 */
async function loadRoleMap(ctx: ExtensionContext): Promise<RoleMap> {
	const stored = await readRoleMap();
	if (stored) return stored;
	return defaultRoleMap((value, budget, role, index) => resolveDefault(ctx, value, budget, role, index), "large");
}

/** Formats the role map for display, marking roles that do not resolve to a usable model. */
function formatRoleMap(ctx: ExtensionContext, map: RoleMap): string[] {
	const resolved = resolveRoleMap(ctx, map);
	const lines = [`budget: ${map.budget}`, ""];
	// A panel role contributes one line per entry. Group them so the role name appears once
	// and the list reads as the list it is.
	const byRole = new Map<string, string[]>();
	for (const entry of resolved) {
		const existing = byRole.get(entry.role) ?? [];
		if (entry.alias) {
			existing.push("parent model");
		} else if (!entry.resolved) {
			existing.push(`needs a choice (${entry.note})`);
		} else {
			// A model that offers no level at or below the budget runs above it. Say so,
			// because the extra reasoning is a cost the user did not ask for.
			existing.push(entry.overBudget ? `${entry.model} (above budget)` : (entry.model ?? ""));
		}
		byRole.set(entry.role, existing);
	}
	for (const [role, values] of byRole) {
		lines.push(values.length === 1 ? `${role}: ${values[0]}` : `${role}: ${values.join(", ")}`);
	}
	return lines;
}

/**
 * The setup flow. It asks for a budget, shows the detected models, and writes the role map.
 * Every model written is one Pi can launch, so the map never names a slug that fails at spawn
 * time.
 */
async function runSetup(
	ctx: ExtensionContext,
	requestedBudget: string,
	report: (ctx: ExtensionContext, message: string, level?: "info" | "warning" | "error") => void,
): Promise<void> {
	const models = modelChoices(ctx);
	if (models.length === 0) {
		report(ctx, "setup-pstack: no models with working credentials were found", "error");
		return;
	}
	const stored = await readRoleMap();
	const current = stored ?? (await loadRoleMap(ctx));

	const budget = await pickBudget(ctx, requestedBudget, current.budget);
	if (!budget) {
		report(ctx, "setup-pstack: cancelled");
		return;
	}

	// Rebuild the map at the chosen budget. Each upstream default keeps its family when the
	// exact slug is unavailable, so a machine without Grok still gets a code model.
	const resolvedMap = defaultRoleMap((value, label, role, index) => resolveDefault(ctx, value, label, role, index), budget);

	// A role the user chose by hand wins over the resolved default, so a re-run of setup
	// changes the budget without discarding their choices. A stored role naming a model the
	// session can no longer launch is dropped, because it would fail at spawn time.
	const usableIds = new Set(usableModels(ctx).map((model) => model.id));
	const map = mergeRoleMaps(resolvedMap, stored, (modelId) => usableIds.has(modelId));

	const resolved = resolveRoleMap(ctx, map);
	const unresolved = resolved.filter((entry) => !entry.resolved && !entry.alias);
	if (unresolved.length > 0) {
		const names = unresolved.map((entry) => `${entry.role} (${entry.note})`).join(", ");
		report(ctx, `setup-pstack: these roles need a choice: ${names}`, "warning");
	}

	const preview = formatRoleMap(ctx, map);
	report(ctx, preview.join("\n"));
	await writeRoleMap(map);
	report(ctx, `setup-pstack: wrote the role map for budget ${budget}. It applies to new sessions.`);
}

/**
 * Resolves one upstream default slug against the models this session has. An exact match wins.
 * Otherwise the same family is used, at the highest effort that family offers at or below the
 * budget, so the budget actually caps the reasoning a role spends.
 *
 * Upstream's default slugs are Cursor-specific, so on a machine without them the role decides
 * which kind of model the work needs: a judgment role takes the strongest model, and a code
 * role takes a cheaper one. The distinction is upstream's own, and dropping it would make
 * every role cost the same.
 *
 * The index is the entry's position in a panel role. A panel compares models, so each entry
 * takes a different family where the machine has more than one. Two entries on the same model
 * would make the comparison worthless.
 */
function resolveDefault(
	ctx: ExtensionContext,
	value: RoleValue,
	budget: RoleMap["budget"],
	role: string,
	index: number,
): RoleValue | undefined {
	const usable = usableModels(ctx);
	if (usable.some((model) => model.id === value)) return value;
	const family = /^([a-z]+)/.exec(value)?.[1];
	if (family) {
		const sameFamily = usable.find((model) => model.id.startsWith(`${family}/`));
		if (sameFamily) {
			const near = nearestAtOrBelow(ctx, value, budget);
			if (near) return near;
			return sameFamily.id;
		}
	}

	// No family match. Group the usable models by family, then pick a family per panel entry
	// so a panel stays diverse.
	const byFamily = new Map<string, CatalogModel[]>();
	for (const model of usable) {
		const key = familyOf(model.id);
		byFamily.set(key, [...(byFamily.get(key) ?? []), model]);
	}
	const families = [...byFamily.keys()].sort();
	if (families.length === 0) return undefined;
	const preferred = families[index % families.length];
	const candidates = byFamily.get(preferred) ?? [];

	// A judgment role wants the strongest model available. A code role wants a capable model
	// that is not the most expensive one, because it runs for every edit.
	if (JUDGMENT_ROLES.has(role)) {
		return strongest(usable, budget) ?? strongest(candidates, budget);
	}
	return capable(candidates, budget) ?? capable(usable, budget);
}

/**
 * The roles that need the strongest model available.
 *
 * These are the roles that judge, decide, and explain, where a wrong answer costs more than
 * a slow one.
 */
const JUDGMENT_ROLES: ReadonlySet<string> = new Set([
	"judgment and prose",
	"hardest tasks",
	"how explainer",
	"why synthesizer",
	"reflect judgment, divergent, synthesizer",
	"arena cross-judge pool",
	"architect runners",
	"interrogate reviewers",
]);

/**
 * The strongest usable model at or below the budget.
 *
 * A model that declares no reasoning levels is ranked lowest, because a plain model cannot
 * do the reasoning-heavy work a pstack role is for. Cost breaks the tie between models that
 * offer the same reasoning level, because every model in a modern catalog offers the same
 * levels and the effort ladder alone cannot tell them apart.
 */
function strongest(models: readonly CatalogModel[], budget: RoleMap["budget"]): string | undefined {
	if (models.length === 0) return undefined;
	const target = BUDGET_EFFORT[budget] as Effort;
	let best: { id: string; index: number; cost: number } | undefined;
	for (const model of models) {
		// The strongest level the model declares, not the first one the provider listed. The
		// declared order is the provider's, and taking the first key ranks a model that
		// offers `max` below one that offers only `off`.
		const effort = strongestDeclaredLevel(model.thinkingLevels);
		if (!effort) continue;
		if (!isAtOrBelowBudget(effort, target)) continue;
		// The ladder runs from most to least reasoning, so a lower index means more reasoning.
		const index = EFFORT_LADDER.indexOf(effort);
		const cost = model.cost;
		if (!best || index < best.index || (index === best.index && cost > best.cost)) {
			best = { id: model.id, index, cost };
		}
	}
	return best?.id ?? models[0].id;
}

/**
 * A capable model that is not the most expensive one.
 *
 * A code role runs for every edit, so it wants a model that can do the work without costing
 * the most. The priciest model is reserved for the judgment roles.
 */
function capable(models: readonly CatalogModel[], budget: RoleMap["budget"]): string | undefined {
	if (models.length === 0) return undefined;
	const target = BUDGET_EFFORT[budget] as Effort;
	const eligible = models.filter((model) => {
		const effort = strongestDeclaredLevel(model.thinkingLevels);
		if (!effort) return false;
		return isAtOrBelowBudget(effort, target);
	});
	if (eligible.length === 0) return strongest(models, budget);
	// Take the median-priced eligible model. The cheapest is usually too weak for real work
	// and the priciest is what the judgment roles are for.
	const sorted = [...eligible].sort((a, b) => a.cost - b.cost);
	return sorted[Math.floor(sorted.length / 2)].id;
}

/**
 * Chooses a budget label. A label passed as the command argument is used directly. Otherwise
 * the user is asked, with the current budget named so the choice is informed. A session with
 * no dialog UI keeps the current budget.
 */
async function pickBudget(
	ctx: ExtensionContext,
	requested: string,
	current: RoleMap["budget"],
): Promise<RoleMap["budget"] | undefined> {
	const match = BUDGETS.find((entry) => entry.label === requested);
	if (match) return match.label;
	if (requested) return undefined;
	if (!ctx.hasUI) return current;
	const options = BUDGETS.map((entry) => `${entry.label} — ${entry.detail}`);
	const choice = await ctx.ui.select(`pstack reasoning budget (current: ${current})`, options);
	if (!choice) return undefined;
	return BUDGETS.find((entry) => choice.startsWith(entry.label))?.label;
}

export { SKILLS_DIR };
