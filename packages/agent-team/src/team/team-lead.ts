import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { runTeamAgent, type TeamAgentConfig } from "../agent/team-agent.js";
import { TaskGraph } from "../task/task-graph.js";
import { TaskScheduler } from "../task/task-scheduler.js";
import type {
	ApprovalDecision,
	ExecutionMode,
	PlannerRunner,
	RoleDefinition,
	SupervisorDecision,
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
import {
	buildSupervisorContext,
	createSupervisorContextCache,
	runSupervisorReview,
	type SupervisorCheckpoint,
	type SupervisorContextCache,
	type SupervisorRunner,
	writeSupervisorDecision,
} from "./supervisor.js";
import { validateTeamOutputWithChecks } from "./validator.js";

const log = createLogger("team-lead");

export type TeamEventEmitter = (event: TeamEvent) => void;

export interface TeamLeadControls {
	waitIfPaused: () => Promise<void>;
	requestApproval: (request: { taskId: string; reason: string; command: string }) => Promise<ApprovalDecision>;
	getInterventions: () => string[];
}

export type TeamAgentRunner = (taskDescription: string, config: TeamAgentConfig) => Promise<TaskResult>;
export type TeamApiKeyResolver = (provider: string) => Promise<string | undefined> | string | undefined;
export type TeamValidatorRunner = (
	outputDir: string,
	plan: TeamPlan,
	signal?: AbortSignal,
) => Promise<ValidationIssue[]>;
export type { SupervisorRunner };

export interface TeamLeadDependencies {
	config: TeamConfig;
	model: Model<Api>;
	getApiKey: TeamApiKeyResolver;
	emit?: TeamEventEmitter;
	controls?: TeamLeadControls;
	agentRunner?: TeamAgentRunner;
	plannerRunner?: PlannerRunner;
	validatorRunner?: TeamValidatorRunner;
	supervisorRunner?: SupervisorRunner;
}

function now(): number {
	return Date.now();
}

function executionGuidance(executionMode: ExecutionMode): string {
	if (executionMode === "restricted") {
		return "- Do not run dependency installation or long-lived service commands; the Lead runs controlled install and whole-project validation.";
	}
	return "- Use commands needed to complete and verify your task. If a command triggers the approval flow, wait for the approval result before continuing.";
}

function buildTaskDescription(
	task: Task,
	plan: TeamPlan,
	requirement: string,
	interventions: string[],
	executionMode: ExecutionMode,
): string {
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

Self-check before finishing:
- Run the narrowest relevant checks for your owned area after writing files.
- Backend tasks should at minimum run syntax/load checks such as node --check on changed JS files and npm run check or npm test when those scripts exist.
- Frontend tasks should run npm run check, npm test, or npm run build when those scripts exist.
- If a check fails, fix the issue and rerun the check before finalizing.
${executionGuidance(executionMode)}
- Your handoff must include changed files, contracts satisfied, checks run, and known risks. The runtime records it at docs/agent-team/tasks/<taskId>-handoff.json.

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

function issuesFromTaskFailures(results: TaskResult[]): ValidationIssue[] {
	return results
		.filter((result) => !result.success)
		.map((result) => ({
			id: `task-failed-${result.taskId}`,
			severity: "error" as const,
			message: `Task ${result.taskId} failed: ${result.error ?? "Unknown agent failure"}`,
			ownerTaskId: result.taskId,
		}));
}

function issuesFromSupervisorDecision(decision: SupervisorDecision | undefined): ValidationIssue[] {
	if (!decision) return [];
	if (decision.decision === "request_human") return [];
	return decision.issues;
}

function defaultControls(): TeamLeadControls {
	return {
		waitIfPaused: async () => undefined,
		requestApproval: async () => "reject",
		getInterventions: () => [],
	};
}

function isTeamLeadDependencies(value: TeamConfig | TeamLeadDependencies): value is TeamLeadDependencies {
	return "config" in value && "getApiKey" in value;
}

function classifySupervisorFailure(message: string): { id: string; label: string; action: string } {
	if (/valid json|unknown supervisor|request_repair issues|returned checkpoint/i.test(message)) {
		return {
			id: "parse",
			label: "parse error",
			action: "Check the supervisor prompt and strict JSON schema.",
		};
	}
	if (/stopped with|rate|429|timeout|timed out|network|fetch|econn|enotfound|etimedout/i.test(message)) {
		return {
			id: "model",
			label: "model/API error",
			action: "Check model availability, network/API limits, and retry configuration.",
		};
	}
	return {
		id: "runtime",
		label: "runtime error",
		action: "Inspect the supervisor runner and context construction path.",
	};
}

function missingDependencyOutput(outputDir: string, task: Task, plan: TeamPlan, graph: TaskGraph): string | undefined {
	for (const dependencyId of task.dependencies) {
		const dependency = plan.tasks.find((item) => item.id === dependencyId);
		if (!dependency) continue;
		const dependencyResult = graph.getTask(dependencyId)?.result;
		if (!dependencyResult?.handoffPath) continue;
		for (const expectedOutput of dependency.expectedOutputs) {
			if (expectedOutput.includes("*") || expectedOutput.includes("?")) continue;
			if (existsSync(join(outputDir, expectedOutput))) continue;
			return `Dependency '${dependencyId}' did not produce expected output: ${expectedOutput}`;
		}
	}
	return undefined;
}

export class TeamLead {
	private abortController = new AbortController();
	private validationIssues: ValidationIssue[] = [];
	private recentEvents: TeamEvent[] = [];
	private supervisorIssues: ValidationIssue[] = [];
	private supervisionSequence = 0;
	private supervisorContextCache: SupervisorContextCache = createSupervisorContextCache();
	private config: TeamConfig;
	private model: Model<Api>;
	private getApiKey: TeamApiKeyResolver;
	private emit: TeamEventEmitter;
	private controls: TeamLeadControls;
	private agentRunner: TeamAgentRunner;
	private plannerRunner: PlannerRunner;
	private validatorRunner: TeamValidatorRunner;
	private supervisorRunner: SupervisorRunner;

	constructor(dependencies: TeamLeadDependencies);
	constructor(
		config: TeamConfig,
		model: Model<Api>,
		getApiKey: TeamApiKeyResolver,
		emit?: TeamEventEmitter,
		controls?: TeamLeadControls,
		agentRunner?: TeamAgentRunner,
		plannerRunner?: PlannerRunner,
		validatorRunner?: TeamValidatorRunner,
		supervisorRunner?: SupervisorRunner,
	);
	constructor(
		configOrDependencies: TeamConfig | TeamLeadDependencies,
		model?: Model<Api>,
		getApiKey?: TeamApiKeyResolver,
		emit: TeamEventEmitter = () => undefined,
		controls: TeamLeadControls = defaultControls(),
		agentRunner: TeamAgentRunner = runTeamAgent,
		plannerRunner: PlannerRunner = llmPlannerRunner,
		validatorRunner: TeamValidatorRunner = validateTeamOutputWithChecks,
		supervisorRunner: SupervisorRunner = runSupervisorReview,
	) {
		if (isTeamLeadDependencies(configOrDependencies)) {
			this.config = configOrDependencies.config;
			this.model = configOrDependencies.model;
			this.getApiKey = configOrDependencies.getApiKey;
			this.emit = configOrDependencies.emit ?? (() => undefined);
			this.controls = configOrDependencies.controls ?? defaultControls();
			this.agentRunner = configOrDependencies.agentRunner ?? runTeamAgent;
			this.plannerRunner = configOrDependencies.plannerRunner ?? llmPlannerRunner;
			this.validatorRunner = configOrDependencies.validatorRunner ?? validateTeamOutputWithChecks;
			this.supervisorRunner = configOrDependencies.supervisorRunner ?? runSupervisorReview;
			return;
		}
		if (!model || !getApiKey) throw new Error("TeamLead requires model and getApiKey.");
		this.config = configOrDependencies;
		this.model = model;
		this.getApiKey = getApiKey;
		this.emit = emit;
		this.controls = controls;
		this.agentRunner = agentRunner;
		this.plannerRunner = plannerRunner;
		this.validatorRunner = validatorRunner;
		this.supervisorRunner = supervisorRunner;
	}

	abort(): void {
		this.abortController.abort();
	}

	async orchestrate(): Promise<TeamResult> {
		const { outputDir, requirement } = this.config;
		const signal = this.abortController.signal;
		const maxRepairRounds = this.config.maxRepairRounds ?? 2;

		this.emitEvent({ type: "run_start", requirement, outputDir, timestamp: now() });
		log.info(`Starting dynamic team orchestration for: ${requirement.slice(0, 80)}...`);
		log.info(`Output directory: ${outputDir}`);

		let plan: TeamPlan;
		try {
			const plannerResult = await this.plannerRunner({
				requirement,
				model: this.model,
				getApiKey: this.getApiKey,
				thinkingLevel: this.config.thinkingLevel,
				permissionMode: this.config.permissionMode ?? "open",
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
			this.emitEvent({ type: "run_end", result, timestamp: now() });
			log.error(result.error ?? "Planning failed.");
			return result;
		}
		this.emitEvent({ type: "plan_created", plan, timestamp: now() });
		await this.supervise("plan_created", plan, {});

		const roleRegistry = createRoleRegistry(
			plan,
			this.config.permissionMode ?? "open",
			this.config.executionMode ?? "open",
		);
		const allResults: TaskResult[] = [];
		let totalTurns = 0;
		let round = 0;
		let tasksToRun = plan.tasks.map(taskFromSpec);

		while (!signal.aborted) {
			const runResult = await this.runTasks(tasksToRun, plan, roleRegistry);
			allResults.push(...runResult.results);
			totalTurns += runResult.turns;

			this.emitEvent({ type: "validation_start", round, timestamp: now() });
			let issues = [
				...issuesFromTaskFailures(runResult.results),
				...(await this.validatorRunner(outputDir, plan, signal)),
				...this.supervisorIssues,
			];
			this.supervisorIssues = [];
			this.validationIssues = issues;
			this.emitEvent({ type: "validation_end", round, issues, timestamp: now() });
			const validationDecision = await this.supervise("validation_end", plan, {
				round,
				validationIssues: issues,
				allResults,
			});
			const validationSupervisorIssues = issuesFromSupervisorDecision(validationDecision);
			if (validationSupervisorIssues.length > 0) {
				issues = [...issues, ...validationSupervisorIssues];
				this.validationIssues = issues;
			}

			if (!hasBlockingIssues(issues)) {
				const finalDecision = await this.supervise("final_review", plan, {
					round,
					validationIssues: issues,
					allResults,
				});
				const finalSupervisorIssues = issuesFromSupervisorDecision(finalDecision);
				if (finalSupervisorIssues.length > 0) {
					issues = [...issues, ...finalSupervisorIssues];
					this.validationIssues = issues;
				}
			}

			if (!hasBlockingIssues(issues)) {
				const result: TeamResult = {
					success: true,
					outputDir,
					tasks: allResults,
					totalTurns,
					plan,
					validationIssues: issues,
				};
				this.emitEvent({ type: "run_end", result, timestamp: now() });
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
				this.emitEvent({ type: "run_end", result, timestamp: now() });
				log.error(result.error ?? "Validation failed.");
				return result;
			}

			round++;
			const repairTasks = createRepairTasks(plan, issues, round);
			this.emitEvent({ type: "repair_requested", round, issues, tasks: repairTasks, timestamp: now() });
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
				this.emitEvent({ type: "run_end", result, timestamp: now() });
				return result;
			}

			tasksToRun = repairTasks.map(taskFromSpec);
			this.emitEvent({
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
		this.emitEvent({ type: "run_end", result, timestamp: now() });
		return result;
	}

	private emitEvent(event: TeamEvent): void {
		this.recentEvents.push(event);
		this.recentEvents = this.recentEvents.slice(-200);
		this.emit(event);
	}

	private persistSupervisorDecision(decision: SupervisorDecision): void {
		try {
			writeSupervisorDecision(this.config.outputDir, ++this.supervisionSequence, decision);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.warn(`Failed to persist supervisor decision: ${message}`);
		}
	}

	private async supervise(
		checkpoint: SupervisorCheckpoint,
		plan: TeamPlan,
		options: {
			task?: Task;
			taskResult?: TaskResult;
			round?: number;
			validationIssues?: ValidationIssue[];
			allResults?: TaskResult[];
		},
	): Promise<SupervisorDecision | undefined> {
		if ((this.config.supervisionMode ?? "off") !== "milestone") return undefined;
		this.emitEvent({
			type: "supervision_start",
			checkpoint,
			taskId: options.task?.id,
			round: options.round,
			timestamp: now(),
		});
		try {
			const context = buildSupervisorContext({
				checkpoint,
				outputDir: this.config.outputDir,
				requirement: this.config.requirement,
				plan,
				task: options.task,
				taskResult: options.taskResult,
				validationIssues: options.validationIssues ?? this.validationIssues,
				recentEvents: this.recentEvents,
				allTaskResults: options.allResults ?? [],
				cache: this.supervisorContextCache,
			});
			const decision = await this.supervisorRunner(checkpoint, context, {
				model: this.model,
				getApiKey: this.getApiKey,
				signal: this.abortController.signal,
			});
			this.persistSupervisorDecision(decision);
			this.emitEvent({ type: "supervision_end", checkpoint, decision, timestamp: now() });
			if (decision.decision === "request_human") {
				this.emitEvent({
					type: "intervention",
					message: `Supervisor requested human input: ${decision.summary}`,
					timestamp: now(),
				});
			}
			return decision;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const failure = classifySupervisorFailure(message);
			const decision = {
				checkpoint,
				decision: "warn" as const,
				summary: `Supervisor review failed (${failure.label}): ${message}`,
				issues: [
					{
						id: `supervisor-${failure.id}-failed-${checkpoint}`,
						severity: "warning" as const,
						message,
					},
				],
				recommendedActions: [failure.action, "Continue with deterministic validation."],
			};
			this.persistSupervisorDecision(decision);
			this.emitEvent({ type: "supervision_end", checkpoint, decision, timestamp: now() });
			return decision;
		}
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
				this.emitEvent({ type: "task_start", task, timestamp: now() });
				createLogger(task.role).info(`Starting task: ${task.subject}`);

				const dependencyError = missingDependencyOutput(this.config.outputDir, task, plan, graph);
				if (dependencyError) {
					return {
						task,
						result: {
							taskId: task.id,
							success: false,
							output: "",
							filesCreated: [],
							error: dependencyError,
							turnsUsed: 0,
						},
					};
				}

				const role = roleRegistry.get(task.role);
				if (!role) throw new Error(`Unknown dynamic role: ${task.role}`);

				const agentConfig: TeamAgentConfig = {
					role,
					model: this.model,
					outputDir: this.config.outputDir,
					streamFn: streamSimple,
					getApiKey: this.getApiKey,
					parentSignal: this.abortController.signal,
					thinkingLevel: role.thinkingLevelOverride ?? this.config.thinkingLevel,
					interventionMode: this.config.interventionMode ?? "none",
					permissionMode: this.config.permissionMode ?? "open",
					executionMode: this.config.executionMode ?? "open",
					taskId: task.id,
					onTaskProgress: (message) =>
						this.emitEvent({ type: "task_progress", taskId: task.id, message, timestamp: now() }),
					onAgentEvent: (event) =>
						this.emitEvent({ type: "agent_event", taskId: task.id, role: task.role, event, timestamp: now() }),
					requestApproval: (request) => this.controls.requestApproval(request),
				};

				const description = buildTaskDescription(
					task,
					plan,
					this.config.requirement,
					this.controls.getInterventions(),
					this.config.executionMode ?? "open",
				);
				const result = await this.agentRunner(description, agentConfig);
				result.taskId = task.id;
				return { task, result };
			});

			const settledResults = await Promise.allSettled(batchPromises);
			const supervisionRequests: Array<{ task: Task; result: TaskResult }> = [];
			for (let index = 0; index < settledResults.length; index++) {
				const settled = settledResults[index];
				const task = batch[index];
				scheduler.finishTask();
				if (settled.status === "rejected") {
					const error = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
					const result: TaskResult = {
						taskId: task.id,
						success: false,
						output: "",
						filesCreated: [],
						error,
						turnsUsed: 0,
					};
					graph.propagateFailure(task.id, error);
					results.push(result);
					const failedTask = graph.getTask(task.id) ?? task;
					this.emitEvent({ type: "task_end", task: failedTask, result, timestamp: now() });
					supervisionRequests.push({ task: failedTask, result });
					continue;
				}

				const { task: completedTask, result } = settled.value;
				turns += result.turnsUsed;
				if (result.success) {
					graph.markComplete(completedTask.id, result);
				} else {
					graph.propagateFailure(completedTask.id, result.error ?? "Unknown agent failure");
				}
				results.push(result);
				const emittedTask = graph.getTask(completedTask.id) ?? completedTask;
				this.emitEvent({
					type: "task_end",
					task: emittedTask,
					result,
					timestamp: now(),
				});
				supervisionRequests.push({ task: emittedTask, result });
			}
			const decisions = await Promise.all(
				supervisionRequests.map(({ task, result }) =>
					this.supervise("task_end", plan, {
						task,
						taskResult: result,
						allResults: results,
					}),
				),
			);
			for (const decision of decisions) {
				this.supervisorIssues.push(...issuesFromSupervisorDecision(decision));
			}
		}

		return { results, turns };
	}
}
