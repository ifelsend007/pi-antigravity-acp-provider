import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { inspectAntigravityAuth, inspectAntigravityCliTransport } from "../src/acp/antigravity.js";
import { describeCliInstallation, describeCliRoot, upgradeCli } from "../src/acp/cli-upgrade.js";
import { describeCredentialStorage } from "../src/acp/credential-storage.js";
import { errorMessage } from "../src/acp/errors.js";
import { resolveAntigravityAcpEntry } from "../src/acp/process.js";
import {
	checkAntigravityAcpUpdate,
	inspectRuntimeSetup,
	updateAntigravityAcpRuntime,
} from "../src/acp/setup.js";
import {
	isPermissionMode,
	isRuntimeUpdateMode,
	isToolActivityMode,
	loadCliUpdates,
	loadConfig,
	loadTransport,
	permissionModeLabel,
	resolveConfigRoot,
	saveCliLocation,
	saveCliUpdates,
	savePermissionMode,
	saveRuntimeUpdateMode,
	saveToolActivityMode,
	type PermissionMode,
} from "../src/config.js";
import {
	ACP_PROTOCOL_VERSION,
	ACP_SDK_VERSION,
	PACKAGE_VERSION,
	QUOTA_REQUEST_CHANNEL,
} from "../src/constants.js";
import type { AntigravityQuotaSnapshot } from "../src/acp/usage-quota.js";
import { projectModels } from "../src/models.js";
import {
	PERMISSION_RESULT_KIND,
	PERMISSION_TOOL_NAME,
	type AntigravityConnectionFactory,
	type PermissionToolResult,
} from "../src/runtime.js";
import { acquireSharedRuntime, releaseSharedRuntime } from "../src/shared-runtime.js";
import { runSetupWizard } from "../src/wizard.js";

export type { AntigravityQuotaSnapshot } from "../src/acp/usage-quota.js";

// Instances sharing an event bus all hear each request; the first to claim it replies. Pi loads every
// instance without a module cache, so the claims live on globalThis.
const CLAIMED_QUOTA_REQUESTS = Symbol.for("pi-antigravity-acp:quota-requests");
const claimSlots = globalThis as unknown as Record<symbol, WeakSet<object> | undefined>;
const claimedQuotaRequests = (claimSlots[CLAIMED_QUOTA_REQUESTS] ??= new WeakSet());

export default function antigravityAcpExtension(pi: ExtensionAPI): void {
	registerAntigravityAcp(pi);
}

