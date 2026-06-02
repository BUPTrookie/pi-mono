import { type Component, Key, matchesKey, ProcessTerminal, TUI, truncateToWidth } from "@mariozechner/pi-tui";
import chalk from "chalk";
import { createTeamRun } from "../team/team-runner.js";
import type { TeamConfig, TeamEvent, TeamResult, TeamRun } from "../types.js";

export interface TeamRunComponentOptions {
	outputDir?: string;
	modelLabel?: string;
	maxParallelAgents?: number;
}

interface TaskViewState {
	order: number;
	id: string;
	role: string;
	profile?: string;
	status: "pending" | "running" | "completed" | "failed";
	dependencies: string[];
	turns?: number;
	files: string[];
	error?: string;
	lastMessage?: string;
}

interface TaskStats {
	completed: number;
	running: number;
	failed: number;
	pending: number;
}

export class TeamRunComponent implements Component {
	private logs: string[] = [];
	private approvalQueue: string[] = [];
	private paused = false;
	private runStatus = "pending";
	private outputDir?: string;
	private startTimestamp?: number;
	private lastTimestamp?: number;
	private validationRound = 0;
	private validationIssueCount = 0;
	private repairRound = 0;
	private currentTool = "-";
	private supervision = "-";
	private tasks = new Map<string, TaskViewState>();

