import { describe, expect, it } from "vitest";

import { permissionModeOf, resolveSessionMode } from "../src/acp/mode-map.js";

const serverIds = ["default", "auto_edit", "yolo"];
const cliIds = ["default", "accept-edits", "auto", "plan"];

describe("permission mode mapping", () => {
	it.each([
		{ mode: "default", available: serverIds, expected: "default" },
		{ mode: "auto_edit", available: serverIds, expected: "auto_edit" },
		{ mode: "yolo", available: serverIds, expected: "yolo" },
		{ mode: "default", available: cliIds, expected: "default" },
		{ mode: "auto_edit", available: cliIds, expected: "accept-edits" },
		{ mode: "yolo", available: cliIds, expected: "auto" },
		{ mode: "yolo", available: ["default"], expected: undefined },
		{ mode: "auto_edit", available: [], expected: undefined },
	] as const)("resolves $mode against $available", ({ mode, available, expected }) => {
		expect(resolveSessionMode(mode, available)).toBe(expected);
	});

	it.each([
		{ id: "default", expected: "default" },
		{ id: "auto_edit", expected: "auto_edit" },
		{ id: "accept-edits", expected: "auto_edit" },
		{ id: "yolo", expected: "yolo" },
		{ id: "auto", expected: "yolo" },
		{ id: "plan", expected: undefined },
		{ id: undefined, expected: undefined },
	] as const)("reads $id back as $expected", ({ id, expected }) => {
		expect(permissionModeOf(id)).toBe(expected);
	});
});
