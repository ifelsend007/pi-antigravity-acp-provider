import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The official Antigravity CLI ships as `agy` and speaks ACP over stdio once
 * started as `agy acp`. Unlike the community ACP server it advertises the full
 * account catalog (Claude, GPT-OSS, orchestrators) and owns its own login. */
export interface AntigravityCliLocation {
	path: string;
	source: string;
}

export function antigravityCliBinary(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "agy.exe" : "agy";
}

/** Candidate install locations, most explicit first: configured path, the
 * plugin's own managed copy, the CLI's state directory, then the desktop app's
 * bundled copy. */
export function antigravityCliCandidates(
	options: {
		cliPath?: string | null | undefined;
		env?: NodeJS.ProcessEnv;
		platform?: NodeJS.Platform;
		home?: string;
	} = {},
): AntigravityCliLocation[] {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = options.home ?? os.homedir();
	const binary = antigravityCliBinary(platform);
	const candidates: AntigravityCliLocation[] = [];
	const configured = options.cliPath?.trim();
	if (configured) candidates.push({ path: configured, source: "config cliPath" });
	const override = env.PI_ANTIGRAVITY_CLI?.trim() || env.AGY_CLI?.trim();
	if (override) candidates.push({ path: override, source: "environment" });
	const appData = env.LOCALAPPDATA?.trim();
	if (appData) candidates.push({ path: path.join(appData, "Programs", "Antigravity", binary), source: "desktop app" });
	for (const directory of [
		path.join(home, ".gemini", "antigravity-cli", "bin"),
		path.join(home, ".gemini", "antigravity", "bin"),
	]) {
		candidates.push({ path: path.join(directory, binary), source: "user install" });
	}
	for (const directory of (env.PATH ?? "").split(path.delimiter)) {
		if (!directory.trim()) continue;
		candidates.push({ path: path.join(directory, binary), source: "PATH" });
	}
	return candidates;
}

export function resolveAntigravityCli(
	cliPath?: string | null | undefined,
	options: Omit<Parameters<typeof antigravityCliCandidates>[0], "cliPath"> = {},
	isExecutable: (file: string) => boolean = executableFile,
): AntigravityCliLocation | undefined {
	return antigravityCliCandidates({ ...options, cliPath }).find((candidate) =>
		isExecutable(candidate.path),
	);
}

function executableFile(file: string): boolean {
	try {
		const stats = fs.statSync(file);
		if (!stats.isFile()) return false;
		if (process.platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
