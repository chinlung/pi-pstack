#!/usr/bin/env node
/**
 * Mirrors upstream pstack into `upstream/` and records which commit it came from.
 *
 *   node scripts/sync-upstream.mjs               # mirror cursor/plugins' default branch
 *   node scripts/sync-upstream.mjs --ref <ref>   # a branch, a tag or a full commit SHA instead
 *   node scripts/sync-upstream.mjs --check       # offline: is upstream/ still what .synced-from says?
 *
 * `--upstream <dir>` points either mode at another directory, which the tests use.
 *
 * After a sync, run `npm run port:skills`, fix the rules that went dead, and run `npm run check`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncFrom, verifyUpstream } from "./upstream-record.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE = "https://github.com/cursor/plugins.git";
const USAGE = "usage: node scripts/sync-upstream.mjs [--check] [--ref <ref>] [--upstream <dir>]";

function parse(argv) {
	const options = { check: false, ref: "HEAD", upstream: join(ROOT, "upstream") };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--check") options.check = true;
		else if (arg === "--ref" || arg === "--upstream") {
			const value = argv[++index];
			if (value === undefined) throw new Error(`${arg} needs a value`);
			options[arg.slice(2)] = value;
		} else throw new Error(`unknown argument ${arg}`);
	}
	return options;
}

function git(cwd, args) {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		stdio: ["ignore", "pipe", "inherit"],
	}).trim();
}

/** A checkout of `pstack/` at `ref`, and the full commit SHA that `ref` resolved to. */
function fetchPstack(dir, ref) {
	git(dir, ["init", "-q"]);
	git(dir, ["remote", "add", "origin", REMOTE]);
	git(dir, ["sparse-checkout", "set", "pstack"]);
	git(dir, ["fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", ref]);
	git(dir, ["checkout", "-q", "FETCH_HEAD"]);
	const commit = git(dir, ["rev-parse", "HEAD"]);
	// `cat-file -e` is the test that this is a commit: `rev-parse --verify` echoes any 40 hex digits back.
	git(dir, ["cat-file", "-e", `${commit}^{commit}`]);
	if (/^[0-9a-f]{40}$/.test(ref) && ref !== commit) throw new Error(`asked for ${ref} but the checkout is at ${commit}`);
	return commit;
}

function main() {
	let options;
	try {
		options = parse(process.argv.slice(2));
	} catch (error) {
		console.error(`${error.message}\n${USAGE}`);
		return 2;
	}

	if (options.check) {
		const problems = verifyUpstream(options.upstream);
		for (const problem of problems) console.log(`FAIL ${problem}`);
		if (problems.length > 0) return 1;
		console.log("upstream/ matches .synced-from.");
		return 0;
	}

	const work = mkdtempSync(join(tmpdir(), "pstack-upstream-"));
	try {
		const commit = fetchPstack(work, options.ref);
		const record = syncFrom({
			pstackDir: join(work, "pstack"),
			upstreamDir: options.upstream,
			commit,
			syncedAt: new Date().toISOString().slice(0, 10),
		});
		console.log(`mirrored pstack ${record.version} at ${record.commit} into ${options.upstream}`);
		console.log("next: npm run port:skills, fix any dead rules, then npm run check");
		return 0;
	} catch (error) {
		console.error(`sync failed: ${error.message}`);
		return 1;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

process.exitCode = main();
