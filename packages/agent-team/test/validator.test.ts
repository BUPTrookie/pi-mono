import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTeamPlan, writeContracts } from "../src/team/planner.js";
import { validateTeamOutput } from "../src/team/validator.js";

function tempProject(): string {
	return join(tmpdir(), `agent-team-validator-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("validator", () => {
	it("detects missing task outputs", () => {
		const outputDir = tempProject();
		mkdirSync(outputDir, { recursive: true });
		const plan = createTeamPlan("Build a todo CRUD API");
		writeContracts(outputDir, "Build a todo CRUD API", plan);

		const issues = validateTeamOutput(outputDir, plan);

		expect(issues.some((issue) => issue.id.startsWith("missing-output-task-api"))).toBe(true);
	});

	it("detects OpenAPI paths that are not represented in code", () => {
		const outputDir = tempProject();
		mkdirSync(join(outputDir, "src"), { recursive: true });
		const plan = createTeamPlan("Build a todo CRUD API");
		writeContracts(outputDir, "Build a todo CRUD API", plan);
		writeFileSync(
			join(outputDir, "package.json"),
			JSON.stringify({ scripts: { start: "node src/index.js" } }),
			"utf-8",
		);
		writeFileSync(join(outputDir, "src/index.js"), "console.log('server')", "utf-8");

		const issues = validateTeamOutput(outputDir, plan);

		expect(issues.some((issue) => issue.id.startsWith("missing-openapi-path"))).toBe(true);
	});
});
