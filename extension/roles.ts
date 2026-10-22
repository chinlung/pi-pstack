/**
 * The pstack role table: the roles a skill can ask a model for, the reasoning budget, and the
 * shape of the stored role map.
 *
 * Upstream pstack keeps the role map in `~/.cursor/rules/pstack-models.mdc`. This package keeps
 * it as JSON in the Pi agent directory. The role names are upstream's, so a pstack role means
 * the same thing in either harness.
 */

/** A stored role value: a model id, or `inherit-parent` / `auto` for the parent chat model. */
export type RoleValue = string;

/** A role's stored choice. A panel role holds one value per seat. */
export type RoleEntry = { readonly value: RoleValue } | { readonly value: readonly RoleValue[] };

export type BudgetLabel = "unlimited" | "large" | "medium" | "small";

export const BUDGETS: readonly BudgetLabel[] = ["unlimited", "large", "medium", "small"];

export interface RoleMap {
	readonly budget: BudgetLabel;
	readonly roles: Readonly<Record<string, RoleEntry>>;
}

/** The effort ladder, ordered from most to least reasoning. */
export const EFFORT_LADDER = ["max", "xhigh", "high", "medium", "low", "minimal", "off"] as const;

export type Effort = (typeof EFFORT_LADDER)[number];

/** The level each budget caps a role at. */
export const BUDGET_EFFORT: Readonly<Record<BudgetLabel, Effort>> = {
	unlimited: "max",
	large: "xhigh",
	medium: "high",
	small: "medium",
};

export function isBudget(value: unknown): value is BudgetLabel {
	return typeof value === "string" && (BUDGETS as readonly string[]).includes(value);
}

export function isLevel(value: string): value is Effort {
	return (EFFORT_LADDER as readonly string[]).includes(value);
}

/**
 * True when `level` spends no more reasoning than the budget's level. The ladder runs from most
 * to least reasoning, so the allowed levels are the ones at or after the target's index.
 */
export function isAtOrBelowBudget(level: Effort, budget: BudgetLabel): boolean {
	return EFFORT_LADDER.indexOf(level) >= EFFORT_LADDER.indexOf(BUDGET_EFFORT[budget]);
}

/** True for the two values that mean "run on the parent chat model". */
export function isInherit(value: RoleValue): boolean {
	return value === "inherit-parent" || value === "auto";
}

/** The values of a role entry, one per seat. */
export function seatsOf(entry: RoleEntry): readonly RoleValue[] {
	return typeof entry.value === "string" ? [entry.value] : entry.value;
}

/**
 * The kind of model a role's work needs. A judgment role judges, decides, or explains, where a
 * wrong answer costs more than a slow one. A code role runs for every edit, so it wants a
 * capable model that is not the most expensive one.
 */
export type RoleKind = "judgment" | "code";

export interface RoleSpec {
	readonly name: string;
	readonly kind: RoleKind;
	/** Seats in the role. More than one makes it a panel: one subagent runs per seat. */
	readonly seats: number;
}

/**
 * Every role upstream's `setup-pstack` defines, with upstream's panel sizes. Upstream defaults
 * named Cursor slugs (`claude-opus-5-5-xhigh` for judgment, `grok-4.7-xhigh-fast` for code),
 * which do not exist in Pi, so the kind of work is what carries over.
 */
export const ROLES: readonly RoleSpec[] = [
	{ name: "feature, refactoring", kind: "code", seats: 1 },
	{ name: "bug-fix", kind: "code", seats: 1 },
	{ name: "perf-issue", kind: "code", seats: 1 },
	{ name: "hillclimb", kind: "code", seats: 1 },
	{ name: "judgment and prose", kind: "judgment", seats: 1 },
	{ name: "hardest tasks", kind: "judgment", seats: 1 },
	{ name: "how explorer", kind: "code", seats: 1 },
	{ name: "how explainer", kind: "judgment", seats: 1 },
	{ name: "why investigators", kind: "code", seats: 1 },
	{ name: "why synthesizer", kind: "judgment", seats: 1 },
	{ name: "reflect tooling", kind: "code", seats: 1 },
	{ name: "reflect judgment, divergent, synthesizer", kind: "judgment", seats: 1 },
	{ name: "arena runners", kind: "code", seats: 2 },
	{ name: "arena cross-judge pool", kind: "judgment", seats: 2 },
	{ name: "swarm workers", kind: "code", seats: 1 },
	{ name: "architect runners", kind: "judgment", seats: 2 },
	{ name: "interrogate reviewers", kind: "judgment", seats: 2 },
];

export const ROLE_NAMES: ReadonlySet<string> = new Set(ROLES.map((role) => role.name));

/**
 * Routing prefixes that a provider puts in front of a model's own name, as in
 * `amazon-bedrock/global.anthropic.claude-opus-5-5`. They say where a request goes, not which
 * model answers it.
 */
const ROUTING_PREFIX = /^(global|us|eu|au|ap|apac|jp|ca|anthropic|openai|amazon|meta|google|mistral|cohere|deepseek|qwen|xai|x-ai|moonshotai|zai|z-ai)\./;

/**
 * A model's family: its vendor lineage, such as `claude`, `gpt`, `grok`, or `gemini`.
 *
 * The provider is not the family. `anthropic/claude-sonnet-5-5` and
 * `amazon-bedrock/global.anthropic.claude-sonnet-5-5` are one model reached through two
 * providers, and a panel that seats both gets no second opinion. The family is read from the
 * model part of the id: the last path segment, with routing prefixes and a leading `~` removed,
 * up to its first non-letter.
 */
export function familyOf(id: string): string {
	const slash = id.indexOf("/");
	let name = (slash < 0 ? id : id.slice(slash + 1)).split("/").at(-1) ?? id;
	name = name.toLowerCase().replace(/^~/, "");
	while (ROUTING_PREFIX.test(name)) name = name.replace(ROUTING_PREFIX, "");
	return /^[a-z]+/.exec(name)?.[0] ?? name;
}
