import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import type { TeamAgentRunner, TeamLeadControls } from "../src/team/team-lead.js";
import { TeamLead } from "../src/team/team-lead.js";
import type { PlannerResult, PlannerRunner, TeamConfig, TeamEvent } from "../src/types.js";

const model: Model<Api> = {
	id: "fake",
	name: "fake",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 1000,
};

function config(outputDir: string): TeamConfig {
	return {
		requirement: "Create a CLI utility that formats JSON files",
		outputDir,
		model: { provider: "openai", model: "fake" },
		maxParallelAgents: 2,
		maxRepairRounds: 1,
	};
}

function tempProject(): string {
	return join(tmpdir(), `agent-team-lead-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function plannerResult(): PlannerResult {
	return {
		plan: {
			id: "fake-plan",
			summary: "JSON formatter CLI",
			roles: [
				{
					name: "project-builder",
					description: "Builds the CLI project",
					allowedTools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
					ownedDirectories: ["src", "."],
					maxTurns: 30,
				},
			],
			tasks: [
				{
					id: "build-cli",
					role: "project-builder",
					subject: "Build CLI",
					description: "Implement the JSON formatter CLI from the contracts.",
					dependencies: [],
					ownedDirectories: ["src", "."],
					expectedOutputs: ["src/index.js", "package.json", "README.md"],
					acceptanceCriteria: ["CLI source and package scripts exist."],
				},
			],
			contracts: [
				{ path: "docs/contracts/team-plan.json", kind: "team-plan", required: true },
				{ path: "docs/contracts/project-manifest.json", kind: "project-manifest", required: true },
			],
			validationRules: ["Required files exist."],
		},
		contracts: {
			projectManifest: {
				goal: "Create a CLI utility that formats JSON files",
				features: ["format JSON from files"],
			},
		},
		diagnostics: [],
	};
}

function parallelPlannerResult(): PlannerResult {
	const result = plannerResult();
	result.plan.tasks = [
		{
			id: "ok-task",
			role: "project-builder",
			subject: "Successful task",
			description: "Complete normally.",
			dependencies: [],
			ownedDirectories: ["src", "."],
			expectedOutputs: ["src/ok.js"],
			acceptanceCriteria: ["Task succeeds."],
		},
		{
			id: "fail-task",
			role: "project-builder",
			subject: "Failing task",
			description: "This task fails.",
			dependencies: [],
			ownedDirectories: ["src", "."],
			expectedOutputs: ["src/fail.js"],
			acceptanceCriteria: ["Task failure is reported."],
		},
	];
	return result;
}

function controls(): TeamLeadControls {
	return {
		waitIfPaused: async () => undefined,
		requestApproval: async () => "reject",
		getInterventions: () => [],
	};
}

describe("TeamLead dynamic run", () => {
	it("emits run, plan, validation, repair, and completion events with an injected planner", async () => {
		const outputDir = tempProject();
		mkdirSync(outputDir, { recursive: true });
		const events: TeamEvent[] = [];
		const descriptions: string[] = [];
		const runner: TeamAgentRunner = async (description, agentConfig) => {
			descriptions.push(description);
			if (agentConfig.taskId?.startsWith("repair-")) {
				mkdirSync(join(agentConfig.outputDir, "src"), { recursive: true });
				writeFileSync(join(agentConfig.outputDir, "src/index.js"), "console.log('ok')", "utf-8");
				writeFileSync(
					join(agentConfig.outputDir, "package.json"),
					JSON.stringify({ scripts: { start: "node src/index.js" } }),
					"utf-8",
				);
				writeFileSync(join(agentConfig.outputDir, "README.md"), "# Project\n", "utf-8");
			}
			return { taskId: agentConfig.taskId ?? "", success: true, output: "ok", filesCreated: [], turnsUsed: 1 };
		};
		const planner: PlannerRunner = async () => plannerResult();

		const lead = new TeamLead(
			config(outputDir),
			model,
			() => "key",
			(event) => events.push(event),
			controls(),
			runner,
			planner,
		);
		const result = await lead.orchestrate();

		expect(result.success).toBe(true);
		expect(events.map((event) => event.type)).toContain("run_start");
		expect(events.map((event) => event.type)).toContain("plan_created");
		expect(events.map((event) => event.type)).toContain("validation_start");
		expect(events.map((event) => event.type)).toContain("repair_requested");
		expect(events[events.length - 1].type).toBe("run_end");
		expect(descriptions[0]).toContain("Self-check before finishing");
		expect(descriptions[0]).toContain("npm run check or npm test");
	});

	it("fails clearly when planning fails and does not start workers", async () => {
		const outputDir = tempProject();
		mkdirSync(outputDir, { recursive: true });
		const events: TeamEvent[] = [];
		let runnerCalls = 0;
		const runner: TeamAgentRunner = async () => {
			runnerCalls++;
			return { taskId: "unexpected", success: true, output: "unexpected", filesCreated: [], turnsUsed: 1 };
		};
		const planner: PlannerRunner = async () => {
			throw new Error("invalid planner output");
		};

		const lead = new TeamLead(
			config(outputDir),
			model,
			() => "key",
			(event) => events.push(event),
			controls(),
			runner,
			planner,
		);
		const result = await lead.orchestrate();

		expect(result.success).toBe(false);
		expect(result.error).toContain("Planning failed: invalid planner output");
		expect(runnerCalls).toBe(0);
		expect(events.map((event) => event.type)).toEqual(["run_start", "run_end"]);
	});

	it("fails the run and reports the actual task when a parallel worker rejects", async () => {
		const outputDir = tempProject();
		mkdirSync(outputDir, { recursive: true });
		const events: TeamEvent[] = [];
		const runner: TeamAgentRunner = async (_description, agentConfig) => {
			if (agentConfig.taskId === "fail-task") {
				throw new Error("worker crashed");
			}
			return { taskId: agentConfig.taskId ?? "", success: true, output: "ok", filesCreated: [], turnsUsed: 1 };
		};
		const planner: PlannerRunner = async () => parallelPlannerResult();

		const lead = new TeamLead(
			{ ...config(outputDir), maxRepairRounds: 0 },
			model,
			() => "key",
			(event) => events.push(event),
			controls(),
			runner,
			planner,
			async () => [],
		);
		const result = await lead.orchestrate();
		const failedResult = result.tasks.find((task) => task.taskId === "fail-task");
		const failedEvent = events.find((event) => event.type === "task_end" && event.task.id === "fail-task");

		expect(result.success).toBe(false);
		expect(result.error).toContain("fail-task");
		expect(failedResult?.success).toBe(false);
		expect(failedResult?.error).toBe("worker crashed");
		expect(failedEvent?.type).toBe("task_end");
	});
});
