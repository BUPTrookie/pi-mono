import type { Api, Model } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { runTeamAgent, type TeamAgentConfig } from "../agent/team-agent.js";
import { TaskGraph } from "../task/task-graph.js";
import { TaskScheduler } from "../task/task-scheduler.js";
import type {
	ApprovalDecision,
	PlannerRunner,
	RoleDefinition,
	Task,
	TaskResult,
	TeamConfig,
	TeamEvent,
	TeamPlan,
	TeamResult,
	ValidationIssue,
} from "../types.js";
import { createLogger } from "../utils/logger.js";
import { createRepairTasks, createRoleRegistry, llmPlannerRunner, taskFromSpec, writeContracts } from "./planner.js";
import { validateTeamOutput } from "./validator.js";

const log = createLogger("team-lead");

export type TeamEventEmitter = (event: TeamEvent) => void;

export interface TeamLeadControls {
	waitIfPaused: () => Promise<void>;
	requestApproval: (request: { taskId: string; reason: string; command: string }) => Promise<ApprovalDecision>;
	getInterventions: () => string[];
}

export type TeamAgentRunner = (taskDescription: string, config: TeamAgentConfig) => Promise<TaskResult>;

function now(): number {
	return Date.now();
}

function buildTaskDescription(task: Task, plan: TeamPlan, requirement: string, interventions: string[]): string {
	const role = plan.roles.find((item) => item.name === task.role);
	const contracts = plan.contracts.map(
		(contract) => `- ${contract.path} (${contract.kind}${contract.required ? ", required" : ""})`,
	);
	const outputs = task.expectedOutputs.map((path) => `- ${path}`);
	const criteria = task.acceptanceCriteria.map((item) => `- ${item}`);
	const interventionText =
		interventions.length > 0 ? `\n\n--- HUMAN INTERVENTIONS ---\n${interventions.join("\n\n")}` : "";

	return `Project requirement:
${requirement}

Team plan summary:
${plan.summary}

Assigned role:
${task.role}${role ? ` - ${role.description}` : ""}

Task:
${task.subject}

Instructions:
${task.description}

Contract files to read first:
${contracts.join("\n")}

Owned paths:
${(role?.ownedDirectories ?? []).map((path) => `- ${path}`).join("\n")}

Expected outputs:
${outputs.join("\n")}

Acceptance criteria:
${criteria.join("\n")}

Do not rely on prior agent prose summaries. Use the contract files and the actual files in the workspace as source of truth.${interventionText}`;
}

function toGraph(tasks: Task[]): TaskGraph {
	const graph = new TaskGraph();
	for (const task of tasks) {
		graph.addTask(task);
	}
	return graph;
}

function hasBlockingIssues(issues: ValidationIssue[]): boolean {
	return issues.some((issue) => issue.severity === "error");
}

export class TeamLead {
	private abortController = new AbortController();
	private validationIssues: ValidationIssue[] = [];

	constructor(
		private config: TeamConfig,
		private model: Model<Api>,
		private getApiKey: (provider: string) => Promise<string | undefined> | string | undefined,
		private emit: TeamEventEmitter = () => undefined,
		private controls: TeamLeadControls = {
			waitIfPaused: async () => undefined,
			requestApproval: async () => "reject",
			getInterventions: () => [],
		},
		private agentRunner: TeamAgentRunner = runTeamAgent,
		private plannerRunner: PlannerRunner = llmPlannerRunner,
	) {}

	abort(): void {
		this.abortController.abort();
	}

