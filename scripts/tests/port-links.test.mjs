import assert from "node:assert/strict";
import { test } from "node:test";
import { danglingLinks, linkDestinations, relinkUnshipped, UPSTREAM_BLOB } from "../port-links.mjs";

const KEY = "skills/ketchup/SKILL.md";
const shipped = new Set(["skills/bro/SKILL.md", "skills/my skill/SKILL.md"]);
const ships = (target) => shipped.has(target);

test("finds inline links, images, reference definitions and angle-bracket destinations", () => {
	const text = [
		"[a](../bro/SKILL.md)",
		"![img](../bro/pic.png \"title\")",
		"[b](<../my skill/SKILL.md>)",
		"[c][ref]",
		"",
		"[ref]: ../gone/SKILL.md",
		"  [ref2]: <../also gone.md>",
	].join("\n");
	assert.deepEqual(
		linkDestinations(text).map((link) => link.href),
		["../bro/SKILL.md", "../bro/pic.png", "../my skill/SKILL.md", "../gone/SKILL.md", "../also gone.md"],
	);
});

test("reports missing targets in every link form, and only those", () => {
	const text = [
		"[ok](../bro/SKILL.md#step-1)",
		"[ok angle](<../my skill/SKILL.md>)",
		"![missing image](../bro/pic.png)",
		"[url](https://example.com/x.md) [anchor](#top) [placeholder](url)",
		"[ref]: ../gone/SKILL.md",
		"[ref2]: <../also gone.md>",
	].join("\n");
	assert.deepEqual(danglingLinks(KEY, text, ships), ["../bro/pic.png", "../gone/SKILL.md", "../also gone.md"]);
});

test("points unshipped upstream links at GitHub in inline and reference form, keeping the anchor", () => {
	const text = "[pack](../../automations/benny/README.md#setup)\n\n[pack]: ../../automations/benny/README.md\n[kept](../bro/SKILL.md)";
	const out = relinkUnshipped(KEY, text, ships);
	assert.equal(
		out,
		`[pack](${UPSTREAM_BLOB}/automations/benny/README.md#setup)\n\n[pack]: ${UPSTREAM_BLOB}/automations/benny/README.md\n[kept](../bro/SKILL.md)`,
	);
	assert.deepEqual(danglingLinks(KEY, out, ships), []);
});

test("leaves a missing link outside unshipped upstream for the gate to fail", () => {
	const text = "[typo](../brro/SKILL.md)";
	assert.equal(relinkUnshipped(KEY, text, ships), text);
	assert.deepEqual(danglingLinks(KEY, text, ships), ["../brro/SKILL.md"]);
});
