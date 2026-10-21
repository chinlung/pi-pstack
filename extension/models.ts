/**
 * Model discovery and role resolution for pstack.
 *
 * Upstream pstack asks the user to paste the model slugs they can pass to a `Task` subagent,
 * because Cursor has no runtime list of them. Pi does: `ctx.modelRegistry` exposes every
 * catalogued model plus the ones whose provider has working credentials. This module turns that
 * catalog into the role map pstack's setup skill needs, and resolves a role's configured value
 * into a model Pi can actually launch.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BUDGET_EFFORT,
	EFFORT_LADDER,
	effortOf,
	familyOf,
	isAtOrBelowBudget,
	isInherit,
	isPanel,
	withEffort,
	type BudgetLabel,
	type Effort,
	type RoleMap,
	type RoleValue,
} from "./roles.ts";

export interface CatalogModel {
	/** `provider/id`, the form pi-subagents accepts. */
	readonly id: string;
	readonly provider: string;
	readonly modelId: string;
	readonly displayName: string;
	/** The reasoning levels the model declares, from its `thinkingLevelMap`. */
	readonly thinkingLevels: readonly string[];
	/** True when the provider has working credentials for this model. */
	readonly usable: boolean;
	/**
	 * The blended price per million tokens, used to rank models that offer the same reasoning
	 * levels. A modern catalog offers the same levels on every model, so the effort ladder
	 * alone cannot tell a cheap model from an expensive one.
	 */
	readonly cost: number;
}

/**
 * Every chat model the session can launch, marked with whether its provider is authenticated.
 *
 * The source is `ctx.scopedModels`, which is the set the user's `enabledModels` setting
 * scopes the session to. The full catalog holds hundreds of models the user cannot launch, and
 * a role map built from those would name a model that is not actually available.
 */
export function listModels(ctx: ExtensionContext): CatalogModel[] {
	const models = ctx.scopedModels.map((scoped) => scoped.model);
	return models.map((model) => ({
		id: `${model.provider}/${model.id}`,
		provider: model.provider,
		modelId: model.id,
		displayName: model.name ?? model.id,
		thinkingLevels: Object.keys(model.thinkingLevelMap ?? {}),
		usable: ctx.modelRegistry.hasConfiguredAuth(model),
		cost: blendedCost(model.cost),
	}));
}

/** The price per million tokens, counting output tokens at twice the input price. */
function blendedCost(cost: { input?: number; output?: number } | undefined): number {
	if (!cost) return 0;
	return (cost.input ?? 0) + 2 * (cost.output ?? 0);
}

/** Only the models Pi can actually launch right now. */
export function usableModels(ctx: ExtensionContext): CatalogModel[] {
	return listModels(ctx).filter((model) => model.usable);
}

/**
 * The `provider/id` list a user could pass to a pi-subagents child. A bare id is allowed by
 * pi-subagents when it is unique, so the setup skill offers both forms.
 */
export function modelChoices(ctx: ExtensionContext): string[] {
	const models = usableModels(ctx);
	const seen = new Set<string>();
	const choices: string[] = [];
	for (const model of models) {
		if (seen.has(model.id)) continue;
		seen.add(model.id);
		choices.push(model.id);
	}
	return choices.sort();
}

/** The family names present among usable models, used to fill a role that names no family. */
export function availableFamilies(ctx: ExtensionContext): string[] {
	const families = new Set<string>();
	for (const model of usableModels(ctx)) {
		families.add(familyOf(model.id));
	}
	return [...families].sort();
}

/**
 * Applies a budget to a slug: raises or lowers the effort token, keeping the family and the
 * `fast` marker. A slug with no effort token gets the target effort appended.
 */
export function applyBudget(slug: string, budget: BudgetLabel): string {
	const target = BUDGET_EFFORT[budget] as Effort;
	const current = effortOf(slug);
	if (!current) return withEffort(slug, target);
	return withEffort(slug, target);
}

/**
 * Finds the usable model in the same family whose effort is the highest at or below the target.
 * Upstream calls this the fallback ladder. When the family has no such model, the result is
 * undefined and the caller marks the role as needing a choice.
 */
