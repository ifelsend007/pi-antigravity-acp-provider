import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RefreshModelsContext } from "@earendil-works/pi-ai";

import type { AcpModelInfo } from "../src/acp/session-state.js";
import { readModelCache, resolveModelCachePath, writeModelCache } from "../src/model-cache.js";
import { FALLBACK_MODELS } from "../src/models.js";
import { createAntigravityProvider } from "../src/provider.js";
import type { AntigravityRuntime } from "../src/runtime.js";

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(path.join(tmpdir(), "antigravity-model-cache-"));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function cacheFile(): string {
	return path.join(directory, "models-cache.json");
}

function refreshContext(
	allowNetwork: boolean,
	publish: (request: { update: () => void }) => Promise<boolean>,
): RefreshModelsContext {
	return { allowNetwork, signal: undefined, publish } as unknown as RefreshModelsContext;
}

describe("model cache", () => {
	it.each([
		["missing file", () => undefined],
		["malformed json", () => writeFileSync(cacheFile(), "{not json")],
		["wrong schema version", () => writeFileSync(cacheFile(), JSON.stringify({ version: 2, models: [{ modelId: "x", name: "X" }] }))],
		["no models array", () => writeFileSync(cacheFile(), JSON.stringify({ version: 1, models: [] }))],
		["only unusable ids", () => writeFileSync(cacheFile(), JSON.stringify({ version: 1, models: [{ modelId: "  " }, { modelId: "bad\nid" }] }))],
	])("returns undefined for %s", (_label, seed) => {
		seed();
		expect(readModelCache(cacheFile())).toBeUndefined();
	});

	it("round-trips the advertised catalog with names", () => {
		const advertised: AcpModelInfo[] = [
			{ modelId: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
			{ modelId: "claude-opus-5.5", name: "Claude Opus 5.5" },
		];
		writeModelCache(advertised, cacheFile(), 1_700_000_000_000);
		expect(readModelCache(cacheFile())).toEqual(advertised);
		expect(JSON.parse(readFileSync(cacheFile(), "utf8"))).toMatchObject({
			version: 1,
			fetchedAt: 1_700_000_000_000,
		});
	});

	it("deduplicates ids and bounds names", () => {
		writeModelCache(
			[
				{ modelId: "gemini-x", name: "First" },
				{ modelId: "gemini-x", name: "Second" },
				{ modelId: "gemini-y", name: "y".repeat(500) },
			],
			cacheFile(),
		);
		const models = readModelCache(cacheFile());
		expect(models?.map((model) => model.modelId)).toEqual(["gemini-x", "gemini-y"]);
		expect(models?.[0]?.name).toBe("First");
		expect(models?.[1]?.name).toHaveLength(200);
	});

	it("ignores an unwritable location instead of failing discovery", () => {
		const blocker = path.join(directory, "blocker");
		writeFileSync(blocker, "");
		expect(() =>
			writeModelCache([{ modelId: "gemini-x", name: "X" }], path.join(blocker, "models-cache.json")),
		).not.toThrow();
	});

	it("defaults to the provider config root", () => {
		expect(resolveModelCachePath()).toMatch(/antigravity-acp-provider[/\\]models-cache\.json$/u);
	});
});

describe("provider catalog", () => {
	it("starts from the cached catalog instead of the bootstrap list", () => {
		writeModelCache(
			[
				{ modelId: "gemini-4-hydrogen-low", name: "Gemini 4 Hydrogen (Low)" },
				{ modelId: "claude-opus-5.5", name: "Claude Opus 5.5" },
			],
			cacheFile(),
		);
		const runtime = {} as AntigravityRuntime;
		const { provider } = createAntigravityProvider(runtime, { modelCachePath: cacheFile() });
		expect(provider.getModels().map((model) => model.id)).toEqual(["gemini-4-hydrogen-low", "claude-opus-5.5"]);
	});

	it("falls back to the bootstrap list without a cache", () => {
		const { provider } = createAntigravityProvider({} as AntigravityRuntime, { modelCachePath: cacheFile() });
		expect(provider.getModels().map((model) => model.id)).toEqual(FALLBACK_MODELS.map((model) => model.id));
	});

	it("publishes and caches whatever the server advertises", async () => {
		const advertised: AcpModelInfo[] = [
			{ modelId: "gemini-5-neon-high", name: "Gemini 5 Neon (High)" },
			{ modelId: "gemini-5-neon-low", name: "Gemini 5 Neon (Low)" },
		];
		const runtime = { discoverModels: async () => advertised } as unknown as AntigravityRuntime;
		const { provider } = createAntigravityProvider(runtime, { modelCachePath: cacheFile() });
		let published: readonly unknown[] = [];
		await provider.refreshModels?.(refreshContext(true, async ({ update }) => {
			update();
			published = provider.getModels();
			return true;
		}));
		expect(published.map((model) => (model as { id: string }).id)).toEqual(["gemini-5-neon"]);
		expect(readModelCache(cacheFile())).toEqual(advertised);
	});

	it("keeps the previous catalog when discovery fails", async () => {
		writeModelCache([{ modelId: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" }], cacheFile());
		const runtime = {
			discoverModels: async () => {
				throw new Error("offline");
			},
		} as unknown as AntigravityRuntime;
		const { provider } = createAntigravityProvider(runtime, { modelCachePath: cacheFile() });
		await provider.refreshModels?.(refreshContext(true, async () => {
			throw new Error("must not publish without discovery");
		}));
		expect(provider.getModels().map((model) => model.id)).toEqual(["gemini-4-argon-low"]);
	});

	it("skips discovery when the context forbids network access", async () => {
		let called = false;
		const runtime = {
			discoverModels: async () => {
				called = true;
				return [];
			},
		} as unknown as AntigravityRuntime;
		const { provider } = createAntigravityProvider(runtime, { modelCachePath: cacheFile() });
		await provider.refreshModels?.(refreshContext(false, async () => false));
		expect(called).toBe(false);
	});
});
