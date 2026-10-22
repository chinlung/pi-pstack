/**
 * Model detection and role resolution.
 *
 * Everything below the detection step is a pure function of a model catalog, so the rules that
 * pick a role's model can be tested without a Pi session.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BUDGET_EFFORT,
	EFFORT_LADDER,
	familyOf,
	isAtOrBelowBudget,
	isInherit,
	isLevel,
	ROLES,
	seatsOf,
	type BudgetLabel,
	type Effort,
	type RoleEntry,
	type RoleKind,
	type RoleMap,
	type RoleValue,
} from "./roles.ts";

/** A model the session can launch, reduced to what role resolution needs. */
export interface CatalogModel {
	/** `provider/id`, the form pi-subagents accepts. */
	readonly id: string;
	/** The id without its provider, for matching a bare id. */
	readonly modelId: string;
	readonly reasoning: boolean;
	/** The levels the model supports, in ladder order from most to least reasoning. */
	readonly thinkingLevels: readonly Effort[];
	/** Price per million tokens, output counted twice. Breaks ties between equally strong models. */
	readonly cost: number;
}

/** The catalog fields detection reads. Structural, so the host's `Model` type fits. */
interface HostModel {
	readonly provider: string;
	readonly id: string;
	readonly reasoning?: boolean;
	readonly thinkingLevelMap?: Partial<Record<string, string | null>>;
	readonly cost?: { readonly input?: number; readonly output?: number };
}

/**
 * The levels a model supports. This is the rule pi-ai's `getSupportedThinkingLevels` applies,
 * repeated here because Pi's extension loader exposes only pi-ai's root entry, which does not
 * export it:
 *
 * - a model without `reasoning` supports only `off`;
 * - a level mapped to `null` is unsupported;
 * - `xhigh` and `max` are supported only when the map names them;
 * - every other level is supported, mapped or not.
 *
 * Reading the map's keys instead gets both directions wrong: a key mapped to `null` is not
 * supported, and a reasoning model without a map still supports `off` through `high`.
 */
export function supportedLevels(model: Pick<HostModel, "reasoning" | "thinkingLevelMap">): readonly Effort[] {
	if (!model.reasoning) return ["off"];
	return EFFORT_LADDER.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

function blendedCost(cost: HostModel["cost"]): number {
	return (cost?.input ?? 0) + 2 * (cost?.output ?? 0);
}

export function toCatalogModel(model: HostModel): CatalogModel {
	return {
		id: `${model.provider}/${model.id}`,
		modelId: model.id,
		reasoning: model.reasoning === true,
		thinkingLevels: supportedLevels(model),
		cost: blendedCost(model.cost),
	};
}

/**
 * The models this session can launch.
 *
 * `ctx.scopedModels` is the set the user's `enabledModels` setting scopes the session to. Pi
 * leaves it empty when no scope is configured, which means every authenticated model is usable,
 * so an empty scope falls back to the registry's available models rather than to nothing.
 */
export function detectModels(ctx: ExtensionContext): CatalogModel[] {
	const scoped = ctx.scopedModels.map((entry) => entry.model);
	const source = scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable();
	const seen = new Set<string>();
	const models: CatalogModel[] = [];
	for (const model of source) {
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) continue;
		const entry = toCatalogModel(model);
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		models.push(entry);
	}
	return models;
}

/**
 * A model's strength under a budget: the highest level it supports at or below the budget's
 * level. A model that also offers more reasoning than the budget allows is not weaker for it.
 * Undefined when the model supports no level within the budget.
 */
export function strengthOf(levels: readonly Effort[], budget: BudgetLabel): Effort | undefined {
	return EFFORT_LADDER.find((level) => levels.includes(level) && isAtOrBelowBudget(level, budget));
}

/**
 * The level to launch a model at. The budget's strength when the model has one; otherwise the
 * model only offers levels above the budget, so it runs at the lowest of them and is flagged,
 * because spending more than the user chose must not be silent. A model without reasoning gets
 * no level, because asking it for reasoning it lacks is a provider error.
 */
