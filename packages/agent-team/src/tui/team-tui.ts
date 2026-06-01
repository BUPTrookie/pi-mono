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
	status: string;
	dependencies: string[];
	turns?: number;
	files: string[];
	error?: string;
	lastMessage?: string;
}

export class TeamRunComponent implements Component {
	private logs: string[] = [];
	private pendingApproval?: string;
	private paused = false;
	private runStatus = "pending";
	private outputDir?: string;
	private validationRound = 0;
	private validationIssueCount = 0;
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
		if (this.pendingApproval && matchesKey(data, "a")) {
			this.run.approve(this.pendingApproval, "approve");
			this.pendingApproval = undefined;
			return;
		}
		if (this.pendingApproval && matchesKey(data, "r")) {
			this.run.approve(this.pendingApproval, "reject");
			this.pendingApproval = undefined;
		}
	}

	push(event: TeamEvent): void {
		switch (event.type) {
			case "run_start":
				this.runStatus = "running";
				this.outputDir = event.outputDir;
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
				this.logs.push(`plan created: ${event.plan.tasks.length} task(s), ${event.plan.roles.length} role(s)`);
				break;
			case "task_start":
				this.upsertTask(event.task.id, {
					role: event.task.role,
					status: event.task.status,
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
				this.validationRound = event.round;
				this.logs.push(`validation round ${event.round} started`);
				break;
			case "validation_end":
				this.validationRound = event.round;
				this.validationIssueCount = event.issues.length;
				this.logs.push(`validation round ${event.round}: ${event.issues.length} issue(s)`);
				break;
			case "repair_requested":
				this.logs.push(`repair round ${event.round}: ${event.tasks.length} task(s)`);
				break;
			case "approval_requested":
				this.pendingApproval = event.requestId;
				this.logs.push(`approval requested: ${event.reason}`);
				break;
			case "approval_resolved":
				if (this.pendingApproval === event.requestId) this.pendingApproval = undefined;
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
		const help = this.pendingApproval
			? "a approve | r reject | p pause/resume | ctrl+c abort"
			: "p pause/resume | ctrl+c abort";
		const status = this.paused ? chalk.yellow("paused") : chalk.green(this.runStatus);
		const model = this.options.modelLabel ?? "unknown";
		const parallel = this.options.maxParallelAgents ?? 2;
		const lines = [
			chalk.bold("agent-team dynamic run"),
			`${status} | model: ${model} | parallel: ${parallel} | validation round: ${this.validationRound}`,
			`output: ${this.outputDir ?? "pending"} | validation issues: ${this.validationIssueCount}`,
			chalk.dim(help),
		];
		if (this.pendingApproval) lines.push(chalk.yellow(`approval pending: ${this.pendingApproval}`));

		lines.push("", chalk.bold("tasks"), "seq | task | role | status | deps | turns | files/error");
		const taskRows = [...this.tasks.values()].sort((left, right) => left.order - right.order);
		if (taskRows.length === 0) {
			lines.push("_no tasks yet_");
		} else {
			for (const task of taskRows) {
				const role = task.profile ? `${task.role}/${task.profile}` : task.role;
				const deps = task.dependencies.length > 0 ? task.dependencies.join(",") : "-";
				const files = task.files.length > 0 ? task.files.join(",") : (task.error ?? task.lastMessage ?? "");
				lines.push(
					`${task.order} | ${task.id} | ${role} | ${task.status} | ${deps} | ${task.turns ?? 0} | ${files}`,
				);
			}
		}

		lines.push("", chalk.bold("recent logs"));
		for (const event of this.logs.slice(-Math.max(3, 10))) {
			lines.push(`- ${event}`);
		}
		return lines.map((line) => truncateToWidth(line, width));
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
	const run = createTeamRun({ ...config, interventionMode: "interactive" });
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);
	const modelLabel = `${config.model.provider ? `${config.model.provider}/` : ""}${config.model.model}`;
	const component = new TeamRunComponent(run, {
		outputDir: config.outputDir,
		modelLabel,
		maxParallelAgents: config.maxParallelAgents ?? 2,
	});
	tui.addChild(component);
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
