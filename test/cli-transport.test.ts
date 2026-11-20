import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inspectAntigravityCliTransport } from "../src/acp/antigravity.js";
import { antigravityCliCandidates, resolveAntigravityCli } from "../src/acp/cli.js";
import { loadTransport } from "../src/config.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-cli-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe("Antigravity CLI discovery", () => {
	it("orders explicit configuration ahead of environment, app and PATH", () => {
		const candidates = antigravityCliCandidates({
			cliPath: "D:/tools/agy.exe",
			env: { PI_ANTIGRAVITY_CLI: "D:/env/agy.exe", LOCALAPPDATA: "C:/Users/x/AppData/Local", PATH: "C:/bin" },
			platform: "win32",
			home: "C:/Users/x",
		});
		expect(candidates.slice(0, 4)).toEqual([
			{ path: "D:/tools/agy.exe", source: "config cliPath" },
			{ path: "D:/env/agy.exe", source: "environment" },
			{ path: path.join("C:/Users/x/AppData/Local", "Programs", "Antigravity", "agy.exe"), source: "desktop app" },
			{
				path: path.join("C:/Users/x", ".gemini", "antigravity-cli", "bin", "agy.exe"),
				source: "user install",
			},
		]);
		expect(candidates.at(-1)).toEqual({ path: path.join("C:/bin", "agy.exe"), source: "PATH" });
	});

	it("returns the first executable candidate and ignores missing ones", () => {
		const location = resolveAntigravityCli(
			null,
			{ env: { PATH: "" }, platform: "linux", home: "/home/x" },
			(file) => file === path.join("/home/x", ".gemini", "antigravity", "bin", "agy"),
		);
		expect(location).toEqual({
			path: path.join("/home/x", ".gemini", "antigravity", "bin", "agy"),
			source: "user install",
		});
	});

	it("expands a home-relative path and honours the requested platform", () => {
		const file = path.join("/home/x", ".local", "bin", "agy");
		const created = temporaryDirectory();
		const real = path.join(created, "agy");
		fs.writeFileSync(real, "#!/bin/sh");
		fs.chmodSync(real, 0o755);
		expect(antigravityCliCandidates({ cliPath: "~/.local/bin/agy", platform: "linux", home: "/home/x" })[0]).toEqual({
			path: file,
			source: "config cliPath",
		});
		expect(resolveAntigravityCli(real, { platform: "linux", env: {}, home: created })).toEqual({
			path: real,
			source: "config cliPath",
		});
	});

	it("reports the keychain login only for a CLI transport with a usable binary", async () => {
		const created = temporaryDirectory();
		const cli = path.join(created, "agy.exe");
		fs.writeFileSync(cli, "");
		const configDir = path.join(created, "agent", "antigravity-acp-provider");
		fs.mkdirSync(configDir, { recursive: true });
		const configFile = path.join(configDir, "config.json");
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = path.join(created, "agent");
		try {
			fs.writeFileSync(configFile, JSON.stringify({ transport: "server", cliPath: cli }));
			expect(inspectAntigravityCliTransport()).toEqual({ status: "cli-missing" });
			fs.writeFileSync(configFile, JSON.stringify({ transport: "cli", cliPath: cli }));
			expect(inspectAntigravityCliTransport()).toEqual({ status: "cli-login", path: cli });
			fs.writeFileSync(configFile, JSON.stringify({ transport: "cli", cliPath: path.join(created, "gone.exe") }));
			expect(inspectAntigravityCliTransport()).toEqual({ status: "cli-missing" });
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
	});

	it.each([
		{ config: { transport: "cli", cliPath: "D:/agy.exe" }, expected: { transport: "cli", cliPath: "D:/agy.exe" } },
		{ config: { transport: "cli" }, expected: { transport: "cli", cliPath: null } },
		{ config: { transport: "server", cliPath: "  " }, expected: { transport: "server", cliPath: null } },
		{ config: {}, expected: { transport: "server", cliPath: null } },
		{ config: { transport: "bogus" }, expected: { transport: "server", cliPath: null } },
	])("reads transport settings from config ($config)", ({ config, expected }) => {
		const file = path.join(temporaryDirectory(), "config.json");
		fs.writeFileSync(file, JSON.stringify(config));
		expect(loadTransport(file)).toEqual(expected);
	});
});
