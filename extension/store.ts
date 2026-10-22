/**
 * Persistence for the pstack role map.
 *
 * Upstream pstack writes `~/.cursor/rules/pstack-models.mdc`. Pi has no always-applied rule
 * file, so the map lives as JSON under the Pi agent directory, where it survives reloads and is
 * shared by every session of the same user.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isBudget, ROLES, seatsOf, type RoleEntry, type RoleMap } from "./roles.ts";

/** The role map's home inside the Pi agent directory. */
export function roleMapPath(): string {
	return join(getAgentDir(), "state", "pi-pstack", "models.json");
}

/** A parse result. Warnings name what was dropped, so a hand edit never disappears silently. */
export interface ParsedRoleMap {
	readonly map?: RoleMap;
	readonly warnings: readonly string[];
}

/**
 * Reads one role's value. The extension writes the object form, `{ "value": ... }`, which says
 * whether the role has one seat or several. A bare string or list is also accepted, so a
 * hand-written map works.
 */
function asRoleEntry(value: unknown): RoleEntry | undefined {
	if (typeof value === "string") return value.trim() === "" ? undefined : { value: value.trim() };
	if (Array.isArray(value)) {
		const seats = value.flatMap((seat) => (typeof seat === "string" && seat.trim() !== "" ? [seat.trim()] : []));
		return seats.length === value.length && seats.length > 0 ? { value: seats } : undefined;
	}
	if (value !== null && typeof value === "object") return asRoleEntry((value as { value?: unknown }).value);
	return undefined;
}

/**
 * Parses a stored role map. A map without a valid budget is rejected whole, because the budget
 * decides every role's level. A role whose name upstream no longer defines is retired and
 * dropped, and a role whose value cannot be read is dropped; both are reported.
 */
export function parseRoleMap(raw: unknown): ParsedRoleMap {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { warnings: ["the role map is not a JSON object"] };
	}
	const record = raw as Record<string, unknown>;
	if (!isBudget(record.budget)) {
		return { warnings: [`the role map's budget ${JSON.stringify(record.budget)} is not unlimited, large, medium, or small`] };
	}
	const warnings: string[] = [];
	const roles: Record<string, RoleEntry> = {};
	const source = record.roles;
	if (source !== null && typeof source === "object" && !Array.isArray(source)) {
		for (const [role, value] of Object.entries(source as Record<string, unknown>)) {
			const spec = ROLES.find((candidate) => candidate.name === role);
			if (!spec) {
				warnings.push(`dropped retired role "${role}"`);
				continue;
			}
			const entry = asRoleEntry(value);
			if (!entry) {
				warnings.push(`dropped role "${role}": its value is not a model id or a list of model ids`);
				continue;
			}
			// One subagent runs per seat, so a list of the wrong length changes the fan-out.
			const count = seatsOf(entry).length;
			if (count !== spec.seats) {
				warnings.push(`dropped role "${role}": it has ${count} model(s), and the role takes ${spec.seats}`);
				continue;
			}
			roles[role] = entry;
		}
	} else if (source !== undefined) {
		warnings.push("the role map's roles field is not an object");
	}
	return { map: { budget: record.budget, roles }, warnings };
}

/**
 * Reads the stored role map. A missing file is the normal state before setup and is not a
 * warning. An unreadable or malformed file is reported, because ignoring it silently would run
 * every role on a default the user did not choose.
 */
export async function readRoleMap(): Promise<ParsedRoleMap> {
	let text: string;
	try {
		text = await readFile(roleMapPath(), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { warnings: [] };
		return { warnings: [`could not read ${roleMapPath()}: ${(error as Error).message}`] };
	}
	try {
		return parseRoleMap(JSON.parse(text));
	} catch (error) {
		return { warnings: [`${roleMapPath()} is not valid JSON: ${(error as Error).message}`] };
	}
}

/**
 * Writes the role map to a temporary file and renames it over the target. A rename is atomic on
 * one filesystem, so a crash never leaves a truncated map that would parse as broken.
 */
export async function writeRoleMap(map: RoleMap): Promise<void> {
	const path = roleMapPath();
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(map, null, 2)}\n`, "utf8");
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

/** A merged map, and the stored roles that were replaced because a seat no longer launches. */
export interface MergedRoleMap {
	readonly map: RoleMap;
	readonly replaced: readonly string[];
}

/**
 * Merges a stored map over a freshly resolved one. A stored role is the user's choice, so it
 * wins, as long as every seat still resolves. `normalize` returns the entry rewritten to full
 * `provider/id` values, or undefined when a seat does not resolve; such a role is re-resolved
 * whole, so a panel keeps its size and its family spread, and its name is reported. The budget
 * comes from the new run.
 */
export function mergeRoleMaps(
	resolved: RoleMap,
	stored: RoleMap | undefined,
	normalize: (entry: RoleEntry) => RoleEntry | undefined,
): MergedRoleMap {
	if (!stored) return { map: resolved, replaced: [] };
	const roles: Record<string, RoleEntry> = { ...resolved.roles };
	const replaced: string[] = [];
	for (const [role, entry] of Object.entries(stored.roles)) {
		const kept = normalize(entry);
		if (kept) roles[role] = kept;
		else replaced.push(role);
	}
	return { map: { budget: resolved.budget, roles }, replaced };
}
