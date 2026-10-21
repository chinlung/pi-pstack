/**
 * A test for the role map and its model resolution.
 *
 * The rules under test are the ones that decide which model a pstack role runs on: the budget
 * caps the reasoning effort, a role picks the kind of model its work needs, and a panel
 * spreads its entries across families so a comparison means something.
 *
 * Run it with:
 *
 *   node --experimental-strip-types --test extension/tests/roles.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BUDGET_EFFORT,
	EFFORT_LADDER,
	effortOf,
	familyOf,
	isAtOrBelowBudget,
	isInherit,
	isPanel,
	readRole,
	singleValue,
	strongestDeclaredLevel,
	panelValues,
	type RoleMap,
} from "../roles.ts";
import { parseRoleMap, mergeRoleMaps } from "../store.ts";

test("the effort ladder runs from most to least reasoning", () => {
	assert.deepEqual([...EFFORT_LADDER], ["max", "xhigh", "high", "medium", "low", "minimal", "off"]);
});

test("a budget maps to one effort", () => {
	assert.equal(BUDGET_EFFORT.unlimited, "max");
	assert.equal(BUDGET_EFFORT.large, "xhigh");
	assert.equal(BUDGET_EFFORT.medium, "high");
	assert.equal(BUDGET_EFFORT.small, "medium");
});

test("the effort token is read from a slug, with or without a fast marker", () => {
	assert.equal(effortOf("grok-4.7-xhigh-fast"), "xhigh");
	assert.equal(effortOf("claude-opus-5-5-xhigh"), "xhigh");
	assert.equal(effortOf("some-model"), undefined);
	assert.equal(effortOf("some-model-fast"), undefined);
});

test("a family is the provider prefix of a Pi model id", () => {
	assert.equal(familyOf("anthropic/claude-opus-5-5"), "anthropic");
	assert.equal(familyOf("amazon-bedrock/global.anthropic.claude-opus-5-5"), "amazon-bedrock");
	assert.equal(familyOf("openrouter/x-ai/grok-4.6"), "openrouter");
});

test("the two alias values mean the parent chat model", () => {
	assert.equal(isInherit("inherit-parent"), true);
	assert.equal(isInherit("auto"), true);
	assert.equal(isInherit("anthropic/claude-opus-5-5"), false);
});

test("a role entry holds either one model or a list", () => {
	assert.equal(isPanel({ value: "one" }), false);
	assert.equal(isPanel({ value: ["one", "two"] }), true);
	assert.equal(isPanel(undefined), false);
});

test("the role map reads single values and panel lists", () => {
	const map: RoleMap = {
		budget: "large",
		roles: {
			"bug-fix": { value: "anthropic/claude-sonnet-5-5" },
			"arena runners": { value: ["anthropic/claude-opus-5-5", "openrouter/x-ai/grok-4.6"] },
		},
	};
	assert.equal(singleValue(map, "bug-fix"), "anthropic/claude-sonnet-5-5");
	assert.deepEqual(panelValues(map, "arena runners"), [
		"anthropic/claude-opus-5-5",
		"openrouter/x-ai/grok-4.6",
	]);
	assert.equal(singleValue(map, "missing"), undefined);
	assert.equal(readRole(map, "missing"), undefined);
});

test("a stored map with a bad budget is rejected, so the defaults stand", () => {
	assert.equal(parseRoleMap({ budget: "enormous", roles: {} }), undefined);
	assert.equal(parseRoleMap({ roles: {} }), undefined);
	assert.equal(parseRoleMap(null), undefined);
	assert.equal(parseRoleMap([]), undefined);
});

test("a stored map keeps its budget and its roles", () => {
	const parsed = parseRoleMap({
		budget: "medium",
		roles: {
			"bug-fix": "anthropic/claude-sonnet-5-5",
			"arena runners": ["anthropic/claude-opus-5-5", "auto"],
			"broken": 42,
		},
	});
	assert.ok(parsed);
	assert.equal(parsed.budget, "medium");
	assert.deepEqual(parsed.roles["bug-fix"], { value: "anthropic/claude-sonnet-5-5" });
	assert.deepEqual(parsed.roles["arena runners"], { value: ["anthropic/claude-opus-5-5", "auto"] });
	// A malformed role is dropped rather than stored, so the map never carries a broken role.
	assert.equal(parsed.roles.broken, undefined);
});

test("a stored map reads back the object form the extension writes", () => {
	// The extension writes `{ "value": "model-id" }`. If the reader did not accept that form,
	// the map would parse as empty and every role would silently fall back to the default.
	const parsed = parseRoleMap({
		budget: "large",
		roles: {
			"bug-fix": { value: "anthropic/claude-opus-5-5" },
			"arena runners": { value: ["anthropic/claude-opus-5-5", "auto"] },
		},
	});
	assert.ok(parsed);
	assert.deepEqual(parsed.roles["bug-fix"], { value: "anthropic/claude-opus-5-5" });
	assert.deepEqual(parsed.roles["arena runners"], { value: ["anthropic/claude-opus-5-5", "auto"] });
});

test("a stored role the user chose survives a setup re-run", () => {
	const resolved: RoleMap = {
		budget: "small",
		roles: {
			"bug-fix": { value: "auto/default" },
			"judgment and prose": { value: "auto/default" },
		},
	};
	const stored: RoleMap = {
		budget: "large",
		roles: {
			"bug-fix": { value: "anthropic/claude-opus-5-5" },
			"judgment and prose": { value: "anthropic/claude-opus-5-5" },
		},
	};
	const usable = new Set(["anthropic/claude-opus-5-5"]);
	const merged = mergeRoleMaps(resolved, stored, (id) => usable.has(id));
	// The user's choice wins over the resolved default.
	assert.deepEqual(merged.roles["bug-fix"], { value: "anthropic/claude-opus-5-5" });
	// The budget still comes from the new run.
	assert.equal(merged.budget, "small");
});

test("a stored role naming an unusable model falls back to the default", () => {
	const resolved: RoleMap = { budget: "large", roles: { "bug-fix": { value: "auto/default" } } };
	const stored: RoleMap = { budget: "large", roles: { "bug-fix": { value: "anthropic/gone-model" } } };
	const usable = new Set(["anthropic/claude-opus-5-5"]);
	const merged = mergeRoleMaps(resolved, stored, (id) => usable.has(id));
	// A model the session can no longer launch would fail at spawn time, so it is dropped.
	assert.deepEqual(merged.roles["bug-fix"], { value: "auto/default" });
});

test("a stored alias role is kept, because it names no model to check", () => {
	const resolved: RoleMap = { budget: "large", roles: { "bug-fix": { value: "auto/default" } } };
	const stored: RoleMap = { budget: "large", roles: { "bug-fix": { value: "inherit-parent" } } };
	const merged = mergeRoleMaps(resolved, stored, () => false);
	assert.deepEqual(merged.roles["bug-fix"], { value: "inherit-parent" });
});

test("a budget allows the levels at or below its effort", () => {
	// The ladder runs from most to least reasoning, so a lower index means more reasoning.
	// A `medium` budget allows medium, low, minimal and off, and not high, xhigh or max.
	assert.equal(isAtOrBelowBudget("medium", "medium"), true);
	assert.equal(isAtOrBelowBudget("low", "medium"), true);
	assert.equal(isAtOrBelowBudget("off", "medium"), true);
	assert.equal(isAtOrBelowBudget("high", "medium"), false);
	assert.equal(isAtOrBelowBudget("max", "medium"), false);
	assert.equal(isAtOrBelowBudget("not-a-level", "medium"), false);

	// The same rule against a budget's effort, which is what the code compares against.
	// `unlimited` means max, so every level is at or below it.
	assert.equal(isAtOrBelowBudget("max", BUDGET_EFFORT.unlimited), true);
	assert.equal(isAtOrBelowBudget("high", BUDGET_EFFORT.unlimited), true);
	assert.equal(isAtOrBelowBudget("off", BUDGET_EFFORT.unlimited), true);
	// `large` means xhigh, so max is above it and xhigh is at it.
	assert.equal(isAtOrBelowBudget("xhigh", BUDGET_EFFORT.large), true);
	assert.equal(isAtOrBelowBudget("max", BUDGET_EFFORT.large), false);
	// `medium` means high.
	assert.equal(isAtOrBelowBudget("high", BUDGET_EFFORT.medium), true);
	assert.equal(isAtOrBelowBudget("xhigh", BUDGET_EFFORT.medium), false);
	// `small` means medium.
	assert.equal(isAtOrBelowBudget("medium", BUDGET_EFFORT.small), true);
	assert.equal(isAtOrBelowBudget("high", BUDGET_EFFORT.small), false);
});

test("the strongest declared level is used, not the first one listed", () => {
	// The provider's key order is not the ladder's. A model that offers `max` must not rank
	// below one that offers only `off`, which is what taking the first key would do.
	assert.equal(strongestDeclaredLevel(["minimal", "low", "medium", "high", "xhigh", "max"]), "max");
	assert.equal(strongestDeclaredLevel(["off", "minimal", "low", "medium", "high", "xhigh", "max"]), "max");
	assert.equal(strongestDeclaredLevel(["xhigh", "max"]), "max");
	assert.equal(strongestDeclaredLevel(["off"]), "off");
	assert.equal(strongestDeclaredLevel([]), undefined);
	assert.equal(strongestDeclaredLevel(["not-a-level"]), undefined);
});

test("a model with no level at or below the budget is reported as over budget", () => {
	// Some providers expose a narrow band, as Bedrock's `["xhigh", "max"]` models do. A role
	// that must use one of them runs above the budget, which the report has to say.
	const narrow = { thinkingLevels: ["xhigh", "max"] };
	const wide = { thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] };

	// A `medium` budget allows high and below. The wide model qualifies, the narrow one does not.
	assert.equal(wide.thinkingLevels.some((level) => isAtOrBelowBudget(level, BUDGET_EFFORT.medium)), true);
	assert.equal(narrow.thinkingLevels.some((level) => isAtOrBelowBudget(level, BUDGET_EFFORT.medium)), false);
	// An `unlimited` budget allows everything, so the narrow model qualifies there.
	assert.equal(narrow.thinkingLevels.some((level) => isAtOrBelowBudget(level, BUDGET_EFFORT.unlimited)), true);
});
