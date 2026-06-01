import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import type { SupervisorRunner, TeamAgentRunner, TeamLeadControls } from "../src/team/team-lead.js";
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
					profile: "project-setup",
					description: "Builds the CLI project",
					ownedDirectories: ["src", "."],
				},
				{
					name: "project-verifier",
					profile: "e2e-verifier",
					description: "Verifies the CLI project end to end",
					ownedDirectories: ["tests/e2e", "docs/e2e-report.md"],
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
				{
					id: "verify-e2e",
					role: "project-verifier",
					subject: "Verify project end to end",
					description: "Run the generated CLI through an end-to-end flow and write the report.",
					dependencies: ["build-cli"],
					ownedDirectories: ["tests/e2e", "docs/e2e-report.md"],
					expectedOutputs: ["docs/e2e-report.md"],
					acceptanceCriteria: ["End-to-end report exists."],
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

function writeHandoff(outputDir: string, taskId: string): void {
	mkdirSync(join(outputDir, "docs", "agent-team", "tasks"), { recursive: true });
	writeFileSync(
		join(outputDir, "docs", "agent-team", "tasks", `${taskId}-handoff.json`),
		JSON.stringify({
			taskId,
			changedFiles: [],
			contractsSatisfied: ["ok"],
			checksRun: [{ command: "node --check src/index.js", exitCode: 0, summary: "ok", required: true }],
			knownRisks: [],
		}),
		"utf-8",
	);
}

describe("TeamLead dynamic run", () => {
	it("emits run, plan, validation, repair, and completion events with an injected planner", async () => {
		const outputDir = tempProject();
		mkdirSync(outputDir, { recursive: true });
		const events: TeamEvent[] = [];
		const descriptions: string[] = [];
		const runner: TeamAgentRunner = async (description, agentConfig) => {
			descriptions.push(description);
			writeHandoff(agentConfig.outputDir, "build-cli");
			writeHandoff(agentConfig.outputDir, "verify-e2e");
			if (agentConfig.taskId?.startsWith("repair-")) {
				mkdirSync(join(agentConfig.outputDir, "src"), { recursive: true });
				writeFileSync(join(agentConfig.outputDir, "src/index.js"), "console.log('ok')", "utf-8");
				writeFileSync(
					join(agentConfig.outputDir, "package.json"),
					JSON.stringify({ scripts: { start: "node src/index.js" } }),
					"utf-8",
				);
				writeFileSync(join(agentConfig.outputDir, "README.md"), "# Project\n", "utf-8");
				mkdirSync(join(agentConfig.outputDir, "docs"), { recursive: true });
				writeFileSync(
					join(agentConfig.outputDir, "docs/e2e-report.md"),
					[
						"# E2E",
						"",
						"Commands: npm run check",
						"Exit status: 0",
						"Observed result: CLI formats JSON.",
						"Acceptance status: pass",
					].join("\n"),
					"utf-8",
				);
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

	it("uses profile runtime config and schedules e2e verification after implementation", async () => {
		const outputDir = tempProject();
		mkdirSync(outputDir, { recursive: true });
		const taskIds: string[] = [];
		const roleConfigs: Array<{
			taskId: string | undefined;
			tools: string[];
			prompt: string;
			thinking: string | undefined;
		}> = [];
		const runner: TeamAgentRunner = async (_description, agentConfig) => {
			taskIds.push(agentConfig.taskId ?? "");
			roleConfigs.push({
				taskId: agentConfig.taskId,
				tools: agentConfig.role.allowedTools,
				prompt: agentConfig.role.systemPrompt,
				thinking: agentConfig.thinkingLevel,
			});
			return { taskId: agentConfig.taskId ?? "", success: true, output: "ok", filesCreated: [], turnsUsed: 1 };
		};
		const planner: PlannerRunner = async () => plannerResult();

		const lead = new TeamLead(
			config(outputDir),
			model,
			() => "key",
			() => undefined,
			controls(),
			runner,
			planner,
			async () => [],
		);
		const result = await lead.orchestrate();
		const buildConfig = roleConfigs.find((item) => item.taskId === "build-cli");
		const e2eConfig = roleConfigs.find((item) => item.taskId === "verify-e2e");

		expect(result.success).toBe(true);
		expect(taskIds).toEqual(["build-cli", "verify-e2e"]);
		expect(buildConfig?.tools).toContain("write");
		expect(buildConfig?.prompt).toContain("Project Setup Agent");
		expect(e2eConfig?.prompt).toContain("End-to-End Verification Agent");
		expect(e2eConfig?.prompt).toContain("ordinary unit tests");
		expect(e2eConfig?.thinking).toBe("medium");
	});

	it("does not run supervisor when supervision mode is off", async () => {
		const outputDir = tempProject();
		mkdirSync(outputDir, { recursive: true });
		let supervisorCalls = 0;
		const supervisor: SupervisorRunner = async () => {
			supervisorCalls++;
			return {
				checkpoint: "plan_created",
				decision: "accept",
				summary: "ok",
				issues: [],
				recommendedActions: [],
			};
		};

		const lead = new TeamLead(
			config(outputDir),
			model,
			() => "key",
			() => undefined,
			controls(),
			async (_description, agentConfig) => ({
				taskId: agentConfig.taskId ?? "",
				success: true,
				output: "ok",
				filesCreated: [],
				turnsUsed: 1,
			}),
			async () => plannerResult(),
			async () => [],
			supervisor,
		);

		const result = await lead.orchestrate();

		expect(result.success).toBe(true);
		expect(supervisorCalls).toBe(0);
	});

	it("runs milestone supervisor reviews for plan, tasks, validation, and final review", async () => {
		const outputDir = tempProject();
		mkdirSync(outputDir, { recursive: true });
		const checkpoints: string[] = [];
		const events: TeamEvent[] = [];
		const supervisor: SupervisorRunner = async (checkpoint) => {
			checkpoints.push(checkpoint);
			return {
				checkpoint,
				decision: "accept",
				summary: `${checkpoint} accepted`,
				issues: [],
				recommendedActions: [],
			};
		};

		const lead = new TeamLead(
			{ ...config(outputDir), supervisionMode: "milestone" },
			model,
			() => "key",
			(event) => events.push(event),
			controls(),
			async (_description, agentConfig) => ({
				taskId: agentConfig.taskId ?? "",
				success: true,
				output: "ok",
				filesCreated: [],
				turnsUsed: 1,
			}),
			async () => plannerResult(),
			async () => [],
			supervisor,
		);

		const result = await lead.orchestrate();

		expect(result.success).toBe(true);
		expect(checkpoints).toEqual(["plan_created", "task_end", "task_end", "validation_end", "final_review"]);
		expect(events.map((event) => event.type)).toContain("supervision_start");
		expect(events.map((event) => event.type)).toContain("supervision_end");
	});

	it("adds supervisor repair issues to the existing repair loop", async () => {
		const outputDir = tempProject();
		mkdirSync(outputDir, { recursive: true });
		const taskIds: string[] = [];
		const supervisor: SupervisorRunner = async (checkpoint) => ({
			checkpoint,
			decision: checkpoint === "validation_end" ? "request_repair" : "accept",
			summary: "reviewed",
			issues:
				checkpoint === "validation_end"
					? [
							{
								id: "supervisor-missing-cli",
								severity: "error",
								message: "CLI output still needs repair",
								ownerTaskId: "build-cli",
								file: "src/index.js",
							},
						]
					: [],
			recommendedActions: checkpoint === "validation_end" ? ["Repair build-cli"] : [],
		});

		const lead = new TeamLead(
			{ ...config(outputDir), supervisionMode: "milestone", maxRepairRounds: 1 },
			model,
			() => "key",
			() => undefined,
			controls(),
			async (_description, agentConfig) => {
				taskIds.push(agentConfig.taskId ?? "");
				return { taskId: agentConfig.taskId ?? "", success: true, output: "ok", filesCreated: [], turnsUsed: 1 };
			},
			async () => plannerResult(),
			async () => [],
			supervisor,
		);

		const result = await lead.orchestrate();

		expect(result.success).toBe(false);
		expect(taskIds).toContain("repair-1-build-cli");
		expect(result.validationIssues?.some((issue) => issue.id === "supervisor-missing-cli")).toBe(true);
	});

	it("emits an intervention event when supervisor requests human input", async () => {
		const outputDir = tempProject();
		mkdirSync(outputDir, { recursive: true });
		const events: TeamEvent[] = [];
		const lead = new TeamLead(
			{ ...config(outputDir), supervisionMode: "milestone", maxRepairRounds: 0 },
			model,
			() => "key",
			(event) => events.push(event),
			controls(),
			async (_description, agentConfig) => ({
				taskId: agentConfig.taskId ?? "",
				success: true,
				output: "ok",
				filesCreated: [],
				turnsUsed: 1,
			}),
			async () => plannerResult(),
			async () => [],
			async (checkpoint) => ({
				checkpoint,
				decision: checkpoint === "validation_end" ? "request_human" : "accept",
				summary: checkpoint === "validation_end" ? "Need product clarification" : "ok",
				issues: [],
				recommendedActions: [],
			}),
		);

		const result = await lead.orchestrate();

		expect(result.success).toBe(true);
		expect(result.validationIssues?.some((issue) => issue.id.startsWith("supervisor-human"))).toBe(false);
		expect(
			events.some((event) => event.type === "intervention" && event.message.includes("Need product clarification")),
		).toBe(true);
	});

	it("continues when supervisor decision persistence fails", async () => {
		const outputDir = tempProject();
		mkdirSync(outputDir, { recursive: true });
		const events: TeamEvent[] = [];
		const runner: TeamAgentRunner = async (_description, agentConfig) => {
			writeHandoff(agentConfig.outputDir, "build-cli");
			writeHandoff(agentConfig.outputDir, "verify-e2e");
			return { taskId: agentConfig.taskId ?? "", success: true, output: "ok", filesCreated: [], turnsUsed: 1 };
		};
		const planner: PlannerRunner = async () => {
			const result = plannerResult();
			mkdirSync(join(outputDir, "docs", "agent-team"), { recursive: true });
			writeFileSync(join(outputDir, "docs", "agent-team", "supervision"), "not a directory", "utf-8");
			return result;
		};

		const lead = new TeamLead(
			{ ...config(outputDir), supervisionMode: "milestone" },
			model,
			() => "key",
			(event) => events.push(event),
			controls(),
			runner,
			planner,
			async () => [],
			async (checkpoint) => ({
				checkpoint,
				decision: "accept",
				summary: "ok",
				issues: [],
				recommendedActions: [],
			}),
		);

		const result = await lead.orchestrate();

		expect(result.success).toBe(true);
		expect(events.some((event) => event.type === "supervision_end")).toBe(true);
	});

	it("reviews completed tasks in a batch without serial supervisor waits", async () => {
		const outputDir = tempProject();
		mkdirSync(outputDir, { recursive: true });
		let activeTaskReviews = 0;
		let maxActiveTaskReviews = 0;
		const supervisor: SupervisorRunner = async (checkpoint) => {
			if (checkpoint === "task_end") {
				activeTaskReviews++;
				maxActiveTaskReviews = Math.max(maxActiveTaskReviews, activeTaskReviews);
				await new Promise((resolve) => setTimeout(resolve, 20));
				activeTaskReviews--;
			}
			return {
				checkpoint,
				decision: "accept",
				summary: "ok",
				issues: [],
				recommendedActions: [],
			};
		};

		const lead = new TeamLead({
			config: { ...config(outputDir), supervisionMode: "milestone", maxRepairRounds: 0 },
			model,
			getApiKey: () => "key",
			emit: () => undefined,
			controls: controls(),
			agentRunner: async (_description, agentConfig) => ({
				taskId: agentConfig.taskId ?? "",
				success: true,
				output: "ok",
				filesCreated: [],
				turnsUsed: 1,
			}),
			plannerRunner: async () => parallelPlannerResult(),
			validatorRunner: async () => [],
			supervisorRunner: supervisor,
		});

		const result = await lead.orchestrate();

		expect(result.success).toBe(true);
		expect(maxActiveTaskReviews).toBe(2);
	});

	it("adds diagnostic categories when supervisor reviews fail", async () => {
		const outputDir = tempProject();
		mkdirSync(outputDir, { recursive: true });
		const events: TeamEvent[] = [];
		const lead = new TeamLead({
			config: { ...config(outputDir), supervisionMode: "milestone", maxRepairRounds: 0 },
			model,
			getApiKey: () => "key",
			emit: (event) => events.push(event),
			controls: controls(),
			agentRunner: async (_description, agentConfig) => ({
				taskId: agentConfig.taskId ?? "",
				success: true,
				output: "ok",
				filesCreated: [],
				turnsUsed: 1,
			}),
			plannerRunner: async () => plannerResult(),
			validatorRunner: async () => [],
			supervisorRunner: async () => {
				throw new Error("Supervisor output must be valid JSON: Unexpected token");
			},
		});

		const result = await lead.orchestrate();
		const supervisorEnd = events.find((event) => event.type === "supervision_end");

		expect(result.success).toBe(true);
		expect(supervisorEnd?.type).toBe("supervision_end");
		expect(supervisorEnd?.decision.issues[0]?.id).toContain("supervisor-parse-failed");
		expect(supervisorEnd?.decision.summary).toContain("parse");
	});

	it("fails dependent tasks before running them when dependency outputs are missing", async () => {
		const outputDir = tempProject();
		mkdirSync(outputDir, { recursive: true });
		const calledTaskIds: string[] = [];
		const lead = new TeamLead({
			config: { ...config(outputDir), maxRepairRounds: 0 },
			model,
			getApiKey: () => "key",
			controls: controls(),
			agentRunner: async (_description, agentConfig) => {
				calledTaskIds.push(agentConfig.taskId ?? "");
				return {
					taskId: agentConfig.taskId ?? "",
					success: true,
					output: "claimed success without files",
					filesCreated: [],
					turnsUsed: 1,
					handoffPath: `docs/agent-team/tasks/${agentConfig.taskId}-handoff.json`,
				};
			},
			plannerRunner: async () => plannerResult(),
			validatorRunner: async () => [],
		});

		const result = await lead.orchestrate();
		const dependent = result.tasks.find((task) => task.taskId === "verify-e2e");

		expect(result.success).toBe(false);
		expect(calledTaskIds).toEqual(["build-cli"]);
		expect(dependent?.success).toBe(false);
		expect(dependent?.error).toContain("Dependency 'build-cli' did not produce expected output");
	});
});
