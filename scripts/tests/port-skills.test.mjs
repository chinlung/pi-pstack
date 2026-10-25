import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "pstack-port-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const path of ["scripts", "upstream", "overrides", "docs", "package.json", "package-lock.json", "README.md", "LICENSE"]) {
		cpSync(join(ROOT, path), join(root, path), { recursive: true });
	}
	mkdirSync(join(root, "skills"));
	writeFileSync(join(root, "skills", "preserve.txt"), "existing output");
	return root;
}

for (const target of ["package-lock.json", "node_modules/local-only/README.md", "scripts/node_modules/local-only/README.md"]) {
	test(`the port rejects an existing but unpackaged ${target} before replacing output`, (t) => {
		const root = fixture(t);
		if (target !== "package-lock.json") {
			mkdirSync(join(root, dirname(target)), { recursive: true });
			writeFileSync(join(root, target), "checkout only");
		}
		appendFileSync(join(root, "upstream", "skills", "ketchup", "SKILL.md"), `\n[unshipped](../../${target})\n`);
		const result = spawnSync(process.execPath, [join(root, "scripts", "port-skills.mjs")], { cwd: root, encoding: "utf8" });
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.ok(result.stdout.includes(`links to ../../${target}`), result.stdout);
		assert.equal(readFileSync(join(root, "skills", "preserve.txt"), "utf8"), "existing output");
	});
}

test("the port accepts package.json, which npm always includes", (t) => {
	const root = fixture(t);
	appendFileSync(join(root, "upstream", "skills", "ketchup", "SKILL.md"), "\n[manifest](../../package.json)\n");
	const result = spawnSync(process.execPath, [join(root, "scripts", "port-skills.mjs")], { cwd: root, encoding: "utf8" });
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(readFileSync(join(root, "skills", "ketchup", "SKILL.md"), "utf8"), /\[manifest\]\(\.\.\/\.\.\/package\.json\)/);
});
