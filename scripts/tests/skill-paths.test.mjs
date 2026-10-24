import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => readFileSync(join(ROOT, file), "utf8");
const commands = [
	["skills/poteto-mode/playbooks/babysit.md", 'bun "<pstack>/skills/poteto-mode/scripts/watch-pr/watch-pr"'],
	["skills/poteto-mode/playbooks/shipping.md", 'bun "<pstack>/skills/poteto-mode/scripts/watch-pr/watch-pr"'],
	["skills/poteto-mode/playbooks/orchestrate.md", 'bun "<pstack>/skills/poteto-mode/scripts/orch/orch.ts"'],
	["skills/poteto-mode/playbooks/worktree-cleanup.md", 'bash "<pstack>/skills/poteto-mode/scripts/worktree-audit.sh"'],
	["skills/show-me-your-work/SKILL.md", 'bash "<pstack>/skills/show-me-your-work/scripts/log.sh"'],
];

for (const [file, command] of commands) {
	test(`${file} locates its bundled tool without changing the project cwd`, () => {
		assert.ok(read(file).includes(command), `missing package-qualified command: ${command}`);
		const target = command.match(/"<pstack>\/(.+)"/)[1];
		assert.ok(existsSync(join(ROOT, target)), `missing bundled tool: ${target}`);
	});
}

test("the documented log command runs from another cwd with spaces in the package path", () => {
	const temporary = mkdtempSync(join(tmpdir(), "pstack-paths-"));
	try {
		const installed = join(temporary, "installed package");
		symlinkSync(ROOT, installed, "dir");
		const match = read("skills/show-me-your-work/SKILL.md").match(/`(bash "<pstack>[^`]+)`/);
		assert.ok(match, "missing package-qualified log command");
		const command = match[1];
		const invocation = command.slice(0, command.indexOf(" <logfile>"))
			.replace("<pstack>", installed);
		const result = spawnSync("bash", ["-c", `${invocation} decisions.tsv verify choice reason evidence result`], {
			cwd: temporary,
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
		const rows = readFileSync(join(temporary, "decisions.tsv"), "utf8").trim().split("\n");
		assert.equal(rows.length, 2);
		assert.ok(rows[1].endsWith("\tverify\tchoice\treason\tevidence\tresult"));
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("the plan template keeps package references valid after copying to a project", () => {
	const text = read("skills/poteto-mode/playbooks/multi-phase-plan.md");
	const template = text.split("````markdown\n")[1].split("````")[0];
	assert.ok(template.includes("<pstack>/skills/poteto-mode/references/bugbot-triage.md"));
	assert.ok(template.includes("<pstack>/skills/poteto-mode/playbooks/shipping.md"));
	assert.doesNotMatch(template, /`(?:\.\.\/references\/|playbooks\/)/);
	for (const match of template.matchAll(/<pstack>\/(skills\/[a-zA-Z0-9/.-]+\.md)\b/g)) {
		assert.ok(existsSync(join(ROOT, match[1])), `missing template target: ${match[1]}`);
	}
});

test("ketchup uses available rendering tools rather than an undeclared visualize command", () => {
	const text = read("skills/ketchup/SKILL.md");
	assert.doesNotMatch(text, /\/visualize\b/);
	assert.match(text, /available in this session/);
	assert.match(text, /plain text/);
});

test("the README and adapter name the shipped plan checker", () => {
	for (const file of ["README.md", "docs/harness/pi.md"]) {
		assert.ok(read(file).includes("skills/poteto-mode/scripts/check-plan.mjs"), file);
		assert.ok(!read(file).includes("`scripts/check-plan.mjs`"), file);
	}
});
