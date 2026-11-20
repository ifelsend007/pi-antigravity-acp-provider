import type { PermissionMode } from "../config.js";

/** The community server advertises the plugin's own ids; the official CLI names
 * the same three policies `default`, `accept-edits` and `auto`. */
const MODE_ALIASES: Record<PermissionMode, readonly string[]> = {
	default: [],
	auto_edit: ["accept-edits"],
	yolo: ["auto"],
};

const ALIAS_TO_MODE: ReadonlyMap<string, PermissionMode> = new Map(modeEntries());

function modeEntries(): [string, PermissionMode][] {
	const entries: [string, PermissionMode][] = [];
	for (const [mode, aliases] of Object.entries(MODE_ALIASES) as [PermissionMode, readonly string[]][]) {
		entries.push([mode, mode]);
		for (const alias of aliases) entries.push([alias, mode]);
	}
	return entries;
}

/** The id to send for a policy, preferring the plugin's own name so a server that
 * advertises it keeps working exactly as before. */
export function resolveSessionMode(
	mode: PermissionMode,
	available: readonly string[],
): string | undefined {
	return [mode, ...MODE_ALIASES[mode]].find((candidate) => available.includes(candidate));
}

/** Reverse mapping, so a session confirmed on an alias still reports the policy
 * the plugin tracks. */
export function permissionModeOf(modeId: string | undefined): PermissionMode | undefined {
	if (!modeId) return undefined;
	return ALIAS_TO_MODE.get(modeId);
}
