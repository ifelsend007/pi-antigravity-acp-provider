import { describe, expect, it } from "vitest";

import { FALLBACK_MODELS, projectModels, resolveAcpModelId, splitEffortSuffix } from "../src/models.js";
import { createAntigravityProvider } from "../src/provider.js";

describe("projectModels", () => {
	it("keeps Flash as the conservative offline default", () => {
		expect(FALLBACK_MODELS[0]?.id).toBe("gemini-3.8-flash");
	});

	it.each([
		["gemini-4-argon", ["low", "medium", "high"]],
		["gemini-4-hydrogen", ["low", "medium", "high", "xhigh"]],
	] as const)("exposes %s offline with every advertised ACP effort id", (id, efforts) => {
		const model = FALLBACK_MODELS.find((candidate) => candidate.id === id);
		expect(model?.thinkingLevelMap?.low).toBe(`${id}-low`);
		expect(model?.thinkingLevelMap?.medium).toBe(`${id}-medium`);
		expect(resolveAcpModelId(model!, "high")).toBe(`${id}-high`);
		for (const level of ["low", "medium", "high", "xhigh"] as const) {
			expect(model?.thinkingLevelMap?.[level]).toBe(
				(efforts as readonly string[]).includes(level) ? `${id}-${level}` : null,
			);
		}
		expect(model?.thinkingLevelMap?.max).toBeNull();
	});

	it("only Hydrogen accepts the extra-high tier", () => {
		const hydrogen = FALLBACK_MODELS.find((candidate) => candidate.id === "gemini-4-hydrogen");
		const argon = FALLBACK_MODELS.find((candidate) => candidate.id === "gemini-4-argon");
		expect(resolveAcpModelId(hydrogen!, "xhigh")).toBe("gemini-4-hydrogen-xhigh");
		expect(resolveAcpModelId(hydrogen!, "max")).toBe("gemini-4-hydrogen-xhigh");
		expect(resolveAcpModelId(argon!, "xhigh")).toBe("gemini-4-argon-high");
		expect(resolveAcpModelId(argon!, "max")).toBe("gemini-4-argon-high");
	});

	it.each(["low", "medium", "high", "xhigh"])("splits a known %s suffix without truncating the base", (effort) => {
		expect(splitEffortSuffix(`gemini-hyphenated-base-${effort}`)).toEqual({ base: "gemini-hyphenated-base", effort });
	});

	it.each(["gemini-base", "-low", "gemini-base-off", "gemini-base-high-extra"])("does not invent a known effort from %s", (id) => {
		expect(splitEffortSuffix(id)).toBeUndefined();
	});

	it("deduplicates and rejects unsafe ids", () => {
		const models = projectModels([
			{ modelId: "gemini-a", name: "Gemini A" },
			{ modelId: "gemini-a", name: "duplicate" },
			{ modelId: "bad\nmodel", name: "bad" },
		]);
		expect(models.map((model) => model.id)).toEqual(["gemini-a"]);
		expect(models[0]?.cost.input).toBe(0);
	});

	it("collapses ACP effort variants into Pi reasoning levels", () => {
		const models = projectModels([
			{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
			{ modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
			{ modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
			{ modelId: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" },
			{ modelId: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
		]);

		expect(models.map((model) => model.id)).toEqual(["gemini-3.8-flash", "gemini-3.1-pro"]);
		expect(models[0]?.thinkingLevelMap?.off).toBeNull();
		expect(models[0]?.thinkingLevelMap?.medium).toBe("gemini-3.8-flash-medium");
		expect(resolveAcpModelId(models[0]!, "low")).toBe("gemini-3.8-flash-low");
		expect(resolveAcpModelId(models[0]!, "high")).toBe("gemini-3.8-flash-high");
		expect(models[1]?.thinkingLevelMap?.medium).toBeNull();
		expect(resolveAcpModelId(models[1]!, "medium")).toBe("gemini-pro-agent");
	});

	it.each(["low", "medium", "high", "xhigh"] as const)("retains the only advertised %s reasoning tier without inventing variants", (effort) => {
		const id = `gemini-4-argon-${effort}`;
		const models = projectModels([{ modelId: id, name: `Gemini 4 Argon (${effort})` }]);
		expect(models).toHaveLength(1);
		expect(models[0]?.id).toBe(id);
		expect(models[0]?.reasoning).toBe(true);
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
			expect(models[0]?.thinkingLevelMap?.[level]).toBe(level === effort ? id : null);
			// Unsupported programmatic levels still select the advertised ID.
			expect(resolveAcpModelId(models[0]!, level === "off" ? undefined : level)).toBe(id);
		}
		expect(resolveAcpModelId(models[0]!, undefined)).toBe(id);
	});

	it("exposes additional Argon tiers only when the server advertises them", () => {
		const models = projectModels([
			{ modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
			{ modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
		]);
		expect(models.map((model) => model.id)).toEqual(["gemini-4-argon"]);
		expect(models[0]?.thinkingLevelMap?.low).toBeNull();
		expect(resolveAcpModelId(models[0]!, "medium")).toBe("gemini-4-argon-medium");
		expect(resolveAcpModelId(models[0]!, "high")).toBe("gemini-4-argon-high");
	});

	it("maps the extra-high tier only where the server advertises it", () => {
		const models = projectModels([
			{ modelId: "gemini-4-hydrogen-low", name: "Gemini 4 Hydrogen (Low)" },
			{ modelId: "gemini-4-hydrogen-medium", name: "Gemini 4 Hydrogen (Medium)" },
			{ modelId: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
			{ modelId: "gemini-4-hydrogen-xhigh", name: "Gemini 4 Hydrogen (XHigh)" },
			{ modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (Extra High)" },
		]);
		const hydrogen = models.find((model) => model.id === "gemini-4-hydrogen");
		expect(hydrogen?.thinkingLevelMap?.xhigh).toBe("gemini-4-hydrogen-xhigh");
		expect(resolveAcpModelId(hydrogen!, "xhigh")).toBe("gemini-4-hydrogen-xhigh");
		// A family that advertises only one tier keeps its raw ACP id as the Pi id.
		const argon = models.find((model) => model.id === "gemini-4-argon-high");
		expect(argon?.thinkingLevelMap?.xhigh).toBe("gemini-4-argon-high");
		expect(resolveAcpModelId(argon!, "xhigh")).toBe("gemini-4-argon-high");
	});

	it("does not infer reasoning for a model without an advertised effort", () => {
		const models = projectModels([{ modelId: "gemini-unknown", name: "Gemini Unknown" }]);
		expect(models[0]?.reasoning).toBe(false);
		expect(models[0]?.thinkingLevelMap).toBeUndefined();
	});

	it("registers separate Google-account and API-key login methods", async () => {
		const { provider, runtime } = createAntigravityProvider();
		try {
			expect(provider.auth.oauth?.loginLabel).toBe("Sign in with Google");
			expect(provider.auth.apiKey?.name).toBe("Antigravity Gemini API key");
		} finally {
			await runtime.close();
		}
	});
});
