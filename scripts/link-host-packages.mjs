#!/usr/bin/env node
/**
 * Links the host's Pi packages into this repo's `node_modules`, so the extension's tests and
 * typecheck can resolve them outside a Pi session.
 *
 * Pi supplies these packages to extensions at runtime and they must not be installed as
 * dependencies, so a plain `node --test` or `tsc` run cannot resolve them. The links point at
 * the release the installed Pi actually runs. The launcher at `~/.pi/agent/bin/pi` reads
 * `install/current-version`; `PI_VERSION` is only the fallback, because it can lag behind.
 *
 * Run it from the package root (`npm test` and `npm run typecheck` run it first):
 *
 *   node scripts/link-host-packages.mjs
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_MODULES = join(ROOT, "node_modules");

/** The packages each Pi release ships, which the extension, its tests and its typecheck import. */
const HOST_PACKAGES = ["@earendil-works/pi-coding-agent", "typebox"];

function agentDir() {
	return process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
}

/**
 * The release directory the installed Pi runs. A version file is the authority: picking the
 * newest folder by name would sort `1.10.0` before `1.9.0`.
 */
export function releaseDir(root = agentDir()) {
	const current = join(root, "install", "current-version");
	const versionFile = existsSync(current) ? current : join(root, "PI_VERSION");
	if (!existsSync(versionFile)) {
		throw new Error(`cannot find ${current} or PI_VERSION; is Pi installed for this user?`);
	}
	const version = readFileSync(versionFile, "utf8").trim();
	const dir = join(root, "install", "releases", version);
	if (!existsSync(dir)) throw new Error(`${versionFile} names ${version}, but ${dir} does not exist`);
	return dir;
}

/**
 * pi-subagents is a Pi package, installed under the agent directory rather than in a release.
 * The tests register the extension's agents through its real registry, so a field it rejects
 * fails the tests instead of every session.
 */
const AGENT_PACKAGES = ["pi-subagents"];

function link(name, source) {
	if (!existsSync(join(source, "package.json"))) throw new Error(`${name} is missing from ${dirname(source)}`);
	const target = join(NODE_MODULES, name);
	mkdirSync(dirname(target), { recursive: true });
	// A dangling symlink is invisible to existsSync, so lstat decides whether to replace it.
	if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) rmSync(target, { recursive: true, force: true });
	symlinkSync(source, target, "dir");
	console.log(`linked ${name} -> ${source}`);
}

// Import-safe: the tests call `releaseDir` without creating links in this repo.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const release = releaseDir();
	for (const name of HOST_PACKAGES) link(name, join(release, "node_modules", name));
	for (const name of AGENT_PACKAGES) link(name, join(agentDir(), "npm", "node_modules", name));
}
