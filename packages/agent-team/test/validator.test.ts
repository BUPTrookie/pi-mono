import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeContracts } from "../src/team/planner.js";
import { validateTeamOutput, validateTeamOutputWithChecks } from "../src/team/validator.js";
import type { PlannerResult } from "../src/types.js";

function tempProject(): string {
	return join(tmpdir(), `agent-team-validator-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function plannerResult(): PlannerResult {
	return {
		plan: {
			id: "test-plan",
			summary: "Test API project",
			roles: [
				{
					name: "api-builder",
					description: "Builds the API",
					allowedTools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
					ownedDirectories: ["src"],
					maxTurns: 30,
				},
			],
			tasks: [
				{
					id: "task-api",
					role: "api-builder",
					subject: "Build API",
					description: "Implement the API from contracts.",
					dependencies: [],
					ownedDirectories: ["src"],
					expectedOutputs: ["src/index.js", "package.json"],
					acceptanceCriteria: ["API routes match OpenAPI."],
				},
			],
			contracts: [
				{ path: "docs/contracts/team-plan.json", kind: "team-plan", required: true },
				{ path: "docs/contracts/project-manifest.json", kind: "project-manifest", required: true },
				{ path: "docs/contracts/openapi.json", kind: "openapi", required: true },
			],
			validationRules: ["Expected files exist.", "OpenAPI routes are represented in source."],
		},
		contracts: {
			projectManifest: { goal: "Build a test API", features: ["health", "items"] },
			openapi: {
				openapi: "3.1.0",
				info: { title: "Test API", version: "1.0.0" },
				paths: {
					"/api/health": {},
					"/api/things/{thingId}/votes": {},
				},
			},
		},
		diagnostics: [],
	};
}

describe("validator", () => {
	it("detects missing task outputs", () => {
		const outputDir = tempProject();
		mkdirSync(outputDir, { recursive: true });
		const result = plannerResult();
		writeContracts(outputDir, result);

		const issues = validateTeamOutput(outputDir, result.plan);

		expect(issues.some((issue) => issue.id.startsWith("missing-output-task-api"))).toBe(true);
	});

	it("detects OpenAPI paths that are not represented in code", () => {
		const outputDir = tempProject();
		mkdirSync(join(outputDir, "src"), { recursive: true });
		const result = plannerResult();
		writeContracts(outputDir, result);
		writeFileSync(
			join(outputDir, "package.json"),
			JSON.stringify({ scripts: { start: "node src/index.js" } }),
			"utf-8",
		);
		writeFileSync(join(outputDir, "src/index.js"), "console.log('server')", "utf-8");

		const issues = validateTeamOutput(outputDir, result.plan);

		expect(issues.some((issue) => issue.id.startsWith("missing-openapi-path"))).toBe(true);
	});

	it("runs package check scripts as whole-project validation", async () => {
		const outputDir = tempProject();
		mkdirSync(join(outputDir, "src"), { recursive: true });
		const result = plannerResult();
		writeContracts(outputDir, result);
		writeFileSync(
			join(outputDir, "package.json"),
			JSON.stringify({ scripts: { check: 'node -e "process.exit(7)"' } }),
			"utf-8",
		);
		writeFileSync(join(outputDir, "src/index.js"), "console.log('/api/health /api/things/votes')", "utf-8");

		const issues = await validateTeamOutputWithChecks(outputDir, result.plan, {
			installDependencies: false,
			runSyntaxChecks: false,
			commandTimeoutMs: 10_000,
		});

		expect(issues.some((issue) => issue.id === "runtime-check-npm-run-check")).toBe(true);
	});

	it("runs syntax checks before package scripts", async () => {
		const outputDir = tempProject();
		mkdirSync(join(outputDir, "src"), { recursive: true });
		const result = plannerResult();
		writeContracts(outputDir, result);
		writeFileSync(
			join(outputDir, "package.json"),
			JSON.stringify({ scripts: { check: "node -e \"console.log('ok')\"" } }),
			"utf-8",
		);
		writeFileSync(join(outputDir, "src/index.js"), "// /api/health /api/things/votes\nfunction broken( {", "utf-8");

		const issues = await validateTeamOutputWithChecks(outputDir, result.plan, {
			installDependencies: false,
			commandTimeoutMs: 10_000,
		});

		expect(issues[0]?.id).toContain("runtime-check-node-check");
		expect(issues[0]?.ownerTaskId).toBe("task-api");
	});

	it("routes package and OpenAPI validation issues to dynamic task owners", () => {
		const outputDir = tempProject();
		mkdirSync(join(outputDir, "src"), { recursive: true });
		const result = plannerResult();
		result.plan.roles[0].name = "project-builder";
		result.plan.tasks[0].id = "build-project";
		result.plan.tasks[0].role = "project-builder";
		result.plan.tasks[0].expectedOutputs = ["src/index.js", "package.json"];
		writeContracts(outputDir, result);
		writeFileSync(join(outputDir, "package.json"), JSON.stringify({ name: "dynamic-app" }), "utf-8");
		writeFileSync(join(outputDir, "src/index.js"), "console.log('/api/health')", "utf-8");

		const issues = validateTeamOutput(outputDir, result.plan);
		const packageIssue = issues.find((issue) => issue.id === "missing-package-scripts");
		const openApiIssue = issues.find((issue) => issue.id.startsWith("missing-openapi-path"));

		expect(packageIssue?.ownerTaskId).toBe("build-project");
		expect(packageIssue?.ownerRole).toBe("project-builder");
		expect(openApiIssue?.ownerTaskId).toBe("build-project");
		expect(openApiIssue?.ownerRole).toBe("project-builder");
	});
});
