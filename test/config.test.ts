import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	DEFAULT_CONFIG_PATH,
	LEGACY_GEMINI_CONFIG_PATH,
	loadCliUpdates,
	loadConfig,
	loadLaunchTempRoot,
	loadTransport,
	resolveConfigPath,
	resolveConfigRoot,
	resolvePiAgentDir,
	saveCliLocation,
	saveCliUpdates,
	savePermissionMode,
	saveRuntimeUpdateMode,
	saveToolActivityMode,
	isToolActivityMode,
} from "../src/config.js";

const directories: string[] = [];
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	vi.restoreAllMocks();
	if (originalPiCodingAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
	}
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("permission configuration", () => {
	it("defaults to yolo and persists an explicit safer mode", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-acp-config-"));
		directories.push(directory);
		const file = path.join(directory, "nested", "config.json");
		expect(loadConfig(file)).toEqual({ permissions: "yolo", runtimeUpdates: "automatic", toolActivity: "off" });
		saveRuntimeUpdateMode("notify", file);
		savePermissionMode("auto_edit", file);
		saveToolActivityMode("off", file);
		expect(loadConfig(file)).toEqual({ permissions: "auto_edit", runtimeUpdates: "notify", toolActivity: "off" });
	});

	it("validates and persists toolActivity modes while defaulting invalid values to off", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-acp-tool-activity-"));
		directories.push(directory);
		const file = path.join(directory, "config.json");

		expect(isToolActivityMode("off")).toBe(true);
		expect(isToolActivityMode("compact")).toBe(true);
		expect(isToolActivityMode("full")).toBe(true);
		expect(isToolActivityMode("verbose")).toBe(false);

		fs.writeFileSync(file, JSON.stringify({ permissions: "yolo", runtimeUpdates: "automatic", toolActivity: "bogus" }));
		expect(loadConfig(file).toolActivity).toBe("off");

		saveToolActivityMode("full", file);
		expect(loadConfig(file).toolActivity).toBe("full");
		saveToolActivityMode("compact", file);
		expect(loadConfig(file).toolActivity).toBe("compact");
	});

	it("resolves default agent directory and config paths when PI_CODING_AGENT_DIR is unset", () => {
		delete process.env.PI_CODING_AGENT_DIR;
		const defaultAgentDir = path.join(os.homedir(), ".pi", "agent");
		expect(resolvePiAgentDir()).toBe(defaultAgentDir);
		expect(resolveConfigRoot()).toBe(path.join(defaultAgentDir, "antigravity-acp-provider"));
		expect(resolveConfigPath()).toBe(path.join(defaultAgentDir, "antigravity-acp-provider", "config.json"));
		expect(DEFAULT_CONFIG_PATH).toBe(path.join(defaultAgentDir, "antigravity-acp-provider", "config.json"));
		expect(LEGACY_GEMINI_CONFIG_PATH).toBe(path.join(defaultAgentDir, "gemini-acp-provider", "config.json"));
	});

	it("respects PI_CODING_AGENT_DIR environment variable", () => {
		// Never inherit a developer's real permission configuration in this test.
		const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-home-"));
		directories.push(fakeHome);
		vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
		const customAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-agent-"));
		directories.push(customAgentDir);
		process.env.PI_CODING_AGENT_DIR = customAgentDir;

		expect(resolvePiAgentDir()).toBe(customAgentDir);
		expect(resolveConfigRoot()).toBe(path.join(customAgentDir, "antigravity-acp-provider"));
		expect(resolveConfigPath()).toBe(path.join(customAgentDir, "antigravity-acp-provider", "config.json"));

		expect(loadConfig()).toEqual({ permissions: "yolo", runtimeUpdates: "automatic", toolActivity: "off" });
		savePermissionMode("default");
		expect(loadConfig()).toEqual({ permissions: "default", runtimeUpdates: "automatic", toolActivity: "off" });

		const configFile = path.join(customAgentDir, "antigravity-acp-provider", "config.json");
		expect(fs.existsSync(configFile)).toBe(true);
	});

	it("expands tilde in PI_CODING_AGENT_DIR", () => {
		process.env.PI_CODING_AGENT_DIR = "~/test-agent-dir";
		expect(resolvePiAgentDir()).toBe(path.join(os.homedir(), "test-agent-dir"));

		process.env.PI_CODING_AGENT_DIR = "~";
		expect(resolvePiAgentDir()).toBe(os.homedir());
	});

	it("falls back to default when PI_CODING_AGENT_DIR is empty or whitespace", () => {
		const defaultAgentDir = path.join(os.homedir(), ".pi", "agent");

		process.env.PI_CODING_AGENT_DIR = "";
		expect(resolvePiAgentDir()).toBe(defaultAgentDir);

		process.env.PI_CODING_AGENT_DIR = "   ";
		expect(resolvePiAgentDir()).toBe(defaultAgentDir);
	});

	it("migrates legacy gemini-acp-provider configuration from default agent directory", () => {
		const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fake-gemini-home-"));
		directories.push(fakeHome);
		vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
		delete process.env.PI_CODING_AGENT_DIR;

		const legacyDir = path.join(fakeHome, ".pi", "agent", "gemini-acp-provider");
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(
			path.join(legacyDir, "config.json"),
			JSON.stringify({ permissions: "auto_edit", runtimeUpdates: "manual" }),
		);

		expect(loadConfig()).toEqual({ permissions: "auto_edit", runtimeUpdates: "manual", toolActivity: "off" });
		const targetFile = path.join(fakeHome, ".pi", "agent", "antigravity-acp-provider", "config.json");
		expect(fs.existsSync(targetFile)).toBe(true);
	});

	it("migrates configuration from default Pi agent directory when PI_CODING_AGENT_DIR is custom", () => {
		const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fake-home-"));
		directories.push(fakeHome);
		vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

		const defaultAntigravityDir = path.join(fakeHome, ".pi", "agent", "antigravity-acp-provider");
		fs.mkdirSync(defaultAntigravityDir, { recursive: true });
		fs.writeFileSync(
			path.join(defaultAntigravityDir, "config.json"),
			JSON.stringify({ permissions: "auto_edit", runtimeUpdates: "notify" }),
		);

		const customAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-agent-migrate-"));
		directories.push(customAgentDir);
		process.env.PI_CODING_AGENT_DIR = customAgentDir;

		expect(loadConfig()).toEqual({ permissions: "auto_edit", runtimeUpdates: "notify", toolActivity: "off" });
		const targetFile = path.join(customAgentDir, "antigravity-acp-provider", "config.json");
		expect(fs.existsSync(targetFile)).toBe(true);
		expect(fs.readFileSync(path.join(defaultAntigravityDir, "config.json"), "utf8")).toBe(
			JSON.stringify({ permissions: "auto_edit", runtimeUpdates: "notify" }),
		);
		if (process.platform !== "win32") expect(fs.statSync(targetFile).mode & 0o777).toBe(0o600);
	});

	it("does not overwrite an existing custom profile or copy saved sessions", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-migration-"));
		directories.push(root);
		vi.spyOn(os, "homedir").mockReturnValue(path.join(root, "home"));
		const source = path.join(root, "home", ".pi", "agent", "antigravity-acp-provider");
		fs.mkdirSync(source, { recursive: true });
		fs.writeFileSync(path.join(source, "config.json"), JSON.stringify({ permissions: "yolo", runtimeUpdates: "automatic" }));
		fs.writeFileSync(path.join(source, "sessions.json"), "[]");
		process.env.PI_CODING_AGENT_DIR = path.join(root, "custom");
		const target = resolveConfigPath();
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const existing = JSON.stringify({ permissions: "default", runtimeUpdates: "manual" });
		fs.writeFileSync(target, existing);
		expect(loadConfig()).toEqual({ permissions: "default", runtimeUpdates: "manual", toolActivity: "off" });
		expect(fs.readFileSync(target, "utf8")).toBe(existing);
		fs.unlinkSync(target);
		expect(loadConfig()).toEqual({ permissions: "yolo", runtimeUpdates: "automatic", toolActivity: "off" });
		expect(fs.existsSync(path.join(path.dirname(target), "sessions.json"))).toBe(false);
		expect(fs.existsSync(path.join(source, "sessions.json"))).toBe(true);
	});
});

