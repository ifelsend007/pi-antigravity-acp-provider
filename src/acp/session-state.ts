import type {
	NewSessionResponse,
	SessionConfigOption,
	SessionConfigSelectOption,
	SessionModeState,
} from "@agentclientprotocol/sdk/unstable";
import { z } from "zod";

import { splitEffortSuffix } from "../models.js";
import { AntigravityAcpError } from "./errors.js";

/** Antigravity's pre-config-option model metadata remains on older ACP v1 servers. */
export interface AcpModelInfo {
	modelId: string;
	name: string;
}

export interface SessionState {
	modes?: SessionModeState | null;
	configOptions?: SessionConfigOption[] | null;
	models?: { currentModelId: string; availableModels: AcpModelInfo[] } | null;
}

export type AcpNewSessionResponse = NewSessionResponse & SessionState;
type SelectOption = Extract<SessionConfigOption, { type: "select" }>;
const valueSchema = z.object({ value: z.string(), name: z.string() });
const selectorBase = { id: z.string(), name: z.string(), category: z.string().nullish() };
const stateSchema = z.object({
	modes: z.object({ currentModeId: z.string(), availableModes: z.array(z.object({ id: z.string(), name: z.string() })) }).nullish(),
	configOptions: z.array(z.discriminatedUnion("type", [
		z.object({ ...selectorBase, type: z.literal("select"), currentValue: z.string(), options: z.union([
			z.array(valueSchema),
			z.array(z.object({ group: z.string(), name: z.string(), options: z.array(valueSchema) })),
		]) }),
		z.object({ ...selectorBase, type: z.literal("boolean"), currentValue: z.boolean() }),
	])).nullish(),
	models: z.object({ currentModelId: z.string(), availableModels: z.array(z.object({ modelId: z.string(), name: z.string() })) }).nullish(),
});

/** Validate the state we use explicitly, preserving Antigravity's legacy model
 * metadata even when it is absent from the SDK's generated response types. */
export function decodeSessionState(response: unknown): SessionState {
	const parsed = stateSchema.safeParse(response);
	if (!parsed.success) throw new AntigravityAcpError("protocol", "Invalid ACP session configuration");
	// JSON responses cannot contain explicit undefined properties; Zod's optional
	// property inference is broader than the SDK's exact-optional declarations.
	return parsed.data as SessionState;
}

export type SessionSelectorCategory = "model" | "mode" | "thought_level";

export function findSessionSelector(state: SessionState, category: SessionSelectorCategory): SelectOption | undefined {
	return state.configOptions?.find((option): option is SelectOption =>
		option.type === "select" &&
		(option.category === category ||
			option.id === category ||
			(category === "thought_level" && option.id === "thinking_level")),
	);
}

export function selectorValues(option: SelectOption): SessionConfigSelectOption[] {
	return option.options.flatMap((entry) => "options" in entry ? entry.options : [entry]);
}

/** Reverse the selector cross-product used by discovery, including unknown
 * thought levels, without misinterpreting an exact native model ID. */
export function splitSessionModelId(state: SessionState, modelId: string): { base: string; effort: string } | undefined {
	const model = findSessionSelector(state, "model");
	const thought = findSessionSelector(state, "thought_level");
	if (!model || !thought) return undefined;
	const models = selectorValues(model);
	if (models.some((option) => option.value === modelId)) return undefined;
	const levels = selectorValues(thought);
	for (const base of models) {
		const level = levels.find((option) => `${base.value}-${option.value}` === modelId);
		if (level) return { base: base.value, effort: level.value };
	}
	return undefined;
}

export function sessionModels(state: SessionState): { currentModelId: string; availableModels: AcpModelInfo[] } | undefined {
	const selector = findSessionSelector(state, "model");
	if (!selector) return state.models ?? undefined;
	const thoughtSelector = findSessionSelector(state, "thought_level");
	const modelOptions = selectorValues(selector);
	if (thoughtSelector) {
		const thoughtOptions = selectorValues(thoughtSelector);
		const qualified = (id: string) => splitEffortSuffix(id) !== undefined ||
			thoughtOptions.some((option) => option.value.length > 0 && id.endsWith(`-${option.value}`));
		if (thoughtOptions.length > 0 && modelOptions.some((option) => !qualified(option.value))) {
			const currentModelId =
				qualified(selector.currentValue) || !thoughtSelector.currentValue
					? selector.currentValue
					: `${selector.currentValue}-${thoughtSelector.currentValue}`;
			// The CLI advertises exactly the (model, effort) pairs that exist — Argon has no
			// xhigh — so a cross-product would publish IDs the server rejects with -32602.
			const advertised = state.models?.availableModels;
			const synthesized = modelOptions.flatMap((modelOpt) =>
				qualified(modelOpt.value)
					? [{ modelId: modelOpt.value, name: modelOpt.name }]
					: thoughtOptions.map((thoughtOpt) => ({
							modelId: `${modelOpt.value}-${thoughtOpt.value}`,
							name: `${modelOpt.name} (${thoughtOpt.name})`,
						})),
			);
			// Only IDs this session actually offers survive: either a selector value
			// (models without an effort axis) or a real model/effort pair.
			const knownIds = new Set([
				...modelOptions.map((option) => option.value),
				...synthesized.map((model) => model.modelId),
			]);
			const usableAdvertised = advertised !== undefined && isCompleteInventory(advertised, knownIds, 2);
			if (usableAdvertised) return { currentModelId, availableModels: advertised };
			// Live selectors are authoritative; retain legacy labels only for the
			// same complete, duplicate-free inventory.
			const isLegacyCompatible =
				advertised !== undefined && isCompleteInventory(advertised, knownIds, synthesized.length);

			return {
				currentModelId,
				availableModels: isLegacyCompatible ? advertised : synthesized,
			};
		}
	}
	return {
		currentModelId: selector.currentValue,
		availableModels: modelOptions.map((option) => ({ modelId: option.value, name: option.name })),
	};
}

function isCompleteInventory(
	models: readonly AcpModelInfo[],
	knownIds: ReadonlySet<string>,
	minimum: number,
): boolean {
	return (
		models.length >= minimum &&
		new Set(models.map((model) => model.modelId)).size === models.length &&
		models.every((model) => knownIds.has(model.modelId))
	);
}

export function sessionModes(state: SessionState): SessionModeState | null | undefined {
	const selector = findSessionSelector(state, "mode");
	if (!selector) return state.modes;
	return {
		currentModeId: selector.currentValue,
		availableModes: selectorValues(selector).map((option) => ({ id: option.value, name: option.name })),
	};
}

