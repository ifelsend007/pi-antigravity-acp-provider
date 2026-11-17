import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	configuredLaunchTempRoot,
	createLaunchTemp,
	defaultLaunchTempRoot,
	recordServerPid,
	scheduleLaunchTempRemoval,
	sweepLaunchTemps,
} from "../src/acp/launch-temp.js";
import { AntigravityProcess } from "../src/acp/process.js";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const envDumpFixture = fileURLToPath(new URL("./fixtures/env-dump-agent.mjs", import.meta.url));
const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-launch-temp-"));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function readRecord(dir: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(dir, ".launch.json"), "utf8")) as Record<string, unknown>;
}

describe("createLaunchTemp", () => {
	it("confines the child temp variables to a fresh directory under the root", () => {
		const launch = createLaunchTemp(root, 4_242, NOW);
		expect(path.dirname(launch.dir)).toBe(root);
		expect(launch.env).toEqual({ TEMP: launch.dir, TMP: launch.dir, TMPDIR: launch.dir });
		expect(readRecord(launch.dir)).toEqual({ piPid: 4_242, startedAt: NOW });
	});

	it("records the server pid without dropping the owner", () => {
		const launch = createLaunchTemp(root, 4_242, NOW);
		recordServerPid(launch.dir, 777);
		expect(readRecord(launch.dir)).toEqual({ piPid: 4_242, serverPid: 777, startedAt: NOW });
	});

	it("stays under the managed root by default", () => {
		expect(defaultLaunchTempRoot()).toBe(path.join(os.homedir(), ".local", "opt", "agy-acp", "tmp"));
	});
});

describe("sweepLaunchTemps", () => {
	it.each([
		{
			name: "keeps a launch whose Pi process is alive",
			prepare: (dir: string) => void fs.writeFileSync(path.join(dir, ".launch.json"), JSON.stringify({ piPid: 101, startedAt: NOW - 10 * MINUTE })),
			removed: false,
		},
		{
			name: "keeps a live launch even when it is days old",
			prepare: (dir: string) => void fs.writeFileSync(path.join(dir, ".launch.json"), JSON.stringify({ piPid: 101, startedAt: NOW - 3 * 24 * 60 * MINUTE })),
			removed: false,
		},
		{
			name: "removes a launch whose Pi process exited",
			prepare: (dir: string) => void fs.writeFileSync(path.join(dir, ".launch.json"), JSON.stringify({ piPid: 999, startedAt: NOW - 10 * MINUTE })),
			removed: true,
		},
		{
			name: "removes a launch whose server exited under a live Pi",
			prepare: (dir: string) => void fs.writeFileSync(path.join(dir, ".launch.json"), JSON.stringify({ piPid: 101, serverPid: 555, startedAt: NOW - 10 * MINUTE })),
			removed: true,
		},
		{
			name: "keeps a launch whose server is still running",
			prepare: (dir: string) => void fs.writeFileSync(path.join(dir, ".launch.json"), JSON.stringify({ piPid: 101, serverPid: 101, startedAt: NOW - 10 * MINUTE })),
			removed: false,
		},
		{
			name: "keeps a just-started launch that has not recorded its server yet",
			prepare: (dir: string) => void fs.writeFileSync(path.join(dir, ".launch.json"), JSON.stringify({ piPid: 999, startedAt: NOW - MINUTE })),
			removed: false,
		},
		{
			name: "removes a recordless launch well past the grace window",
			prepare: (dir: string) => {
				fs.rmSync(path.join(dir, ".launch.json"), { force: true });
				fs.utimesSync(dir, new Date(NOW - 2 * 60 * MINUTE), new Date(NOW - 2 * 60 * MINUTE));
			},
			removed: true,
		},
		{
			name: "keeps a recordless launch inside the grace window",
			prepare: (dir: string) => {
				fs.rmSync(path.join(dir, ".launch.json"), { force: true });
				fs.utimesSync(dir, new Date(NOW - MINUTE), new Date(NOW - MINUTE));
			},
			removed: false,
		},
		{
			name: "removes a launch whose record claims a future start but whose directory is old",
			prepare: (dir: string) => {
				fs.writeFileSync(path.join(dir, ".launch.json"), JSON.stringify({ piPid: 999, startedAt: NOW + 60 * MINUTE }));
				fs.utimesSync(dir, new Date(NOW - 2 * 60 * MINUTE), new Date(NOW - 2 * 60 * MINUTE));
			},
			removed: true,
		},
	])("$name", ({ prepare, removed }) => {
		const launch = createLaunchTemp(root, 4_242, NOW - 10 * MINUTE);
		prepare(launch.dir);
		const swept = sweepLaunchTemps(root, (pid) => pid === 101, NOW);
		expect(swept.includes(launch.dir)).toBe(removed);
		expect(fs.existsSync(launch.dir)).toBe(!removed);
	});

	it("ignores directories the provider does not own", () => {
		const foreign = path.join(root, "keep-me");
		fs.mkdirSync(foreign);
		fs.utimesSync(foreign, new Date(NOW - 5 * 60 * MINUTE), new Date(NOW - 5 * 60 * MINUTE));
		expect(sweepLaunchTemps(root, () => false, NOW)).toEqual([]);
		expect(fs.existsSync(foreign)).toBe(true);
	});

	it("returns nothing when the root does not exist yet", () => {
		expect(sweepLaunchTemps(path.join(root, "missing"), () => false, NOW)).toEqual([]);
	});
});