export function registerAntigravityAcp(pi: ExtensionAPI, connectionFactory?: AntigravityConnectionFactory): void {
	const shared = acquireSharedRuntime(connectionFactory);
	const { runtime, provider } = shared;
	pi.registerProvider(provider);

	// Other extensions ask for quota with `{ reply }` and get exactly one `{ ok, quota | error }`.
	const unsubscribeQuota = pi.events.on(QUOTA_REQUEST_CHANNEL, (data) => {
		const reply = (data as { reply?: unknown } | undefined)?.reply;
		if (typeof reply !== "function" || claimedQuotaRequests.has(data as object)) return;
		claimedQuotaRequests.add(data as object);
		void runtime.quota(undefined).then(
			(quota) => ({ ok: true as const, quota }),
			(error: unknown) => ({ ok: false as const, error: errorMessage(error) }),
		).then((result) => {
			try {
				reply(result);
			} catch {
				// A failing listener must not get a second reply.
			}
		});
	});

	pi.registerTool({
		name: PERMISSION_TOOL_NAME,
		label: "Antigravity ACP Permission",
		description: "Presents an Antigravity ACP permission request to the user. Only call IDs emitted by the provider are valid.",
		parameters: Type.Object({ requestId: Type.String({ minLength: 1, maxLength: 128 }) }),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const request = runtime.getPermission(params.requestId);
			if (!request) throw new Error("This Antigravity permission request is missing, expired, or already used");
			const labels = request.options.map(
				(option, index) => `${index + 1}. ${option.label} [${option.kind.replaceAll("_", " ")}]`,
			);
			let selected: string | undefined;
			try {
				selected = await ctx.ui.select(request.title, labels);
			} catch {
				// Print/RPC/headless modes deny when no interactive selector is available.
			}
			const selectedIndex = selected === undefined ? -1 : labels.indexOf(selected);
			const optionId = selectedIndex < 0 ? undefined : request.options[selectedIndex]?.id;
			const details: PermissionToolResult = {
				kind: PERMISSION_RESULT_KIND,
				requestId: request.id,
				...(optionId === undefined ? {} : { optionId }),
				cancelled: optionId === undefined,
			};
			return {
				content: [
					{
						type: "text",
						text: optionId === undefined ? "Permission denied." : `Permission decision recorded: ${selected}`,
					},
				],
				details,
			};
		},
	});

	const commandDefinition = {
		description: "Set up, inspect, update, or configure Google Antigravity ACP",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const command = args.trim() || "doctor";
			if (command === "setup") {
				await runSetupWizard(ctx.ui, runtime);
				return;
			}
			if (command === "update" || command === "update-runtime") {
				const result = await updateAntigravityAcpRuntime((message) => ctx.ui.notify(message, "info"));
				ctx.ui.notify(
					result.changed
						? `Installed verified Antigravity ACP ${result.version}. Restart Pi to move active sessions to it.`
						: `Antigravity ACP ${result.version} is already the latest signed release.`,
					"info",
				);
				return;
			}
			if (command === "updates" || command.startsWith("updates ")) {
				const requested = command.slice("updates".length).trim();
				if (!requested) {
					ctx.ui.notify(`Antigravity runtime updates: ${loadConfig().runtimeUpdates}`, "info");
					return;
				}
				if (!isRuntimeUpdateMode(requested)) {
					ctx.ui.notify(
						"Usage: /antigravity-acp updates [automatic|notify|manual]",
						"warning",
					);
					return;
				}
				saveRuntimeUpdateMode(requested);
				ctx.ui.notify(`Antigravity runtime updates: ${requested}`, "info");
				return;
			}
			if (command === "logout" || command === "account" || command === "switch-account") {
				await runtime.logout();
				ctx.ui.notify(
					"Local Antigravity credentials and saved ACP sessions were cleared. Run /logout for the old Pi marker, then /login to choose the next account.",
					"info",
				);
				return;
			}
			if (command === "models") {
				// Show what the account's ACP session really advertises: the catalog is
				// discovered, never hardcoded, so this is the authority on why a model
				// the user expects is missing.
				const advertised = await runtime.discoverModels(undefined).then(
					(value) => value,
					(error: unknown) => errorMessage(error),
				);
				if (typeof advertised === "string") {
					ctx.ui.notify(`Antigravity models: discovery failed (${advertised})`, "warning");
					return;
				}
				const projected = projectModels(advertised);
				ctx.ui.notify(
					[
						`Antigravity models: ${projected.length} for Pi from ${advertised.length} advertised ids`,
						...projected.map(
							(model) => `• ${model.id}${model.reasoning ? " (reasoning)" : ""} — ${model.name}`,
						),
						`Raw ACP ids: ${advertised.map((model) => model.modelId).join(", ") || "none"}`,
					].join("\n"),
					"info",
				);
				return;
			}
			if (command === "quota") {
				const quota = await runtime.quota(undefined).then(
					formatQuota,
					(error: unknown) => `Antigravity quota: unavailable (${errorMessage(error)})`,
				);
				ctx.ui.notify([quota, formatMetrics((await runtime.snapshot()).metrics)].join("\n"), "info");
				return;
			}
			if (command === "qualify") {
				await runSetupWizard(ctx.ui, runtime);
				return;
			}
			if (command === "permissions" || command.startsWith("permissions ")) {
				let requested = command.slice("permissions".length).trim().replaceAll("-", "_");
				if (!requested) {
					const choices = [
						"yolo — allow commands and edits automatically (default)",
						"auto-edit — allow edits automatically; commands may ask",
						"default — ask before sensitive operations",
					];
					const selected = await ctx.ui.select("Antigravity permission mode", choices);
					if (!selected) return;
					requested = selected.split(" ", 1)[0]!.replaceAll("-", "_");
				}
				if (!isPermissionMode(requested)) {
					ctx.ui.notify(
						"Usage: /antigravity-acp permissions [default|auto-edit|yolo]",
						"warning",
					);
					return;
				}
				const mode: PermissionMode = requested;
				await runtime.setPermissionMode(mode);
				savePermissionMode(mode);
				ctx.ui.notify(
					mode === "yolo"
						? "Antigravity permission mode: yolo. Commands and edits may run without confirmation."
						: `Antigravity permission mode: ${permissionModeLabel(mode)}.`,
					mode === "yolo" ? "warning" : "info",
				);
				return;
			}
			if (command === "cli" || command.startsWith("cli ")) {
				const request = command.slice("cli".length).trim();
				if (request === "updates" || request.startsWith("updates ")) {
					const requested = request.slice("updates".length).trim();
					if (!requested) {
						ctx.ui.notify(`Antigravity CLI updates: ${loadCliUpdates()}`, "info");
						return;
					}
					if (!isRuntimeUpdateMode(requested)) {
						ctx.ui.notify("Usage: /antigravity-acp cli updates [automatic|notify|manual]", "warning");
						return;
					}
					saveCliUpdates(requested);
					ctx.ui.notify(`Antigravity CLI updates: ${requested}`, "info");
					return;
				}
				if (request === "root" || request.startsWith("root ")) {
					const requested = request.slice("root".length).trim();
					if (!requested) {
						ctx.ui.notify(`Antigravity CLI root: ${describeCliRoot()}`, "info");
						return;
					}
					saveCliLocation({ cliRoot: requested, cliPath: null });
					ctx.ui.notify(`Antigravity CLI root: ${requested}`, "info");
					return;
				}
				if (request === "update" || request === "upgrade") {
					ctx.ui.notify("Checking the Antigravity CLI release manifest…", "info");
					const result = await upgradeCli((message) => ctx.ui.notify(message, "info")).catch(
						(error: unknown) => errorMessage(error),
					);
					if (typeof result === "string") {
						ctx.ui.notify(`Antigravity CLI upgrade failed: ${result}`, "warning");
						return;
					}
					ctx.ui.notify(
						result.changed
							? `Installed Antigravity CLI ${result.to} at ${result.path}. Restart Pi to launch it.`
							: `Antigravity CLI ${result.to} is already the newest published release.`,
						"info",
					);
					return;
				}
				if (request && request !== "status") {
					ctx.ui.notify("Usage: /antigravity-acp cli [status|update|root [dir]|updates [automatic|notify|manual]]", "warning");
					return;
				}
				const installation = await describeCliInstallation(resolveConfigRoot());
				const { update } = installation;
				ctx.ui.notify(
					[
						`Antigravity CLI: ${installation.version ?? "unknown"}${update.latest ? ` (latest published ${update.latest})` : ""}`,
						`Path: ${installation.path ?? "not found"}${installation.source ? ` (${installation.source})` : ""}`,
						`Managed root: ${installation.root}`,
						`Upgrade: ${update.updateAvailable ? `available — run /antigravity-acp cli update` : update.latest ? "up to date" : "manifest unreachable"}; updates=${loadCliUpdates()}`,
					].join("\n"),
					update.updateAvailable ? "warning" : "info",
				);
				return;
			}
			if (command === "tool-activity" || command.startsWith("tool-activity ")) {
				let requested = command.slice("tool-activity".length).trim().toLowerCase();
				if (!requested) {
					const choices = [
						"off — hide Antigravity tool activity in thinking blocks (default)",
						"compact — show one line when an Antigravity tool starts",
						"full — show all Antigravity tool calls, updates, and output details",
					];
					const selected = await ctx.ui.select("Antigravity tool activity", choices);
					if (!selected) return;
					requested = selected.split(" ", 1)[0]!;
				}
				if (!isToolActivityMode(requested)) {
					ctx.ui.notify(
						"Usage: /antigravity-acp tool-activity [off|compact|full]",
						"warning",
					);
					return;
				}
				runtime.setToolActivityMode(requested);
				saveToolActivityMode(requested);
				ctx.ui.notify(`Antigravity tool activity: ${requested}`, "info");
				return;
			}
			const verbose = command === "doctor --verbose";
			if (command !== "doctor" && command !== "status" && !verbose) {
				ctx.ui.notify(
					"Usage: /antigravity-acp [setup|doctor|status|models|quota|update|updates|cli|logout|account|qualify|permissions|tool-activity]",
					"warning",
				);
				return;
			}
			const cliRuntime = inspectAntigravityCliTransport();
			const snapshot = await runtime.snapshot(verbose);
			const auth = inspectAntigravityAuth();
			let runtimeLines: string[];
			if (loadTransport().transport === "cli") {
				runtimeLines = [
					`Transport: official Antigravity CLI ${cliRuntime.version ?? "unknown"} (${cliRuntime.path ?? "not found"}); manage it with /antigravity-acp cli`,
					`Authentication: ${
						cliRuntime.status === "cli-login"
							? "cli-login (OS keychain, managed by agy)"
							: "missing (run `agy acp --login`)"
					}; ACP SDK ${ACP_SDK_VERSION}, protocol ${ACP_PROTOCOL_VERSION}`,
				];
			} else {
				let entry: string;
				try {
					entry = resolveAntigravityAcpEntry();
				} catch (error) {
					entry = error instanceof Error ? error.message : String(error);
				}
				const setup = inspectRuntimeSetup();
				const update = await checkAntigravityAcpUpdate().catch(() => undefined);
				runtimeLines = [
					`Runtime: installed=${setup.installedVersion ?? "external/unknown"} approved=${update?.approvedVersion ?? setup.approvedVersion} registry=${update?.latestVersion ?? "unavailable"} updates=${setup.updateMode}; ACP SDK ${ACP_SDK_VERSION}, protocol ${ACP_PROTOCOL_VERSION}`,
					`Antigravity server: ${entry}`,
					`Authentication: ${auth.status}${auth.authType ? ` (${auth.authType})` : ""}`,
				];
			}
			ctx.ui.notify(
				[
					`Antigravity ACP provider ${PACKAGE_VERSION}`,
					...runtimeLines,
					`Credential storage (preflight): ${describeCredentialStorage()}`,
					`Requested permission mode: ${permissionModeLabel(snapshot.permissionMode)}`,
					`Tool activity mode: ${snapshot.toolActivityMode}`,
					`Active bindings: ${snapshot.bindings}`,
					formatMetrics(snapshot.metrics),
					...snapshot.processes.flatMap((item) => [
						`• pid=${item.pid ?? "?"} generation=${item.generation} model=${item.modelId} confirmedMode=${item.confirmedPermissionMode} alive=${item.alive} restored=${item.restored} agent=${item.agentVersion ?? "?"} mcpHttp=${item.mcpHttp} bridged=${item.mcpBridged} permission=${item.waitingForPermission} tools=${item.waitingForTools} ignoredStdoutNoise=${item.ignoredStdoutNoiseLines}`,
						`  omitted Pi tools: ${item.omittedTools.length ? item.omittedTools.map((tool) => `${tool.name} (${tool.reason})`).join("; ") : "none"}`,
						...(verbose && item.stderrTail ? [`  stderr (redacted): ${item.stderrTail}`] : []),
					]),
				].join("\n"),
				"info",
			);
		},
	};
	pi.registerCommand("antigravity-acp", commandDefinition);
	pi.registerCommand("gemini-acp", {
		...commandDefinition,
		description: "Deprecated alias for /antigravity-acp",
	});

	pi.on("session_start", async (_event, ctx) => {
		void announceCliUpdate(ctx);
		if (loadConfig().runtimeUpdates !== "notify") return;
		try {
			const update = await checkAntigravityAcpUpdate();
			if (update.approvalPending) {
				ctx.ui.notify(
					`Antigravity ACP ${update.latestVersion} is published but is still awaiting a signed runtime manifest.`,
					"warning",
				);
			} else if (update.updateAvailable) {
				ctx.ui.notify(
					update.managed
						? `Antigravity ACP ${update.approvedVersion} is available. Run /antigravity-acp update.`
						: `Antigravity ACP ${update.approvedVersion} is available, but the selected external runtime must be updated manually.`,
					"info",
				);
			}
		} catch {
			// Update checks are advisory and must not interrupt Pi startup.
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		unsubscribeQuota();
		await runtime.closeSession(ctx.sessionManager.getSessionId());
		await releaseSharedRuntime(shared, event.reason);
	});
}