export function nearestAtOrBelow(ctx: ExtensionContext, slug: string, budget: BudgetLabel): string | undefined {
	const target = BUDGET_EFFORT[budget] as Effort;
	const family = familyOf(slug);
	const candidates = usableModels(ctx).filter((model) => familyOf(model.id) === family);
	if (candidates.length === 0) return undefined;

	// The ladder runs from most to least reasoning, so a lower index means more reasoning.
	// "At or below the budget" is the strongest level the budget still allows, which is the
	// lowest index that is not above the target.
	let best: { id: string; index: number } | undefined;
	for (const candidate of candidates) {
		const effort = effortOf(candidate.id);
		// A model with no effort token is a plain model; treat it as the weakest rung.
		const index = effort ? EFFORT_LADDER.indexOf(effort) : EFFORT_LADDER.length - 1;
		if (index < 0) continue;
		if (!isAtOrBelowBudget(effort ?? "off", target)) continue;
		if (!best || index < best.index) best = { id: candidate.id, index };
	}
	if (best) return best.id;
	// Nothing at or below the target: take the weakest available in the family rather than
	// over-budgeting silently, and let the caller report the downgrade.
	return candidates.reduce((weakest, candidate) => {
		const effort = effortOf(candidate.id);
		const index = effort ? EFFORT_LADDER.indexOf(effort) : EFFORT_LADDER.length - 1;
		const weakestIndex = effortOf(weakest.id) ? EFFORT_LADDER.indexOf(effortOf(weakest.id) as Effort) : EFFORT_LADDER.length - 1;
		return index > weakestIndex ? candidate : weakest;
	}).id;
}

/**
 * Resolves a configured role value into a model Pi can launch.
 *
 * Returns the model id to pass to pi-subagents, or undefined when the value is an alias
 * (`inherit-parent`, `auto`) or when no usable model matches. The caller distinguishes the two:
 * an alias means "omit the model", an unresolved slug means "this role needs a choice".
 *
 * The budget sets the reasoning effort. Pi models carry their effort in the id, as
 * `provider/id:level` for pi-subagents, so the resolved model carries the budget's effort and
 * a role does not silently run at a different effort than the user chose.
 */
export function resolveRoleValue(
	ctx: ExtensionContext,
	value: RoleValue,
	budget: BudgetLabel,
): { readonly model?: string; readonly alias: boolean; readonly resolved: boolean } {
	if (isInherit(value)) return { alias: true, resolved: true };
	const usable = usableModels(ctx);
	if (usable.some((model) => model.id === value)) return { model: value, alias: false, resolved: true };

	// A bare id may still be unique in the catalog.
	const bare = usable.filter((model) => model.modelId === value);
	if (bare.length === 1) return { model: bare[0].id, alias: false, resolved: true };

	// Not an exact match: try the same family at the budget's effort.
	const familyMatch = usable.find((model) => familyOf(model.id) === familyOf(value));
	if (familyMatch) {
		const near = nearestAtOrBelow(ctx, value, budget);
		if (near) return { model: near, alias: false, resolved: true };
	}
	return { alias: false, resolved: false };
}

/**
 * The model a role should launch, with the budget's effort applied.
 *
 * Pi's thinking level is a `:level` suffix on the model id for pi-subagents, so the effort
 * travels with the model rather than as a separate field. A model that declares no effort
 * levels gets no suffix, because asking for reasoning it does not have is a provider error.
 */
