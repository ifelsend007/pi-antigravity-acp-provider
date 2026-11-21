import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadTransport } from "../config.js";
import { antigravityCliBinary, expandHome, installedCliVersions, resolveCliRoot } from "./cli-install.js";

/** The official Antigravity CLI ships as `agy` and speaks ACP over stdio once
 * started as `agy acp`. Unlike the community ACP server it advertises the full
 * account catalog (Claude, GPT-OSS, orchestrators) and owns its own login. */
export interface AntigravityCliLocation {
	path: string;
	source: string;
}

/** Candidate install locations, most explicit first: configured path, environment
 * override, the plugin's own managed copies, then the CLI's state directory and
 * the desktop app's bundled copy. An explicit pin must win over anything the
 * plugin installed itself. */
export interface AntigravityCliLookupOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	home?: string;
}

export function antigravityCliCandidates(
	options: AntigravityCliLookupOptions & { cliPath?: string | null | undefined; cliRoot?: string | null | undefined } = {},
): AntigravityCliLocation[] {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = options.home ?? os.homedir();
	const binary = antigravityCliBinary(platform);
	const candidates: AntigravityCliLocation[] = [];
	const configured = options.cliPath?.trim();
	if (configured) candidates.push({ path: expandHome(configured, home), source: "config cliPath" });
	const override = env.PI_ANTIGRAVITY_CLI?.trim() || env.AGY_CLI?.trim();
	if (override) candidates.push({ path: expandHome(override, home), source: "environment" });
	const root = options.cliRoot?.trim();
	if (root) {
		for (const installed of installedCliVersions(expandHome(root, home), platform)) {
			candidates.push({ path: installed.path, source: `managed ${installed.version}` });
		}
	}
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
	options: AntigravityCliLookupOptions & { cliRoot?: string | null | undefined } = {},
	isExecutable: (file: string) => boolean = executableFileFor(options.platform ?? process.platform),
): AntigravityCliLocation | undefined {
	return antigravityCliCandidates({ ...options, cliPath }).find((candidate) =>
		isExecutable(candidate.path),
	);
}

/** Resolves the CLI from the plugin config in one place: `cliPath` when set and
 * usable, then the managed root's newest copy, then the legacy and PATH locations. */
export function resolveConfiguredCli(options: AntigravityCliLookupOptions = {}): AntigravityCliLocation | undefined {
	const config = loadTransport();
	return resolveAntigravityCli(config.cliPath, {
		...options,
		cliRoot: resolveCliRoot(config.cliRoot, options),
	});
}

function executableFileFor(platform: NodeJS.Platform): (file: string) => boolean {
	return (file) => {
		try {
			const stats = fs.statSync(file);
			if (!stats.isFile()) return false;
			if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	};
}