	constructor(
		private run: TeamRun,
		private options: TeamRunComponentOptions = {},
	) {
		this.outputDir = options.outputDir;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c"))) {
			this.run.abort();
			return;
		}
		if (matchesKey(data, "p")) {
			if (this.paused) {
				this.run.resume();
			} else {
				this.run.pause();
			}
			return;
		}
		if (this.approvalQueue.length > 0 && matchesKey(data, "a")) {
			const requestId = this.approvalQueue.shift();
			if (requestId) this.run.approve(requestId, "approve");
			return;
		}
		if (this.approvalQueue.length > 0 && matchesKey(data, "r")) {
			const requestId = this.approvalQueue.shift();
			if (requestId) this.run.approve(requestId, "reject");
		}
	}

	push(event: TeamEvent): void {
		this.lastTimestamp = event.timestamp;
		switch (event.type) {
			case "run_start":
				this.runStatus = "planning";
				this.outputDir = event.outputDir;
				this.startTimestamp = event.timestamp;
				this.logs.push(`run started: ${event.requirement}`);
				break;
			case "plan_created":
				event.plan.tasks.forEach((task, index) => {
					const role = event.plan.roles.find((candidate) => candidate.name === task.role);
					this.tasks.set(task.id, {
						order: index + 1,
						id: task.id,
						role: task.role,
						profile: role?.profile,
						status: "pending",
						dependencies: task.dependencies,
						files: [],
					});
				});
				this.runStatus = "running";
				this.logs.push(`plan created: ${event.plan.tasks.length} task(s), ${event.plan.roles.length} role(s)`);
				break;
			case "task_start":
				this.upsertTask(event.task.id, {
					role: event.task.role,
					status: "running",
					dependencies: event.task.dependencies,
				});
				this.logs.push(`task started: ${event.task.id} (${event.task.role})`);
				break;
			case "task_end":
				this.upsertTask(event.task.id, {
					role: event.task.role,
					status: event.result.success ? "completed" : "failed",
					dependencies: event.task.dependencies,
					turns: event.result.turnsUsed,
					files: event.result.filesCreated,
					error: event.result.error,
				});
				this.logs.push(`task ${event.result.success ? "completed" : "failed"}: ${event.task.id}`);
				if (event.result.error) this.logs.push(`task error: ${event.task.id}: ${event.result.error}`);
				break;
			case "task_progress":
				this.upsertTask(event.taskId, { lastMessage: event.message });
				this.logs.push(`${event.taskId}: ${event.message}`);
				break;
			case "validation_start":
				this.runStatus = "validating";
				this.validationRound = event.round;
				this.logs.push(`validation round ${event.round} started`);
				break;
			case "validation_end":
				this.validationRound = event.round;
				this.validationIssueCount = event.issues.length;
				this.runStatus = event.issues.some((issue) => issue.severity === "error") ? "validating" : "running";
				this.logs.push(`validation round ${event.round}: ${event.issues.length} issue(s)`);
				for (const issue of event.issues.slice(0, 3)) {
					const owner = issue.ownerTaskId ?? issue.ownerRole ?? "-";
					const file = issue.file ?? "-";
					this.logs.push(`${issue.id} owner: ${owner} file: ${file} ${issue.severity}: ${issue.message}`);
				}
				break;
			case "repair_requested":
				this.runStatus = "repairing";
				this.repairRound = event.round;
				this.logs.push(`repair round ${event.round}: ${event.tasks.length} task(s)`);
				break;
			case "supervision_start":
				this.supervision = `reviewing ${event.checkpoint}`;
				this.logs.push(`supervision started: ${event.checkpoint}`);
				break;
			case "supervision_end": {
				this.supervision = `${event.decision.decision} ${event.checkpoint}`;
				this.logs.push(`supervision: ${this.supervision}: ${event.decision.summary}`);
				for (const issue of event.decision.issues.slice(0, 2)) {
					const owner = issue.ownerTaskId ?? issue.ownerRole ?? "-";
					const file = issue.file ?? "-";
					this.logs.push(`${issue.id} owner: ${owner} file: ${file} ${issue.severity}: ${issue.message}`);
				}
				break;
			}
			case "approval_requested":
				this.approvalQueue.push(event.requestId);
				this.logs.push(`approval requested: ${event.reason}`);
				break;
			case "approval_resolved":
				this.approvalQueue = this.approvalQueue.filter((requestId) => requestId !== event.requestId);
				this.logs.push(`approval ${event.decision}: ${event.requestId}`);
				break;
			case "run_paused":
				this.paused = true;
				this.runStatus = "paused";
				this.logs.push("run paused");
				break;
			case "run_resumed":
				this.paused = false;
				this.runStatus = "running";
				this.logs.push("run resumed");
				break;
			case "intervention":
				this.logs.push(`intervention: ${event.message}`);
				break;
			case "run_end":
				this.runStatus = event.result.success ? "success" : "failed";
				this.logs.push(`run ended: ${event.result.success ? "success" : "failed"}`);
				break;
			case "agent_event":
				// Skip LLM streaming delta events (noisy per-token events)
				if (event.event.type === "message_update") break;
				if (event.event.type === "tool_execution_start") {
					const args = event.event.args as { path?: string; command?: string };
					const target = args.path ?? args.command ?? "";
					this.currentTool = `${event.taskId} ${event.event.toolName}${target ? ` ${target}` : ""}`;
					this.logs.push(`tool: ${this.currentTool}`);
					break;
				}
				this.logs.push(`agent event: ${event.taskId}: ${event.event.type}`);
				break;
			case "plan_updated":
				this.logs.push(`plan updated: ${event.reason}`);
				break;
		}
		this.logs = this.logs.slice(-200);
	}

	invalidate(): void {}

	render(width: number): string[] {
		return [
			...this.renderHeader(),
			...this.renderProgressSummary(),
			...this.renderTaskTable(),
			...this.renderRecentLogs(),
			...this.renderFooter(),
		].map((line) => truncateToWidth(line, width));
	}

	private renderHeader(): string[] {
		const model = this.options.modelLabel ?? "unknown";
		const parallel = this.options.maxParallelAgents ?? 2;
		return [
			chalk.bold("agent-team dynamic run"),
			`${this.colorStatus(`status: ${this.runStatus}`)} | elapsed: ${this.formatElapsed()} | model: ${model} | parallel: ${parallel}`,
			`output: ${this.outputDir ?? "pending"}`,
		];
	}

	private renderProgressSummary(): string[] {
		const stats = this.taskStats();
		const active = this.activeTasks().join(", ") || "-";
		const approval = this.approvalQueue.length > 0 ? `approvals: ${this.approvalQueue.join(",")}` : "approvals: -";
		return [
			"",
			chalk.bold("progress"),
			`completed: ${stats.completed} | running: ${stats.running} | failed: ${stats.failed} | pending: ${stats.pending}`,
			`active: ${active} | validation round: ${this.validationRound} | repair round: ${this.repairRound} | issues: ${this.validationIssueCount} | ${approval}`,
			`tool: ${this.currentTool}`,
			`supervision: ${this.supervision}`,
		];
	}

	private renderTaskTable(): string[] {
		const lines = ["", chalk.bold("tasks"), "seq | task | role/profile | status | deps | turns | files | last"];
		const taskRows = [...this.tasks.values()].sort((left, right) => left.order - right.order);
		if (taskRows.length === 0) {
			lines.push("_no tasks yet_");
			return lines;
		}

		for (const task of taskRows) {
			const role = task.profile ? `${task.role}/${task.profile}` : task.role;
			const deps = task.dependencies.length > 0 ? task.dependencies.join(",") : "-";
			const turns = task.turns ?? 0;
			const last = task.error ?? task.lastMessage ?? "-";
			lines.push(
				`${task.order} | ${task.id} | ${role} | ${this.colorStatus(task.status)} | ${deps} | turns: ${turns} | files: ${task.files.length} | ${last}`,
			);
		}
		return lines;
	}

	private renderRecentLogs(): string[] {
		const lines = ["", chalk.bold("recent logs")];
		const recentLogs = this.logs.slice(-10);
		if (recentLogs.length === 0) {
			lines.push("- _no events yet_");
			return lines;
		}
		for (const event of recentLogs) {
			lines.push(`- ${event}`);
		}
		return lines;
	}

	private renderFooter(): string[] {
		const help =
			this.approvalQueue.length > 0
				? "keys: p pause/resume | a approve | r reject | ctrl+c abort"
				: "keys: p pause/resume | ctrl+c abort";
		return ["", chalk.dim(help)];
	}

	private taskStats(): TaskStats {
		const stats: TaskStats = { completed: 0, running: 0, failed: 0, pending: 0 };
		for (const task of this.tasks.values()) {
			stats[task.status]++;
		}
		return stats;
	}

	private activeTasks(): string[] {
		return [...this.tasks.values()]
			.filter((task) => task.status === "running")
			.sort((left, right) => left.order - right.order)
			.map((task) => task.id);
	}

	private formatElapsed(): string {
		if (this.startTimestamp === undefined) return "0s";
		const endTimestamp = this.lastTimestamp ?? this.startTimestamp;
		const elapsedSeconds = Math.max(0, Math.floor((endTimestamp - this.startTimestamp) / 1000));
		const minutes = Math.floor(elapsedSeconds / 60);
		const seconds = elapsedSeconds % 60;
		if (minutes === 0) return `${seconds}s`;
		return `${minutes}m ${seconds}s`;
	}

	private colorStatus(status: string): string {
		if (status.includes("failed")) return chalk.red(status);
		if (status.includes("success") || status.includes("completed")) return chalk.green(status);
		if (status.includes("running")) return chalk.cyan(status);
		if (status.includes("paused")) return chalk.yellow(status);
		return chalk.dim(status);
	}

	private upsertTask(taskId: string, patch: Partial<Omit<TaskViewState, "id" | "order">>): void {
		const existing = this.tasks.get(taskId);
		this.tasks.set(taskId, {
			order: existing?.order ?? this.tasks.size + 1,
			id: taskId,
			role: patch.role ?? existing?.role ?? "unknown",
			profile: patch.profile ?? existing?.profile,
			status: patch.status ?? existing?.status ?? "pending",
			dependencies: patch.dependencies ?? existing?.dependencies ?? [],
			turns: patch.turns ?? existing?.turns,
			files: patch.files ?? existing?.files ?? [],
			error: patch.error ?? existing?.error,
			lastMessage: patch.lastMessage ?? existing?.lastMessage,
		});
	}
}

export async function runTeamTui(config: TeamConfig): Promise<TeamResult> {
	const run = createTeamRun(config);
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);
	const modelLabel = `${config.model.provider ? `${config.model.provider}/` : ""}${config.model.model}`;
	const component = new TeamRunComponent(run, {
		outputDir: config.outputDir,
		modelLabel,
		maxParallelAgents: config.maxParallelAgents ?? 2,
	});
	tui.addChild(component);
	tui.setFocus(component);
	const unsubscribe = run.subscribe((event) => {
		component.push(event);
		tui.requestRender();
	});

	tui.start();
	try {
		return await run.start();
	} finally {
		unsubscribe();
		tui.stop();
	}
}
