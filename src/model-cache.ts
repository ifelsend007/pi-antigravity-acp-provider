import fs from "node:fs";
import path from "node:path";

import type { AcpModelInfo } from "./acp/session-state.js";
import { resolveConfigRoot } from "./config.js";

const CACHE_SCHEMA_VERSION = 1;
const MAX_CACHED_MODELS = 200;
const MAX_NAME_LENGTH = 200;
const MAX_ID_LENGTH = 128;

export function resolveModelCachePath(): string {
	return path.join(resolveConfigRoot(), "models-cache.json");
}

/** Last inventory the server actually advertised. Discovery is the only source
 * of truth for what exists, so a later start that cannot reach the network
 * replays real ids instead of a catalog hardcoded here drifting behind every
 * Google release. */
export function readModelCache(file = resolveModelCachePath()): AcpModelInfo[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		// Missing or unreadable cache simply means "nothing cached yet".
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const entry = parsed as { version?: unknown; models?: unknown };
	if (entry.version !== CACHE_SCHEMA_VERSION || !Array.isArray(entry.models)) return undefined;
	const models = normalize(entry.models);
	return models.length > 0 ? models : undefined;
}

/** Persist what the server just advertised so an offline start still shows it.
 * Best effort: a read-only home directory must not fail a discovery refresh. */
export function writeModelCache(
	models: readonly AcpModelInfo[],
	file = resolveModelCachePath(),
	now = Date.now(),
): void {
	const cached = normalize(models);
	if (cached.length === 0) return;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		const temporary = `${file}.${process.pid}.tmp`;
		const payload = { version: CACHE_SCHEMA_VERSION, fetchedAt: now, models: cached };
		fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temporary, file);
	} catch {
		// The cache only saves a round trip after restart; never surface this.
	}
}

/** Drop anything the ACP session could not have produced (control characters,
 * blank or oversized ids) and keep the first name for a repeated id. */
function normalize(candidates: readonly unknown[]): AcpModelInfo[] {
	const unique = new Map<string, AcpModelInfo>();
	for (const candidate of candidates) {
		if (unique.size >= MAX_CACHED_MODELS) break;
		if (!candidate || typeof candidate !== "object") continue;
		const { modelId, name } = candidate as { modelId?: unknown; name?: unknown };
		if (typeof modelId !== "string") continue;
		const id = modelId.trim();
		if (id.length === 0 || id.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(id)) continue;
		if (unique.has(id)) continue;
		const label = typeof name === "string" ? name.trim().slice(0, MAX_NAME_LENGTH) : "";
		unique.set(id, { modelId: id, name: label || id });
	}
	return [...unique.values()];
}
