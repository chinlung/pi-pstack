import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { releaseDir } from "../link-host-packages.mjs";

function agentRoot(t, files) {
	const root = mkdtempSync(join(tmpdir(), "link-host-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}

test("current-version wins over PI_VERSION when the two disagree", (t) => {
	const root = agentRoot(t, {
		"install/current-version": "1.4.0\n",
		PI_VERSION: "1.3.0\n",
		"install/releases/1.4.0/.keep": "",
		"install/releases/1.3.0/.keep": "",
	});
	assert.equal(releaseDir(root), join(root, "install", "releases", "1.4.0"));
});

test("PI_VERSION is the fallback when current-version is absent", (t) => {
	const root = agentRoot(t, { PI_VERSION: "1.3.0", "install/releases/1.3.0/.keep": "" });
	assert.equal(releaseDir(root), join(root, "install", "releases", "1.3.0"));
});

test("a version that names no release directory fails loudly, naming the file", (t) => {
	const root = agentRoot(t, { "install/current-version": "9.9.9", "install/releases/1.4.0/.keep": "" });
	assert.throws(() => releaseDir(root), /current-version names 9\.9\.9/);
});
