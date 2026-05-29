import { type Component, Key, matchesKey, ProcessTerminal, TUI, truncateToWidth } from "@mariozechner/pi-tui";
import chalk from "chalk";
import { createTeamRun } from "../team/team-runner.js";
import type { TeamConfig, TeamEvent, TeamResult, TeamRun } from "../types.js";

class TeamRunComponent implements Component {
	private events: string[] = [];
	private pendingApproval?: string;
	private paused = false;

	constructor(private run: TeamRun) {}

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
				this.events.push(`run started: ${event.requirement}`);
				break;
			case "plan_created":
				this.events.push(`plan created: ${event.plan.tasks.length} task(s), ${event.plan.roles.length} role(s)`);
				break;
			case "task_start":
				this.events.push(`task started: ${event.task.id} (${event.task.role})`);
				break;
			case "task_end":
				this.events.push(`task ${event.result.success ? "completed" : "failed"}: ${event.task.id}`);
				break;
			case "validation_start":
				this.events.push(`validation round ${event.round} started`);
				break;
			case "validation_end":
				this.events.push(`validation round ${event.round}: ${event.issues.length} issue(s)`);
				break;
			case "repair_requested":
				this.events.push(`repair round ${event.round}: ${event.tasks.length} task(s)`);
				break;
			case "approval_requested":
				this.pendingApproval = event.requestId;
				this.events.push(`approval requested: ${event.reason}`);
				break;
			case "approval_resolved":
				this.events.push(`approval ${event.decision}: ${event.requestId}`);
				break;
			case "run_paused":
				this.paused = true;
				this.events.push("run paused");
				break;
			case "run_resumed":
				this.paused = false;
				this.events.push("run resumed");
				break;
			case "intervention":
				this.events.push(`intervention: ${event.message}`);
				break;
			case "run_end":
				this.events.push(`run ended: ${event.result.success ? "success" : "failed"}`);
				break;
			case "agent_event":
			case "plan_updated":
			case "task_progress":
				break;
		}
		this.events = this.events.slice(-200);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const help = this.pendingApproval
			? "a approve | r reject | p pause/resume | ctrl+c abort"
			: "p pause/resume | ctrl+c abort";
		const status = this.paused ? chalk.yellow("paused") : chalk.green("running");
		const lines = [chalk.bold("agent-team dynamic run"), `${status}  ${chalk.dim(help)}`, ""];
		for (const event of this.events.slice(-Math.max(3, 20))) {
			lines.push(`- ${event}`);
		}
		return lines.map((line) => truncateToWidth(line, width));
	}
}

export async function runTeamTui(config: TeamConfig): Promise<TeamResult> {
	const run = createTeamRun({ ...config, interventionMode: "interactive" });
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);
	const component = new TeamRunComponent(run);
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
