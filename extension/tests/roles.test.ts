/**
 * Tests for the role table and the stored role map.
 *
 * Run it with:
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUDGET_EFFORT, EFFORT_LADDER, isAtOrBelowBudget, isInherit, ROLE_NAMES, ROLES, seatsOf, type RoleEntry, type RoleMap } from "../roles.ts";
import { normalizeEntry, supportedLevels } from "../models.ts";
import { mergeRoleMaps, parseRoleMap, readRoleMap, roleMapPath, writeRoleMap } from "../store.ts";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

test("the effort ladder runs from most to least reasoning", () => {
	assert.deepEqual([...EFFORT_LADDER], ["max", "xhigh", "high", "medium", "low", "minimal", "off"]);
});

test("a budget maps to one level", () => {
	assert.deepEqual(BUDGET_EFFORT, { unlimited: "max", large: "xhigh", medium: "high", small: "medium" });
});

test("a budget allows the levels at or below its level", () => {
	assert.equal(isAtOrBelowBudget("max", "unlimited"), true);
	assert.equal(isAtOrBelowBudget("high", "unlimited"), true);
	assert.equal(isAtOrBelowBudget("xhigh", "large"), true);
	assert.equal(isAtOrBelowBudget("max", "large"), false);
	assert.equal(isAtOrBelowBudget("high", "medium"), true);
	assert.equal(isAtOrBelowBudget("xhigh", "medium"), false);
	assert.equal(isAtOrBelowBudget("medium", "small"), true);
	assert.equal(isAtOrBelowBudget("high", "small"), false);
});

test("supported levels follow pi-ai's rule, not the map's keys", () => {
	// A level mapped to null is unsupported.
	assert.deepEqual(supportedLevels({ reasoning: true, thinkingLevelMap: { off: null, xhigh: "x", max: "m" } }), [
		"max",
		"xhigh",
		"high",
		"medium",
		"low",
		"minimal",
	]);
	// A reasoning model without a map still supports off through high, but not xhigh or max.
	assert.deepEqual(supportedLevels({ reasoning: true }), ["high", "medium", "low", "minimal", "off"]);
	// A model without reasoning supports only off.
	assert.deepEqual(supportedLevels({ reasoning: false, thinkingLevelMap: { max: "m" } }), ["off"]);
});

test("the two alias values mean the parent chat model", () => {
	assert.equal(isInherit("inherit-parent"), true);
	assert.equal(isInherit("auto"), true);
	assert.equal(isInherit("anthropic/claude-opus-5-5"), false);
});

test("the role table matches upstream's seventeen roles and four panels", () => {
	assert.equal(ROLES.length, 17);
	assert.deepEqual(
		ROLES.filter((role) => role.seats > 1).map((role) => role.name),
		["arena runners", "arena cross-judge pool", "architect runners", "interrogate reviewers"],
	);
	assert.deepEqual(seatsOf({ value: "a" }), ["a"]);
	assert.deepEqual(seatsOf({ value: ["a", "b"] }), ["a", "b"]);
});

test("a map without a valid budget is rejected whole, with a reason", () => {
	for (const raw of [{ budget: "enormous", roles: {} }, { roles: {} }, null, []]) {
		const parsed = parseRoleMap(raw);
		assert.equal(parsed.map, undefined);
		assert.equal(parsed.warnings.length, 1);
	}
});

test("a stored map reads the object form the extension writes, and bare values", () => {
	const parsed = parseRoleMap({
		budget: "medium",
		roles: {
			"bug-fix": { value: "anthropic/claude-opus-5-5" },
			"swarm workers": "openai/gpt-6-sol",
			"arena runners": { value: ["anthropic/claude-opus-5-5", "auto"] },
		},
	});
	assert.deepEqual(parsed.warnings, []);
	assert.deepEqual(parsed.map?.roles["bug-fix"], { value: "anthropic/claude-opus-5-5" });
	assert.deepEqual(parsed.map?.roles["swarm workers"], { value: "openai/gpt-6-sol" });
	assert.deepEqual(parsed.map?.roles["arena runners"], { value: ["anthropic/claude-opus-5-5", "auto"] });
});

test("retired and malformed roles are dropped and reported", () => {
	const parsed = parseRoleMap({ budget: "large", roles: { "how critics": "a/b", "bug-fix": 42, "hillclimb": ["a/b", 7] } });
	assert.deepEqual(parsed.map?.roles, {});
	assert.equal(parsed.warnings.length, 3);
	assert.match(parsed.warnings[0], /retired role "how critics"/);
});

const CATALOG = [
	{ id: "anthropic/claude-opus-5-5", modelId: "claude-opus-5-5", reasoning: true, thinkingLevels: ["max", "xhigh", "high"] as const, cost: 44 },
	{ id: "openai/gpt-6-sol", modelId: "gpt-6-sol", reasoning: true, thinkingLevels: ["xhigh", "high"] as const, cost: 30 },
];
const normalize = (entry: RoleEntry) => normalizeEntry(CATALOG, entry);

test("a stored role survives a setup re-run when every seat still launches", () => {
	const resolved: RoleMap = { budget: "small", roles: { "bug-fix": { value: "openai/gpt-6-sol" } } };
	const stored: RoleMap = { budget: "large", roles: { "bug-fix": { value: "anthropic/claude-opus-5-5" } } };
	const merged = mergeRoleMaps(resolved, stored, normalize);
	assert.deepEqual(merged.map.roles["bug-fix"], { value: "anthropic/claude-opus-5-5" });
	assert.equal(merged.map.budget, "small");
	assert.deepEqual(merged.replaced, []);
});

test("a kept stored value is rewritten to a full provider/id with no level suffix", () => {
	const resolved: RoleMap = { budget: "large", roles: {} };
	const stored: RoleMap = {
		budget: "large",
		roles: { "bug-fix": { value: "gpt-6-sol" }, "hardest tasks": { value: "anthropic/claude-opus-5-5:xhigh" }, "arena runners": { value: ["auto", "gpt-6-sol:high"] } },
	};
	const merged = mergeRoleMaps(resolved, stored, normalize);
	assert.deepEqual(merged.map.roles["bug-fix"], { value: "openai/gpt-6-sol" });
	assert.deepEqual(merged.map.roles["hardest tasks"], { value: "anthropic/claude-opus-5-5" });
	assert.deepEqual(merged.map.roles["arena runners"], { value: ["auto", "openai/gpt-6-sol"] });
});

test("a stored panel with one seat gone is re-resolved whole, and its name is reported", () => {
	const resolved: RoleMap = { budget: "large", roles: { "arena runners": { value: ["openai/gpt-6-sol", "anthropic/claude-opus-5-5"] } } };
	const stored: RoleMap = { budget: "large", roles: { "arena runners": { value: ["anthropic/claude-opus-5-5", "y/gone"] } } };
	const merged = mergeRoleMaps(resolved, stored, normalize);
	assert.deepEqual(merged.map.roles["arena runners"], { value: ["openai/gpt-6-sol", "anthropic/claude-opus-5-5"] });
	assert.deepEqual(merged.replaced, ["arena runners"]);
});

test("a stored role with the wrong number of seats is dropped and reported", () => {
	const parsed = parseRoleMap({ budget: "large", roles: { "bug-fix": ["a/x", "b/y"], "arena runners": "a/x", "interrogate reviewers": ["a/x", "b/y"] } });
	assert.deepEqual(Object.keys(parsed.map?.roles ?? {}), ["interrogate reviewers"]);
	assert.equal(parsed.warnings.length, 2);
	assert.match(parsed.warnings[0], /"bug-fix": it has 2 model\(s\), and the role takes 1/);
});

test("every role name in the table is known to the parser", () => {
	for (const role of ROLES) assert.ok(ROLE_NAMES.has(role.name));
});

test("the role map round-trips through disk, and a broken file is reported, not ignored", async () => {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-pstack-"));
	assert.deepEqual(await readRoleMap(), { warnings: [] });
	const map: RoleMap = { budget: "medium", roles: { "bug-fix": { value: "openai/gpt-6-sol" } } };
	await writeRoleMap(map);
	assert.deepEqual(await readRoleMap(), { map, warnings: [] });
	assert.deepEqual(readdirSync(dirname(roleMapPath())), ["models.json"], "no temporary file is left behind");
	writeFileSync(roleMapPath(), "{ not json");
	const broken = await readRoleMap();
	assert.equal(broken.map, undefined);
	assert.match(broken.warnings[0], /is not valid JSON/);
});
