import type { Task, TaskResult } from "../types.js";

export class TaskGraph {
	private tasks = new Map<string, Task>();

	addTask(task: Task): void {
		if (this.tasks.has(task.id)) {
			throw new Error(`Task already exists: ${task.id}`);
		}
		this.tasks.set(task.id, { ...task, status: "pending" });
	}

	getTask(id: string): Task | undefined {
		return this.tasks.get(id);
	}

	getAllTasks(): Task[] {
		return [...this.tasks.values()];
	}

	/**
	 * Get tasks whose dependencies are all completed.
	 * Excludes tasks that are blocked by any failed dependency.
	 */
	getReadyTasks(): Task[] {
		const ready: Task[] = [];
		for (const task of this.tasks.values()) {
			if (task.status !== "pending") continue;

			let blocked = false;
			let allDepsCompleted = true;
			for (const depId of task.dependencies) {
				const dep = this.tasks.get(depId);
				if (dep?.status === "failed") {
					blocked = true;
					break;
				}
				if (dep?.status !== "completed") {
					allDepsCompleted = false;
				}
			}

			if (!blocked && allDepsCompleted) {
				ready.push(task);
			}
		}
		return ready;
	}

	markInProgress(id: string): void {
		const task = this.tasks.get(id);
		if (!task) throw new Error(`Task not found: ${id}`);
		task.status = "in_progress";
	}

	markComplete(id: string, result: TaskResult): void {
		const task = this.tasks.get(id);
		if (!task) throw new Error(`Task not found: ${id}`);
		task.status = "completed";
		task.result = result;
	}

	markFailed(id: string, error: string): void {
		const task = this.tasks.get(id);
		if (!task) throw new Error(`Task not found: ${id}`);
		task.status = "failed";
		task.result = { taskId: id, success: false, output: "", filesCreated: [], error, turnsUsed: 0 };
	}

	/**
	 * Reset a task back to pending state (for retries).
	 * Clears result and resets status.
	 */
	resetTask(id: string): void {
		const task = this.tasks.get(id);
		if (!task) throw new Error(`Task not found: ${id}`);
		task.status = "pending";
		task.result = undefined;
	}

	/**
	 * Mark a task as failed and propagate failure to all downstream dependents.
	 * Returns the list of task IDs that were cascade-failed.
	 */
	propagateFailure(id: string, error: string): string[] {
		const failed: string[] = [id];
		this.markFailed(id, error);

		// BFS: find all tasks that transitively depend on the failed task
		const queue: string[] = [id];
		while (queue.length > 0) {
			const currentId = queue.shift()!;
			for (const task of this.tasks.values()) {
				if (task.status !== "pending" && task.status !== "in_progress") continue;
				if (task.dependencies.includes(currentId)) {
					this.markFailed(task.id, `Dependency '${currentId}' failed: ${error}`);
					failed.push(task.id);
					queue.push(task.id);
				}
			}
		}

		return failed;
	}

	isComplete(): boolean {
		for (const task of this.tasks.values()) {
			if (task.status !== "completed" && task.status !== "failed") return false;
		}
		return true;
	}

	hasFailed(): boolean {
		return [...this.tasks.values()].some((t) => t.status === "failed");
	}

	getFailedTasks(): Task[] {
		return [...this.tasks.values()].filter((t) => t.status === "failed");
	}
}
