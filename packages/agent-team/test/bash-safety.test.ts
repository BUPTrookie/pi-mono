import { describe, expect, it } from "vitest";
import { explainUnsafeBash } from "../src/agent/bash-safety.js";

describe("bash safety", () => {
	it("allows read-only inspection commands", () => {
		expect(explainUnsafeBash("ls src")).toBeUndefined();
		expect(explainUnsafeBash('grep -R "todo" src')).toBeUndefined();
	});

	it("allows normal project file operations", () => {
		expect(explainUnsafeBash("mkdir -p src client")).toBeUndefined();
		expect(explainUnsafeBash("touch README.md")).toBeUndefined();
		expect(explainUnsafeBash("cp a b")).toBeUndefined();
		expect(explainUnsafeBash("mv a b")).toBeUndefined();
	});

	it("allows local self-check commands", () => {
		expect(explainUnsafeBash("npm run check")).toBeUndefined();
		expect(explainUnsafeBash("npm test")).toBeUndefined();
		expect(explainUnsafeBash("npm run test:unit")).toBeUndefined();
		expect(explainUnsafeBash("npm run build")).toBeUndefined();
		expect(explainUnsafeBash("node --check src/index.js")).toBeUndefined();
	});

	it("blocks destructive, dependency, docker, and service commands", () => {
		expect(explainUnsafeBash("rm -rf src")).toBeDefined();
		expect(explainUnsafeBash("npm install")).toBeDefined();
		expect(explainUnsafeBash("pnpm install")).toBeDefined();
		expect(explainUnsafeBash("docker build .")).toBeDefined();
		expect(explainUnsafeBash("docker compose up")).toBeDefined();
		expect(explainUnsafeBash("npm start")).toBeDefined();
		expect(explainUnsafeBash("npm run dev")).toBeDefined();
	});
});
