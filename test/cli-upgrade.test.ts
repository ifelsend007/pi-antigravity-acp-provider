import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveConfiguredCli } from "../src/acp/cli.js";
import { antigravityCliBinary } from "../src/acp/cli-install.js";
import { upgradeCli } from "../src/acp/cli-upgrade.js";
import { loadTransport } from "../src/config.js";

const temporaryDirectories: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalCliEnv = process.env.PI_ANTIGRAVITY_CLI;
const originalAgyCliEnv = process.env.AGY_CLI;

function sandbox(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cli-upgrade-"));
	temporaryDirectories.push(directory);
	return directory;
}

function tarWith(name: string, content: Buffer): Buffer {
	const header = Buffer.alloc(512);
	header.write(name, 0, 100, "utf8");
	header.write("0000644\0", 100, 8, "utf8");
	header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
	header.write("0000000\0", 136, 8, "utf8");
	header.write("0000000\0", 148, 8, "utf8");
	header.write("        ", 156, 8, "utf8");
	header.write("ustar\0" + "00", 257, 8, "utf8");
	const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
	return Buffer.concat([header, content, padding, Buffer.alloc(1024)]);
}

function releaseAsset(): Buffer {
	if (process.platform === "win32") return Buffer.from("MZ fake executable");
	return gzipSync(tarWith("agy/bin/agy", Buffer.from("#!/bin/sh\necho agy\n")));
}

function writeBinary(root: string, version: string): string {
	const file = path.join(root, version, antigravityCliBinary());
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, process.platform === "win32" ? "MZ old" : "#!/bin/sh\n");
	if (process.platform !== "win32") fs.chmodSync(file, 0o755);
	return file;
}

function stubReleaseFetch(version: string | undefined) {
	const payload = releaseAsset();
	const assetUrl = `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version ?? "0.0.0"}/agy`;
	const manifest = version
		? JSON.stringify({
				version,
				url: assetUrl,
				sha512: createHash("sha512").update(payload).digest("hex"),
			})
		: "";
	const requestedUrls: string[] = [];
	vi.stubGlobal("fetch", async (input: string) => {
		requestedUrls.push(input);
		if (input === assetUrl) {
			return {
				ok: true,
				status: 200,
				arrayBuffer: async () =>
					payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer,
			};
		}
		if (!version) {
			return { ok: false, status: 503, text: async () => "" };
		}
		return { ok: true, status: 200, text: async () => manifest };
	});
	return { requestedUrls, assetUrl };
}

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalCliEnv === undefined) delete process.env.PI_ANTIGRAVITY_CLI;
	else process.env.PI_ANTIGRAVITY_CLI = originalCliEnv;
	if (originalAgyCliEnv === undefined) delete process.env.AGY_CLI;
	else process.env.AGY_CLI = originalAgyCliEnv;
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe("upgradeCli", () => {
	it.each([
		{
			scenario: "upgrades to a newer release without pinning cliPath",
			installedVersions: ["1.5.13"],
			pinVersion: undefined as string | undefined,
			latestVersion: "1.6.0",
			expectedChanged: true,
			expectedFrom: "1.5.13" as string | undefined,
			expectedTo: "1.6.0",
			expectedDownloaded: true,
		},
		{
			scenario: "clears a stale pinned cliPath when upgrading to a newer release",
			installedVersions: ["1.5.13"],
			pinVersion: "1.5.13",
			latestVersion: "1.6.0",
			expectedChanged: true,
			expectedFrom: "1.5.13",
			expectedTo: "1.6.0",
			expectedDownloaded: true,
		},
		{
			scenario: "clears a stale pinned cliPath even when cliRoot already has the latest release",
			installedVersions: ["1.5.13", "1.6.0"],
			pinVersion: "1.5.13",
			latestVersion: "1.6.0",
			expectedChanged: false,
			expectedFrom: undefined,
			expectedTo: "1.6.0",
			expectedDownloaded: false,
		},
		{
			scenario: "keeps config clean when already on the latest managed release",
			installedVersions: ["1.6.0"],
			pinVersion: undefined,
			latestVersion: "1.6.0",
			expectedChanged: false,
			expectedFrom: undefined,
			expectedTo: "1.6.0",
			expectedDownloaded: false,
		},
	])(
		"$scenario",
		async ({
			installedVersions,
			pinVersion,
			latestVersion,
			expectedChanged,
			expectedFrom,
			expectedTo,
			expectedDownloaded,
		}) => {
			const base = sandbox();
			const agentDir = path.join(base, "agent");
			const cliRoot = path.join(base, "managed");
			const configDir = path.join(agentDir, "antigravity-acp-provider");
			fs.mkdirSync(configDir, { recursive: true });
			for (const version of installedVersions) writeBinary(cliRoot, version);
			const pinnedPath = pinVersion ? path.join(cliRoot, pinVersion, antigravityCliBinary()) : undefined;
			const configFile = path.join(configDir, "config.json");
			fs.writeFileSync(
				configFile,
				JSON.stringify({
					transport: "cli",
					cliRoot,
					...(pinnedPath ? { cliPath: pinnedPath } : {}),
				}),
			);

			process.env.PI_CODING_AGENT_DIR = agentDir;
			delete process.env.PI_ANTIGRAVITY_CLI;
			delete process.env.AGY_CLI;

			const { requestedUrls, assetUrl } = stubReleaseFetch(latestVersion);
			const result = await upgradeCli();

			const expectedPath = path.join(cliRoot, expectedTo, antigravityCliBinary());
			expect(result).toEqual({
				changed: expectedChanged,
				...(expectedFrom ? { from: expectedFrom } : {}),
				to: expectedTo,
				path: expectedPath,
			});
			expect(requestedUrls.includes(assetUrl)).toBe(expectedDownloaded);
			expect(loadTransport(configFile)).toEqual({
				transport: "cli",
				cliPath: null,
				cliRoot,
			});
			expect(resolveConfiguredCli()).toEqual({
				path: expectedPath,
				source: `managed ${expectedTo}`,
			});
		},
	);

	it("throws when the release manifest is unavailable", async () => {
		const base = sandbox();
		process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
		stubReleaseFetch(undefined);

		await expect(upgradeCli()).rejects.toThrow(/manifest is unavailable/u);
	});
});
