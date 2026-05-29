import { describe, expect, it } from "vitest";
import { TaskGraph } from "../src/task/task-graph.js";
import type { Task } from "../src/types.js";

function makeTask(overrides: Partial<Task> & { id: string }): Task {
	return {
		role: "project-builder",
		subject: "Test task",
		description: "Test description",
		dependencies: [],
		status: "pending",
		expectedOutputs: [],
		acceptanceCriteria: [],
		...overrides,
	};
}

function makeResult(id: string): Task["result"] & {} {
	return { taskId: id, success: true, output: "done", filesCreated: [], turnsUsed: 1 };
}

describe("TaskGraph", () => {
	it("should add and retrieve tasks", () => {
		const graph = new TaskGraph();
		const task = makeTask({ id: "t1" });
		graph.addTask(task);

		expect(graph.getTask("t1")).toEqual({ ...task, status: "pending" });
		expect(graph.getAllTasks()).toHaveLength(1);
	});

	it("should throw on duplicate task ID", () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "t1" }));
		expect(() => graph.addTask(makeTask({ id: "t1" }))).toThrow("Task already exists: t1");
	});

	it("should return ready tasks with no dependencies", () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "t1" }));
		graph.addTask(makeTask({ id: "t2" }));

		const ready = graph.getReadyTasks();
		expect(ready).toHaveLength(2);
		expect(ready.map((t) => t.id)).toContain("t1");
		expect(ready.map((t) => t.id)).toContain("t2");
	});

	it("should not return tasks with unmet dependencies", () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "t1" }));
		graph.addTask(makeTask({ id: "t2", dependencies: ["t1"] }));

		const ready = graph.getReadyTasks();
		expect(ready).toHaveLength(1);
		expect(ready[0].id).toBe("t1");
	});

	it("should unblock tasks when dependencies complete", () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "t1" }));
		graph.addTask(makeTask({ id: "t2", dependencies: ["t1"] }));

		graph.markComplete("t1", makeResult("t1"));

		const ready = graph.getReadyTasks();
		expect(ready).toHaveLength(1);
		expect(ready[0].id).toBe("t2");
	});

	it("should track completion status", () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "t1" }));
		expect(graph.isComplete()).toBe(false);

		graph.markComplete("t1", makeResult("t1"));
		expect(graph.isComplete()).toBe(true);
	});

	it("should track failed tasks", () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "t1" }));

		graph.markFailed("t1", "something went wrong");
		expect(graph.isComplete()).toBe(true);
		expect(graph.hasFailed()).toBe(true);
		expect(graph.getFailedTasks()).toHaveLength(1);
	});

	it("should handle complex dependency chains", () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "a" }));
		graph.addTask(makeTask({ id: "b", dependencies: ["a"] }));
		graph.addTask(makeTask({ id: "c", dependencies: ["a"] }));
		graph.addTask(makeTask({ id: "d", dependencies: ["b", "c"] }));

		// Only 'a' is ready initially
		expect(graph.getReadyTasks().map((t) => t.id)).toEqual(["a"]);

		// Complete 'a' -> 'b' and 'c' become ready
		graph.markComplete("a", makeResult("a"));
		const ready1 = graph.getReadyTasks().map((t) => t.id);
		expect(ready1).toContain("b");
		expect(ready1).toContain("c");

		// Complete 'b' only -> 'd' still blocked by 'c'
		graph.markComplete("b", makeResult("b"));
		expect(graph.getReadyTasks().map((t) => t.id)).toEqual(["c"]);

		// Complete 'c' -> 'd' becomes ready
		graph.markComplete("c", makeResult("c"));
		expect(graph.getReadyTasks().map((t) => t.id)).toEqual(["d"]);

		// Complete 'd'
		graph.markComplete("d", makeResult("d"));
		expect(graph.isComplete()).toBe(true);
	});

	it("should mark tasks as in_progress", () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "t1" }));
		graph.markInProgress("t1");
		expect(graph.getTask("t1")?.status).toBe("in_progress");
	});

	// --- New: resetTask ---

	it("should reset a task back to pending", () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "t1" }));
		graph.markFailed("t1", "error");

		expect(graph.getTask("t1")?.status).toBe("failed");

		graph.resetTask("t1");
		expect(graph.getTask("t1")?.status).toBe("pending");
		expect(graph.getTask("t1")?.result).toBeUndefined();
	});

	it("should reset a completed task", () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "t1" }));
		graph.markComplete("t1", makeResult("t1"));

		graph.resetTask("t1");
		expect(graph.getTask("t1")?.status).toBe("pending");
		expect(graph.getTask("t1")?.result).toBeUndefined();
	});

	// --- New: propagateFailure ---

	it("should propagate failure to downstream dependents", () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "a" }));
		graph.addTask(makeTask({ id: "b", dependencies: ["a"] }));
		graph.addTask(makeTask({ id: "c", dependencies: ["b"] }));

		const failed = graph.propagateFailure("a", "root cause");

		expect(failed).toContain("a");
		expect(failed).toContain("b");
		expect(failed).toContain("c");
		expect(graph.getTask("a")?.status).toBe("failed");
		expect(graph.getTask("b")?.status).toBe("failed");
		expect(graph.getTask("c")?.status).toBe("failed");
	});

	it("should propagate failure through diamond dependency", () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "a" }));
		graph.addTask(makeTask({ id: "b", dependencies: ["a"] }));
		graph.addTask(makeTask({ id: "c", dependencies: ["a"] }));
		graph.addTask(makeTask({ id: "d", dependencies: ["b", "c"] }));

		const failed = graph.propagateFailure("a", "root cause");

		expect(failed).toHaveLength(4);
		expect(graph.isComplete()).toBe(true);
		expect(graph.hasFailed()).toBe(true);
	});

	// --- New: getReadyTasks blocks on failed dependency ---

	it("should not return tasks blocked by a failed dependency", () => {
		const graph = new TaskGraph();
		graph.addTask(makeTask({ id: "a" }));
		graph.addTask(makeTask({ id: "b", dependencies: ["a"] }));

		graph.markFailed("a", "error");

		// 'b' should NOT be ready because its dependency failed
		expect(graph.getReadyTasks()).toHaveLength(0);
	});
});
