import { beforeEach, describe, expect, it, vi } from "vitest";

const { ensureReady } = vi.hoisted(() => ({ ensureReady: vi.fn() }));
vi.mock("../src/acp/setup.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/acp/setup.js")>()),
	ensureAntigravityAcpReady: ensureReady,
}));
// The CLI serves the agent while a managed server copy sits on disk: the state where a
// stale server used to short-circuit the quota refresh forever.
vi.mock("../src/acp/antigravity.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/acp/antigravity.js")>()),
	hasAntigravityCli: () => true,
	hasAntigravityAcpServer: () => true,
}));

const { AntigravityRuntime } = await import("../src/runtime.js");

beforeEach(() => {
	ensureReady.mockReset();
});

describe("quota refreshes the managed server", () => {
	it("refreshes the managed server even when the CLI serves the agent", async () => {
		ensureReady.mockRejectedValueOnce(new Error("refresh reached"));
		const runtime = new AntigravityRuntime();
		await expect(runtime.quota(undefined)).rejects.toThrow("refresh reached");
		expect(ensureReady).toHaveBeenCalledTimes(1);
	});

	it("leaves the decision to an injected connection factory", async () => {
		const runtime = new AntigravityRuntime(() => {
			throw new Error("factory reached");
		});
		await expect(runtime.quota(undefined)).rejects.toThrow();
		expect(ensureReady).not.toHaveBeenCalled();
	});
});
