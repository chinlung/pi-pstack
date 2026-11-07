/**
 * What `upstream/` was copied from, and a check that it still is.
 *
 * `upstream/` is a verbatim mirror of three directories of cursor/plugins' `pstack/`. Nothing in
 * the tree says which upstream commit it came from, so the next sync had to guess the base by
 * diffing candidate commits. `upstream/.synced-from` records it, and a digest of the mirrored
 * files lets an offline check tell "still the mirror" from "somebody edited the read-only copy".
 *
 * This module only touches the filesystem. `scripts/sync-upstream.mjs` does the network part.
 */
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The directories of upstream's `pstack/` that `upstream/` mirrors. Everything else is ignored. */
export const MIRRORED = ["skills", "agents", "docs"];

/** Where the record lives, inside `upstream/`. The port never reads it: it walks the subdirectories. */
export const RECORD_FILE = ".synced-from";

const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Editor and OS litter that is not upstream content, and that the port's own `walk` skips too. */
const IGNORED = new Set([".DS_Store"]);

/**
 * Every file under `dir` as a path relative to `dir`. The order is whatever the filesystem
 * returns, so callers that need a fixed one must sort. A symlink throws: the mirror copies
 * bytes, so a link would be recorded as something it is not.
 */
function files(dir, prefix = "") {
	const found = [];
	for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
		if (IGNORED.has(entry.name)) continue;
		const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isSymbolicLink()) throw new Error(`${join(dir, path)} is a symlink, which the mirror does not support`);
		if (entry.isDirectory()) found.push(...files(dir, path));
		else found.push(path);
	}
	return found;
}

const isExecutable = (path) => (statSync(path).mode & 0o111) !== 0;

/**
 * The digest of a list of `{ path, executable, hash }` entries, whatever order they come in:
 * for each one, in path order, whether it is executable, the hash of its bytes, and its path.
 * The execute bit counts because a skill runs some of its scripts directly, and a lost bit is a
 * broken step that no byte comparison would show. The sort is here, not in the directory walk,
 * because APFS happens to list names in order and ext4 does not, so only this function can be
 * tested for it on every machine.
 */
export function digestEntries(entries) {
	const hash = createHash("sha256");
	const byPath = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	for (const { path, executable, hash: bytes } of byPath) {
		hash.update(`${executable ? "x" : "-"} ${bytes} ${JSON.stringify(path)}\n`);
	}
	return `sha256:${hash.digest("hex")}`;
}

/** The digest of the mirrored directories of `dir`. */
export function digestUpstream(dir) {
	const entries = [];
	for (const top of MIRRORED) {
		if (!existsSync(join(dir, top))) continue;
		for (const path of files(dir, top)) {
			const full = join(dir, path);
			entries.push({
				path,
				executable: isExecutable(full),
				hash: createHash("sha256").update(readFileSync(full)).digest("hex"),
			});
		}
	}
	return digestEntries(entries);
}

