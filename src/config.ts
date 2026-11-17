import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type PermissionMode = "default" | "auto_edit" | "yolo";
export type RuntimeUpdateMode = "automatic" | "notify" | "manual";

export interface AntigravityAcpConfig {
	permissions: PermissionMode;
	runtimeUpdates: RuntimeUpdateMode;
}

export function resolvePiAgentDir(): string {
	const custom = process.env.PI_CODING_AGENT_DIR?.trim();
	if (custom) {
		return custom === "~" || custom.startsWith("~/")
			? path.join(os.homedir(), custom.slice(1))
			: custom;
	}
	return path.join(os.homedir(), ".pi", "agent");
}

export function resolveConfigRoot(): string {
	return path.join(resolvePiAgentDir(), "antigravity-acp-provider");
}

export function resolveConfigPath(): string {
	return path.join(resolveConfigRoot(), "config.json");
}

export function resolveDefaultPiConfigPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "antigravity-acp-provider", "config.json");
}

export function resolveLegacyGeminiConfigPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "gemini-acp-provider", "config.json");
}

export const DEFAULT_CONFIG_PATH = resolveDefaultPiConfigPath();
export const LEGACY_GEMINI_CONFIG_PATH = resolveLegacyGeminiConfigPath();

export const CONFIG_PATH = resolveConfigPath();

export function loadConfig(file = resolveConfigPath()): AntigravityAcpConfig {
	if (file === resolveConfigPath()) migrateConfig(file);
	const parsed = readConfigFile(file);
	return {
		permissions: isPermissionMode(parsed.permissions) ? parsed.permissions : "yolo",
		runtimeUpdates: isRuntimeUpdateMode(parsed.runtimeUpdates) ? parsed.runtimeUpdates : "automatic",
	};
}

/** Directory the Antigravity server unpacks itself into, when the user picked
 * one. Kept out of `AntigravityAcpConfig` because that type is the wizard's
 * three toggles; hand-edited keys like this one survive a wizard write. */
export function loadLaunchTempRoot(file = resolveConfigPath()): string | null {
	const value = readConfigFile(file).launchTempRoot;
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function savePermissionMode(mode: PermissionMode, file = resolveConfigPath()): void {
	writeConfig({ ...loadConfig(file), permissions: mode }, file);
}

export function saveRuntimeUpdateMode(mode: RuntimeUpdateMode, file = resolveConfigPath()): void {
	writeConfig({ ...loadConfig(file), runtimeUpdates: mode }, file);
}

function writeConfig(config: AntigravityAcpConfig, file: string): void {
	const directory = path.dirname(file);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.tmp`;
	// Merge over the file: keys the wizard does not own (launchTempRoot and any
	// future hand-edited setting) must survive a permission or update toggle.
	const merged = { ...readConfigFile(file), ...config };
	fs.writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, file);
}

function readConfigFile(file: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		// Missing or malformed configuration uses the documented defaults.
		return {};
	}
}

function migrateConfig(targetFile = resolveConfigPath()): void {
	if (fs.existsSync(targetFile)) return;

	const defaultPiConfig = resolveDefaultPiConfigPath();
	if (targetFile !== defaultPiConfig && fs.existsSync(defaultPiConfig)) {
		copyConfig(defaultPiConfig, targetFile);
		return;
	}

	const legacyGeminiConfig = resolveLegacyGeminiConfigPath();
	if (fs.existsSync(legacyGeminiConfig)) {
		copyConfig(legacyGeminiConfig, targetFile);
		return;
	}
}

function copyConfig(source: string, destination: string): void {
	try {
		fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
		fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
		fs.chmodSync(destination, 0o600);
	} catch {
		// Migration is best-effort; defaults remain available.
	}
}

export function isPermissionMode(value: unknown): value is PermissionMode {
	return value === "default" || value === "auto_edit" || value === "yolo";
}

export function isRuntimeUpdateMode(value: unknown): value is RuntimeUpdateMode {
	return value === "automatic" || value === "notify" || value === "manual";
}

export function permissionModeLabel(mode: PermissionMode): string {
	if (mode === "auto_edit") return "auto-edit";
	return mode;
}
