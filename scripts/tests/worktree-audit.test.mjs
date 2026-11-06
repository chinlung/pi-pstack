import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const audit = fileURLToPath(new URL("../../skills/poteto-mode/scripts/worktree-audit.sh", import.meta.url));

function fixture(t, worktreeName = "work[blue") {
	const root = mkdtempSync(join(tmpdir(), "pstack-audit-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	const worktree = join(root, worktreeName);
	const bin = join(root, "bin");
	mkdirSync(bin);
	mkdirSync(repo);
	mkdirSync(worktree);
	// Controlled Git/forge state avoids touching real repositories or contacting the network.
	// The audit, jq, literal transcript search, and filesystem operations still run for real.
	writeFileSync(join(bin, "git"), `#!/usr/bin/env node
import { existsSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "-C") args.splice(0, 2);
const command = args.join(" ");
if (args[0] === "status") {
 if (process.env.AUDIT_STATUS_ERROR === "yes") process.exit(1);
 if (process.env.AUDIT_MANY_TRACKED === "yes") { await new Promise(resolve => process.stdout.write(" M tracked-file\\n".repeat(20000), resolve)); process.exit(0); }
 if (process.env.AUDIT_SUBMODULE_DIRTY === "yes" && args.includes("--ignore-submodules=none")) console.log(" M submodule");
 if (existsSync(process.env.AUDIT_WORKTREE + "/new-source.ts") && (process.env.AUDIT_HIDE_UNTRACKED !== "yes" || args.includes("--untracked-files=all"))) console.log("?? new-source.ts");
 process.exit(0);
}
if (args[0] === "fetch") process.exit(0);
if (command === "rev-parse --symbolic-full-name " + process.env.AUDIT_BASE) {
 const base = process.env.AUDIT_BASE;
 if (base.startsWith("refs/")) console.log(base);
 else if (base.startsWith("origin/")) console.log("refs/remotes/" + base);
 else if (base === "main") console.log("refs/heads/main");
 process.exit(0);
}
if (command === "rev-parse --verify --quiet " + process.env.AUDIT_BASE + "^{commit}") { console.log("base"); process.exit(0); }
if (args[0] === "merge-base") process.exit(process.env.AUDIT_MERGED === "yes" ? 0 : 1);
switch (command) {
 case "rev-parse --git-dir": console.log(".git"); break;
 case "worktree list --porcelain": console.log("worktree " + process.env.AUDIT_REPO + "\\n\\nworktree " + process.env.AUDIT_WORKTREE + "\\n"); break;
 case "rev-parse HEAD": if (process.env.AUDIT_HEAD_ERROR === "yes") process.exit(1); console.log("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); break;
 case "log -1 --format=%ct HEAD": console.log("1"); break;
 case "symbolic-ref --quiet --short HEAD": console.log("topic"); break;
 case "show-ref --verify --quiet refs/remotes/origin/topic": process.exit(1); break;
 default: console.error("unexpected test Git command: " + command); process.exit(99);
}
`, { mode: 0o755 });
	writeFileSync(join(bin, "origin"), '#!/usr/bin/env node\nif (!process.env.ORIGIN_JSON) process.exit(1);\nconsole.log(process.env.ORIGIN_JSON);\n', { mode: 0o755 });
	writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (process.env.GH_ERROR === "yes") process.exit(1);
if (process.env.GH_RAW) { console.log(process.env.GH_RAW); process.exit(0); }
const fields = args[args.indexOf("--json") + 1].split(",");
const prs = process.env.PR_JSON ? JSON.parse(process.env.PR_JSON) : [{number: 1, state: process.env.PR_STATE, headRefName: "topic", headRefOid: process.env.PR_HEAD, baseRefName: process.env.PR_BASE}];
const visible = args.includes("--author") && process.env.PR_OWNER !== "me" ? [] : prs;
console.log(JSON.stringify(visible.map(pr => Object.fromEntries(fields.filter(key => key in pr).map(key => [key, pr[key]])))));
`, { mode: 0o755 });
	const env = {
		...process.env,
		HOME: root,
		PI_CODING_AGENT_DIR: "",
		PI_CODING_AGENT_SESSION_DIR: "",
		PATH: `${bin}${delimiter}${process.env.PATH}`,
		ORIGIN_JSON: "",
		GH_ERROR: "no",
		GH_RAW: "",
		PR_STATE: "CLOSED",
		PR_HEAD: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		PR_BASE: "main",
		PR_JSON: "",
		PR_OWNER: "me",
		AUDIT_BASE: "main",
		AUDIT_STATUS_ERROR: "no",
		AUDIT_MANY_TRACKED: "no",
		AUDIT_HEAD_ERROR: "no",
		AUDIT_HIDE_UNTRACKED: "no",
		AUDIT_SUBMODULE_DIRTY: "no",
		AUDIT_REPO: repo,
		AUDIT_WORKTREE: worktree,
		AUDIT_MERGED: "no",
	};
	const invoke = () => spawnSync("bash", [audit, "-b", env.AUDIT_BASE, repo], { cwd: root, env, encoding: "utf8" });
	const run = () => {
		const result = invoke();
		assert.equal(result.status, 0, result.stderr);
		const row = result.stdout.trim().split("\n").at(-1).split("\t");
		assert.equal(row[8], worktree);
		return { merged: row[2], dirty: row[3], pr: row[5], lastChat: row[6], bucket: row[7] };
	};
	return { root, repo, worktree, bin, env, run, invoke };
}

test("an unmerged closed PR is not safe, and a merged PR must cover the exact head", (t) => {
	const f = fixture(t);
	assert.equal(f.run().bucket, "review");
	f.env.PR_STATE = "MERGED";
	assert.equal(f.run().bucket, "safe");
	f.env.PR_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
	assert.equal(f.run().bucket, "review", "an earlier merge does not cover new branch commits");
	f.env.PR_STATE = "OPEN";
	assert.equal(f.run().bucket, "hold-open-pr");
});

test("a merged PR must target the selected base", (t) => {
	const f = fixture(t);
	f.env.PR_STATE = "MERGED";
	f.env.PR_BASE = "another-branch";
	assert.equal(f.run().bucket, "review");
	f.env.PR_BASE = "main";
	for (const base of ["main", "origin/main", "refs/remotes/origin/main", "refs/heads/main"]) {
		f.env.AUDIT_BASE = base;
		assert.equal(f.run().bucket, "safe", base);
	}
	f.env.AUDIT_BASE = "HEAD~1";
	assert.equal(f.run().bucket, "review", "an arbitrary commit has no proven PR target");
});

test("a worktree whose status cannot be established is held, not treated as clean", (t) => {
	const f = fixture(t);
	f.env.AUDIT_MERGED = "yes";
	f.env.AUDIT_STATUS_ERROR = "yes";
	assert.equal(f.run().bucket, "hold-unknown");
});

test("an empty head cannot prove that a merged PR covers the worktree", (t) => {
	const f = fixture(t);
	f.env.PR_STATE = "MERGED";
	f.env.PR_HEAD = "";
	f.env.AUDIT_HEAD_ERROR = "yes";
	assert.equal(f.run().bucket, "review");
});

test("untracked visibility settings cannot hide source work from the audit", (t) => {
	const f = fixture(t);
	f.env.AUDIT_MERGED = "yes";
	f.env.AUDIT_HIDE_UNTRACKED = "yes";
	writeFileSync(join(f.worktree, "new-source.ts"), "export const work = 1;\n");
	assert.equal(f.run().bucket, "hold-untracked");
});

test("submodule visibility settings cannot hide dirty work from the audit", (t) => {
	const f = fixture(t);
	f.env.AUDIT_MERGED = "yes";
	f.env.AUDIT_SUBMODULE_DIRTY = "yes";
	assert.equal(f.run().bucket, "hold-wip");
});

test("PR fields are never borrowed from different PRs", (t) => {
	const f = fixture(t);
	f.env.PR_JSON = JSON.stringify([
		{ number: 1, state: "MERGED", headRefName: "topic", headRefOid: null, baseRefName: "main" },
		{ number: 2, state: "CLOSED", headRefName: "topic", headRefOid: f.env.PR_HEAD, baseRefName: "main" },
	]);
	assert.equal(f.run().bucket, "review");
});

test("any matching PR that is open holds the worktree, even behind a merged record", (t) => {
	const f = fixture(t);
	f.env.PR_JSON = JSON.stringify([
		{ number: 1, state: "MERGED", headRefName: "topic", headRefOid: f.env.PR_HEAD, baseRefName: "main" },
		{ number: 2, state: "OPEN", headRefName: "topic", headRefOid: f.env.PR_HEAD, baseRefName: "main" },
	]);
	assert.equal(f.run().bucket, "hold-open-pr");
});

test("Origin PRs hold open worktrees regardless of state casing but cannot prove a merge", (t) => {
	const f = fixture(t);
	for (const state of ["open", "OPEN", "draft", "DRAFT", "merged", "MERGED"]) {
		f.env.AUDIT_MERGED = state.toLowerCase() === "merged" ? "no" : "yes";
		f.env.ORIGIN_JSON = JSON.stringify([{ number: 2, status: state, headRef: "topic" }]);
		const result = f.run();
		assert.equal(result.bucket, state.toLowerCase() === "merged" ? "review" : "hold-open-pr", state);
		assert.equal(result.pr, `#2/${state.toLowerCase()}`);
	}
});

