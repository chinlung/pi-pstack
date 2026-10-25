import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { useAgentDir } from "./agent-dir.ts";

test("agent fixtures restore the environment and remove their directory after a test", async (t) => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	let root = "";
	await t.test("the directory exists and is active during the test", (child) => {
		root = useAgentDir(child);
		assert.equal(process.env.PI_CODING_AGENT_DIR, root);
		assert.ok(existsSync(root));
	});
	assert.ok(root);
	assert.equal(process.env.PI_CODING_AGENT_DIR, previous);
	assert.equal(existsSync(root), false);
});