function formatMetrics(metrics: {
	totals: {
		turns: number;
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
	};
	latestQuota?: { remaining?: number; limit?: number; resetAt?: string; tier?: string; model?: string };
}): string {
	const totalTokens =
		metrics.totals.input +
		metrics.totals.output +
		metrics.totals.cacheRead +
		metrics.totals.cacheWrite;
	const quota = metrics.latestQuota;
	return [
		`Usage this process: turns=${metrics.totals.turns} tokens=${totalTokens} input=${metrics.totals.input} output=${metrics.totals.output} reasoning=${metrics.totals.reasoning} cacheRead=${metrics.totals.cacheRead}`,
		...(quota
			? [`Latest quota: remaining=${quota.remaining ?? "unknown"}/${quota.limit ?? "unknown"} reset=${quota.resetAt ?? "unknown"} tier=${quota.tier ?? "unknown"} model=${quota.model ?? "unknown"}`]
			: []),
	].join("\n");
}

/** Runs once per session: `automatic` upgrades in the background, `notify`
 * mentions a newer release, `manual` stays silent. Update failures stay quiet
 * because a flaky manifest must never break startup. */
async function announceCliUpdate(ctx: {
	ui: { notify(message: string, level: "info" | "warning"): void };
}): Promise<void> {
	if (loadTransport().transport !== "cli") return;
	const mode = loadCliUpdates();
	if (mode === "manual") return;
	try {
		if (mode === "automatic") {
			let progress: string | undefined;
			const result = await upgradeCli((message) => {
				progress = message;
			});
			if (result.changed) {
				ctx.ui.notify(
					`Antigravity CLI updated to ${result.to}${progress ? ` (${progress})` : ""}. It is used on the next session.`,
					"info",
				);
			}
			return;
		}
		const installation = await describeCliInstallation(resolveConfigRoot());
		if (!installation.update.updateAvailable || !installation.update.latest) return;
		ctx.ui.notify(
			`Antigravity CLI ${installation.update.latest} is available (installed ${installation.version ?? "unknown"}). Run /antigravity-acp cli update.`,
			"info",
		);
	} catch (error: unknown) {
		if (error instanceof Error && /abort|fetch failed|ENOTFOUND|ETIMEDOUT/u.test(error.message)) return;
		ctx.ui.notify(`Antigravity CLI update check failed: ${errorMessage(error)}`, "warning");
	}
}

function formatQuota(snapshot: AntigravityQuotaSnapshot): string {
	return [
		"Antigravity quota:",
		...snapshot.groups.map((group) => `  ${group.displayName}: ${group.buckets.length
			? group.buckets.map((bucket) => `${bucket.window} ${Math.round(bucket.remainingFraction * 100)}%${bucket.resetTime ? ` (resets ${bucket.resetTime})` : ""}`).join(", ")
			: "no percentage limits reported"}`),
	].join("\n");
}