test("an open PR owned by a teammate also holds the worktree", (t) => {
	const f = fixture(t);
	f.env.AUDIT_MERGED = "yes";
	f.env.PR_STATE = "OPEN";
	f.env.PR_OWNER = "teammate";
	assert.equal(f.run().bucket, "hold-open-pr");
});

test("untracked source files are held even when their branch is merged", (t) => {
	const f = fixture(t);
	f.env.AUDIT_MERGED = "yes";
	assert.equal(f.run().bucket, "safe");
	const source = join(f.worktree, "new-source.ts");
	writeFileSync(source, "export const work = 1;\n");
	const result = f.run();
	assert.equal(result.dirty, "untracked:1");
	assert.equal(result.bucket, "hold-untracked");
	assert.equal(readFileSync(source, "utf8"), "export const work = 1;\n");
});

function recordRecentActivity(f, cwd = f.repo) {
	const slug = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	const configured = f.env.PI_CODING_AGENT_SESSION_DIR || join(f.env.PI_CODING_AGENT_DIR || join(f.root, ".pi", "agent"), "sessions", `--${slug}--`);
	const sessions = resolve(f.root, configured.replace(/^~(?=\/|$)/, f.env.HOME));
	mkdirSync(sessions, { recursive: true });
	writeFileSync(join(sessions, "current.jsonl"), JSON.stringify({ cwd: f.worktree }) + "\n");
}

