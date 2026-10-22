/**
 * Tests for model detection and role resolution.
 *
 * The resolver decides which model each pstack role runs on. Every rule here was once broken in
 * a way the old tests could not see, so each test pins one rule against a small catalog shaped
 * like the real one: most models declare every level from `off` to `max`, some providers expose
 * only a narrow band, and one model can be served by several providers.
 *
 * Run it with:
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultRoleMap, levelFor, resolveRoleMap, resolveValue, strengthOf, type CatalogModel } from "../models.ts";
import { familyOf, ROLES, type Effort } from "../roles.ts";

const FULL: readonly Effort[] = ["max", "xhigh", "high", "medium", "low", "minimal", "off"];

function model(id: string, cost: number, levels: readonly Effort[] = FULL): CatalogModel {
	return { id, modelId: id.slice(id.indexOf("/") + 1), reasoning: levels.length > 1 || levels[0] !== "off", thinkingLevels: levels, cost };
}

/** A catalog shaped like the machine this was found on. */
const CATALOG: readonly CatalogModel[] = [
	model("openrouter/z-ai/glm-5.3", 3),
	model("anthropic/claude-haiku-5-5", 1),
	model("anthropic/claude-sonnet-5-5", 22),
	model("anthropic/claude-opus-5-5", 44),
	model("amazon-bedrock/global.anthropic.claude-opus-5-5", 44, ["xhigh", "max"]),
	model("openai/gpt-6-sol", 30),
	model("openai/gpt-6-astra", 60),
];

test("a model's family is its vendor lineage, not its provider", () => {
	assert.equal(familyOf("anthropic/claude-sonnet-5-5"), "claude");
	assert.equal(familyOf("amazon-bedrock/global.anthropic.claude-sonnet-5-5"), "claude");
	assert.equal(familyOf("openrouter/x-ai/grok-4.6"), "grok");
	assert.equal(familyOf("openrouter/~openai/gpt-sol-latest"), "gpt");
	assert.equal(familyOf("amazon-bedrock/amazon.nova-2-lite-v1:0"), "nova");
	assert.equal(familyOf("lmstudio/poolside/laguna-s-2.1"), familyOf("openrouter/poolside/laguna-xs-2.1"));
});

test("strength is the highest level at or below the budget, not the highest level declared", () => {
	// A model that also offers `max` must not be dropped under a `medium` budget.
	assert.equal(strengthOf(FULL, "medium"), "high");
	assert.equal(strengthOf(FULL, "large"), "xhigh");
	assert.equal(strengthOf(FULL, "unlimited"), "max");
	// A narrow band above the budget has no strength there.
	assert.equal(strengthOf(["xhigh", "max"], "medium"), undefined);
	assert.equal(strengthOf(["xhigh", "max"], "large"), "xhigh");
});

test("the budget's level is applied, and a model that cannot meet it is flagged", () => {
	assert.deepEqual(levelFor(model("a/full", 1), "medium"), { level: "high", aboveBudget: false });
	assert.deepEqual(levelFor(model("a/narrow", 1, ["xhigh", "max"]), "medium"), { level: "xhigh", aboveBudget: true });
	// A plain model gets no level: asking it for reasoning it lacks is a provider error.
	assert.deepEqual(levelFor(model("a/plain", 1, ["off"]), "large"), { level: undefined, aboveBudget: false });
});

test("judgment roles take the strongest model under every budget", () => {
	for (const budget of ["unlimited", "large", "medium", "small"] as const) {
		const map = defaultRoleMap(CATALOG, budget);
		// Every full-range model ties on strength, so the higher price breaks the tie.
		assert.deepEqual(map.roles["judgment and prose"], { value: "openai/gpt-6-astra" }, budget);
	}
});

test("code roles take a mid-priced model, not the cheapest or the priciest", () => {
	const map = defaultRoleMap(CATALOG, "large");
	const picked = map.roles["bug-fix"];
	assert.ok(picked && !Array.isArray(picked.value));
	assert.notEqual(picked.value, "openai/gpt-6-astra");
	assert.notEqual(picked.value, "anthropic/claude-haiku-5-5");
	// Seven full-range models tie on strength; sorted by cost the middle one is gpt-6-sol (30).
	assert.equal(picked.value, "openai/gpt-6-sol");
});