describe("launch temp root configuration", () => {
	it.each([
		{ name: "an absent key", content: {}, expected: null },
		{ name: "a blank value", content: { launchTempRoot: "   " }, expected: null },
		{ name: "a non-string value", content: { launchTempRoot: 42 }, expected: null },
		{ name: "a configured root", content: { launchTempRoot: " V:/tmp " }, expected: "V:/tmp" },
	])("reads $name", ({ content, expected }) => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-acp-config-"));
		directories.push(directory);
		const file = path.join(directory, "config.json");
		fs.writeFileSync(file, JSON.stringify(content));
		expect(loadLaunchTempRoot(file)).toBe(expected);
	});

	it("survives a permission toggle that rewrites the file", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-acp-config-"));
		directories.push(directory);
		const file = path.join(directory, "config.json");
		fs.writeFileSync(
			file,
			JSON.stringify({ permissions: "yolo", runtimeUpdates: "automatic", launchTempRoot: "V:/tmp" }),
		);
		savePermissionMode("auto_edit", file);
		expect(loadConfig(file)).toEqual({ permissions: "auto_edit", runtimeUpdates: "automatic", toolActivity: "off" });
		expect(loadLaunchTempRoot(file)).toBe("V:/tmp");
	});
});
describe("antigravity cli location", () => {
	it.each([
		{ name: "an absent key", content: {}, expected: { transport: "server", cliPath: null, cliRoot: null } },
		{ name: "a blank root", content: { cliRoot: "  " }, expected: { transport: "server", cliPath: null, cliRoot: null } },
		{
			name: "a configured root and path",
			content: { transport: "cli", cliPath: " V:/DevCache/agy/1.5.13/agy.exe ", cliRoot: " V:/DevCache/agy " },
			expected: { transport: "cli", cliPath: "V:/DevCache/agy/1.5.13/agy.exe", cliRoot: "V:/DevCache/agy" },
		},
		{
			name: "an unknown transport",
			content: { transport: "carrier-pigeon" },
			expected: { transport: "server", cliPath: null, cliRoot: null },
		},
	])("reads $name", ({ content, expected }) => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-acp-config-"));
		directories.push(directory);
		const file = path.join(directory, "config.json");
		fs.writeFileSync(file, JSON.stringify(content));
		expect(loadTransport(file)).toEqual(expected);
	});

	it("clears a pinned path when the root is changed", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-acp-config-"));
		directories.push(directory);
		const file = path.join(directory, "config.json");
		fs.writeFileSync(file, JSON.stringify({ transport: "cli", cliPath: "V:/old/agy.exe", cliRoot: "V:/old" }));
		saveCliLocation({ cliRoot: "V:/DevCache/agy", cliPath: null }, file);
		expect(loadTransport(file)).toEqual({ transport: "cli", cliPath: null, cliRoot: "V:/DevCache/agy" });
	});

	it("keeps the root and update mode across a permission toggle", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-acp-config-"));
		directories.push(directory);
		const file = path.join(directory, "config.json");
		fs.writeFileSync(file, JSON.stringify({ permissions: "yolo", cliRoot: "V:/DevCache/agy", cliUpdates: "automatic" }));
		savePermissionMode("auto_edit", file);
		expect(loadTransport(file).cliRoot).toBe("V:/DevCache/agy");
		expect(loadCliUpdates(file)).toBe("automatic");
	});
});

describe("antigravity cli update mode", () => {
	it.each([
		{ name: "an absent key", content: {}, expected: "notify" },
		{ name: "an unknown mode", content: { cliUpdates: "sometimes" }, expected: "notify" },
		{ name: "manual", content: { cliUpdates: "manual" }, expected: "manual" },
		{ name: "automatic", content: { cliUpdates: "automatic" }, expected: "automatic" },
	])("reads $name", ({ content, expected }) => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-acp-config-"));
		directories.push(directory);
		const file = path.join(directory, "config.json");
		fs.writeFileSync(file, JSON.stringify(content));
		expect(loadCliUpdates(file)).toBe(expected);
	});

	it("round-trips a saved mode", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-acp-config-"));
		directories.push(directory);
		const file = path.join(directory, "config.json");
		saveCliUpdates("automatic", file);
		expect(loadCliUpdates(file)).toBe("automatic");
	});
});
