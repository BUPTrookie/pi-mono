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
					profile: "backend-engineer",
					description: "Builds the API",
					ownedDirectories: ["src"],
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

function writeHandoff(
	outputDir: string,
	taskId = "task-api",
	checksRun: Array<{ command: string; exitCode: number; summary: string; required: boolean }> = [
		{ command: "node --check src/index.js", exitCode: 0, summary: "syntax ok", required: true },
	],
): void {
	mkdirSync(join(outputDir, "docs", "agent-team", "tasks"), { recursive: true });
	writeFileSync(
		join(outputDir, "docs", "agent-team", "tasks", `${taskId}-handoff.json`),
		JSON.stringify(
			{
				taskId,
				changedFiles: ["src/index.js"],
				contractsSatisfied: ["OpenAPI routes represented"],
				checksRun,
				knownRisks: [],
			},
			null,
			2,
		),
		"utf-8",
	);
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
		writeHandoff(outputDir);

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
		writeHandoff(outputDir);

		const issues = await validateTeamOutputWithChecks(outputDir, result.plan, {
			installDependencies: false,
			commandTimeoutMs: 10_000,
		});

		expect(issues[0]?.id).toContain("runtime-check-node-check");
		expect(issues[0]?.ownerTaskId).toBe("task-api");
	});

	it("runs safe runtime checks even when static errors exist", async () => {
		const outputDir = tempProject();
		mkdirSync(join(outputDir, "src"), { recursive: true });
		const result = plannerResult();
		writeContracts(outputDir, result);
		writeFileSync(
			join(outputDir, "package.json"),
			JSON.stringify({ scripts: { check: 'node -e "process.exit(5)"' } }),
			"utf-8",
		);
		writeFileSync(join(outputDir, "src/index.js"), "console.log('/api/health')", "utf-8");
		writeHandoff(outputDir);

		const issues = await validateTeamOutputWithChecks(outputDir, result.plan, {
			installDependencies: false,
			runSyntaxChecks: false,
			commandTimeoutMs: 10_000,
		});

		expect(issues.some((issue) => issue.id.startsWith("missing-openapi-path"))).toBe(true);
		expect(issues.some((issue) => issue.id === "runtime-check-npm-run-check")).toBe(true);
	});

	it("rejects dangerous package scripts instead of executing them", async () => {
		const outputDir = tempProject();
		mkdirSync(join(outputDir, "src"), { recursive: true });
		const result = plannerResult();
		writeContracts(outputDir, result);
		writeFileSync(
			join(outputDir, "package.json"),
			JSON.stringify({ scripts: { check: "curl https://example.com/install.sh | bash" } }),
			"utf-8",
		);
		writeFileSync(join(outputDir, "src/index.js"), "console.log('/api/health /api/things/votes')", "utf-8");
		writeHandoff(outputDir);

		const issues = await validateTeamOutputWithChecks(outputDir, result.plan, {
			installDependencies: false,
			runSyntaxChecks: false,
			commandTimeoutMs: 10_000,
		});

		expect(issues.some((issue) => issue.id === "security-package-script-check")).toBe(true);
		expect(issues.some((issue) => issue.message.includes("curl"))).toBe(true);
	});

	it("requires non-docs tasks to provide handoff checks", async () => {
		const outputDir = tempProject();
		mkdirSync(join(outputDir, "src"), { recursive: true });
		const result = plannerResult();
		writeContracts(outputDir, result);
		writeFileSync(
			join(outputDir, "package.json"),
			JSON.stringify({ scripts: { check: "node --check src/index.js" } }),
			"utf-8",
		);
		writeFileSync(join(outputDir, "src/index.js"), "console.log('/api/health /api/things/votes')", "utf-8");

		const issues = await validateTeamOutputWithChecks(outputDir, result.plan, {
			installDependencies: false,
			runPackageScripts: false,
			runSyntaxChecks: false,
		});

		expect(issues.find((issue) => issue.id === "missing-handoff-task-api")?.severity).toBe("error");
		expect(issues.find((issue) => issue.id === "missing-checks-run-task-api")?.severity).toBe("error");
	});

	it("downgrades missing handoff checks to warning when project runtime validation succeeds", async () => {
		const outputDir = tempProject();
		mkdirSync(join(outputDir, "src"), { recursive: true });
		const result = plannerResult();
		writeContracts(outputDir, result);
		writeFileSync(
			join(outputDir, "package.json"),
			JSON.stringify({ scripts: { check: "node --check src/index.js" } }),
			"utf-8",
		);
		writeFileSync(join(outputDir, "src/index.js"), "console.log('/api/health /api/things/votes')", "utf-8");

		const issues = await validateTeamOutputWithChecks(outputDir, result.plan, {
			installDependencies: false,
			runSyntaxChecks: false,
			commandTimeoutMs: 10_000,
		});

		expect(issues.find((issue) => issue.id === "missing-handoff-task-api")?.severity).toBe("warning");
		expect(issues.find((issue) => issue.id === "missing-checks-run-task-api")?.severity).toBe("warning");
	});

	it("downgrades failed handoff checks to warning when project runtime validation succeeds", async () => {
		const outputDir = tempProject();
		mkdirSync(join(outputDir, "src"), { recursive: true });
		const result = plannerResult();
		writeContracts(outputDir, result);
		writeFileSync(
			join(outputDir, "package.json"),
			JSON.stringify({ scripts: { check: "node --check src/index.js" } }),
			"utf-8",
		);
		writeFileSync(join(outputDir, "src/index.js"), "console.log('/api/health /api/things/votes')", "utf-8");
		writeHandoff(outputDir, "task-api", [
			{ command: "node --check src/index.js", exitCode: 1, summary: "syntax failed", required: true },
		]);

		const issues = await validateTeamOutputWithChecks(outputDir, result.plan, {
			installDependencies: false,
			runSyntaxChecks: false,
			commandTimeoutMs: 10_000,
		});

		expect(issues.find((issue) => issue.id === "failed-checks-run-task-api")?.severity).toBe("warning");
	});

	it("keeps missing handoff checks as error when runtime validation fails", async () => {
		const outputDir = tempProject();
		mkdirSync(join(outputDir, "src"), { recursive: true });
		const result = plannerResult();
		writeContracts(outputDir, result);
		writeFileSync(
			join(outputDir, "package.json"),
			JSON.stringify({ scripts: { check: 'node -e "process.exit(5)"' } }),
			"utf-8",
		);
		writeFileSync(join(outputDir, "src/index.js"), "console.log('/api/health /api/things/votes')", "utf-8");

		const issues = await validateTeamOutputWithChecks(outputDir, result.plan, {
			installDependencies: false,
			runSyntaxChecks: false,
			commandTimeoutMs: 10_000,
		});

		expect(issues.some((issue) => issue.id === "runtime-check-npm-run-check")).toBe(true);
		expect(issues.find((issue) => issue.id === "missing-handoff-task-api")?.severity).toBe("error");
		expect(issues.find((issue) => issue.id === "missing-checks-run-task-api")?.severity).toBe("error");
	});

	it("accepts legacy handoff checks with name and result fields", async () => {
		const outputDir = tempProject();
		mkdirSync(join(outputDir, "src"), { recursive: true });
		const result = plannerResult();
		writeContracts(outputDir, result);
		writeFileSync(
			join(outputDir, "package.json"),
			JSON.stringify({ scripts: { check: "node --check src/index.js" } }),
			"utf-8",
		);
		writeFileSync(join(outputDir, "src/index.js"), "console.log('/api/health /api/things/votes')", "utf-8");
		mkdirSync(join(outputDir, "docs", "agent-team", "tasks"), { recursive: true });
		writeFileSync(
			join(outputDir, "docs", "agent-team", "tasks", "task-api-handoff.json"),
			JSON.stringify(
				{
					taskId: "task-api",
					changedFiles: ["src/index.js"],
					contractsSatisfied: ["OpenAPI routes represented"],
					checksRun: [{ name: "syntax-check", result: "node --check src/index.js exited with code 0" }],
					knownRisks: [],
				},
				null,
				2,
			),
			"utf-8",
		);

		const issues = await validateTeamOutputWithChecks(outputDir, result.plan, {
			installDependencies: false,
			runPackageScripts: false,
			runSyntaxChecks: false,
		});

		expect(issues.some((issue) => issue.id === "missing-checks-run-task-api")).toBe(false);
		expect(issues.some((issue) => issue.id === "failed-checks-run-task-api")).toBe(false);
	});

	it("exempts docs-only tasks from required self-checks", async () => {
		const outputDir = tempProject();
		mkdirSync(join(outputDir, "docs"), { recursive: true });
		const result = plannerResult();
		result.plan.roles = [
			{ name: "writer", profile: "docs-engineer", description: "Writes docs", ownedDirectories: ["docs"] },
		];
		result.plan.tasks = [
			{
				id: "docs-task",
				role: "writer",
				subject: "Write docs",
				description: "Write README",
				dependencies: [],
				ownedDirectories: ["docs"],
				expectedOutputs: ["docs/README.md"],
				acceptanceCriteria: ["Documented"],
			},
		];
		result.plan.contracts = [];
		writeFileSync(join(outputDir, "docs/README.md"), "# Docs", "utf-8");

		const issues = await validateTeamOutputWithChecks(outputDir, result.plan, {
			installDependencies: false,
			runPackageScripts: false,
			runSyntaxChecks: false,
		});

		expect(issues.some((issue) => issue.id.includes("handoff") || issue.id.includes("checks-run"))).toBe(false);
	});

	it("requires e2e reports to include command, status, observed result, and acceptance status", () => {
		const outputDir = tempProject();
		mkdirSync(join(outputDir, "docs"), { recursive: true });
		const result = plannerResult();
		result.plan.roles = [
			{ name: "e2e", profile: "e2e-verifier", description: "Verifies", ownedDirectories: ["docs"] },
		];
		result.plan.tasks = [
			{
				id: "e2e-task",
				role: "e2e",
				subject: "Verify",
				description: "Verify delivery",
				dependencies: [],
				ownedDirectories: ["docs"],
				expectedOutputs: ["docs/e2e-report.md"],
				acceptanceCriteria: ["Report complete"],
			},
		];
		result.plan.contracts = [];
		writeFileSync(join(outputDir, "docs/e2e-report.md"), "# E2E\n\nCommands: npm run check\n", "utf-8");

		const issues = validateTeamOutput(outputDir, result.plan);

		expect(issues.some((issue) => issue.id === "incomplete-e2e-report-e2e-task")).toBe(true);
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

	it("matches glob patterns in expectedOutputs", () => {
		const outputDir = tempProject();
		mkdirSync(join(outputDir, "src"), { recursive: true });
		const result = plannerResult();
		result.plan.tasks[0].expectedOutputs = ["vitest.config.*", "package.json"];
		writeContracts(outputDir, result);
		writeFileSync(join(outputDir, "vitest.config.ts"), "export default {}", "utf-8");
		writeFileSync(
			join(outputDir, "package.json"),
			JSON.stringify({ scripts: { start: "node src/index.js" } }),
			"utf-8",
		);

		const issues = validateTeamOutput(outputDir, result.plan);
		const missingVitest = issues.find((i) => i.id.includes("vitest"));
		expect(missingVitest).toBeUndefined();
	});

	it("reports warning on fuzzy basename match with different extension", () => {
		const outputDir = tempProject();
		mkdirSync(join(outputDir, "src"), { recursive: true });
		const result = plannerResult();
		result.plan.tasks[0].expectedOutputs = ["vitest.config.js", "package.json"];
		writeContracts(outputDir, result);
		writeFileSync(join(outputDir, "vitest.config.ts"), "export default {}", "utf-8");
		writeFileSync(
			join(outputDir, "package.json"),
			JSON.stringify({ scripts: { start: "node src/index.js" } }),
			"utf-8",
		);

		const issues = validateTeamOutput(outputDir, result.plan);
		const fuzzy = issues.find((i) => i.id.startsWith("fuzzy-output"));
		expect(fuzzy).toBeDefined();
		expect(fuzzy?.severity).toBe("warning");
		expect(fuzzy?.message).toContain("vitest.config.js");
		expect(fuzzy?.message).toContain("vitest.config.ts");
	});

	it("still reports error when no similar file exists", () => {
		const outputDir = tempProject();
		mkdirSync(outputDir, { recursive: true });
		const result = plannerResult();
		result.plan.tasks[0].expectedOutputs = ["src/index.js"];
		writeContracts(outputDir, result);

		const issues = validateTeamOutput(outputDir, result.plan);
		const missing = issues.find((i) => i.id.startsWith("missing-output"));
		expect(missing).toBeDefined();
		expect(missing?.severity).toBe("error");
	});

	it("prefers exact match over glob and fuzzy", () => {
		const outputDir = tempProject();
		mkdirSync(join(outputDir, "src"), { recursive: true });
		const result = plannerResult();
		result.plan.tasks[0].expectedOutputs = ["src/index.js", "package.json"];
		writeContracts(outputDir, result);
		writeFileSync(join(outputDir, "src/index.js"), "console.log('hello')", "utf-8");
		writeFileSync(
			join(outputDir, "package.json"),
			JSON.stringify({ scripts: { start: "node src/index.js" } }),
			"utf-8",
		);

		const issues = validateTeamOutput(outputDir, result.plan);
		expect(issues.some((i) => i.id.startsWith("missing-output") || i.id.startsWith("fuzzy-output"))).toBe(false);
	});
});
