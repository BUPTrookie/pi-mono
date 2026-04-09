/**
 * Notification queue for async sub-agent task management.
 *
 * Tracks background sub-agent tasks and delivers completion notifications
 * via the MessageBus (same pattern as EventsWatcher).
 */

import type { SubAgentResult } from "./sub-agent.js";

export interface AsyncTaskRecord {
	id: string;
	agentType: string;
	description: string;
	startedAt: number;
	status: "running" | "completed" | "failed";
	result?: SubAgentResult;
}

export class NotificationQueue {
	private tasks = new Map<string, AsyncTaskRecord>();
	private nextId = 1;

	constructor(
		private channelType: string,
		private chatId: string,
		private onComplete: (channelType: string, chatId: string, text: string) => void,
	) {}

	/**
	 * Start an async sub-agent task.
	 * Returns the task ID immediately. The task runs in the background
	 * and triggers onComplete when done.
	 */
	startAsync(agentType: string, description: string, runFn: () => Promise<SubAgentResult>): string {
		const id = `async-${this.nextId++}`;
		const record: AsyncTaskRecord = {
			id,
			agentType,
			description,
			startedAt: Date.now(),
			status: "running",
		};
		this.tasks.set(id, record);

		// Fire-and-forget
		void runFn().then(
			(result) => {
				record.status = result.success ? "completed" : "failed";
				record.result = result;
				this.onComplete(this.channelType, this.chatId, this.formatNotification(id, agentType, description, result));
			},
			(error) => {
				record.status = "failed";
				record.result = {
					success: false,
					text: "",
					messages: [],
					error: error instanceof Error ? error.message : String(error),
					turnsUsed: 0,
				};
				this.onComplete(
					this.channelType,
					this.chatId,
					this.formatNotification(id, agentType, description, record.result),
				);
			},
		);

		return id;
	}

	getTask(id: string): AsyncTaskRecord | undefined {
		return this.tasks.get(id);
	}

	listTasks(): AsyncTaskRecord[] {
		return Array.from(this.tasks.values());
	}

	private formatNotification(id: string, agentType: string, description: string, result: SubAgentResult): string {
		if (result.success) {
			return `[ASYNC-AGENT:${id}:${agentType}:completed] ${description}\n\nResult:\n${result.text}`;
		}
		return `[ASYNC-AGENT:${id}:${agentType}:failed] ${description}\n\nError: ${result.error || "Unknown error"}`;
	}
}
