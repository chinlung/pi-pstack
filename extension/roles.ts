/**
 * pstack role table: the per-role model map that pstack's `setup-pstack` skill writes and every
 * other skill reads.
 *
 * Upstream pstack keeps this in `~/.cursor/rules/pstack-models.mdc`. Pi has no always-applied
 * rule format, so this package keeps it as JSON in the agent directory and reads it back at
 * session start. The role names and the shape of each entry are unchanged from upstream, so a
 * pstack model map means the same thing in either harness.
 */

/** A role's model choice. `inherit` and `auto` both mean "run on the parent chat model". */
export type RoleValue = string;

/**
 * A role's model choice. A panel role holds a list, and one subagent runs per entry, so the
 * list length sets the count.
 */
export type RoleEntry =
	| { readonly value: RoleValue }
	| { readonly value: readonly RoleValue[] };

export interface RoleMap {
	/** The reasoning budget label chosen in setup: unlimited, large, medium, small. */
	readonly budget: BudgetLabel;
	readonly roles: Readonly<Record<string, RoleEntry>>;
}

export type BudgetLabel = "unlimited" | "large" | "medium" | "small";

/**
 * Reasoning effort per budget label. The ladder runs max > xhigh > high > medium > low.
 * `unlimited` and `large` differ only at the top of the ladder.
 */
export const BUDGET_EFFORT: Record<BudgetLabel, string> = {
	unlimited: "max",
	large: "xhigh",
	medium: "high",
	small: "medium",
};

/** The effort ladder, ordered from most to least reasoning. */
export const EFFORT_LADDER = ["max", "xhigh", "high", "medium", "low", "minimal", "off"] as const;

export type Effort = (typeof EFFORT_LADDER)[number];

/**
 * The strongest level a model declares.
 *
 * A model's declared levels come from a map, and the map's key order is the provider's, not
 * the ladder's. A model that declares `["minimal", "low", "medium", "high", "xhigh", "max"]`
 * offers `max`, so taking the first key would rank it below a model that offers only `off`.
 */
export function strongestDeclaredLevel(levels: readonly string[]): Effort | undefined {
	let best: Effort | undefined;
	for (const level of levels) {
		if (!EFFORT_LADDER.includes(level as Effort)) continue;
		const candidate = level as Effort;
		if (best === undefined || EFFORT_LADDER.indexOf(candidate) < EFFORT_LADDER.indexOf(best)) {
			best = candidate;
		}
	}
	return best;
}

/**
 * True when a level is at or below a budget's effort.
 *
 * The ladder runs from most to least reasoning, so a lower index means more reasoning. A
 * budget caps the reasoning a role may spend, so the levels it allows are the ones at or
 * after the target's index, not before it.
 */
export function isAtOrBelowBudget(level: string, target: string): boolean {
	const levelIndex = EFFORT_LADDER.indexOf(level as Effort);
	const targetIndex = EFFORT_LADDER.indexOf(target as Effort);
	if (levelIndex < 0 || targetIndex < 0) return false;
	return levelIndex >= targetIndex;
}

/** The last token of a model slug, or the one before a trailing `fast`. */
export function effortOf(slug: string): Effort | undefined {
	const parts = slug.split(/[-_:]/).filter(Boolean);
	const tail = parts.at(-1);
	if (tail === "fast") {
		const previous = parts.at(-2);
		return previous && (EFFORT_LADDER as readonly string[]).includes(previous) ? (previous as Effort) : undefined;
	}
	return tail && (EFFORT_LADDER as readonly string[]).includes(tail) ? (tail as Effort) : undefined;
}

/** Replaces the effort token of a slug, keeping the family and the fast marker. */
export function withEffort(slug: string, effort: Effort): string {
	const parts = slug.split(/[-_:]/).filter(Boolean);
	if (parts.at(-1) === "fast") {
		const previous = parts.at(-2);
		if (previous && (EFFORT_LADDER as readonly string[]).includes(previous)) {
			parts[parts.length - 2] = effort;
			return parts.join("-");
		}
	}
	parts.push(effort);
	return parts.join("-");
}

