import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planLaunch, resolveSupervisorEntry } from "../src/acp/process.js";

const temporaryDirectories: string[] = [];
let agentDir: string;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalServerBin = process.env.AGY_ACP_BIN;

function temporaryDirectory(prefix: string): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

beforeEach(() => {
	agentDir = temporaryDirectory("antigravity-plan-agent-");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const configDirectory = path.join(agentDir, "antigravity-acp-provider");
	fs.mkdirSync(configDirectory, { recursive: true });
	fs.writeFileSync(
		path.join(configDirectory, "config.json"),
		JSON.stringify({ launchTempRoot: path.join(agentDir, "confined") }),
	);
	// Point the server lookup at a throwaway binary so the plan does not depend on
	// whatever runtime the developer happens to have installed.
	const serverBin = path.join(agentDir, "agy_acp_server.par");
	fs.writeFileSync(serverBin, "", { mode: 0o755 });
	process.env.AGY_ACP_BIN = serverBin;
});

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalServerBin === undefined) delete process.env.AGY_ACP_BIN;
	else process.env.AGY_ACP_BIN = originalServerBin;
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe("launch planning", () => {
	it("confines the default server launch and keeps the watchdog", () => {
		const plan = planLaunch({ cwd: agentDir, env: { ...process.env }, transport: "server" });
		expect(plan.command).toBe(process.execPath);
		expect(plan.args[0]).toBe(resolveSupervisorEntry());
		expect(plan.args[1]).toBe("--command");
		expect(plan.launchTempRoot).toBe(path.join(agentDir, "confined"));
	});

	it("confines the CLI launch and runs it under the watchdog too", () => {
		const cli = path.join(agentDir, "agy.exe");
		fs.writeFileSync(cli, "");
		const plan = planLaunch({ cwd: agentDir, env: { ...process.env }, transport: "cli", cliPath: cli });
		expect(plan.command).toBe(process.execPath);
		expect(plan.args).toEqual([resolveSupervisorEntry(), "--command", cli, "acp"]);
		expect(plan.launchTempRoot).toBe(path.join(agentDir, "confined"));
	});

	it("refuses to plan a CLI launch without an agy binary", () => {
		expect(() =>
			planLaunch({ cwd: agentDir, env: { PATH: "", HOME: agentDir }, transport: "cli", cliPath: null }),
		).toThrow(/agy/);
	});

	it("leaves an explicit command alone", () => {
		const plan = planLaunch({ cwd: agentDir, env: {}, command: "C:/bin/agent.exe", args: ["--x"] });
		expect(plan).toEqual({ command: "C:/bin/agent.exe", args: ["--x"] });
	});

	it("supervises an explicit entry path without confining its temp", () => {
		const plan = planLaunch({ cwd: agentDir, env: {}, entryPath: "C:/agent/index.mjs", args: ["--y"] });
		expect(plan.args).toEqual([
			resolveSupervisorEntry(),
			"--command",
			process.execPath,
			"C:/agent/index.mjs",
			"--y",
		]);
		expect(plan.launchTempRoot).toBeUndefined();
	});
});
