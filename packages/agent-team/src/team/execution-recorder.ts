import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { TeamEvent, TeamResult } from "../types.js";

export interface RecordedTeamEvent {
	seq: number;
	timestamp: number;
	type: TeamEvent["type"];
	event: TeamEvent;
}

export interface ExecutionRecorder {
	record(event: TeamEvent): void;
	finish(result: TeamResult): void;
}

interface RecorderState {
	validationRounds: Array<{ round: number; issues: number }>;
	repairRounds: Array<{ round: number; issues: number; tasks: number }>;
}

/** Keys whose values should always be redacted (API keys, tokens, etc.) */
const SENSITIVE_KEY_PARTS = ["key", "token", "secret", "authorization", "password"];

/** Streaming delta event types — noisy intermediate chunks, not useful for replay */
const STREAMING_DELTA_TYPES = new Set([
	"message_update",
	"thinking_delta",
	"text_delta",
	"toolcall_delta",
	"tool_execution_update",
]);

function sanitizeTaskId(taskId: string): string {
	return taskId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isStreamingDelta(event: TeamEvent): boolean {
	if (event.type !== "agent_event") return false;
	const inner = (event as { event?: { type?: string } }).event;
	return typeof inner?.type === "string" && STREAMING_DELTA_TYPES.has(inner.type);
}

function taskIdForEvent(event: TeamEvent): string | undefined {
	switch (event.type) {
		case "task_start":
		case "task_end":
			return event.task.id;
		case "task_progress":
		case "agent_event":
		case "approval_requested":
			return event.taskId;
		default:
			return undefined;
	}
}

function shouldRedactKey(key: string): boolean {
	const normalized = key.toLowerCase();
	return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function redactValue(value: unknown, key = ""): unknown {
	if (key && shouldRedactKey(key)) return "[redacted]";
	if (Array.isArray(value)) return value.map((item) => redactValue(item));
	if (value && typeof value === "object") {
		const redacted: Record<string, unknown> = {};
		for (const [entryKey, entryValue] of Object.entries(value)) {
			redacted[entryKey] = redactValue(entryValue, entryKey);
		}
		return redacted;
	}
	return value;
}

function redactEvent(event: TeamEvent): TeamEvent {
	if (event.type !== "agent_event") return event;
	return { ...event, event: redactValue(event.event) as AgentEvent };
}

function writeJsonl(path: string, envelope: RecordedTeamEvent): void {
	appendFileSync(path, `${JSON.stringify(envelope)}\n`, "utf-8");
}

function formatIssueSummary(result: TeamResult): string {
	const issues = result.validationIssues ?? [];
	if (issues.length === 0) return "None";
	return issues.map((issue) => `- ${issue.id}: ${issue.severity}: ${issue.message}`).join("\n");
}

function formatTaskRows(result: TeamResult): string {
	if (result.tasks.length === 0) return "| _none_ | _none_ | 0 |  | 0 |  |  |";
	return result.tasks
		.map((task) => {
			const status = task.success ? "success" : "failed";
			const files = task.filesCreated.join(", ");
			const error = task.error ?? "";
			return `| ${task.taskId} | ${status} | ${task.turnsUsed} | ${files} | ${task.checksRun?.length ?? 0} | ${task.handoffPath ?? ""} | ${error} |`;
		})
		.join("\n");
}

function formatChecks(result: TeamResult): string {
	const checks = result.tasks.flatMap((task) =>
		(task.checksRun ?? []).map(
			(check) =>
				`- ${task.taskId}: ${check.command} -> ${check.exitCode ?? "unknown"}${check.summary ? ` (${check.summary})` : ""}`,
		),
	);
	return checks.length === 0 ? "None" : checks.join("\n");
}

function formatRepairSummary(state: RecorderState): string {
	if (state.validationRounds.length === 0 && state.repairRounds.length === 0) return "None";
	return [
		...state.validationRounds.map((round) => `- validation round ${round.round}: ${round.issues} issue(s)`),
		...state.repairRounds.map(
			(round) => `- repair round ${round.round}: ${round.issues} issue(s), ${round.tasks} task(s)`,
		),
	].join("\n");
}

function buildSummary(result: TeamResult, state: RecorderState): string {
	return [
		"# Agent Team Run Summary",
		"",
		`Success: ${result.success}`,
		`Output Dir: ${result.outputDir}`,
		`Total Turns: ${result.totalTurns}`,
		result.error ? `Error: ${result.error}` : undefined,
		"",
		"## Tasks",
		"",
		"| Task | Status | Turns | Files | Checks | Handoff | Error |",
		"| --- | --- | ---: | --- | ---: | --- | --- |",
		formatTaskRows(result),
		"",
		"## Checks Run",
		"",
		formatChecks(result),
		"",
		"## Validation And Repair",
		"",
		formatRepairSummary(state),
		"",
		"## Validation Issues",
		"",
		formatIssueSummary(result),
		"",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

export function createExecutionRecorder(outputDir: string): ExecutionRecorder {
	const baseDir = join(outputDir, "docs", "agent-team");
	const tasksDir = join(baseDir, "tasks");
	const eventsPath = join(baseDir, "events.jsonl");
	const summaryPath = join(baseDir, "run-summary.md");
	let seq = 0;
	const state: RecorderState = { validationRounds: [], repairRounds: [] };

	mkdirSync(tasksDir, { recursive: true });

	return {
		record(event: TeamEvent): void {
			// Skip streaming delta events — redundant with message_start/message_end
			if (isStreamingDelta(event)) return;
			if (event.type === "validation_end") {
				state.validationRounds.push({ round: event.round, issues: event.issues.length });
			} else if (event.type === "repair_requested") {
				state.repairRounds.push({ round: event.round, issues: event.issues.length, tasks: event.tasks.length });
			}

			const safeEvent = redactEvent(event);
			const envelope: RecordedTeamEvent = {
				seq: ++seq,
				timestamp: event.timestamp,
				type: event.type,
				event: safeEvent,
			};
			writeJsonl(eventsPath, envelope);
			const taskId = taskIdForEvent(event);
			if (taskId) {
				writeJsonl(join(tasksDir, `${sanitizeTaskId(taskId)}.jsonl`), envelope);
			}
		},

		finish(result: TeamResult): void {
			mkdirSync(baseDir, { recursive: true });
			writeFileSync(summaryPath, buildSummary(result, state), "utf-8");
		},
	};
}