/** The model family a slug belongs to. Families go by prefix. */
export function familyOf(slug: string): string {
	const head = slug.split("/")[0];
	if (head.includes("/")) return head;
	const match = /^(claude|gpt|grok|gemini|llama|mistral|qwen|glm|kimi|composer|cursor-grok|deepseek)/.exec(slug);
	return match ? match[1] : head;
}

/** True for the two values that mean "run on the parent chat model". */
export function isInherit(value: RoleValue): boolean {
	return value === "inherit-parent" || value === "auto";
}

/** True when a role entry holds a list of models, one subagent per entry. */
export function isPanel(entry: RoleEntry | undefined): entry is { readonly value: readonly RoleValue[] } {
	return entry !== undefined && Array.isArray(entry.value);
}

/**
 * The upstream default role map. Upstream defaults to `claude-opus-5-5-xhigh` for prose and
 * judgment and `grok-4.7-xhigh-fast` for code work. Those slugs are Cursor-specific and are not
 * assumed to exist in Pi, so the Pi defaults name a role and a family rather than a concrete
 * slug; the setup skill resolves them against the models Pi actually has.
 */
export const UPSTREAM_ROLE_DEFAULTS: Readonly<Record<string, readonly RoleValue[]>> = {
	"feature, refactoring": ["grok-4.7-xhigh-fast"],
	"bug-fix": ["grok-4.7-xhigh-fast"],
	"perf-issue": ["grok-4.7-xhigh-fast"],
	hillclimb: ["grok-4.7-xhigh-fast"],
	"judgment and prose": ["claude-opus-5-5-xhigh"],
	"hardest tasks": ["claude-opus-5-5-xhigh"],
	"how explorer": ["grok-4.7-xhigh-fast"],
	"how explainer": ["claude-opus-5-5-xhigh"],
	"why investigators": ["grok-4.7-xhigh-fast"],
	"why synthesizer": ["claude-opus-5-5-xhigh"],
	"reflect tooling": ["grok-4.7-xhigh-fast"],
	"reflect judgment, divergent, synthesizer": ["claude-opus-5-5-xhigh"],
	"arena runners": ["claude-opus-5-5-xhigh", "grok-4.7-xhigh-fast"],
	"arena cross-judge pool": ["claude-opus-5-5-xhigh", "grok-4.7-xhigh-fast"],
	"swarm workers": ["grok-4.7-xhigh-fast"],
	"architect runners": ["claude-opus-5-5-xhigh", "grok-4.7-xhigh-fast"],
	"interrogate reviewers": ["claude-opus-5-5-xhigh", "grok-4.7-xhigh-fast"],
};

/** Roles whose value is a list. One subagent runs per entry, so the list length sets the count. */
export const PANEL_ROLES: ReadonlySet<string> = new Set([
	"arena runners",
	"arena cross-judge pool",
	"architect runners",
	"interrogate reviewers",
]);

/** The role a playbook reads when it needs a code-writing model. */
export const CODE_ROLES: Readonly<Record<string, string>> = {
	"feature, refactoring": "feature, refactoring",
	"bug-fix": "bug-fix",
	"perf-issue": "perf-issue",
	hillclimb: "hillclimb",
	refactoring: "feature, refactoring",
};

/** The role a playbook reads when it needs a prose or judgment model. */
export const JUDGMENT_ROLE = "judgment and prose";

/** The role a playbook reads when it needs the strongest model available. */
export const HARDEST_ROLE = "hardest tasks";

export function readRole(map: RoleMap | undefined, role: string): RoleEntry | undefined {
	return map?.roles[role];
}

/** The single model for a role, or undefined when the role is missing or a panel. */
export function singleValue(map: RoleMap | undefined, role: string): RoleValue | undefined {
	const entry = readRole(map, role);
	if (!entry) return undefined;
	return isPanel(entry) ? entry.value[0] : entry.value;
}

/** The panel list for a role, or undefined when the role is missing or singular. */
export function panelValues(map: RoleMap | undefined, role: string): readonly RoleValue[] | undefined {
	const entry = readRole(map, role);
	if (!entry) return undefined;
	return isPanel(entry) ? entry.value : [entry.value];
}
