import { describe, expect, it } from "vitest";
import { TaskGraph } from "../src/task/task-graph.js";
import { TaskScheduler } from "../src/task/task-scheduler.js";
import type { Task } from "../src/types.js";

function makeTask(overrides: Partial<Task> & { id: string }): Task {
	return {
		role: "project-builder",
		subject: "Test",
		description: "Test",
		dependencies: [],
		status: "pending",
		expectedOutputs: [],
		acceptanceCriteria: [],
		...overrides,
	};
}

describe("TaskScheduler", () => {
	it("should return tasks up to maxParallel limit", () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "t1" }));
		graph.addTask(makeTask({ id: "t2" }));
		graph.addTask(makeTask({ id: "t3" }));

		const scheduler = new TaskScheduler(graph, 2);
		const batch = scheduler.nextBatch();
		expect(batch).toHaveLength(2);
	});

	it("should return empty batch when no slots available", () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "t1" }));
		graph.addTask(makeTask({ id: "t2" }));

		const scheduler = new TaskScheduler(graph, 2);
		scheduler.startTask("t1");
		scheduler.startTask("t2");

		// No more slots
		graph.addTask(makeTask({ id: "t3" }));
		// t3 is pending but t1/t2 are in_progress, so not ready (depends on graph state)
		// Actually t3 has no deps, but the scheduler has 0 slots
		const batch = scheduler.nextBatch();
		expect(batch).toHaveLength(0);
	});

	it("should free slots when tasks finish", () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "t1" }));
		graph.addTask(makeTask({ id: "t2" }));
		graph.addTask(makeTask({ id: "t3" }));

		const scheduler = new TaskScheduler(graph, 1);

		// Get first task
		const batch1 = scheduler.nextBatch();
		expect(batch1).toHaveLength(1);
		scheduler.startTask(batch1[0].id);

		// No more slots
		expect(scheduler.nextBatch()).toHaveLength(0);

		// Finish task
		scheduler.finishTask();

		// Now can get next
		const batch2 = scheduler.nextBatch();
		expect(batch2).toHaveLength(1);
	});

	it("should respect task dependencies", () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "t1" }));
		graph.addTask(makeTask({ id: "t2", dependencies: ["t1"] }));

		const scheduler = new TaskScheduler(graph, 2);
		const batch = scheduler.nextBatch();
		expect(batch).toHaveLength(1);
		expect(batch[0].id).toBe("t1");
	});

	it("should detect completion", () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "t1" }));

		const scheduler = new TaskScheduler(graph, 1);
		expect(scheduler.isDone()).toBe(false);

		graph.markComplete("t1", { taskId: "t1", success: true, output: "", filesCreated: [], turnsUsed: 1 });
		expect(scheduler.isDone()).toBe(true);
	});

	it("should detect failure", () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "t1" }));

		const scheduler = new TaskScheduler(graph, 1);
		graph.markFailed("t1", "error");
		expect(scheduler.hasFailed()).toBe(true);
	});
});
