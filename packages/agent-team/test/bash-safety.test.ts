import { describe, expect, it } from "vitest";
import { explainUnsafeBash } from "../src/agent/bash-safety.js";

describe("bash safety", () => {
	it("allows read-only inspection commands", () => {
		expect(explainUnsafeBash("ls src")).toBeUndefined();
		expect(explainUnsafeBash('grep -R "todo" src')).toBeUndefined();
		expect(explainUnsafeBash("mkdir -p src client")).toBeUndefined();
	});

	it("blocks file mutation and long-running dependency commands", () => {
		expect(explainUnsafeBash("echo hello > package.json")).toBeDefined();
		expect(explainUnsafeBash("rm -rf src")).toBeDefined();
		expect(explainUnsafeBash("npm install")).toBeDefined();
		expect(explainUnsafeBash("npm start")).toBeDefined();
	});
});
