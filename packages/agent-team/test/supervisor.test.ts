import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSupervisorContext, parseSupervisorDecision, type SupervisorCheckpoint } from "../src/team/supervisor.js";
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
});
