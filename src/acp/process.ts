import fs from "node:fs";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { loadTransport, type TransportMode } from "../config.js";
import { resolveAntigravityAcpLaunch } from "./antigravity.js";
import { resolveAntigravityCli } from "./cli.js";
import { AntigravityAcpError, redact } from "./errors.js";
import {
	configuredLaunchTempRoot,
	createLaunchTemp,
	recordServerPid,
	scheduleLaunchTempRemoval,
	type LaunchTemp,
} from "./launch-temp.js";
import { applyAcpProxyEnvironment } from "./proxy.js";
import { applyCredentialStorageEnvironment, type CredentialStorageOptions } from "./credential-storage.js";
const STDERR_LIMIT = 16 * 1024;
const STDERR_LINE_LIMIT = 4 * 1024;
// Longer than supervisor.mjs's 750 ms agent-tree escalation window.
const KILL_GRACE_MS = 1_500;
let nextGeneration = 1;

export interface AntigravityProcessOptions {
	cwd: string;
	entryPath?: string;
	command?: string;
	args?: string[];
	/** `cli` launches the official `agy acp`; unset reads the plugin config. */
	transport?: TransportMode;
	cliPath?: string | null;
	env?: NodeJS.ProcessEnv;
	/** Overrides the credential-storage resolution seams (keychain probe and
	 * token path) in tests; production callers leave this unset. */
	credentialStorage?: Omit<CredentialStorageOptions, "env">;
	/** Root for the per-launch temp directory the server unpacks itself into.
	 * `null` disables it; unset confines only real Antigravity launches. */
	launchTempRoot?: string | null;
}

export interface ProcessExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	stderrTail: string;
}

export function resolveSupervisorEntry(): string {
	return fileURLToPath(new URL("./supervisor.mjs", import.meta.url));
}

export function resolveAntigravityAcpEntry(): string {
	// Kept as a compatibility export for diagnostics; the provider now targets
	// Google Antigravity's ACP server rather than the retired Gemini CLI client.
	return resolveAntigravityAcpLaunch().command;
}

export function resolveNodeBinary(
	explicit?: string,
	env: NodeJS.ProcessEnv = process.env,
	isExecutable: (filePath: string) => boolean = isExecutableFile,
): string {
	// An override may be a wrapper with any filename; use the same environment
	// that will be passed to the supervisor when resolving it.
	const override = explicit || env.NODE;
	if (override) return override;
	const candidate = process.execPath;
	const base = (candidate.split(/[\\/]/).pop() ?? "").toLowerCase();
	// A standalone Pi binary is not a Node interpreter, but Node itself can be
	// named nodejs (not just node), particularly in Nix environments.
	if (/^node(?:js)?(?:\.exe|\.cmd|\.bat)?$/.test(base)) return candidate;
	for (const directory of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
		// Only use absolute PATH entries: the supervisor may spawn with a
		// different cwd than the caller used to resolve this executable.
		if (!path.isAbsolute(directory)) continue;
		for (const name of process.platform === "win32" ? ["node.exe", "nodejs.exe"] : ["node", "nodejs"]) {
			const binary = path.join(directory, name);
			if (isExecutable(binary)) return binary;
		}
	}
	throw new Error(
		"Node.js is required to launch the Antigravity ACP supervisor; install node or set NODE to its executable path.",
	);
}

