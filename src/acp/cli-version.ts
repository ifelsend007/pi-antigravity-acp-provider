import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { cliManifestUrl, isNewerCliVersion, parseCliRelease, type CliPlatform, type CliRelease } from "./cli-release.js";

/** Cached checks keep Pi startup offline: one manifest fetch per window at most. */
export const CLI_UPDATE_CHECK_TTL_MS = 6 * 60 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 15_000;
const VERSION_OUTPUT = /(?:^|\s)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/u;

export interface CliUpdateStatus {
	current?: string;
	latest?: string;
	updateAvailable: boolean;
	checkedAt: number;
}

interface CachedCheck {
	checkedAt: number;
	latest?: string;
}

type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** `agy --version` prints the bare version; the regex also tolerates a future
 * `agy version 1.2.3` wording so a cosmetic change cannot blind the check. */
export async function probeCliVersion(binaryPath: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<string | undefined> {
	const output = await new Promise<string>((resolve) => {
		let text = "";
		let settled = false;
		const finish = (value: string) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const child = spawn(binaryPath, ["--version"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(text);
		}, timeoutMs);
		timer.unref();
		for (const stream of [child.stdout, child.stderr]) {
			stream?.setEncoding("utf8");
			stream?.on("data", (chunk: string) => {
				text += chunk;
			});
		}
		child.on("error", () => finish(text));
		child.on("close", () => {
			clearTimeout(timer);
			finish(text);
		});
	});
	return VERSION_OUTPUT.exec(output)?.[1];
}

export async function fetchLatestCliRelease(
	target: CliPlatform = { platform: process.platform, arch: process.arch },
	fetchImpl: FetchLike = fetch,
	timeoutMs = FETCH_TIMEOUT_MS,
): Promise<CliRelease | undefined> {
	const url = cliManifestUrl(target);
	if (!url) return undefined;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref();
	try {
		const response = await fetchImpl(url, { signal: controller.signal });
		if (!response.ok) return undefined;
		return parseCliRelease(JSON.parse(await response.text()));
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

export function cacheFile(configRoot: string): string {
	return path.join(configRoot, "cli-update.json");
}

function readCache(configRoot: string): CachedCheck | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(cacheFile(configRoot), "utf8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		const candidate = parsed as Partial<CachedCheck>;
		if (typeof candidate.checkedAt !== "number") return undefined;
		return {
			checkedAt: candidate.checkedAt,
			...(typeof candidate.latest === "string" ? { latest: candidate.latest } : {}),
		};
	} catch {
		return undefined;
	}
}

function writeCache(configRoot: string, check: CachedCheck): void {
	try {
		fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
		const file = cacheFile(configRoot);
		const temporary = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(check, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temporary, file);
	} catch {
		// A cache write failure must never block the upgrade notice.
	}
}

export interface CliUpdateCheckOptions {
	binaryPath?: string;
	configRoot: string;
	now?: number;
	ttlMs?: number;
	probe?: (binaryPath: string) => Promise<string | undefined>;
	latest?: () => Promise<CliRelease | undefined>;
}

/** Compares the installed binary with the published manifest, reusing a cached
 * manifest result inside the TTL. Never throws: the caller only prints advice. */
export async function checkCliUpdate(options: CliUpdateCheckOptions): Promise<CliUpdateStatus> {
	const now = options.now ?? Date.now();
	const ttl = options.ttlMs ?? CLI_UPDATE_CHECK_TTL_MS;
	const cached = readCache(options.configRoot);
	const fresh = cached && now - cached.checkedAt < ttl ? cached : undefined;
	const current = options.binaryPath
		? await (options.probe ?? probeCliVersion)(options.binaryPath).catch(() => undefined)
		: undefined;
	let latest = fresh?.latest;
	let checkedAt = fresh?.checkedAt ?? now;
	if (!fresh) {
		const release = await (options.latest ?? (() => fetchLatestCliRelease())).call(undefined).catch(() => undefined);
		latest = release?.version;
		writeCache(options.configRoot, { checkedAt: now, ...(latest ? { latest } : {}) });
	}
	return {
		...(current ? { current } : {}),
		...(latest ? { latest } : {}),
		updateAvailable: isNewerCliVersion(latest, current),
		checkedAt,
	};
}