test("recent activity is detected when a worktree path contains regex metacharacters", (t) => {
	const f = fixture(t);
	f.env.AUDIT_MERGED = "yes";
	recordRecentActivity(f);
	const result = f.run();
	assert.notEqual(result.lastChat, "-");
	assert.equal(result.bucket, "verify-recent-chat");
});

test("recent activity follows configured agent and session storage", (t) => {
	const f = fixture(t);
	f.env.AUDIT_MERGED = "yes";
	for (const agent of [join(f.root, "absolute agent"), "~/tilde agent", "relative agent", "missing/../normalized agent"]) {
		f.env.PI_CODING_AGENT_DIR = agent;
		recordRecentActivity(f);
		assert.equal(f.run().bucket, "verify-recent-chat", agent);
	}
	f.env.PI_CODING_AGENT_DIR = join(f.root, "no agent sessions");
	for (const sessions of [join(f.root, "absolute sessions"), "~/tilde sessions", "relative sessions", "missing/../normalized sessions"]) {
		f.env.PI_CODING_AGENT_SESSION_DIR = sessions;
		recordRecentActivity(f);
		assert.equal(f.run().bucket, "verify-recent-chat", sessions);
	}
});

for (const variable of ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"]) {
	test(`recent activity uses the real filesystem target of ${variable} file URLs`, (t) => {
		const f = fixture(t);
		f.env.AUDIT_MERGED = "yes";
		const storage = join(f.root, "URL storage #with spaces");
		f.env[variable] = storage;
		recordRecentActivity(f); // Create the transcript at a physical path, not a resolver-derived URL path.
		f.env[variable] = pathToFileURL(storage).href;
		assert.equal(f.run().bucket, "verify-recent-chat");
	});
}

test("invalid configured file URLs fail rather than reporting safe absence", (t) => {
	for (const variable of ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"]) {
		const f = fixture(t);
		f.env.AUDIT_MERGED = "yes";
		f.env[variable] = "file:///invalid%ZZ";
		const result = f.invoke();
		assert.notEqual(result.status, 0, variable);
		assert.doesNotMatch(result.stdout, /\tsafe\t/);
		assert.match(result.stderr, /cannot resolve Pi session storage path/);
	}
});

