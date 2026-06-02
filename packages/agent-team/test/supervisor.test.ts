import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildSupervisorContext,
	createSupervisorContextCache,
	parseSupervisorDecision,
	type SupervisorCheckpoint,
	writeSupervisorDecision,
} from "../src/team/supervisor.js";
import type { TeamPlan, ValidationIssue } from "../src/types.js";

function tempProject(): string {
	return join(tmpdir(), `agent-team-supervisor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function plan(): TeamPlan {
	return {
		id: "plan",
		summary: "Build a CLI",
		roles: [{ name: "builder", profile: "project-setup", description: "Builds", ownedDirectories: ["."] }],
		tasks: [
			{
				id: "build-cli",
				role: "builder",
				subject: "Build CLI",
				description: "Build the CLI",
				dependencies: [],
				ownedDirectories: ["."],
				expectedOutputs: ["src/index.js"],
				acceptanceCriteria: ["CLI works"],
			},
		],
		contracts: [{ path: "docs/contracts/project-manifest.json", kind: "project-manifest", required: true }],
		validationRules: ["Outputs exist"],
	};
}

function e2ePlan(): TeamPlan {
	const base = plan();
	return {
		...base,
		roles: [
			{ name: "backend", profile: "backend-engineer", description: "Builds API", ownedDirectories: ["src"] },
			{ name: "e2e", profile: "e2e-verifier", description: "Verifies", ownedDirectories: ["docs"] },
		],
		tasks: [
			{
				id: "backend",
				role: "backend",
				subject: "Build API",
				description: "Build API",
				dependencies: [],
				ownedDirectories: ["src"],
				expectedOutputs: ["src/index.js"],
				acceptanceCriteria: ["API works"],
			},
			{
				id: "e2e",
				role: "e2e",
				subject: "Verify E2E",
				description: "Verify API",
				dependencies: ["backend"],
				ownedDirectories: ["docs"],
				expectedOutputs: ["docs/e2e-report.md"],
				acceptanceCriteria: ["Report E2E"],
			},
		],
	};
}

describe("supervisor", () => {
	it("parses strict supervisor JSON decisions", () => {
		const decision = parseSupervisorDecision(`{
			"checkpoint": "task_end",
			"decision": "request_repair",
			"summary": "Missing self-check evidence",
			"issues": [
				{
					"id": "missing-check",
					"severity": "error",
					"message": "No checks were reported",
					"ownerTaskId": "build-cli",
					"file": "src/index.js"
				}
			],
			"recommendedActions": ["Rerun build-cli with checks"]
		}`);

		expect(decision.decision).toBe("request_repair");
		expect(decision.issues[0]?.ownerTaskId).toBe("build-cli");
		expect(decision.recommendedActions).toEqual(["Rerun build-cli with checks"]);
	});

	it("rejects invalid or unactionable supervisor output", () => {
		expect(() => parseSupervisorDecision("not json")).toThrow("Supervisor output must be valid JSON");
		expect(() =>
			parseSupervisorDecision(
				JSON.stringify({
					checkpoint: "task_end",
					decision: "invented",
					summary: "bad",
					issues: [],
					recommendedActions: [],
				}),
			),
		).toThrow("Unknown supervisor decision");
		expect(() =>
			parseSupervisorDecision(
				JSON.stringify({
					checkpoint: "task_end",
					decision: "request_repair",
					summary: "No owner",
					issues: [{ id: "missing-owner", severity: "error", message: "No owner" }],
					recommendedActions: ["Fix it"],
				}),
			),
		).toThrow("request_repair issues must include ownerTaskId or file");
	});

	it("builds context from contracts, handoff, checks, files, and validation issues", () => {
		const outputDir = tempProject();
		mkdirSync(join(outputDir, "docs", "contracts"), { recursive: true });
		mkdirSync(join(outputDir, "docs", "agent-team", "tasks"), { recursive: true });
		mkdirSync(join(outputDir, "src"), { recursive: true });
		writeFileSync(join(outputDir, "docs/contracts/project-manifest.json"), JSON.stringify({ goal: "CLI" }), "utf-8");
		writeFileSync(
			join(outputDir, "docs/agent-team/tasks/build-cli-handoff.json"),
			JSON.stringify({
				taskId: "build-cli",
				changedFiles: ["src/index.js"],
				contractsSatisfied: ["manifest"],
				checksRun: [{ command: "node --check src/index.js", exitCode: 0, summary: "ok", required: true }],
				knownRisks: [],
			}),
			"utf-8",
		);
		writeFileSync(join(outputDir, "src/index.js"), "console.log('ok')", "utf-8");
		const validationIssues: ValidationIssue[] = [
			{ id: "warn", severity: "warning", message: "Minor risk", ownerTaskId: "build-cli" },
		];

		const context = buildSupervisorContext({
			checkpoint: "task_end" as SupervisorCheckpoint,
			outputDir,
			requirement: "Build a CLI",
			plan: plan(),
			task: plan().tasks[0],
			taskResult: {
				taskId: "build-cli",
				success: true,
				output: "agent prose should not be the only truth",
				filesCreated: ["src/index.js"],
				turnsUsed: 1,
				checksRun: [{ command: "node --check src/index.js", exitCode: 0, summary: "ok", required: true }],
				handoffPath: "docs/agent-team/tasks/build-cli-handoff.json",
			},
			validationIssues,
			recentEvents: [],
			allTaskResults: [],
		});

		expect(JSON.stringify(context.contracts)).toContain("CLI");
		expect(JSON.stringify(context.handoffs)).toContain("node --check src/index.js");
		expect(JSON.stringify(context.changedFiles)).toContain("console.log");
		expect(JSON.stringify(context.validationIssues)).toContain("Minor risk");
	});

	it("includes e2e reports in validation review context", () => {
		const outputDir = tempProject();
		mkdirSync(join(outputDir, "docs"), { recursive: true });
		writeFileSync(
			join(outputDir, "docs/e2e-report.md"),
			[
				"# E2E",
				"Command: curl http://127.0.0.1:3000/api/notes",
				"Exit status: 0",
				"Observed result: HTTP 500",
				"Acceptance status: FAIL",
				"Evidence: backend route threw.",
			].join("\n"),
			"utf-8",
		);

		const context = buildSupervisorContext({
			checkpoint: "validation_end",
			outputDir,
			requirement: "Build an API",
			plan: e2ePlan(),
			validationIssues: [
				{
					id: "e2e-acceptance-failed-e2e",
					severity: "error",
					message: "E2E failed and needs semantic routing.",
					ownerTaskId: "e2e",
					file: "docs/e2e-report.md",
					needsSemanticRouting: true,
				},
			],
			recentEvents: [],
			allTaskResults: [],
		});

		expect(context.e2eReports[0]?.path).toBe("docs/e2e-report.md");
		expect(context.e2eReports[0]?.content).toContain("Acceptance status: FAIL");
		expect(JSON.stringify(context.validationIssues)).toContain("needsSemanticRouting");
	});

	it("reports truncation when changed files or file content are omitted", () => {
		const outputDir = tempProject();
		mkdirSync(join(outputDir, "src"), { recursive: true });
		const files = Array.from({ length: 13 }, (_item, index) => `src/file-${index}.js`);
		for (const file of files) {
			writeFileSync(join(outputDir, file), indexContent(file), "utf-8");
		}
		writeFileSync(join(outputDir, "src/file-0.js"), "x".repeat(12_050), "utf-8");

		const context = buildSupervisorContext({
			checkpoint: "task_end",
			outputDir,
			requirement: "Build a CLI",
			plan: plan(),
			task: plan().tasks[0],
			taskResult: {
				taskId: "build-cli",
				success: true,
				output: "ok",
				filesCreated: files,
				turnsUsed: 1,
			},
			validationIssues: [],
			recentEvents: [],
			allTaskResults: [],
		});

		expect(context.changedFiles).toHaveLength(12);
		expect(context.truncationWarnings.some((warning) => warning.includes("1 changed file"))).toBe(true);
		expect(context.truncationWarnings.some((warning) => warning.includes("src/file-0.js"))).toBe(true);
	});

	it("appends team leader markdown reviews instead of overwriting prior checkpoints", () => {
		const outputDir = tempProject();
		const first = {
			checkpoint: "task_end" as const,
			decision: "warn" as const,
			summary: "Task warning",
			issues: [{ id: "task-risk", severity: "warning" as const, message: "Missing edge case" }],
			recommendedActions: ["Repair task"],
		};
		const second = {
			checkpoint: "final_review" as const,
			decision: "accept" as const,
			summary: "Final ok",
			issues: [],
			recommendedActions: [],
		};

		writeSupervisorDecision(outputDir, 1, first);
		writeSupervisorDecision(outputDir, 2, second);

		const review = readFileSync(join(outputDir, "docs", "agent-team", "team-leader-review.md"), "utf-8");
		expect(review).toContain("Task warning");
		expect(review).toContain("Final ok");
	});

	it("reuses cached contract content across checkpoints", () => {
		const outputDir = tempProject();
		mkdirSync(join(outputDir, "docs", "contracts"), { recursive: true });
		writeFileSync(join(outputDir, "docs/contracts/project-manifest.json"), "first content", "utf-8");
		const cache = createSupervisorContextCache();
		const baseInput = {
			outputDir,
			requirement: "Build a CLI",
			plan: plan(),
			task: plan().tasks[0],
			validationIssues: [],
			recentEvents: [],
			allTaskResults: [],
			cache,
		};

		const first = buildSupervisorContext({ ...baseInput, checkpoint: "task_end" as const });
		writeFileSync(join(outputDir, "docs/contracts/project-manifest.json"), "changed content", "utf-8");
		const second = buildSupervisorContext({ ...baseInput, checkpoint: "validation_end" as const });

		expect(first.contracts[0]?.content).toBe("first content");
		expect(second.contracts[0]?.content).toBe("first content");
	});
});

function indexContent(file: string): string {
	return `console.log(${JSON.stringify(file)});`;
}