describe("launch temp reclamation", () => {
	it("removes the directory through the default remover", async () => {
		const launch = createLaunchTemp(root, 4_242, NOW);
		scheduleLaunchTempRemoval(launch.dir);
		await waitFor(() => !fs.existsSync(launch.dir));
	});

	it("retries a removal that is still locked", async () => {
		const launch = createLaunchTemp(root, 4_242, NOW);
		let calls = 0;
		scheduleLaunchTempRemoval(launch.dir, () => {
			calls += 1;
			return calls >= 3;
		});
		await waitFor(() => calls >= 3);
		expect(calls).toBe(3);
	});
});

describe("AntigravityProcess launch temp", () => {
	it("hands the confined temp root to the server and reclaims it after exit", async () => {
		const child = new AntigravityProcess({
			cwd: path.dirname(envDumpFixture),
			entryPath: envDumpFixture,
			args: [],
			launchTempRoot: root,
		});
		const exit = await child.exited;
		const reported = JSON.parse(exit.stderrTail) as { temp: string | null; tmpdir: string | null };
		expect(child.launchTempDir).toBeDefined();
		expect(reported.temp).toBe(child.launchTempDir);
		expect(reported.tmpdir).toBe(child.launchTempDir);
		expect(fs.existsSync(child.launchTempDir!)).toBe(false);
	});

	it("leaves the ambient environment alone for an explicit command", () => {
		const child = new AntigravityProcess({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent, "browser-noise"],
		});
		expect(child.launchTempDir).toBeUndefined();
		void child.close();
	});

	it("can be disabled outright", () => {
		const child = new AntigravityProcess({
			cwd: path.dirname(envDumpFixture),
			entryPath: envDumpFixture,
			args: [],
			launchTempRoot: null,
		});
		expect(child.launchTempDir).toBeUndefined();
		void child.close();
	});
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("condition was not met in time");
}

describe("configuredLaunchTempRoot", () => {
	const original = process.env.PI_CODING_AGENT_DIR;
	const cleanup: string[] = [];

	afterEach(() => {
		if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = original;
		for (const directory of cleanup.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
	});

	it("uses the root configured in config.json", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-agent-"));
		cleanup.push(agentDir);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const file = path.join(agentDir, "antigravity-acp-provider", "config.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			JSON.stringify({ permissions: "yolo", runtimeUpdates: "automatic", launchTempRoot: "V:/tmp" }),
		);
		expect(configuredLaunchTempRoot()).toBe(path.resolve("V:/tmp"));
	});

	it("falls back to the managed default without a configured root", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-agent-"));
		cleanup.push(agentDir);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		expect(configuredLaunchTempRoot()).toBe(defaultLaunchTempRoot());
	});
});
