import { describe, expect, it } from "vitest";
import { isPathOwned } from "../src/agent/file-ownership.js";

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
	});
});
