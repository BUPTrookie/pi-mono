import type { Task } from "../types.js";
import type { TaskGraph } from "./task-graph.js";

export class TaskScheduler {
	private runningCount = 0;

	constructor(
		private graph: TaskGraph,
		private maxParallel: number = 2,
	) {}

	/** Get the next batch of tasks to run, respecting parallelism limits. */
	nextBatch(): Task[] {
		const ready = this.graph.getReadyTasks();
		const slots = this.maxParallel - this.runningCount;
		if (slots <= 0) return [];
		return ready.slice(0, slots);
	}

	/** Call before a task starts executing. */
	startTask(taskId: string): void {
		this.graph.markInProgress(taskId);
		this.runningCount++;
	}

	/** Call after a task finishes (success or failure). */
	finishTask(): void {
		this.runningCount = Math.max(0, this.runningCount - 1);
	}

	/** Whether all tasks are done (completed or failed). */
	isDone(): boolean {
		return this.graph.isComplete();
	}

	/** Whether there are failed tasks. */
	hasFailed(): boolean {
		return this.graph.hasFailed();
	}
}