function isCalendarDate(value) {
	const match = typeof value === "string" ? DATE.exec(value) : null;
	if (!match) return false;
	const [year, month, day] = match.slice(1).map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** The problems with the fields a caller supplies, as messages. */
function fieldProblems({ commit, version, syncedAt }) {
	const problems = [];
	if (typeof commit !== "string" || !COMMIT.test(commit)) problems.push(`commit must be 40 lowercase hex digits, got ${JSON.stringify(commit)}`);
	if (typeof version !== "string" || version === "") problems.push(`version must be a non-empty string, got ${JSON.stringify(version)}`);
	if (!isCalendarDate(syncedAt)) problems.push(`syncedAt must be a YYYY-MM-DD date, got ${JSON.stringify(syncedAt)}`);
	return problems;
}

function requireValid(fields) {
	const problems = fieldProblems(fields);
	if (problems.length > 0) throw new Error(problems.join("; "));
}

/** Writes `upstream/.synced-from` for the files currently in `dir`. */
export function recordUpstream(dir, { commit, version, syncedAt }) {
	requireValid({ commit, version, syncedAt });
	const record = { commit, version, syncedAt, digest: digestUpstream(dir) };
	writeFileSync(join(dir, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
	return record;
}

/**
 * Everything wrong with `dir` as a recorded mirror, as messages; an empty list means it is fine.
 *
 * This is offline, so it proves the files are the ones that were recorded. It cannot prove that
 * the recorded commit exists upstream or that its `pstack/` produced those files; the sync
 * command resolves the commit from a real checkout, which is what makes the record true.
 */
export function verifyUpstream(dir) {
	const path = join(dir, RECORD_FILE);
	if (!existsSync(path)) return [`${RECORD_FILE} is missing from ${dir}; run \`npm run sync:upstream\` to record where it came from`];
	let record;
	try {
		record = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return [`${RECORD_FILE} is not a JSON object`];
	}
	if (record === null || typeof record !== "object" || Array.isArray(record)) return [`${RECORD_FILE} is not a JSON object`];

	const problems = fieldProblems(record).map((problem) => `${RECORD_FILE}: ${problem}`);
	if (typeof record.digest !== "string" || !DIGEST.test(record.digest)) {
		problems.push(`${RECORD_FILE}: digest must be sha256:<64 hex digits>, got ${JSON.stringify(record.digest)}`);
		return problems;
	}
	let actual;
	try {
		actual = digestUpstream(dir);
	} catch (error) {
		return [...problems, error.message];
	}
	if (actual !== record.digest) {
		problems.push(`upstream/ does not match the digest in ${RECORD_FILE}: it was edited by hand, or mirrored without recording. Run \`npm run sync:upstream\``);
	}
	return problems;
}

function readVersion(pstackDir) {
	const path = join(pstackDir, "plugin.json");
	let version;
	try {
		version = JSON.parse(readFileSync(path, "utf8")).version;
	} catch (error) {
		throw new Error(`cannot read a version from ${path}: ${error.message}`);
	}
	if (typeof version !== "string" || version === "") throw new Error(`${path} has no version`);
	return version;
}

/** Copies one mirrored directory, normalising modes to what the digest sees: executable or not. */
function copyTree(from, to) {
	for (const path of files(from)) {
		const source = join(from, path);
		mkdirSync(dirname(join(to, path)), { recursive: true });
		copyFileSync(source, join(to, path));
		chmodSync(join(to, path), isExecutable(source) ? 0o755 : 0o644);
	}
	mkdirSync(to, { recursive: true });
}

/**
 * Replaces the mirrored directories of `upstreamDir` with those of `pstackDir`, then records the
 * source. Everything about the source is checked, and the copy is staged, before anything in
 * `upstreamDir` is removed, so a bad source leaves the old mirror and its record as they were.
 * The swap itself is not atomic: if a rename fails partway, the directories are a mix and the old
 * record no longer matches them. `verifyUpstream` reports that, and running the sync again fixes it.
 */
export function syncFrom({ pstackDir, upstreamDir, commit, syncedAt }) {
	for (const top of MIRRORED) {
		if (!existsSync(join(pstackDir, top))) throw new Error(`${pstackDir} has no ${top}/ directory, so it is not a pstack checkout`);
	}
	const version = readVersion(pstackDir);
	requireValid({ commit, version, syncedAt });

	mkdirSync(upstreamDir, { recursive: true });
	const stage = mkdtempSync(join(upstreamDir, ".sync-"));
	try {
		for (const top of MIRRORED) copyTree(join(pstackDir, top), join(stage, top));
		for (const top of MIRRORED) {
			rmSync(join(upstreamDir, top), { recursive: true, force: true });
			renameSync(join(stage, top), join(upstreamDir, top));
		}
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
	return recordUpstream(upstreamDir, { commit, version, syncedAt });
}
