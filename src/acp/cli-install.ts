import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { compareCliVersions, type CliRelease } from "./cli-release.js";

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const RETIRED_VERSION_COPIES = 3;

export function antigravityCliBinary(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "agy.exe" : "agy";
}

export function expandHome(file: string, home: string): string {
	if (file === "~") return home;
	return file.startsWith("~/") || file.startsWith("~\\") ? path.join(home, file.slice(2)) : file;
}

type FetchLike = (
	input: string,
	init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface CliRootOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	home?: string;
	exists?: (directory: string) => boolean;
}

/** Managed installs live on the user's fast drive; every other platform (and a
 * Windows box without that drive) keeps the historical `~/.local/opt` layout. */
export function defaultCliRoot(options: CliRootOptions = {}): string {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = options.home ?? os.homedir();
	const override = env.PI_ANTIGRAVITY_CLI_ROOT?.trim();
	if (override) return expandHome(override, home);
	const fallback = path.join(home, ".local", "opt", "agy-cli");
	if (platform !== "win32") return fallback;
	const exists = options.exists ?? ((directory: string) => fs.existsSync(directory));
	return exists("V:\\") ? path.join("V:", "DevCache", "agy") : fallback;
}

export function resolveCliRoot(configured: string | null | undefined, options: CliRootOptions = {}): string {
	const home = options.home ?? os.homedir();
	const trimmed = configured?.trim();
	return trimmed ? expandHome(trimmed, home) : defaultCliRoot(options);
}

export interface InstalledCli {
	version: string;
	path: string;
}

/** Every `<root>/<version>/agy[.exe]` the plugin installed itself, newest first. */
export function installedCliVersions(root: string, platform: NodeJS.Platform = process.platform): InstalledCli[] {
	const binary = antigravityCliBinary(platform);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const installed: InstalledCli[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const candidate = path.join(root, entry.name, binary);
		if (!isFile(candidate)) continue;
		installed.push({ version: entry.name, path: candidate });
	}
	return installed.sort((left, right) => compareCliVersions(right.version, left.version));
}

/** Recovers the version from `<root>/<version>/agy[.exe]` so a resolved
 * binary can report its release without re-reading the config. */
export function versionFromManagedPath(file: string): string | undefined {
	const parent = path.basename(path.dirname(file));
	return /^d+.d+.d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(parent) ? parent : undefined;
}

/** Extracts one member from a gzipped tar without adding a dependency; the CLI
 * ships single-binary archives, so only the `agy` entry matters. */
export function extractTarEntry(archive: Buffer, wanted: string): Buffer | undefined {
	let tar: Buffer;
	try {
		tar = gunzipSync(archive);
	} catch {
		return undefined;
	}
	for (let offset = 0; offset + 512 <= tar.length; ) {
		const header = tar.subarray(offset, offset + 512);
		const name = header.toString("utf8", 0, 100).replace(/\0.*$/u, "").trim();
		if (!name && header.every((byte) => byte === 0)) break;
		const size = Number.parseInt(header.toString("utf8", 124, 136).replace(/\0.*$/u, "").trim() || "0", 8);
		const start = offset + 512;
		if (path.basename(name) === wanted) return tar.subarray(start, start + size);
		offset = start + Math.ceil(size / 512) * 512;
	}
	return undefined;
}

export interface InstallCliOptions {
	root: string;
	platform?: NodeJS.Platform;
	fetch?: FetchLike;
	onProgress?: (message: string) => void;
}

/** Downloads the manifest's asset, verifies its sha512, and only then publishes
 * `<root>/<version>/agy[.exe]` via rename so a failed upgrade never shadows the
 * working binary. */
export async function installCliRelease(release: CliRelease, options: InstallCliOptions): Promise<string> {
	const platform = options.platform ?? process.platform;
	const fetchImpl = options.fetch ?? fetch;
	const binary = antigravityCliBinary(platform);
	const target = path.join(options.root, release.version, binary);
	options.onProgress?.(`Downloading Antigravity CLI ${release.version}…`);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
	let body: Buffer;
	try {
		const response = await fetchImpl(release.url, { signal: controller.signal });
		if (!response.ok) throw new Error(`Antigravity CLI download failed with HTTP ${response.status}`);
		body = Buffer.from(await response.arrayBuffer());
	} finally {
		clearTimeout(timer);
	}
	const digest = createHash("sha512").update(body).digest("hex");
	if (digest !== release.sha512) {
		throw new Error(`Antigravity CLI ${release.version} failed sha512 verification; refusing to install`);
	}
	const payload = platform === "win32" ? body : extractTarEntry(body, binary);
	if (!payload) throw new Error(`Antigravity CLI ${release.version} archive did not contain ${binary}`);
	fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
	const temporary = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, payload, { mode: 0o755 });
	if (platform !== "win32") fs.chmodSync(temporary, 0o755);
	fs.renameSync(temporary, target);
	options.onProgress?.(`Installed Antigravity CLI ${release.version} at ${target}`);
	return target;
}

/** Keeps the newest copies so a rollback stays possible without unbounded growth. */
export function pruneCliVersions(root: string, keep = RETIRED_VERSION_COPIES, platform: NodeJS.Platform = process.platform): string[] {
	const removed: string[] = [];
	for (const installed of installedCliVersions(root, platform).slice(keep)) {
		try {
			fs.rmSync(path.dirname(installed.path), { recursive: true, force: true });
			removed.push(installed.version);
		} catch {
			// A version still locked by a running session is retired on the next upgrade.
		}
	}
	return removed;
}

function isFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