export function modelWithBudget(
	ctx: ExtensionContext,
	modelId: string,
	budget: BudgetLabel,
): string {
	// The catalog entry is found by matching the whole id, not by splitting on the provider
	// separator. A provider-scoped id can carry a slash in the model part, as in
	// `amazon-bedrock/global.anthropic.claude-opus-5-5`.
	const model = usableModels(ctx).find((entry) => entry.id === modelId);
	if (!model) return modelId;
	const levels = model.thinkingLevels;
	if (levels.length === 0) return modelId;
	const target = BUDGET_EFFORT[budget];
	if (levels.includes(target)) return `${modelId}:${target}`;

	// The model does not offer the budget's effort. Use the strongest level the budget still
	// allows, so the role never runs above the budget the user chose.
	const atOrBelow = levels
		.filter((level) => isAtOrBelowBudget(level, target))
		.sort((a, b) => EFFORT_LADDER.indexOf(a as Effort) - EFFORT_LADDER.indexOf(b as Effort))[0];
	if (atOrBelow) return `${modelId}:${atOrBelow}`;

	// The model offers no level at or below the budget. Some providers only expose a narrow
	// band, so a role that must use this model has to run above the budget. The caller
	// reports it, because silently spending more reasoning than the user asked for is a
	// surprise they cannot see.
	const weakest = levels
		.filter((level) => EFFORT_LADDER.includes(level as Effort))
		.sort((a, b) => EFFORT_LADDER.indexOf(b as Effort) - EFFORT_LADDER.indexOf(a as Effort))[0];
	return weakest ? `${modelId}:${weakest}` : modelId;
}

/**
 * True when a model offers no reasoning level at or below the budget.
 *
 * The model then runs above the budget, which is a real cost the user did not ask for, so the
 * report says so.
 */
export function isOverBudget(ctx: ExtensionContext, modelId: string, budget: BudgetLabel): boolean {
	const model = usableModels(ctx).find((entry) => entry.id === modelId);
	if (!model || model.thinkingLevels.length === 0) return false;
	const target = BUDGET_EFFORT[budget];
	return !model.thinkingLevels.some((level) => isAtOrBelowBudget(level, target));
}

export interface ResolvedRole {
	readonly role: string;
	/** The model to launch, or undefined for an alias or an unresolved role. */
	readonly model?: string;
	/** True when the role runs on the parent chat model. */
	readonly alias: boolean;
	/** True when the configured value maps to a model Pi can launch. */
	readonly resolved: boolean;
	/** Why the value did not resolve, for the setup skill's report. */
	readonly note?: string;
	/**
	 * True when the model offers no level at or below the budget, so it runs at a level above
	 * the one the user chose. The caller reports it, because a silent over-budget is a
	 * surprise the user cannot see.
	 */
	readonly overBudget?: boolean;
}

/**
 * Resolves every role in a map. A panel role resolves each of its entries independently, so a
 * panel with one bad entry still contributes its good ones.
 */
export function resolveRoleMap(ctx: ExtensionContext, map: RoleMap): ResolvedRole[] {
	const resolved: ResolvedRole[] = [];
	for (const [role, entry] of Object.entries(map.roles)) {
		const values = isPanel(entry) ? entry.value : [entry.value as RoleValue];
		for (const value of values) {
			const outcome = resolveRoleValue(ctx, value, map.budget);
			const applied = outcome.model ? modelWithBudget(ctx, outcome.model, map.budget) : undefined;
			resolved.push({
				role,
				model: applied,
				alias: outcome.alias,
				resolved: outcome.resolved,
				note: outcome.resolved ? undefined : `no usable model for ${value}`,
				overBudget: outcome.model !== undefined && isOverBudget(ctx, outcome.model, map.budget),
			});
		}
	}
	return resolved;
}

/**
 * A family fallback for a role whose upstream default names a Cursor-only slug. Picks the
 * strongest usable model in the requested family, so the default map still works on a machine
 * that has that family.
 */
export function familyFallback(ctx: ExtensionContext, family: string, budget: BudgetLabel): string | undefined {
	const usable = usableModels(ctx).filter((model) => familyOf(model.id) === family);
	if (usable.length === 0) return undefined;
	const target = BUDGET_EFFORT[budget] as Effort;
	const targetIndex = EFFORT_LADDER.indexOf(target);
	let best: { id: string; index: number } | undefined;
	for (const candidate of usable) {
		const effort = effortOf(candidate.id);
		const index = effort ? EFFORT_LADDER.indexOf(effort) : EFFORT_LADDER.length - 1;
		if (index < 0 || index > targetIndex) continue;
		if (!best || index > best.index) best = { id: candidate.id, index };
	}
	return best?.id ?? usable[0].id;
}
