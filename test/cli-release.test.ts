import { describe, expect, it } from "vitest";

import {
	cliManifestPlatform,
	cliManifestUrl,
	compareCliVersions,
	isNewerCliVersion,
	parseCliRelease,
} from "../src/acp/cli-release.js";

const SHA = "a".repeat(128);
const URL = `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13/windows_amd64/agy.exe`;

describe("cli manifest target", () => {
	it.each([
		[{ platform: "win32" as const, arch: "x64" }, "windows_amd64"],
		[{ platform: "linux" as const, arch: "x64" }, "linux_amd64"],
		[{ platform: "darwin" as const, arch: "arm64" }, "darwin_arm64"],
		[{ platform: "darwin" as const, arch: "x64" }, "darwin_amd64"],
		[{ platform: "win32" as const, arch: "arm64" }, undefined],
		[{ platform: "aix" as const, arch: "ppc64" }, undefined],
	])("maps %j to %s", (target, expected) => {
		expect(cliManifestPlatform(target)).toBe(expected);
	});

	it("derives the manifest URL only for supported targets", () => {
		expect(cliManifestUrl({ platform: "win32", arch: "x64" })).toBe(
			"https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json",
		);
		expect(cliManifestUrl({ platform: "win32", arch: "ia32" })).toBeUndefined();
	});
});

describe("parseCliRelease", () => {
	it("accepts the published shape", () => {
		expect(parseCliRelease({ version: "1.5.13", url: URL, sha512: SHA })).toEqual({
			version: "1.5.13",
			url: URL,
			sha512: SHA,
		});
	});

	it.each([
		["non-object", "1.5.13"],
		["array", [{ version: "1.5.13", url: URL, sha512: SHA }]],
		["short version", { version: "1.5", url: URL, sha512: SHA }],
		["foreign origin", { version: "1.5.13", url: "https://evil.example/agy.exe", sha512: SHA }],
		["http origin", { version: "1.5.13", url: URL.replace("https:", "http:"), sha512: SHA }],
		["short digest", { version: "1.5.13", url: URL, sha512: "abc" }],
		["missing digest", { version: "1.5.13", url: URL }],
	])("rejects %s", (_label, value) => {
		expect(parseCliRelease(value)).toBeUndefined();
	});
});

describe("cli version ordering", () => {
	it.each([
		["1.5.13", "1.5.9", 1],
		["1.5.9", "1.5.13", -1],
		["1.5.13", "1.5.13", 0],
		["2.0.0", "1.9.9", 1],
		["1.5.13+build.7", "1.5.13", 0],
		["nightly", "1.5.13", -1],
	])("compares %s with %s as %d", (left, right, expected) => {
		expect(compareCliVersions(left, right)).toBe(expected);
	});

	it.each([
		["1.5.14", "1.5.13", true],
		["1.5.13", "1.5.13", false],
		["1.5.12", "1.5.13", false],
		[undefined, "1.5.13", false],
		["1.5.14", undefined, false],
	])("isNewerCliVersion(%s, %s) is %s", (latest, current, expected) => {
		expect(isNewerCliVersion(latest, current)).toBe(expected);
	});
});
