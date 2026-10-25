import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));

test("the lockfile root agrees with the manifest's dependency contracts", () => {
	for (const field of ["name", "version", "devDependencies", "peerDependencies", "peerDependenciesMeta"]) {
		assert.deepEqual(lock.packages[""][field], manifest[field], `lockfile root differs in ${field}`);
	}
});

test("the lockfile is portable rather than tied to a local host installation", () => {
	for (const [path, entry] of Object.entries(lock.packages)) {
		assert.ok(path === "" || path.startsWith("node_modules/"), `local package snapshot: ${path}`);
		assert.notEqual(entry.link, true, `machine-local symlink: ${path}`);
	}
});