test("configured session storage does not fall back to stale default or unrelated sessions", (t) => {
	const f = fixture(t);
	f.env.AUDIT_MERGED = "yes";
	recordRecentActivity(f);
	f.env.PI_CODING_AGENT_DIR = join(f.root, "custom agent");
	assert.equal(f.run().bucket, "safe", "default storage is no longer authoritative");
	recordRecentActivity(f);
	assert.equal(f.run().bucket, "verify-recent-chat", "the configured agent store now has recent activity");
	f.env.PI_CODING_AGENT_SESSION_DIR = join(f.root, "custom sessions");
	mkdirSync(f.env.PI_CODING_AGENT_SESSION_DIR);
	writeFileSync(join(f.env.PI_CODING_AGENT_SESSION_DIR, "other.jsonl"), JSON.stringify({ cwd: "/unrelated/project" }) + "\n");
	assert.equal(f.run().bucket, "safe", "unrelated sessions in a shared store are not activity in this worktree");
});

test("ignored transcripts in an explicit session store still count as recent work", (t) => {
	const f = fixture(t);
	f.env.AUDIT_MERGED = "yes";
	f.env.PI_CODING_AGENT_SESSION_DIR = join(f.root, "custom sessions");
	recordRecentActivity(f);
	writeFileSync(join(f.env.PI_CODING_AGENT_SESSION_DIR, ".ignore"), "*.jsonl\n");
	assert.equal(f.run().bucket, "verify-recent-chat");
});

test("many tracked changes retain their correct dirty classification under pipefail", (t) => {
	const f = fixture(t);
	f.env.AUDIT_MANY_TRACKED = "yes";
	const result = f.run();
	assert.equal(result.dirty, "wip:20000");
	assert.equal(result.bucket, "hold-wip");
});

test("a successful empty forge response and a normal session no-match remain valid absence", (t) => {
	const f = fixture(t);
	f.env.AUDIT_MERGED = "yes";
	f.env.PR_JSON = "[]";
	const sessions = join(f.root, ".pi", "agent", "sessions", `--${f.repo.replace(/^\//, "").replace(/\//g, "-")}--`);
	mkdirSync(sessions, { recursive: true });
	writeFileSync(join(sessions, "unrelated.jsonl"), JSON.stringify({ cwd: "/another/project" }) + "\n");
	const result = f.run();
	assert.equal(result.pr, "-");
	assert.equal(result.bucket, "safe");
});

test("forge inspection fails closed on command and normalization errors", (t) => {
	const f = fixture(t);
	f.env.AUDIT_MERGED = "yes";
	f.env.GH_ERROR = "yes";
	let result = f.invoke();
	assert.notEqual(result.status, 0);
	assert.doesNotMatch(result.stdout, /\tsafe\t/);
	f.env.GH_ERROR = "no";
	for (const raw of ["invalid", "{}", "null", "[{}]", '[{"state":"OPEN","number":1}]', '[{"state":"unknown","headRefName":"topic","number":1}]']) {
		f.env.GH_RAW = raw;
		result = f.invoke();
		assert.notEqual(result.status, 0, raw);
		assert.doesNotMatch(result.stdout, /\tsafe\t/);
	}
});

test("a saturated PR listing cannot prove absence of an open PR beyond the cap", (t) => {
	const f = fixture(t);
	f.env.AUDIT_MERGED = "yes";
	const prs = Array.from({ length: 1000 }, (_, index) => ({ number: index + 1, state: "CLOSED", headRefName: "unrelated" }));
	f.env.PR_JSON = JSON.stringify(prs);
	let result = f.invoke();
	assert.notEqual(result.status, 0, "GitHub may have omitted the worktree branch's open PR beyond the limit");
	assert.doesNotMatch(result.stdout, /\tsafe\t/);
	f.env.PR_JSON = JSON.stringify(prs.slice(0, 999));
	assert.equal(f.run().bucket, "safe", "a complete, unsaturated response still permits normal ancestry proof");
	f.env.PR_JSON = JSON.stringify(prs);
	const originPrs = prs.map(pr => ({ number: pr.number, status: "closed", headRef: "unrelated" }));
	f.env.ORIGIN_JSON = JSON.stringify(originPrs);
	result = f.invoke();
	assert.notEqual(result.status, 0, "a saturated Origin response is incomplete too");
	assert.doesNotMatch(result.stdout, /\tsafe\t/);
	f.env.ORIGIN_JSON = JSON.stringify(originPrs.slice(0, 999));
	assert.equal(f.run().bucket, "safe");
});

