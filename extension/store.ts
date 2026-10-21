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
import type { BudgetLabel, RoleEntry, RoleMap, RoleValue } from "./roles.ts";
import { BUDGET_EFFORT, isInherit, isPanel, UPSTREAM_ROLE_DEFAULTS } from "./roles.ts";

/** The role map's home inside the Pi agent directory. */
export function roleMapPath(): string {
	return join(getAgentDir(), "state", "pi-pstack", "models.json");
}

const BUDGETS: readonly BudgetLabel[] = ["unlimited", "large", "medium", "small"];

function isBudget(value: unknown): value is BudgetLabel {
	return typeof value === "string" && (BUDGETS as readonly string[]).includes(value);
}

/**
 * Reads one role's value out of a stored map.
 *
 * The extension writes the object form, `{ "value": "model-id" }`, because a role's value is
 * either one model or a list and the object form names which. A bare string or list is also
 * accepted, so a hand-written map works.
 */
function asRoleEntry(value: unknown): RoleEntry | undefined {
	if (typeof value === "string" && value.trim() !== "") return { value: value.trim() };
	if (Array.isArray(value)) {
		const list = value
			.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
			.map((entry) => entry.trim());
		return list.length > 0 ? { value: list } : undefined;
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return asRoleEntry((value as { value?: unknown }).value);
	}
	return undefined;
}

/**
 * Parses a stored role map. An unreadable or malformed file yields undefined so the caller can
 * fall back to the defaults rather than running with a half-parsed map.
 */
export function parseRoleMap(raw: unknown): RoleMap | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	if (!isBudget(record.budget)) return undefined;
	const roles: Record<string, RoleEntry> = {};
	const source = record.roles;
	if (source && typeof source === "object" && !Array.isArray(source)) {
		for (const [role, value] of Object.entries(source as Record<string, unknown>)) {
			const entry = asRoleEntry(value);
			if (entry) roles[role] = entry;
		}
	}
	return { budget: record.budget, roles };
}

/** Reads the stored role map, or undefined when there is none or it is unreadable. */
export async function readRoleMap(): Promise<RoleMap | undefined> {
	try {
		const raw = await readFile(roleMapPath(), "utf8");
		return parseRoleMap(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

/**
 * Writes the role map.
 *
 * The write goes to a temporary file and is then renamed over the target, because a rename is
 * atomic on the same filesystem. A direct write can leave a truncated file when the process
 * dies mid-write, and a truncated file parses as a broken map, which would silently discard
 * the user's choices.
 */
export async function writeRoleMap(map: RoleMap): Promise<void> {
	const path = roleMapPath();
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(map, null, 2)}\n`, "utf8");
		await rename(temporary, path);
	} catch (error) {
		// A failed rename leaves the temporary file behind. It is not the map, and a stale
		// temporary file would be read as one if the name ever collided.
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

/**
 * Merges a freshly resolved map over the stored one.
 *
 * A stored role is the user's own choice, so it wins over the resolved default. Upstream
 * behaves the same way: a re-run of setup keeps any role the user changed and only fills in
 * the roles that are missing.
 *
 * A stored role that names a model the session can no longer launch is dropped, because
 * keeping it would make the role fail at spawn time. The dropped role falls back to the
 * resolved default.
 */
export function mergeRoleMaps(resolved: RoleMap, stored: RoleMap | undefined, isUsable: (modelId: string) => boolean): RoleMap {
	if (!stored) return resolved;
	const roles: Record<string, RoleEntry> = { ...resolved.roles };
	for (const [role, entry] of Object.entries(stored.roles)) {
		const values = isPanel(entry) ? entry.value : [entry.value as RoleValue];
		const usable = values.every((value) => isInherit(value) || isUsable(value));
		if (usable) roles[role] = entry;
	}
	return { budget: resolved.budget, roles };
}

/**
 * The role map used when nothing is stored. It mirrors upstream's default shape but resolves
 * against the models the user actually has, so a fresh install works without running setup.
 *
 * The resolver is told which role it is resolving and which entry of a panel it is resolving.
 * Both matter: a role decides the kind of model the work needs, and a panel exists to compare
 * models, so two entries that resolve to the same model make the comparison worthless.
 */
export function defaultRoleMap(
	resolve: (value: RoleValue, budget: BudgetLabel, role: string, index: number) => RoleValue | undefined,
	budget: BudgetLabel = "large",
): RoleMap {
	const roles: Record<string, RoleEntry> = {};
	for (const [role, values] of Object.entries(UPSTREAM_ROLE_DEFAULTS)) {
		const resolved = values
			.map((value, index) => resolve(value, budget, role, index))
			.filter((value): value is RoleValue => value !== undefined);
		if (resolved.length === 0) continue;
		roles[role] = resolved.length === 1 ? { value: resolved[0] } : { value: resolved };
	}
	return { budget, roles };
}

/** The reasoning effort a budget maps to, as the string pi-subagents expects. */
export function budgetEffort(budget: BudgetLabel): string {
	return BUDGET_EFFORT[budget];
}
