import { loadTransport, saveCliLocation } from "../config.js";
import { compareCliVersions, type CliRelease } from "./cli-release.js";
import { installedCliVersions, installCliRelease, pruneCliVersions, resolveCliRoot } from "./cli-install.js";
import { resolveConfiguredCli } from "./cli.js";
import { checkCliUpdate, fetchLatestCliRelease, type CliUpdateStatus } from "./cli-version.js";

export interface CliInstallation {
	root: string;
	path?: string;
	source?: string;
	version?: string;
	update: CliUpdateStatus;
}

export interface CliUpgradeResult {
	changed: boolean;
	from?: string;
	to: string;
	path: string;
}

export function describeCliRoot(): string {
	return resolveCliRoot(loadTransport().cliRoot);
}

/** Everything the status command and the startup notice need, resolved from the
 * same config the launcher uses so the report cannot disagree with reality. */
export async function describeCliInstallation(configRoot: string): Promise<CliInstallation> {
	const config = loadTransport();
	const root = resolveCliRoot(config.cliRoot);
	const found = resolveConfiguredCli();
	const update = await checkCliUpdate({
		configRoot,
		...(found ? { binaryPath: found.path } : {}),
	});
	return {
		root,
		...(found ? { path: found.path, source: found.source } : {}),
		...(update.current ? { version: update.current } : {}),
		update,
	};
}

/** Installs the published release into the managed root and repoints `cliPath`
 * at it, so the upgrade takes effect on the next session instead of leaving a
 * stale pinned path behind. */
export async function upgradeCli(onProgress?: (message: string) => void): Promise<CliUpgradeResult> {
	const release: CliRelease | undefined = await fetchLatestCliRelease();
	if (!release) throw new Error("Antigravity CLI release manifest is unavailable");
	const root = resolveCliRoot(loadTransport().cliRoot);
	const current = installedCliVersions(root)[0];
	if (current && compareCliVersions(current.version, release.version) >= 0) {
		return { changed: false, to: current.version, path: current.path };
	}
	const installed = await installCliRelease(release, { root, ...(onProgress ? { onProgress } : {}) });
	saveCliLocation({ cliPath: installed });
	pruneCliVersions(root);
	return { changed: true, ...(current ? { from: current.version } : {}), to: release.version, path: installed };
}
