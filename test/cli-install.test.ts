import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
	defaultCliRoot,
	extractTarEntry,
	installCliRelease,
	installedCliVersions,
	pruneCliVersions,
	resolveCliRoot,
} from "../src/acp/cli-install.js";
import type { CliRelease } from "../src/acp/cli-release.js";

const temporaryDirectories: string[] = [];

function sandbox(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cli-install-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

function releaseFor(payload: Buffer, version = "1.5.13"): CliRelease {
	return {
		version,
		url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}/agy`,
		sha512: createHash("sha512").update(payload).digest("hex"),
	};
}

function fetchReturning(payload: Buffer, status = 200) {
	const calls: string[] = [];
	const impl = async (url: string) => {
		calls.push(url);
		return {
			ok: status >= 200 && status < 300,
			status,
			arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer,
		};
	};
	return { impl, calls };
}

/** Minimal ustar writer so the extraction test does not need a tar dependency. */
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

describe("defaultCliRoot", () => {
	it("uses the dev drive on Windows when it exists", () => {
		expect(
			defaultCliRoot({ platform: "win32", home: "C:\\Users\\me", env: {}, exists: (directory) => directory === "V:\\" }),
		).toBe(path.join("V:", "DevCache", "agy"));
	});

	it("falls back to ~/.local/opt when the dev drive is missing", () => {
		expect(
			defaultCliRoot({ platform: "win32", home: path.join("C:", "Users", "me"), env: {}, exists: () => false }),
		).toBe(path.join("C:", "Users", "me", ".local", "opt", "agy-cli"));
	});

	it("never probes the dev drive off Windows", () => {
		let probed = false;
		const home = path.join("home", "me");
		expect(
			defaultCliRoot({
				platform: "linux",
				home,
				env: {},
				exists: () => {
					probed = true;
					return true;
				},
			}),
		).toBe(path.join(home, ".local", "opt", "agy-cli"));
		expect(probed).toBe(false);
	});

	it("honours PI_ANTIGRAVITY_CLI_ROOT and expands ~", () => {
		const home = path.join("home", "me");
		expect(defaultCliRoot({ platform: "linux", home, env: { PI_ANTIGRAVITY_CLI_ROOT: "/opt/agy" } })).toBe("/opt/agy");
		expect(defaultCliRoot({ platform: "linux", home, env: { PI_ANTIGRAVITY_CLI_ROOT: "~/agy" } })).toBe(
			path.join(home, "agy"),
		);
	});

	it("prefers the configured root over every default", () => {
		const home = path.join("home", "me");
		const fallback = path.join(home, ".local", "opt", "agy-cli");
		expect(resolveCliRoot("/custom/agy", { platform: "win32", home: "C:\\Users\\me" })).toBe("/custom/agy");
		expect(resolveCliRoot("  ", { platform: "linux", home })).toBe(fallback);
		expect(resolveCliRoot(null, { platform: "linux", home })).toBe(fallback);
	});
});

describe("installedCliVersions", () => {
	it("lists managed binaries newest first and ignores everything else", () => {
		const root = sandbox();
		for (const version of ["1.5.9", "1.5.13", "1.4.0"]) {
			fs.mkdirSync(path.join(root, version), { recursive: true });
			fs.writeFileSync(path.join(root, version, "agy.exe"), "binary");
		}
		fs.mkdirSync(path.join(root, ".staging"), { recursive: true });
		fs.writeFileSync(path.join(root, ".staging", "agy.exe"), "partial");
		fs.mkdirSync(path.join(root, "1.6.0"), { recursive: true });

		expect(installedCliVersions(root, "win32").map((entry) => entry.version)).toEqual(["1.5.13", "1.5.9", "1.4.0"]);
	});

	it("returns nothing for a missing root", () => {
		expect(installedCliVersions(path.join(sandbox(), "absent"))).toEqual([]);
	});
});

describe("extractTarEntry", () => {
	it("extracts the requested member from a gzipped tar", () => {
		const archive = gzipSync(tarWith("agy-1.5.13/bin/agy", Buffer.from("payload")));
		expect(extractTarEntry(archive, "agy")?.toString("utf8")).toBe("payload");
	});

	it("ignores non-gzip input and missing members", () => {
		const archive = gzipSync(tarWith("agy-1.5.13/bin/agy", Buffer.from("payload")));
		expect(extractTarEntry(Buffer.from("not a tarball"), "agy")).toBeUndefined();
		expect(extractTarEntry(archive, "other")).toBeUndefined();
	});
});

describe("installCliRelease", () => {
	it("publishes the verified binary under <root>/<version>", async () => {
		const root = sandbox();
		const payload = Buffer.from("MZ fake executable");
		const fetch = fetchReturning(payload);
		const installed = await installCliRelease(releaseFor(payload), {
			root,
			platform: "win32",
			fetch: fetch.impl,
		});

		expect(installed).toBe(path.join(root, "1.5.13", "agy.exe"));
		expect(fs.readFileSync(installed, "utf8")).toBe("MZ fake executable");
		expect(fetch.calls).toHaveLength(1);
		expect(fs.readdirSync(path.join(root, "1.5.13"))).toEqual(["agy.exe"]);
	});

	it("refuses a digest mismatch and leaves no binary behind", async () => {
		const root = sandbox();
		const payload = Buffer.from("MZ fake executable");
		const release = { ...releaseFor(payload), sha512: "b".repeat(128) };
		await expect(
			installCliRelease(release, { root, platform: "win32", fetch: fetchReturning(payload).impl }),
		).rejects.toThrow(/sha512/u);
		expect(installedCliVersions(root, "win32")).toEqual([]);
	});

	it("refuses a non-2xx download", async () => {
		const root = sandbox();
		const payload = Buffer.from("MZ fake executable");
		await expect(
			installCliRelease(releaseFor(payload), { root, platform: "win32", fetch: fetchReturning(payload, 503).impl }),
		).rejects.toThrow(/HTTP 503/u);
	});

	it.skipIf(process.platform === "win32")("unpacks the tarball on Unix platforms", async () => {
		const root = sandbox();
		const payload = Buffer.from("#!/bin/sh\necho agy\n");
		const archive = gzipSync(tarWith("agy-1.5.13/bin/agy", payload));
		const installed = await installCliRelease(releaseFor(archive), {
			root,
			platform: "linux",
			fetch: fetchReturning(archive).impl,
		});

		expect(path.basename(installed)).toBe("agy");
		expect(fs.readFileSync(installed, "utf8")).toBe("#!/bin/sh\necho agy\n");
		expect(fs.statSync(installed).mode & 0o111).not.toBe(0);
	});

	it("rejects a unix archive without the binary", async () => {
		const root = sandbox();
		const archive = gzipSync(tarWith("agy-1.5.13/README.md", Buffer.from("docs")));
		await expect(
			installCliRelease(releaseFor(archive), { root, platform: "linux", fetch: fetchReturning(archive).impl }),
		).rejects.toThrow(/did not contain agy/u);
	});
});

describe("pruneCliVersions", () => {
	it("keeps the newest copies and reports the retired ones", () => {
		const root = sandbox();
		for (const version of ["1.4.0", "1.5.9", "1.5.13", "1.6.0"]) {
			fs.mkdirSync(path.join(root, version), { recursive: true });
			fs.writeFileSync(path.join(root, version, "agy.exe"), "binary");
		}

		expect(pruneCliVersions(root, 2, "win32")).toEqual(["1.5.9", "1.4.0"]);
		expect(installedCliVersions(root, "win32").map((entry) => entry.version)).toEqual(["1.6.0", "1.5.13"]);
	});
});