export function levelFor(model: CatalogModel, budget: BudgetLabel): { level: Effort | undefined; aboveBudget: boolean } {
	if (!model.reasoning) return { level: undefined, aboveBudget: false };
	const strength = strengthOf(model.thinkingLevels, budget);
	if (strength) return { level: strength, aboveBudget: false };
	const lowest = [...EFFORT_LADDER].reverse().find((level) => model.thinkingLevels.includes(level));
	return { level: lowest, aboveBudget: lowest !== undefined };
}

/** Strongest first: models with a within-budget level, then higher level, then higher price. */
function byStrength(budget: BudgetLabel): (a: CatalogModel, b: CatalogModel) => number {
	const rank = (model: CatalogModel): number => {
		const strength = strengthOf(model.thinkingLevels, budget);
		return strength === undefined ? EFFORT_LADDER.length : EFFORT_LADDER.indexOf(strength);
	};
	return (a, b) => rank(a) - rank(b) || b.cost - a.cost || a.id.localeCompare(b.id);
}

/**
 * The model a role of this kind takes from a pool. A judgment role takes the strongest. A code
 * role takes the median-priced model among those that tie for the strongest level, so it gets
 * full reasoning without the priciest model.
 */
export function pick(pool: readonly CatalogModel[], kind: RoleKind, budget: BudgetLabel): CatalogModel | undefined {
	const ranked = [...pool].sort(byStrength(budget));
	const best = ranked[0];
	if (!best || kind === "judgment") return best;
	const top = strengthOf(best.thinkingLevels, budget);
	const tied = ranked.filter((model) => strengthOf(model.thinkingLevels, budget) === top);
	const byCost = [...tied].sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id));
	return byCost[Math.floor(byCost.length / 2)];
}

/**
 * The models for a panel role. A panel compares models, so seats take different families first,
 * in the order of each family's best model. When families run out, seats take models not yet
 * seated. A model repeats only when every usable model is already seated.
 */
export function pickPanel(models: readonly CatalogModel[], kind: RoleKind, budget: BudgetLabel, seats: number): CatalogModel[] {
	const families = new Map<string, CatalogModel[]>();
	for (const model of models) families.set(familyOf(model.id), [...(families.get(familyOf(model.id)) ?? []), model]);
	const order = [...families.values()]
		.map((pool) => ({ pool, best: pick(pool, kind, budget) }))
		.filter((entry): entry is { pool: CatalogModel[]; best: CatalogModel } => entry.best !== undefined)
		.sort((a, b) => byStrength(budget)(a.best, b.best));
	const chosen: CatalogModel[] = [];
	for (let seat = 0; seat < seats; seat++) {
		const family = order[seat];
		const unused = models.filter((model) => !chosen.includes(model));
		const next = family ? pick(family.pool.filter((model) => !chosen.includes(model)), kind, budget) : pick(unused, kind, budget);
		const fallback = next ?? pick(unused, kind, budget) ?? pick(models, kind, budget);
		if (fallback) chosen.push(fallback);
	}
	return chosen;
}

/**
 * The role map a fresh install runs on, built from the detected models. A role with no usable
 * model is left out, so the skills fall back to the parent model for it.
 */
export function defaultRoleMap(models: readonly CatalogModel[], budget: BudgetLabel): RoleMap {
	const roles: Record<string, RoleEntry> = {};
	for (const role of ROLES) {
		if (role.seats === 1) {
			const chosen = pick(models, role.kind, budget);
			if (chosen) roles[role.name] = { value: chosen.id };
			continue;
		}
		const chosen = pickPanel(models, role.kind, budget, role.seats);
		if (chosen.length > 0) roles[role.name] = { value: chosen.map((model) => model.id) };
	}
	return { budget, roles };
}

/** What one stored value resolves to. */
export type ResolvedValue =
	| { readonly kind: "model"; readonly id: string; readonly strippedSuffix?: Effort }
	| { readonly kind: "parent" }
	| { readonly kind: "unresolved"; readonly value: RoleValue };

function findModel(models: readonly CatalogModel[], text: string): CatalogModel | undefined {
	const exact = models.find((model) => model.id === text);
	if (exact) return exact;
	const bare = models.filter((model) => model.modelId === text);
	return bare.length === 1 ? bare[0] : undefined;
}