function isExecutableFile(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function isReadableRegularFile(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.R_OK);
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

export const DEFAULT_CA_BUNDLE_PATHS = [
	"/etc/ssl/certs/ca-bundle.crt",
	"/etc/ssl/certs/ca-certificates.crt",
	"/etc/pki/tls/certs/ca-bundle.crt",
	"/etc/ssl/ca-bundle.pem",
	"/etc/ssl/cert.pem",
];

export function resolveDefaultSslCertFile(
	env: NodeJS.ProcessEnv = process.env,
	isReadableFile: (filePath: string) => boolean = isReadableRegularFile,
): string | undefined {
	if (env.SSL_CERT_FILE && isReadableFile(env.SSL_CERT_FILE)) return env.SSL_CERT_FILE;
	if (env.NIX_SSL_CERT_FILE && isReadableFile(env.NIX_SSL_CERT_FILE)) return env.NIX_SSL_CERT_FILE;
	for (const candidate of DEFAULT_CA_BUNDLE_PATHS) {
		if (isReadableFile(candidate)) return candidate;
	}
	return undefined;
}

export function applyDefaultTlsEnvironment(
	baseEnv: NodeJS.ProcessEnv = process.env,
	isReadableFile: (filePath: string) => boolean = isReadableRegularFile,
): NodeJS.ProcessEnv {
	const env = { ...baseEnv };
	if (!env.SSL_CERT_FILE) {
		const certFile = resolveDefaultSslCertFile(env, isReadableFile);
		if (certFile) env.SSL_CERT_FILE = certFile;
	}
	return env;
}

export class AntigravityProcess {
	readonly generation = nextGeneration++;
	readonly child: ChildProcessWithoutNullStreams;
	readonly input: ReadableStream<Uint8Array>;
	readonly output: WritableStream<Uint8Array>;
	readonly exited: Promise<ProcessExit>;
	readonly launchTempDir?: string;
	private stderr = "";
	private stderrPartial = "";
	private readonly stderrLineListeners = new Set<(line: string) => void>();
	private ignoredStdoutNoise = 0;
	private settled = false;
	private closing?: Promise<void>;

	constructor(options: AntigravityProcessOptions) {
		const plan = planLaunch(options);
		const { command, args } = plan;
		const launchTemp = resolveLaunchTemp(options, plan.launchTempRoot);
		let resolveExit!: (exit: ProcessExit) => void;
		this.exited = new Promise((resolve) => {
			resolveExit = resolve;
		});

		const env = applyCredentialStorageEnvironment(
			applyDefaultTlsEnvironment(
				applyAcpProxyEnvironment(launchTempEnv(options.env ?? process.env, launchTemp)),
			),
			options.credentialStorage ?? {},
		);
		const child = spawn(command, args, {
			cwd: path.resolve(options.cwd),
			env,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			windowsHide: true,
			detached: process.platform !== "win32",
		});
		this.child = child;
		if (launchTemp) {
			this.launchTempDir = launchTemp.dir;
			recordServerPid(launchTemp.dir, child.pid);
		}
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderr = redact((this.stderr + chunk).slice(-STDERR_LIMIT));
			const lines = (this.stderrPartial + chunk).split("\n");
			this.stderrPartial = lines.pop()!.slice(-STDERR_LINE_LIMIT);
			for (const line of lines) {
				const safe = redact(line.slice(-STDERR_LINE_LIMIT));
				for (const listener of this.stderrLineListeners) listener(safe);
			}
		});
		child.once("error", (cause) => {
			this.finish(resolveExit, null, null, `spawn failed: ${cause.message}`);
		});
		child.once("exit", (code, signal) => {
			this.finish(resolveExit, code, signal, this.stderr);
		});

		this.input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
		this.output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
	}

	get pid(): number | undefined {
		return this.child.pid;
	}

	get stderrTail(): string {
		return this.stderr;
	}

	/** Complete, redacted and length-bounded stderr lines as they arrive. */
	onStderrLine(listener: (line: string) => void): void {
		this.stderrLineListeners.add(listener);
	}

	get ignoredStdoutNoiseLines(): number {
		return this.ignoredStdoutNoise;
	}

	recordCompatibilityNoise(): void {
		this.ignoredStdoutNoise += 1;
	}

	get alive(): boolean {
		// child.killed only records that kill() was called; it does not mean the
		// process has exited. Keep it alive until exit/error settles.
		return !this.settled && this.child.exitCode === null;
	}

	async close(): Promise<void> {
		this.closing ??= this.closeOnce();
		return this.closing;
	}

	private async closeOnce(): Promise<void> {
		if (!this.alive) return;
		// Do not end stdin independently of the Web WritableStream adapter. An
		// in-flight SDK write may otherwise reach Node after stdin.end() and raise
		// ERR_STREAM_WRITE_AFTER_END as an uncaught stream error. Terminating the
		// owned process tree closes all three stdio streams together.
		this.signal("SIGTERM");
		const exited = await Promise.race([
			this.exited.then(() => true),
			delay(KILL_GRACE_MS).then(() => false),
		]);
		if (!exited && this.alive) {
			this.signal("SIGKILL");
			await Promise.race([this.exited, delay(KILL_GRACE_MS)]);
		}
	}

	private signal(signal: NodeJS.Signals): void {
		try {
			if (process.platform === "win32" && this.child.pid) {
				const args = ["/PID", String(this.child.pid), "/T"];
				if (signal === "SIGKILL") args.push("/F");
				spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
				return;
			}
			if (this.child.pid) process.kill(-this.child.pid, signal);
			else this.child.kill(signal);
		} catch {
			// ESRCH means the process tree is already gone.
		}
	}

	private finish(
		resolve: (exit: ProcessExit) => void,
		code: number | null,
		signal: NodeJS.Signals | null,
		stderrTail: string,
	): void {
		if (this.settled) return;
		this.settled = true;
		if (this.launchTempDir) scheduleLaunchTempRemoval(this.launchTempDir);
		resolve({ code, signal, stderrTail: redact(stderrTail) });
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

/** Only a real Antigravity launch gets the confined temp root; an explicit
 * command or entry path (fixtures, `AGY_ACP_BIN` wrappers in tests) keeps the
 * ambient environment unless a root is passed in. */
/** Command line plus the implicit temp root for a launch, so the transport
 * branches stay testable without spawning anything. */
export interface LaunchPlan {
	command: string;
	args: string[];
	launchTempRoot?: string;
}

export function planLaunch(options: AntigravityProcessOptions): LaunchPlan {
	const env = options.env ?? process.env;
	const transportConfig = loadTransport();
	if (options.command) return { command: options.command, args: options.args ?? [] };
	const nodeBinary = resolveNodeBinary(env.NODE, env);
	if (options.entryPath) {
		return {
			command: nodeBinary,
			args: [resolveSupervisorEntry(), "--command", nodeBinary, options.entryPath, ...(options.args ?? [])],
		};
	}
	if ((options.transport ?? transportConfig.transport) === "cli") {
		const cli = resolveAntigravityCli(options.cliPath ?? transportConfig.cliPath, { env });
		if (!cli) {
			throw new AntigravityAcpError(
				"spawn",
				"Antigravity CLI (agy) was not found; install it or set cliPath in the plugin config",
			);
		}
		// The CLI is a PyInstaller bundle too, so its unpacked files need confining.
		return {
			command: nodeBinary,
			args: [resolveSupervisorEntry(), "--command", cli.path, "acp"],
			launchTempRoot: configuredLaunchTempRoot(),
		};
	}
	const launch = resolveAntigravityAcpLaunch();
	return {
		command: nodeBinary,
		args: [resolveSupervisorEntry(), "--command", launch.command, ...launch.args],
		launchTempRoot: configuredLaunchTempRoot(),
	};
}

function resolveLaunchTemp(
	options: AntigravityProcessOptions,
	fallbackRoot?: string,
): LaunchTemp | undefined {
	const root = options.launchTempRoot !== undefined ? options.launchTempRoot : fallbackRoot;
	if (root === null || root === undefined) return undefined;
	return createLaunchTemp(root);
}

function launchTempEnv(env: NodeJS.ProcessEnv, launchTemp: LaunchTemp | undefined): NodeJS.ProcessEnv {
	return launchTemp ? { ...env, ...launchTemp.env } : env;
}
