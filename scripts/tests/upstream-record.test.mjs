import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { digestEntries, digestUpstream, RECORD_FILE, recordUpstream, syncFrom, verifyUpstream } from "../upstream-record.mjs";

const CLI = fileURLToPath(new URL("../sync-upstream.mjs", import.meta.url));
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";

const BASE = {
	"skills/a/SKILL.md": "# a\n",
	"skills/a/run.sh": { content: "#!/bin/sh\n", exec: true },
	"skills/b/SKILL.md": "# b\n",
	"agents/x.md": "x\n",
	"docs/guide/01.md": "one\n",
	"docs/harness/pi.md": "pi\n",
};

const roots = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Writes `files` under `root`; a string is a plain file, `{ content, exec }` can set the execute bit. */
function writeTree(root, files) {
	for (const [path, spec] of Object.entries(files)) {
		const { content, exec = false } = typeof spec === "string" ? { content: spec } : spec;
		const full = join(root, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
		chmodSync(full, exec ? 0o755 : 0o644);
	}
}

function fixture(files = BASE) {
	const root = mkdtempSync(join(tmpdir(), "upstream-record-"));
	roots.push(root);
	writeTree(root, files);
	return root;
}

/** A tree whose record was written by the library, so it verifies clean until a test breaks it. */
function recorded(files = BASE) {
	const root = fixture(files);
	recordUpstream(root, { commit: COMMIT, version: "1.2.3", syncedAt: "2026-11-07" });
	return root;
}

function rewriteRecord(root, patch) {
	const path = join(root, RECORD_FILE);
	writeFileSync(path, `${JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...patch }, null, 2)}\n`);
}

const TREE_CHANGES = {
	"a changed byte": (root) => writeFileSync(join(root, "skills/a/SKILL.md"), "# A\n"),
	"an added file": (root) => writeFileSync(join(root, "docs/guide/02.md"), "two\n"),
	"an added file in a new directory": (root) => {
		mkdirSync(join(root, "skills/c"));
		writeFileSync(join(root, "skills/c/SKILL.md"), "# c\n");
	},
	"a removed file": (root) => rmSync(join(root, "agents/x.md")),
	"a renamed file": (root) => renameSync(join(root, "agents/x.md"), join(root, "agents/y.md")),
	"a lost execute bit": (root) => chmodSync(join(root, "skills/a/run.sh"), 0o644),
	"a gained execute bit": (root) => chmodSync(join(root, "skills/b/SKILL.md"), 0o755),
	"contents swapped between two files": (root) => {
		writeFileSync(join(root, "skills/a/SKILL.md"), "# b\n");
		writeFileSync(join(root, "skills/b/SKILL.md"), "# a\n");
	},
};

test("the digest does not depend on the order files were created in", () => {
	const reversed = Object.fromEntries(Object.entries(BASE).reverse());
	assert.equal(digestUpstream(fixture(BASE)), digestUpstream(fixture(reversed)));
});

test("the digest does not depend on the order a directory walk returns entries in", () => {
	const entries = [
		{ path: "skills/a/SKILL.md", executable: false, hash: "1".repeat(64) },
		{ path: "skills/a/run.sh", executable: true, hash: "2".repeat(64) },
		{ path: "agents/x.md", executable: false, hash: "3".repeat(64) },
		{ path: "docs/guide/01.md", executable: false, hash: "4".repeat(64) },
	];
	const expected = digestEntries(entries);
	assert.equal(digestEntries([...entries].reverse()), expected);
	assert.equal(digestEntries([...entries.slice(2), ...entries.slice(0, 2)]), expected);
	assert.equal(digestEntries([entries[1], entries[3], entries[0], entries[2]]), expected);
});

test("the digest has the sha256: prefix and 64 hex digits", () => {
	assert.match(digestUpstream(fixture()), /^sha256:[0-9a-f]{64}$/);
});

for (const [name, change] of Object.entries(TREE_CHANGES)) {
	test(`the digest changes with ${name}`, () => {
		const root = fixture();
		const before = digestUpstream(root);
		change(root);
		assert.notEqual(digestUpstream(root), before);
	});
}

test("the digest ignores .DS_Store and the record itself, which are not upstream content", () => {
	const root = fixture();
	const before = digestUpstream(root);
	writeFileSync(join(root, "skills/.DS_Store"), "junk");
	writeFileSync(join(root, RECORD_FILE), "{}");
	assert.equal(digestUpstream(root), before);
});

test("a clean recorded tree verifies", () => {
	assert.deepEqual(verifyUpstream(recorded()), []);
});

test("a missing record is reported", () => {
	const root = recorded();
	rmSync(join(root, RECORD_FILE));
	assert.match(verifyUpstream(root).join("\n"), /\.synced-from.*(missing|not found)/i);
});

test("a record that is not a JSON object is reported", () => {
	for (const body of ["not json", "[]", "null", '"text"', ""]) {
		const root = recorded();
		writeFileSync(join(root, RECORD_FILE), body);
		assert.match(verifyUpstream(root).join("\n"), /JSON object/, `body ${JSON.stringify(body)}`);
	}
});

test("a commit that is not 40 lowercase hex digits is reported", () => {
	for (const commit of ["abc123", "A".repeat(40), "a".repeat(41), "g".repeat(40), 123, null, undefined]) {
		const root = recorded();
		rewriteRecord(root, { commit });
		assert.match(verifyUpstream(root).join("\n"), /commit/, `commit ${String(commit)}`);
	}
});

test("a missing or empty version is reported", () => {
	for (const version of [undefined, "", 7]) {
		const root = recorded();
		rewriteRecord(root, { version });
		assert.match(verifyUpstream(root).join("\n"), /version/, `version ${String(version)}`);
	}
});

test("a syncedAt that is not a calendar date is reported", () => {
	for (const syncedAt of ["2026-13-01", "2026-02-30", "11/07/2026", "2026-11-07T00:00:00Z", undefined]) {
		const root = recorded();
		rewriteRecord(root, { syncedAt });
		assert.match(verifyUpstream(root).join("\n"), /syncedAt/, `syncedAt ${String(syncedAt)}`);
	}
});

test("a digest that is malformed or missing is reported", () => {
	for (const digest of ["abc", `sha256:${"A".repeat(64)}`, `sha256:${"a".repeat(63)}`, undefined]) {
		const root = recorded();
		rewriteRecord(root, { digest });
		assert.match(verifyUpstream(root).join("\n"), /digest must be/, `digest ${String(digest)}`);
	}
});

test("a symlink under upstream/ is reported rather than recorded as a file", () => {
	const root = recorded();
	symlinkSync("../b/SKILL.md", join(root, "skills/a/link.md"));
	assert.match(verifyUpstream(root).join("\n"), /symlink/);
});

test("sync refuses a source containing a symlink and leaves upstream untouched", () => {
	const pstack = pstackFixture();
	symlinkSync("../b/SKILL.md", join(pstack, "skills/a/link.md"));
	const upstream = recorded();
	const before = digestUpstream(upstream);

	assert.throws(() => syncFrom({ pstackDir: pstack, upstreamDir: upstream, commit: OTHER_COMMIT, syncedAt: "2026-11-08" }), /symlink/);

	assert.equal(digestUpstream(upstream), before);
	assert.deepEqual(readdirSync(upstream).sort(), [RECORD_FILE, "agents", "docs", "skills"]);
});

for (const [name, change] of Object.entries(TREE_CHANGES)) {
	test(`a hand edit to upstream/ is reported: ${name}`, () => {
		const root = recorded();
		change(root);
		assert.match(verifyUpstream(root).join("\n"), /does not match|hand/i);
	});
}

test("the offline check trusts the digest and never the commit: only a content change makes it fail", () => {
	const root = recorded();
	rewriteRecord(root, { commit: OTHER_COMMIT });
	assert.deepEqual(verifyUpstream(root), []);
	TREE_CHANGES["a changed byte"](root);
	assert.notDeepEqual(verifyUpstream(root), []);
});

function pstackFixture(extra = {}) {
	return fixture({
		...BASE,
		"plugin.json": JSON.stringify({ name: "pstack", version: "9.9.9" }),
		"README.md": "not mirrored\n",
		"automations/pack/README.md": "not mirrored\n",
		...extra,
	});
}

test("sync mirrors skills, agents and docs, removes stale files, and records the source", () => {
	const pstack = pstackFixture({ "skills/new/SKILL.md": "# new\n" });
	const upstream = fixture({
		"skills/old/SKILL.md": "# stale\n",
		"agents/stale.md": "stale\n",
		"docs/stale/x.md": "stale\n",
	});

	syncFrom({ pstackDir: pstack, upstreamDir: upstream, commit: COMMIT, syncedAt: "2026-11-07" });

	assert.equal(existsSync(join(upstream, "skills/old")), false);
	assert.equal(existsSync(join(upstream, "agents/stale.md")), false);
	assert.equal(existsSync(join(upstream, "docs/stale")), false);
	assert.equal(readFileSync(join(upstream, "skills/new/SKILL.md"), "utf8"), "# new\n");
	assert.equal(existsSync(join(upstream, "automations")), false);
	assert.equal(existsSync(join(upstream, "README.md")), false);
	assert.equal(existsSync(join(upstream, "plugin.json")), false);
	assert.deepEqual(JSON.parse(readFileSync(join(upstream, RECORD_FILE), "utf8")), {
		commit: COMMIT,
		version: "9.9.9",
		syncedAt: "2026-11-07",
		digest: digestUpstream(upstream),
	});
	assert.deepEqual(verifyUpstream(upstream), []);
});

test("sync keeps the execute bit of upstream scripts", () => {
	const pstack = pstackFixture();
	const upstream = fixture({ "skills/old/SKILL.md": "x" });
	syncFrom({ pstackDir: pstack, upstreamDir: upstream, commit: COMMIT, syncedAt: "2026-11-07" });
	assert.equal(statSync(join(upstream, "skills/a/run.sh")).mode & 0o111, 0o111);
	assert.equal(statSync(join(upstream, "skills/a/SKILL.md")).mode & 0o111, 0);
});

test("sync twice from the same source gives the same digest", () => {
	const pstack = pstackFixture();
	const upstream = fixture({});
	syncFrom({ pstackDir: pstack, upstreamDir: upstream, commit: COMMIT, syncedAt: "2026-11-07" });
	const first = digestUpstream(upstream);
	syncFrom({ pstackDir: pstack, upstreamDir: upstream, commit: COMMIT, syncedAt: "2026-11-08" });
	assert.equal(digestUpstream(upstream), first);
});

test("sync refuses a source missing one of the mirrored directories and leaves upstream untouched", () => {
	for (const missing of ["skills", "agents", "docs"]) {
		const pstack = pstackFixture();
		rmSync(join(pstack, missing), { recursive: true });
		const upstream = recorded();
		const before = { digest: digestUpstream(upstream), record: readFileSync(join(upstream, RECORD_FILE), "utf8") };

		assert.throws(
			() => syncFrom({ pstackDir: pstack, upstreamDir: upstream, commit: OTHER_COMMIT, syncedAt: "2026-11-08" }),
			new RegExp(`no ${missing}/ directory, so it is not a pstack checkout`),
		);

		assert.equal(digestUpstream(upstream), before.digest, `${missing}: tree changed`);
		assert.equal(readFileSync(join(upstream, RECORD_FILE), "utf8"), before.record, `${missing}: record changed`);
	}
});

test("sync refuses a source without a usable plugin.json version and leaves upstream untouched", () => {
	for (const plugin of [undefined, "not json", JSON.stringify({ name: "pstack" }), JSON.stringify({ version: "" })]) {
		const pstack = pstackFixture();
		if (plugin === undefined) rmSync(join(pstack, "plugin.json"));
		else writeFileSync(join(pstack, "plugin.json"), plugin);
		const upstream = recorded();
		const before = digestUpstream(upstream);

		assert.throws(() => syncFrom({ pstackDir: pstack, upstreamDir: upstream, commit: OTHER_COMMIT, syncedAt: "2026-11-08" }), /plugin\.json/);

		assert.equal(digestUpstream(upstream), before, `plugin ${String(plugin)}: tree changed`);
	}
});

test("sync refuses a commit that is not a full lowercase SHA and leaves upstream untouched", () => {
	for (const commit of ["main", "HEAD", "abc123", "A".repeat(40)]) {
		const pstack = pstackFixture({ "skills/new/SKILL.md": "# new\n" });
		const upstream = recorded();
		const before = digestUpstream(upstream);

		assert.throws(() => syncFrom({ pstackDir: pstack, upstreamDir: upstream, commit, syncedAt: "2026-11-07" }), /commit/);

		assert.equal(digestUpstream(upstream), before, `commit ${commit}: tree changed`);
		assert.equal(existsSync(join(upstream, "skills/new")), false, `commit ${commit}: new skill was mirrored`);
	}
});

test("sync leaves nothing behind in upstream/ besides the mirrored directories and the record", () => {
	const upstream = fixture({});
	syncFrom({ pstackDir: pstackFixture(), upstreamDir: upstream, commit: COMMIT, syncedAt: "2026-11-07" });
	assert.deepEqual(readdirSync(upstream).sort(), [RECORD_FILE, "agents", "docs", "skills"]);
});

test("npm run check runs the upstream check and CI runs npm run check, so a hand-edited upstream/ fails the build", () => {
	const { scripts } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
	assert.equal(scripts["check:upstream"], "node scripts/sync-upstream.mjs --check");
	assert.equal(scripts["sync:upstream"], "node scripts/sync-upstream.mjs");
	assert.match(scripts.check, /(^|&& )npm run check:upstream($| &&)/);

	const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
	assert.match(workflow, /^\s+run: npm run check\s*$/m);
});

test("a failed fetch exits 1 with a one-line message and leaves upstream/ untouched", () => {
	const upstream = recorded();
	const before = digestUpstream(upstream);

	// With no PATH the CLI cannot find git, the same failure shape as a fetch that cannot reach GitHub.
	const result = spawnSync(process.execPath, [CLI, "--upstream", upstream], { encoding: "utf8", env: { ...process.env, PATH: "" } });

	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /^sync failed: /m);
	assert.doesNotMatch(result.stderr, /\n\s+at /, "a stack trace leaked");
	assert.equal(digestUpstream(upstream), before);
	assert.deepEqual(readdirSync(upstream).sort(), [RECORD_FILE, "agents", "docs", "skills"]);
});

test("an unknown argument exits 2 with the usage line", () => {
	const result = spawnSync(process.execPath, [CLI, "--bogus"], { encoding: "utf8" });
	assert.equal(result.status, 2, result.stdout + result.stderr);
	assert.match(result.stderr, /unknown argument --bogus[\s\S]*usage:/);
});

function runCheck(upstream) {
	return spawnSync(process.execPath, [CLI, "--check", "--upstream", upstream], { encoding: "utf8" });
}

test("the check command exits 0 on a clean tree", () => {
	const result = runCheck(recorded());
	assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("the check command exits 1 and names the problem when upstream/ was edited by hand", () => {
	for (const [name, change] of Object.entries(TREE_CHANGES)) {
		const root = recorded();
		change(root);
		const result = runCheck(root);
		assert.equal(result.status, 1, `${name}: ${result.stdout}${result.stderr}`);
		assert.match(result.stdout, /does not match/, name);
	}
});

test("the check command exits 1 when the record is missing", () => {
	const root = recorded();
	rmSync(join(root, RECORD_FILE));
	const result = runCheck(root);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, /\.synced-from/);
});
