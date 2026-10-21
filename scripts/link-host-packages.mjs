#!/usr/bin/env node
/**
 * Links the host's Pi packages into this repo's `node_modules`, so the extension's tests can
 * resolve `@earendil-works/pi-coding-agent` outside a Pi session.
 *
 * Pi supplies that package to extensions at runtime, so a plain `node --test` run cannot
 * resolve it. The link points at the installed host release, which is the same code the
 * extension runs against.
 *
 * Run it from the package root:
 *
 *   node scripts/link-host-packages.mjs
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_MODULES = join(ROOT, "node_modules");

/** The host packages the extension and its tests import. */
const HOST_PACKAGES = ["@earendil-works/pi-coding-agent"];

/** The agent directory Pi is running from. */
function agentDir() {
	return process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
}

/**
 * The installed host release. Pi keeps its packages under `install/releases/<version>`, and
 * the version directory is what a running Pi actually loads.
 */
function hostPackageDir(name) {
	const releaseRoot = join(agentDir(), "install", "releases");
	if (!existsSync(releaseRoot)) return undefined;
	const versions = readdirSync(releaseRoot)
		.filter((entry) => existsSync(join(releaseRoot, entry, "node_modules", name, "package.json")))
		.sort();
	if (versions.length === 0) return undefined;
	// The newest release is the one a current Pi runs.
	return join(releaseRoot, versions.at(-1), "node_modules", name);
}

let linked = 0;
for (const name of HOST_PACKAGES) {
	const source = hostPackageDir(name);
	if (!source) {
		console.log(`skip ${name}: no installed host release found under ${agentDir()}/install/releases`);
		continue;
	}
	const target = join(NODE_MODULES, name);
	mkdirSync(dirname(target), { recursive: true });
	// A symlink is not an existing directory as far as `existsSync` is concerned, so it needs
	// its own check before the replace.
	const targetExists = existsSync(target) || lstatSync(target, { throwIfNoEntry: false }) !== undefined;
	if (targetExists) rmSync(target, { recursive: true, force: true });
	symlinkSync(source, target, "dir");
	console.log(`linked ${name} -> ${source}`);
	linked++;
}

if (linked === 0) {
	console.log("No host package was linked. The extension's tests need @earendil-works/pi-coding-agent.");
	process.exit(1);
}
