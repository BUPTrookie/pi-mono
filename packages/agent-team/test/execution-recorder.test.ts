import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createExecutionRecorder } from "../src/team/execution-recorder.js";
import type { TeamEvent, TeamResult } from "../src/types.js";

function tempProject(): string {
	return join(tmpdir(), `agent-team-recorder-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function readJsonl(path: string): Array<Record<string, unknown>> {
	return readFileSync(path, "utf-8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const result: TeamResult = {
	success: true,
	outputDir: "out",
	tasks: [
		{
			taskId: "build/api",
			success: true,
			output: "built",
			filesCreated: ["src/index.ts"],
			turnsUsed: 2,
		},
	],
	totalTurns: 2,
	validationIssues: [],
};

describe("execution recorder", () => {
	it("writes ordered envelopes, task shards, and run summary", () => {
		const outputDir = tempProject();
		const recorder = createExecutionRecorder(outputDir);
		const events: TeamEvent[] = [
			{ type: "run_start", requirement: "Build an API", outputDir, timestamp: 1000 },
			{
				type: "task_start",
				task: {
					id: "build/api",
					role: "backend",
					subject: "Build API",
					description: "Build it",
					dependencies: [],
					status: "in_progress",
					expectedOutputs: ["src/index.ts"],
					acceptanceCriteria: ["works"],
				},
				timestamp: 1001,
			},
			{
				type: "agent_event",
				taskId: "build/api",
				role: "backend",
				event: {
					type: "tool_execution_start",
					toolCallId: "tool-1",
					toolName: "write",
					args: { path: "src/index.ts", apiKey: "secret-key", content: "secret content" },
				},
				timestamp: 1002,
			},
			{
				type: "task_end",
				task: {
					id: "build/api",
					role: "backend",
					subject: "Build API",
					description: "Build it",
					dependencies: [],
					status: "completed",
					expectedOutputs: ["src/index.ts"],
					acceptanceCriteria: ["works"],
				},
				result: result.tasks[0],
				timestamp: 1003,
			},
			{ type: "run_end", result, timestamp: 1004 },
		];

		for (const event of events) {
			recorder.record(event);
		}
		recorder.finish(result);

		const baseDir = join(outputDir, "docs", "agent-team");
		const mainLog = readJsonl(join(baseDir, "events.jsonl"));
		const taskLog = readJsonl(join(baseDir, "tasks", "build_api.jsonl"));
		const summary = readFileSync(join(baseDir, "run-summary.md"), "utf-8");

		expect(mainLog.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
		expect(mainLog.map((entry) => entry.type)).toEqual([
			"run_start",
			"task_start",
			"agent_event",
			"task_end",
			"run_end",
		]);
		expect(taskLog.map((entry) => entry.seq)).toEqual([2, 3, 4]);
		expect(JSON.stringify(mainLog)).not.toContain("secret-key");
		expect(JSON.stringify(mainLog)).toContain("secret content");
		expect(summary).toContain("# Agent Team Run Summary");
		expect(summary).toContain("| build/api | success | 2 | src/index.ts |  |");
	});

	it("creates the log directory before recording", () => {
		const outputDir = tempProject();
		const recorder = createExecutionRecorder(outputDir);

		recorder.record({ type: "run_start", requirement: "Build", outputDir, timestamp: 1 });

		expect(existsSync(join(outputDir, "docs", "agent-team", "events.jsonl"))).toBe(true);
	});

	it("skips streaming delta events (message_update, tool_execution_update)", () => {
		const outputDir = tempProject();
		const recorder = createExecutionRecorder(outputDir);

		const dummyMsg = { role: "assistant" as const, content: "ok", timestamp: 1 };
		const dummyToolResult = {
			toolCallId: "t1",
			toolName: "read" as const,
			role: "toolResult" as const,
			content: [{ type: "text" as const, text: "ok" }],
			isError: false,
			timestamp: 1,
			result: {},
		};

		recorder.record({ type: "run_start", requirement: "Test", outputDir, timestamp: 1 });

		// message_update — streaming delta, should be skipped
		recorder.record({
			type: "agent_event",
			taskId: "test",
			role: "tester",
			event: {
				type: "message_update",
				message: dummyMsg as never,
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "hello",
					partial: dummyMsg as never,
				},
			},
			timestamp: 2,
		});

		// tool_execution_update — streaming delta, should be skipped
		recorder.record({
			type: "agent_event",
			taskId: "test",
			role: "tester",
			event: {
				type: "tool_execution_update",
				toolCallId: "t1",
				toolName: "bash",
				args: { command: "ls" },
				partialResult: {} as never,
			},
			timestamp: 3,
		});

		// turn_end — meaningful event, should be recorded
		recorder.record({
			type: "agent_event",
			taskId: "test",
			role: "tester",
			event: {
				type: "turn_end",
				message: dummyMsg as never,
				toolResults: [dummyToolResult],
			},
			timestamp: 4,
		});

		const log = readJsonl(join(outputDir, "docs", "agent-team", "events.jsonl"));
		// Only run_start and turn_end should be recorded; 2 streaming deltas skipped
		expect(log.map((e) => e.seq)).toEqual([1, 2]);
		expect(log.map((e) => e.type)).toEqual(["run_start", "agent_event"]);
		const recordedInner = log
			.filter((e) => e.type === "agent_event")
			.map((e) => (e.event as Record<string, unknown>).event as Record<string, unknown>);
		expect(recordedInner.map((e) => e.type)).toEqual(["turn_end"]);
	});
});
