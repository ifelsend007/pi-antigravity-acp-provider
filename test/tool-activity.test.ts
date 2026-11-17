import { describe, expect, it } from "vitest";

import type { AcpActivity } from "../src/acp/events.js";
import { activityOutput } from "../src/runtime.js";

const tool: AcpActivity = { type: "tool", text: "\n[Antigravity tool: Running edit_file — in_progress]\n" };
const plan: AcpActivity = { type: "plan", text: "\n[Antigravity plan]\n- [completed] read\n" };

describe("activityOutput", () => {
	it.each([
		{ name: "streams agent text", activity: { type: "text", delta: "hello" } as AcpActivity, mode: "off", expected: { kind: "text", delta: "hello" } },
		{ name: "streams real thoughts", activity: { type: "thought", delta: "thinking" } as AcpActivity, mode: "off", expected: { kind: "thinking", delta: "thinking" } },
		{ name: "drops tool activity by default", activity: tool, mode: "off", expected: undefined },
		{ name: "drops plan activity by default", activity: plan, mode: "off", expected: undefined },
		{ name: "interleaves tool activity on request", activity: tool, mode: "transcript", expected: { kind: "thinking", delta: tool.type === "tool" ? tool.text : "" } },
		{ name: "interleaves plan activity on request", activity: plan, mode: "transcript", expected: { kind: "thinking", delta: plan.type === "plan" ? plan.text : "" } },
		{ name: "leaves usage to the caller", activity: { type: "usage", used: 42 } as AcpActivity, mode: "transcript", expected: undefined },
		{ name: "leaves unknown updates to the caller", activity: { type: "unknown", updateType: "x" } as AcpActivity, mode: "transcript", expected: undefined },
	] as { name: string; activity: AcpActivity; mode: "off" | "transcript"; expected: unknown }[])("$name", ({ activity, mode, expected }) => {
		expect(activityOutput(activity, mode)).toEqual(expected);
	});
});
