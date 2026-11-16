import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LAUNCH_DIR_PREFIX = "launch-";
const RECORD_FILE = ".launch.json";
/** A directory younger than this may belong to a spawn that has not recorded
 * its server PID yet, so it is never swept. */
const FRESH_GUARD_MS = 5 * 60_000;
/** A launch that died before writing its record leaves no PID to check. */
const ORPHAN_GRACE_MS = 60 * 60_000;
const REMOVAL_DELAY_MS = 300;
const REMOVAL_ATTEMPTS = 4;

export interface LaunchTempRecord {
	piPid: number;
	serverPid?: number;
	startedAt: number;
}

export interface LaunchTemp {
	dir: string;
	env: NodeJS.ProcessEnv;
}

export function defaultLaunchTempRoot(): string {
	return path.join(os.homedir(), ".local", "opt", "agy-acp", "tmp");
}

/** Antigravity's server is a PyInstaller one-file build: every start unpacks
 * its whole CPython runtime (~137 MB) into the temp directory it inherits and
 * only removes that copy on a clean exit. Giving each launch its own temp
 * directory keeps those copies out of the system temp directory and makes each
 * one attributable to the process that created it. */
export function createLaunchTemp(
	root: string = defaultLaunchTempRoot(),
	piPid: number = process.pid,
	now: number = Date.now(),
): LaunchTemp {
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	const dir = path.join(root, `${LAUNCH_DIR_PREFIX}${now}-${piPid}-${randomSuffix()}`);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeRecord(dir, { piPid, startedAt: now });
	return { dir, env: { TEMP: dir, TMP: dir, TMPDIR: dir } };
}

export function recordServerPid(dir: string, serverPid: number | undefined): void {
	const record = readRecord(dir);
	if (!record || serverPid === undefined) return;
	writeRecord(dir, { ...record, serverPid });
}

export function removeLaunchTemp(dir: string): boolean {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
		return !fs.existsSync(dir);
	} catch {
		return false;
	}
}

/** Windows keeps a just-exited child's image files locked for a moment, so the
 * removal is retried instead of being reported as an orphan on next start. */
export function scheduleLaunchTempRemoval(
	dir: string,
	remove: (target: string) => boolean = removeLaunchTemp,
): void {
	let attempt = 0;
	const retry = (): void => {
		attempt += 1;
		if (remove(dir) || attempt >= REMOVAL_ATTEMPTS) return;
		const timer = setTimeout(retry, REMOVAL_DELAY_MS);
		timer.unref?.();
	};
	retry();
}

/** Deletes launch directories no live process owns. Returns the removed paths.
 * A PID that still exists is never aged out: deleting the unpacked runtime of a
 * running server crashes it, and a leaked directory is cheaper than that. */
export function sweepLaunchTemps(
	root: string = defaultLaunchTempRoot(),
	isAlive: (pid: number) => boolean = pidAlive,
	now: number = Date.now(),
): string[] {
	const removed: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return removed;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(LAUNCH_DIR_PREFIX)) continue;
		const dir = path.join(root, entry.name);
		if (!isStale(dir, isAlive, now)) continue;
		if (removeLaunchTemp(dir)) removed.push(dir);
	}
	return removed;
}

function isStale(dir: string, isAlive: (pid: number) => boolean, now: number): boolean {
	const record = readRecord(dir);
	if (!record) return directoryAge(dir, now) > ORPHAN_GRACE_MS;
	// A future timestamp is clock skew or a record written after the spawn, so
	// it cannot pin the directory: fall back to the directory's own age.
	if (now < record.startedAt) return directoryAge(dir, now) > ORPHAN_GRACE_MS;
	if (now - record.startedAt < FRESH_GUARD_MS) return false;
	if (!isAlive(record.piPid)) return true;
	return record.serverPid !== undefined && !isAlive(record.serverPid);
}

function directoryAge(dir: string, now: number): number {
	try {
		return now - fs.statSync(dir).mtimeMs;
	} catch {
		return 0;
	}
}

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readRecord(dir: string): LaunchTempRecord | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, RECORD_FILE), "utf8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		const candidate = parsed as Partial<LaunchTempRecord>;
		if (typeof candidate.piPid !== "number" || typeof candidate.startedAt !== "number") return undefined;
		return typeof candidate.serverPid === "number"
			? { piPid: candidate.piPid, serverPid: candidate.serverPid, startedAt: candidate.startedAt }
			: { piPid: candidate.piPid, startedAt: candidate.startedAt };
	} catch {
		return undefined;
	}
}

function writeRecord(dir: string, record: LaunchTempRecord): void {
	try {
		fs.writeFileSync(path.join(dir, RECORD_FILE), JSON.stringify(record));
	} catch {
		// A missing record only costs precision: the directory is then swept by age.
	}
}

function randomSuffix(): string {
	return Math.random().toString(16).slice(2, 10);
}
