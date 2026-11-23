import { describe, expect, it } from "vitest";

import { truncateText } from "../src/acp/text.js";

describe("truncateText", () => {
	it.each([
		["under the limit", "abc", 8, "abc"],
		["exactly at the limit", "abcdefgh", 8, "abcdefgh"],
		["over the limit", "abcdefghij", 8, "abcdefgh"],
		["a BMP multibyte character at the boundary", "中文字符", 2, "中文"],
		["a surrogate pair straddling the boundary", "ab😀", 3, "ab"],
		["a surrogate pair inside the limit", "ab😀", 4, "ab😀"],
	] as const)("keeps %s intact", (_case, text, limit, expected) => {
		expect(truncateText(text, limit)).toBe(expected);
	});

	it("never leaves a lone high surrogate at the cut", () => {
		const truncated = truncateText(`${"x".repeat(9)}😀`, 10);
		expect(truncated).toBe("x".repeat(9));
		expect(truncated.length).toBe(9);
	});
});