test("a non-panel role is not limited to the alphabetically first family", () => {
	// `amazon-bedrock` sorts first; its only model must not win just because of that.
	const map = defaultRoleMap(CATALOG, "medium");
	assert.notEqual((map.roles["bug-fix"] as { value: string }).value, "amazon-bedrock/global.anthropic.claude-opus-5-5");
});

test("panel seats take different families, and never two copies of one model", () => {
	const map = defaultRoleMap(CATALOG, "large");
	for (const role of ROLES.filter((entry) => entry.seats > 1)) {
		const seats = (map.roles[role.name] as { value: readonly string[] }).value;
		assert.equal(seats.length, role.seats, role.name);
		assert.notEqual(familyOf(seats[0]), familyOf(seats[1]), `${role.name}: ${seats.join(", ")}`);
	}
});

test("a panel falls back to different models in one family when only one family exists", () => {
	const claudeOnly = CATALOG.filter((entry) => familyOf(entry.id) === "claude");
	const seats = (defaultRoleMap(claudeOnly, "large").roles["arena runners"] as { value: readonly string[] }).value;
	assert.notEqual(seats[0], seats[1]);
});

test("a panel repeats a model only when exactly one model is usable", () => {
	const seats = (defaultRoleMap([model("openai/gpt-6-sol", 30)], "large").roles["arena runners"] as { value: readonly string[] }).value;
	assert.deepEqual(seats, ["openai/gpt-6-sol", "openai/gpt-6-sol"]);
});

test("no usable model leaves every role out of the default map", () => {
	assert.deepEqual(defaultRoleMap([], "large").roles, {});
});

test("a stored value resolves exactly, by unique bare id, or not at all", () => {
	assert.deepEqual(resolveValue(CATALOG, "openai/gpt-6-sol"), { kind: "model", id: "openai/gpt-6-sol" });
	assert.deepEqual(resolveValue(CATALOG, "gpt-6-astra"), { kind: "model", id: "openai/gpt-6-astra" });
	assert.deepEqual(resolveValue(CATALOG, "inherit-parent"), { kind: "parent" });
	// A model that is gone must be reported, never silently swapped for a same-provider model.
	assert.deepEqual(resolveValue(CATALOG, "anthropic/claude-opus-4-old"), { kind: "unresolved", value: "anthropic/claude-opus-4-old" });
});

test("a hand-written level suffix is stripped and reported, unless it is part of the id", () => {
	assert.deepEqual(resolveValue(CATALOG, "openai/gpt-6-sol:xhigh"), {
		kind: "model",
		id: "openai/gpt-6-sol",
		strippedSuffix: "xhigh",
	});
	// An id that contains a colon is matched whole first.
	const withColon = [...CATALOG, model("openrouter/qwen/qwen3-coder:exacto", 2)];
	assert.deepEqual(resolveValue(withColon, "openrouter/qwen/qwen3-coder:exacto"), {
		kind: "model",
		id: "openrouter/qwen/qwen3-coder:exacto",
	});
	// Only the seven levels count as a suffix.
	assert.equal(resolveValue(CATALOG, "openai/gpt-6-sol:turbo").kind, "unresolved");
});

test("a resolved role carries the launch spec with the budget's level", () => {
	const resolved = resolveRoleMap(CATALOG, {
		budget: "medium",
		roles: {
			"bug-fix": { value: "openai/gpt-6-sol" },
			"arena runners": { value: ["amazon-bedrock/global.anthropic.claude-opus-5-5", "auto"] },
		},
	});
	const bugFix = resolved.find((entry) => entry.role === "bug-fix");
	assert.deepEqual(bugFix?.seats, [{ kind: "model", id: "openai/gpt-6-sol", spec: "openai/gpt-6-sol:high", level: "high", aboveBudget: false }]);
	const arena = resolved.find((entry) => entry.role === "arena runners");
	assert.deepEqual(arena?.seats, [
		{
			kind: "model",
			id: "amazon-bedrock/global.anthropic.claude-opus-5-5",
			spec: "amazon-bedrock/global.anthropic.claude-opus-5-5:xhigh",
			level: "xhigh",
			aboveBudget: true,
		},
		{ kind: "parent" },
	]);
});
