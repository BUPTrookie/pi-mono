import { describe, expect, it } from "vitest";
import type { BeforeToolCallContext } from "@mariozechner/pi-agent-core";
import { createOwnershipGuard, isPathOwned } from "../src/agent/file-ownership.js";

function toolContext(name: string, args: Record<string, unknown>): BeforeToolCallContext {
	return {
		toolCall: { id: "tool-call", name, arguments: args },
		args,
	} as unknown as BeforeToolCallContext;
}

describe("file-ownership", () => {
	const outputDir = "/project";

	describe("isPathOwned", () => {
		it("should allow paths within owned directories", () => {
			expect(isPathOwned("src/index.ts", ["src"], outputDir)).toBe(true);
			expect(isPathOwned("docs/requirements.md", ["docs"], outputDir)).toBe(true);
			expect(isPathOwned("client/App.tsx", ["client"], outputDir)).toBe(true);
		});

		it("should reject paths outside owned directories", () => {
			expect(isPathOwned("src/index.ts", ["docs"], outputDir)).toBe(false);
			expect(isPathOwned("README.md", ["src"], outputDir)).toBe(false);
		});

		it("should handle multiple owned directories", () => {
			expect(isPathOwned("src/index.ts", ["src", "docs"], outputDir)).toBe(true);
			expect(isPathOwned("docs/api.md", ["src", "docs"], outputDir)).toBe(true);
			expect(isPathOwned("client/App.tsx", ["src", "docs"], outputDir)).toBe(false);
		});

		it("should handle exact file matches in owned directories", () => {
			expect(isPathOwned("README.md", ["README.md"], outputDir)).toBe(true);
			expect(isPathOwned("Dockerfile", ["Dockerfile"], outputDir)).toBe(true);
		});

		it("should handle nested paths", () => {
			expect(isPathOwned("src/db/models/user.ts", ["src"], outputDir)).toBe(true);
			expect(isPathOwned("db/migrations/001.sql", ["db"], outputDir)).toBe(true);
		});

		it("should allow self-test bash commands without owned write targets", async () => {
			const guard = createOwnershipGuard(["src"], outputDir);

			expect(await guard(toolContext("bash", { command: "npm run check" }))).toBeUndefined();
			expect(await guard(toolContext("bash", { command: "npm test" }))).toBeUndefined();
			expect(await guard(toolContext("bash", { command: "npm run build" }))).toBeUndefined();
			expect(await guard(toolContext("bash", { command: "node --check src/index.js" }))).toBeUndefined();
		});

		it("should block bash commands that write outside owned directories", async () => {
			const guard = createOwnershipGuard(["src"], outputDir);

			expect(await guard(toolContext("bash", { command: "echo ok > src/out.txt" }))).toBeUndefined();
			const blockedRedirect = await guard(toolContext("bash", { command: "echo ok > docs/out.txt" }));
			const blockedCompactRedirect = await guard(toolContext("bash", { command: "echo ok>README.md" }));
			const blockedMove = await guard(toolContext("bash", { command: "mv src/out.txt README.md" }));

			expect(blockedRedirect?.block).toBe(true);
			expect(blockedCompactRedirect?.block).toBe(true);
			expect(blockedMove?.block).toBe(true);
		});
	});
});
