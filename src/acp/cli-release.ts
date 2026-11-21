/** The official CLI publishes a per-platform auto-updater manifest that the
 * binary itself consumes; the plugin reads the same document so an upgrade
 * notice can never invent a version the CLI would not install. */
export const CLI_MANIFEST_BASE =
	"https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";

const RELEASE_ORIGIN = "https://storage.googleapis.com/antigravity-public/antigravity-cli/";
const SHA512 = /^[0-9a-f]{128}$/u;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u;

export interface CliRelease {
	version: string;
	url: string;
	sha512: string;
}

export interface CliPlatform {
	platform: NodeJS.Platform;
	arch: string;
}

/** `<os>_<arch>` as the updater names its manifests; unknown pairs stay
 * unresolved so the caller reports "unsupported" instead of guessing an asset. */
export function cliManifestPlatform({ platform, arch }: CliPlatform): string | undefined {
	if (platform === "win32" && arch === "x64") return "windows_amd64";
	if (platform === "linux" && arch === "x64") return "linux_amd64";
	if (platform === "darwin" && arch === "arm64") return "darwin_arm64";
	if (platform === "darwin" && arch === "x64") return "darwin_amd64";
	return undefined;
}

export function cliManifestUrl(target: CliPlatform): string | undefined {
	const name = cliManifestPlatform(target);
	return name ? `${CLI_MANIFEST_BASE}/${name}.json` : undefined;
}

/** Accepts only the exact shape the updater publishes: https asset under the
 * official bucket and a full sha512, so a tampered manifest cannot redirect the
 * download or downgrade verification. */
export function parseCliRelease(value: unknown): CliRelease | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Partial<Record<keyof CliRelease, unknown>>;
	const { version, url, sha512 } = candidate;
	if (typeof version !== "string" || !VERSION.test(version)) return undefined;
	if (typeof url !== "string" || !url.startsWith(RELEASE_ORIGIN)) return undefined;
	if (typeof sha512 !== "string" || !SHA512.test(sha512)) return undefined;
	return { version, url, sha512 };
}

function versionParts(version: string): number[] | undefined {
	const match = VERSION.exec(version);
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Numeric comparison so `1.5.9` sorts above `1.5.13`'s predecessor and never
 * lexicographically below `1.5.10`. Invalid versions sort lowest. */
export function compareCliVersions(left: string, right: string): number {
	const a = versionParts(left);
	const b = versionParts(right);
	if (!a || !b) return (a ? 1 : 0) - (b ? 1 : 0);
	for (let index = 0; index < 3; index += 1) {
		const difference = a[index]! - b[index]!;
		if (difference !== 0) return difference < 0 ? -1 : 1;
	}
	return 0;
}

export function isNewerCliVersion(latest: string | undefined, current: string | undefined): boolean {
	if (!latest || !current) return false;
	return compareCliVersions(latest, current) > 0;
}