test("invalid Origin normalization falls back to a valid GitHub response", (t) => {
	const f = fixture(t);
	f.env.AUDIT_MERGED = "yes";
	for (const raw of ["invalid", "{}", "[{}]", '[{"status":"OPEN","number":2}]']) {
		f.env.ORIGIN_JSON = raw;
		const result = f.run();
		assert.equal(result.pr, "#1/closed", raw);
		assert.equal(result.bucket, "safe");
	}
});

test("session inspection errors cannot be reported as safe absence", (t) => {
	for (const command of ["rg", "find", "stat"]) {
		const f = fixture(t);
		f.env.AUDIT_MERGED = "yes";
		recordRecentActivity(f, command === "find" ? f.worktree : f.repo);
		writeFileSync(join(f.bin, command), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
		const result = f.invoke();
		assert.notEqual(result.status, 0, command);
		assert.doesNotMatch(result.stdout, /\tsafe\t/, command);
		assert.match(result.stderr, /session/i);
	}
});

test("recent activity is detected for JSON-escaped paths in explicit session storage", (t) => {
	for (const name of ['work"blue', "work\\blue"]) {
		const f = fixture(t, name);
		f.env.AUDIT_MERGED = "yes";
		f.env.PI_CODING_AGENT_SESSION_DIR = join(f.root, "custom sessions");
		recordRecentActivity(f);
		const result = f.run();
		assert.notEqual(result.lastChat, "-", name);
		assert.equal(result.bucket, "verify-recent-chat", name);
	}
});

test("session inspection failures stay nonzero when successful commands follow the report", (t) => {
	const f = fixture(t);
	f.env.AUDIT_MERGED = "yes";
	f.env.PI_CODING_AGENT_SESSION_DIR = join(f.root, "custom sessions");
	recordRecentActivity(f);
	writeFileSync(join(f.bin, "stat"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
	const script = join(f.root, "audit-with-followup.sh");
	writeFileSync(script, `${readFileSync(audit, "utf8")}\ntrue\n`, { mode: 0o755 });
	const result = spawnSync("bash", [script, "-b", f.env.AUDIT_BASE, f.repo], { cwd: f.root, env: f.env, encoding: "utf8" });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /session/i);
});

test("recent activity survives GNU-only stat and date interfaces", (t) => {
	const f = fixture(t);
	f.env.AUDIT_MERGED = "yes";
	recordRecentActivity(f);
	writeFileSync(join(f.bin, "stat"), `#!/usr/bin/env node
import { statSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] !== "-c" || args[1] !== "%Y") process.exit(1);
console.log(Math.floor(statSync(args[2]).mtimeMs / 1000));
`, { mode: 0o755 });
	writeFileSync(join(f.bin, "date"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "+%s") console.log(Math.floor(Date.now() / 1000));
else if (args[0] === "-d" && args[1].startsWith("@")) console.log(new Date(Number(args[1].slice(1)) * 1000).toISOString().slice(0, 10));
else process.exit(1);
`, { mode: 0o755 });
	const result = f.run();
	assert.match(result.lastChat, /^\d{4}-\d{2}-\d{2}$/);
	assert.equal(result.bucket, "verify-recent-chat");
});

test("recent activity is read with GNU stat and date, where `stat -f` is file system status", (t) => {
	const f = fixture(t);
	f.env.AUDIT_MERGED = "yes";
	// GNU stat accepts `-c`, and treats `-f` as file system status: it exits 0 and prints text
	// that is not a timestamp. GNU date reads `-r` as a file name and takes a timestamp from `-d @N`.
	writeFileSync(join(f.bin, "stat"), `#!/usr/bin/env node
import { statSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "-c") { console.log(Math.floor(statSync(args.at(-1)).mtimeMs / 1000)); process.exit(0); }
if (args[0] === "-f") { console.log("  File: \\"" + args.at(-1) + "\\"\\n    ID: 0 Namelen: 255 Type: ext2/ext3"); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });
	writeFileSync(join(f.bin, "date"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "-d" && args[1].startsWith("@")) { console.log(new Date(Number(args[1].slice(1)) * 1000).toISOString().slice(0, 10)); process.exit(0); }
console.error("date: invalid date or missing file: " + args.join(" ")); process.exit(1);
`, { mode: 0o755 });
	recordRecentActivity(f);
	const row = f.run();
	assert.equal(row.bucket, "verify-recent-chat");
	assert.match(row.lastChat, /^\d{4}-\d{2}-\d{2}$/);
});