	async orchestrate(): Promise<TeamResult> {
		const { outputDir, requirement } = this.config;
		const signal = this.abortController.signal;
		const maxRepairRounds = this.config.maxRepairRounds ?? 2;

		this.emit({ type: "run_start", requirement, outputDir, timestamp: now() });
		log.info(`Starting dynamic team orchestration for: ${requirement.slice(0, 80)}...`);
		log.info(`Output directory: ${outputDir}`);

		let plan: TeamPlan;
		try {
			const plannerResult = await this.plannerRunner({
				requirement,
				model: this.model,
				getApiKey: this.getApiKey,
				thinkingLevel: this.config.thinkingLevel,
				signal,
			});
			plan = plannerResult.plan;
			writeContracts(outputDir, plannerResult);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const result: TeamResult = {
				success: false,
				outputDir,
				tasks: [],
				totalTurns: 0,
				error: `Planning failed: ${message}`,
			};
			this.emit({ type: "run_end", result, timestamp: now() });
			log.error(result.error ?? "Planning failed.");
			return result;
		}
		this.emit({ type: "plan_created", plan, timestamp: now() });

		const roleRegistry = createRoleRegistry(plan);
		const allResults: TaskResult[] = [];
		let totalTurns = 0;
		let round = 0;
		let tasksToRun = plan.tasks.map(taskFromSpec);

		while (!signal.aborted) {
			const runResult = await this.runTasks(tasksToRun, plan, roleRegistry);
			allResults.push(...runResult.results);
			totalTurns += runResult.turns;

			this.emit({ type: "validation_start", round, timestamp: now() });
			const issues = validateTeamOutput(outputDir, plan);
			this.validationIssues = issues;
			this.emit({ type: "validation_end", round, issues, timestamp: now() });

			if (!hasBlockingIssues(issues)) {
				const result: TeamResult = {
					success: true,
					outputDir,
					tasks: allResults,
					totalTurns,
					plan,
					validationIssues: issues,
				};
				this.emit({ type: "run_end", result, timestamp: now() });
				log.success("Dynamic team run completed successfully.");
				return result;
			}

			if (round >= maxRepairRounds) {
				const result: TeamResult = {
					success: false,
					outputDir,
					tasks: allResults,
					totalTurns,
					plan,
					validationIssues: issues,
					error: `Validation failed after ${round} repair rounds: ${issues.map((issue) => issue.message).join("; ")}`,
				};
				this.emit({ type: "run_end", result, timestamp: now() });
				log.error(result.error ?? "Validation failed.");
				return result;
			}

			round++;
			const repairTasks = createRepairTasks(plan, issues, round);
			this.emit({ type: "repair_requested", round, issues, tasks: repairTasks, timestamp: now() });
			if (repairTasks.length === 0) {
				const result: TeamResult = {
					success: false,
					outputDir,
					tasks: allResults,
					totalTurns,
					plan,
					validationIssues: issues,
					error: "Validation failed and no repair tasks could be routed.",
				};
				this.emit({ type: "run_end", result, timestamp: now() });
				return result;
			}

			tasksToRun = repairTasks.map(taskFromSpec);
			this.emit({
				type: "plan_updated",
				plan,
				reason: `Added ${repairTasks.length} repair task(s).`,
				timestamp: now(),
			});
		}

		const result: TeamResult = {
			success: false,
			outputDir,
			tasks: allResults,
			totalTurns,
			plan,
			validationIssues: this.validationIssues,
			error: "Run aborted.",
		};
		this.emit({ type: "run_end", result, timestamp: now() });
		return result;
	}

	private async runTasks(
		tasks: Task[],
		plan: TeamPlan,
		roleRegistry: Map<string, RoleDefinition>,
	): Promise<{ results: TaskResult[]; turns: number }> {
		const graph = toGraph(tasks);
		const scheduler = new TaskScheduler(graph, this.config.maxParallelAgents ?? 2);
		const results: TaskResult[] = [];
		let turns = 0;

		while (!scheduler.isDone()) {
			if (this.abortController.signal.aborted) break;
			await this.controls.waitIfPaused();

			const batch = scheduler.nextBatch();
			if (batch.length === 0) {
				if (scheduler.hasFailed()) break;
				break;
			}

			const batchPromises = batch.map(async (task) => {
				scheduler.startTask(task.id);
				this.emit({ type: "task_start", task, timestamp: now() });
				createLogger(task.role).info(`Starting task: ${task.subject}`);

				const role = roleRegistry.get(task.role);
				if (!role) throw new Error(`Unknown dynamic role: ${task.role}`);

				const agentConfig: TeamAgentConfig = {
					role,
					model: this.model,
					outputDir: this.config.outputDir,
					streamFn: streamSimple,
					getApiKey: this.getApiKey,
					parentSignal: this.abortController.signal,
					thinkingLevel: this.config.thinkingLevel,
					interventionMode: this.config.interventionMode ?? "none",
					taskId: task.id,
					onTaskProgress: (message) =>
						this.emit({ type: "task_progress", taskId: task.id, message, timestamp: now() }),
					onAgentEvent: (event) =>
						this.emit({ type: "agent_event", taskId: task.id, role: task.role, event, timestamp: now() }),
					requestApproval: (request) => this.controls.requestApproval(request),
				};

				const description = buildTaskDescription(
					task,
					plan,
					this.config.requirement,
					this.controls.getInterventions(),
				);
				const result = await this.agentRunner(description, agentConfig);
				result.taskId = task.id;
				return { task, result };
			});

			const settledResults = await Promise.allSettled(batchPromises);
			for (const settled of settledResults) {
				scheduler.finishTask();
				if (settled.status === "rejected") {
					const inProgress = graph.getAllTasks().find((task) => task.status === "in_progress");
					if (inProgress) {
						const error = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
						graph.propagateFailure(inProgress.id, error);
					}
					continue;
				}

				const { task, result } = settled.value;
				turns += result.turnsUsed;
				if (result.success) {
					graph.markComplete(task.id, result);
				} else {
					graph.propagateFailure(task.id, result.error ?? "Unknown agent failure");
				}
				results.push(result);
				this.emit({ type: "task_end", task: graph.getTask(task.id) ?? task, result, timestamp: now() });
			}
		}

		return { results, turns };
	}
}