/**
 * Resolves a stored value against the detected models: an exact `provider/id`, then a bare id
 * that is unique. A value that matches neither is reported as unresolved, never swapped for a
 * nearby model, because a silent substitution runs the role on a model nobody chose.
 *
 * A hand-written value may carry a `:<level>` suffix, Pi's usual spelling. The suffix is
 * stripped only when the whole text is not itself a model id, since some ids contain a colon,
 * and only when it names one of the seven levels. The budget sets the level, so the stripped
 * suffix is reported rather than used.
 */
export function resolveValue(models: readonly CatalogModel[], value: RoleValue): ResolvedValue {
	if (isInherit(value)) return { kind: "parent" };
	const whole = findModel(models, value);
	if (whole) return { kind: "model", id: whole.id };
	const colon = value.lastIndexOf(":");
	const suffix = colon < 0 ? "" : value.slice(colon + 1);
	if (isLevel(suffix)) {
		const base = findModel(models, value.slice(0, colon));
		if (base) return { kind: "model", id: base.id, strippedSuffix: suffix };
	}
	return { kind: "unresolved", value };
}

/**
 * Every role in the table, in table order. A role the map does not name runs on the parent
 * model, one parent seat per seat of the role so a panel keeps its fan-out.
 */
export function completeRoles(resolved: readonly ResolvedRole[]): ResolvedRole[] {
	return ROLES.map(
		(spec) =>
			resolved.find((entry) => entry.role === spec.name) ?? {
				role: spec.name,
				seats: Array.from({ length: spec.seats }, () => ({ kind: "parent" as const })),
			},
	);
}

/** The model ids that more than one seat of a role names, so setup can say a panel is one model twice. */
export function duplicateModels(seats: readonly ResolvedSeat[]): string[] {
	const ids = seats.flatMap((seat) => (seat.kind === "model" ? [seat.id] : []));
	return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
}

/** One seat of a resolved role, ready to launch. */
export type ResolvedSeat =
	| {
			readonly kind: "model";
			readonly id: string;
			/** The `model` value to pass to pi-subagents: the id with the budget's level. */
			readonly spec: string;
			readonly level: Effort | undefined;
			readonly aboveBudget: boolean;
			readonly strippedSuffix?: Effort;
	  }
	| { readonly kind: "parent" }
	| { readonly kind: "unresolved"; readonly value: RoleValue };

export interface ResolvedRole {
	readonly role: string;
	readonly seats: readonly ResolvedSeat[];
}

export function resolveSeat(models: readonly CatalogModel[], value: RoleValue, budget: BudgetLabel): ResolvedSeat {
	const resolved = resolveValue(models, value);
	if (resolved.kind !== "model") return resolved;
	const model = models.find((entry) => entry.id === resolved.id) as CatalogModel;
	const { level, aboveBudget } = levelFor(model, budget);
	return {
		kind: "model",
		id: model.id,
		spec: level ? `${model.id}:${level}` : model.id,
		level,
		aboveBudget,
		...(resolved.strippedSuffix ? { strippedSuffix: resolved.strippedSuffix } : {}),
	};
}

/** Resolves every role in a map, in the map's order. */
export function resolveRoleMap(models: readonly CatalogModel[], map: RoleMap): ResolvedRole[] {
	return Object.entries(map.roles).map(([role, entry]) => ({
		role,
		seats: seatsOf(entry).map((value) => resolveSeat(models, value, map.budget)),
	}));
}

/**
 * A stored role rewritten in the form setup writes: each seat a full `provider/id` with no level
 * suffix, or the parent alias as written. Undefined when any seat does not resolve, because the
 * role then needs a new choice.
 */
export function normalizeEntry(models: readonly CatalogModel[], entry: RoleEntry): RoleEntry | undefined {
	const seats: RoleValue[] = [];
	for (const value of seatsOf(entry)) {
		const resolved = resolveValue(models, value);
		if (resolved.kind === "unresolved") return undefined;
		seats.push(resolved.kind === "model" ? resolved.id : value);
	}
	return typeof entry.value === "string" ? { value: seats[0] } : { value: seats };
}

export { BUDGET_EFFORT };
