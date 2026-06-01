import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import type {
	SupervisorCheckpoint as BaseSupervisorCheckpoint,
	SupervisorDecision,
	Task,
	TaskResult,
	TaskSpec,
	TeamEvent,
	TeamPlan,
	ValidationIssue,
} from "../types.js";

export type SupervisorCheckpoint = BaseSupervisorCheckpoint;

export interface SupervisorContextInput {
	checkpoint: SupervisorCheckpoint;
	outputDir: string;
	requirement: string;
	plan: TeamPlan;
	task?: TaskSpec | Task;
	taskResult?: TaskResult;
	validationIssues: ValidationIssue[];
	recentEvents: TeamEvent[];
	allTaskResults: TaskResult[];
}

export interface SupervisorContext {
	checkpoint: SupervisorCheckpoint;
	requirement: string;
	plan: TeamPlan;
	task?: TaskSpec | Task;
	taskResult?: Omit<TaskResult, "output"> & { outputSummary?: string };
	contracts: Array<{ path: string; content: string }>;
	handoffs: Array<{ path: string; content: unknown }>;
	changedFiles: Array<{ path: string; content: string }>;
	truncationWarnings: string[];
	validationIssues: ValidationIssue[];
	recentEvents: Array<{ type: TeamEvent["type"]; taskId?: string; summary: string }>;
	allTaskResults: Array<Omit<TaskResult, "output"> & { outputSummary?: string }>;
}

export interface SupervisorRunnerOptions {
	model: Model<Api>;
	getApiKey: (provider: string) => Promise<string | undefined> | string | undefined;
	signal?: AbortSignal;
}

export type SupervisorRunner = (
	checkpoint: SupervisorCheckpoint,
	context: SupervisorContext,
	options: SupervisorRunnerOptions,
) => Promise<SupervisorDecision>;

const VALID_CHECKPOINTS = new Set<SupervisorCheckpoint>(["plan_created", "task_end", "validation_end", "final_review"]);
const VALID_DECISIONS = new Set(["accept", "warn", "request_repair", "request_human"]);
const MAX_FILE_CHARS = 12_000;

function stripCodeFence(text: string): string {
	const trimmed = text.trim();
	const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
	return match ? match[1].trim() : trimmed;
}

function extractJsonText(text: string): string {
	const stripped = stripCodeFence(text);
	const first = stripped.indexOf("{");
	const last = stripped.lastIndexOf("}");
	if (first === -1 || last === -1 || last <= first) return stripped;
	return stripped.slice(first, last + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string.`);
	return value.trim();
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function parseIssue(value: unknown, index: number): ValidationIssue {
	if (!isRecord(value)) throw new Error(`Supervisor issue ${index} must be an object.`);
	const severity = value.severity;
	if (severity !== "error" && severity !== "warning" && severity !== "info") {
		throw new Error(`Supervisor issue ${index} has unknown severity.`);
	}
	return {
		id: asString(value.id, `issues[${index}].id`),
		severity,
		message: asString(value.message, `issues[${index}].message`),
		ownerRole: typeof value.ownerRole === "string" ? value.ownerRole : undefined,
		ownerTaskId: typeof value.ownerTaskId === "string" ? value.ownerTaskId : undefined,
		file: typeof value.file === "string" ? value.file : undefined,
	};
}

export function parseSupervisorDecision(text: string): SupervisorDecision {
	let parsed: unknown;
	try {
		parsed = JSON.parse(extractJsonText(text));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Supervisor output must be valid JSON: ${message}`);
	}
	if (!isRecord(parsed)) throw new Error("Supervisor output must be a JSON object.");

	const checkpoint = asString(parsed.checkpoint, "checkpoint");
	if (!VALID_CHECKPOINTS.has(checkpoint as SupervisorCheckpoint))
		throw new Error(`Unknown supervisor checkpoint: ${checkpoint}`);
	const decision = asString(parsed.decision, "decision");
	if (!VALID_DECISIONS.has(decision)) throw new Error(`Unknown supervisor decision: ${decision}`);
	const issues = Array.isArray(parsed.issues) ? parsed.issues.map(parseIssue) : [];
	if (decision === "request_repair") {
		for (const issue of issues) {
			if (!issue.ownerTaskId && !issue.file) {
				throw new Error("request_repair issues must include ownerTaskId or file.");
			}
		}
	}

	return {
		checkpoint: checkpoint as SupervisorCheckpoint,
		decision: decision as SupervisorDecision["decision"],
		summary: asString(parsed.summary, "summary"),
		issues,
		recommendedActions: asStringArray(parsed.recommendedActions),
	};
}

function readTextWithMetadata(path: string): { content: string; truncated: boolean } {
	try {
		const text = readFileSync(path, "utf-8");
		return {
			content: text.length > MAX_FILE_CHARS ? text.slice(0, MAX_FILE_CHARS) : text,
			truncated: text.length > MAX_FILE_CHARS,
		};
	} catch {
		return { content: "", truncated: false };
	}
}

function readText(path: string): string {
	return readTextWithMetadata(path).content;
}

function readJson(path: string): unknown {
	const text = readText(path);
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function sanitizeTaskId(taskId: string): string {
	return taskId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function summarizeTaskResult(result: TaskResult): Omit<TaskResult, "output"> & { outputSummary?: string } {
	const output = result.output.trim();
	return {
		...result,
		output: undefined,
		outputSummary: output ? output.slice(0, 500) : undefined,
	} as Omit<TaskResult, "output"> & { outputSummary?: string };
}

function eventSummary(event: TeamEvent): { type: TeamEvent["type"]; taskId?: string; summary: string } {
	if (event.type === "task_start" || event.type === "task_end") {
		return { type: event.type, taskId: event.task.id, summary: event.task.subject };
	}
	if (event.type === "task_progress" || event.type === "agent_event") {
		return {
			type: event.type,
			taskId: event.taskId,
			summary: event.type === "task_progress" ? event.message : event.event.type,
		};
	}
	if (event.type === "validation_end") {
		return { type: event.type, summary: `${event.issues.length} issue(s)` };
	}
	if (event.type === "supervision_end") {
		return { type: event.type, summary: `${event.decision.decision}: ${event.decision.summary}` };
	}
	return { type: event.type, summary: event.type };
}

export function buildSupervisorContext(input: SupervisorContextInput): SupervisorContext {
	const contracts = input.plan.contracts.map((contract) => ({
		path: contract.path,
		content: readText(join(input.outputDir, contract.path)),
	}));
	const taskIds = new Set<string>();
	if (input.task?.id) taskIds.add(input.task.id);
	for (const result of input.allTaskResults) taskIds.add(result.taskId);
	if (input.taskResult?.taskId) taskIds.add(input.taskResult.taskId);
	const handoffs = [...taskIds].map((taskId) => {
		const path = `docs/agent-team/tasks/${sanitizeTaskId(taskId)}-handoff.json`;
		return { path, content: readJson(join(input.outputDir, path)) };
	});

	const filePaths = new Set<string>();
	for (const result of [input.taskResult, ...input.allTaskResults]) {
		for (const file of result?.filesCreated ?? []) filePaths.add(file);
		if (result?.handoffPath) {
			const handoff = readJson(join(input.outputDir, result.handoffPath));
			if (isRecord(handoff) && Array.isArray(handoff.changedFiles)) {
				for (const file of handoff.changedFiles) {
					if (typeof file === "string") filePaths.add(file);
				}
			}
		}
	}

	const truncationWarnings: string[] = [];
	const allFilePaths = [...filePaths];
	if (allFilePaths.length > 12) {
		truncationWarnings.push(
			`${allFilePaths.length - 12} changed file(s) omitted from supervisor context: ${allFilePaths
				.slice(12)
				.join(", ")}`,
		);
	}
	const changedFiles = allFilePaths.slice(0, 12).map((path) => {
		const file = readTextWithMetadata(join(input.outputDir, path));
		if (file.truncated) {
			truncationWarnings.push(`File ${path} was truncated to ${MAX_FILE_CHARS} characters.`);
		}
		return {
			path,
			content: file.content,
		};
	});

	return {
		checkpoint: input.checkpoint,
		requirement: input.requirement,
		plan: input.plan,
		task: input.task,
		taskResult: input.taskResult ? summarizeTaskResult(input.taskResult) : undefined,
		contracts,
		handoffs,
		changedFiles,
		truncationWarnings,
		validationIssues: input.validationIssues,
		recentEvents: input.recentEvents.slice(-40).map(eventSummary),
		allTaskResults: input.allTaskResults.map(summarizeTaskResult),
	};
}

function supervisorPrompt(context: SupervisorContext): string {
	return `You are the Supervisor TeamLeader Agent for a multi-agent software build.

You do not implement code. You review the run using facts from contracts, files, handoffs, checks, events, and validator issues.
Do not trust worker prose alone. Prefer concrete changed files, handoff JSON, checksRun, expected outputs, and validation issues.
If truncationWarnings is non-empty, account for the missing or partial facts in your confidence and request human input when that prevents a safe judgment.

Return ONLY valid JSON:
{
  "checkpoint": "${context.checkpoint}",
  "decision": "accept | warn | request_repair | request_human",
  "summary": "short review summary",
  "issues": [
    { "id": "stable-id", "severity": "error|warning|info", "message": "issue", "ownerTaskId": "task-id", "file": "path" }
  ],
  "recommendedActions": ["action"]
}

Use request_repair only for actionable implementation fixes and include ownerTaskId or file on each issue.
Use request_human only when the runtime cannot safely decide.`;
}

async function extractAssistantText(message: Awaited<ReturnType<typeof completeSimple>>): Promise<string> {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

export async function runSupervisorReview(
	checkpoint: SupervisorCheckpoint,
	context: SupervisorContext,
	options: SupervisorRunnerOptions,
): Promise<SupervisorDecision> {
	const apiKey = await options.getApiKey(options.model.provider);
	const message = await completeSimple(
		options.model,
		{
			systemPrompt: supervisorPrompt(context),
			messages: [
				{
					role: "user",
					content: `Review this milestone context:\n${JSON.stringify(context, null, 2)}`,
					timestamp: Date.now(),
				},
			],
		},
		{ apiKey, signal: options.signal },
	);
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throw new Error(message.errorMessage ?? `Supervisor model stopped with ${message.stopReason}`);
	}
	const decision = parseSupervisorDecision(await extractAssistantText(message));
	if (decision.checkpoint !== checkpoint) {
		throw new Error(`Supervisor returned checkpoint ${decision.checkpoint}, expected ${checkpoint}.`);
	}
	return decision;
}

export function writeSupervisorDecision(outputDir: string, sequence: number, decision: SupervisorDecision): string {
	const baseDir = join(outputDir, "docs", "agent-team");
	const jsonPath = join(baseDir, "supervision", `${String(sequence).padStart(3, "0")}-${decision.checkpoint}.json`);
	const reviewPath = join(baseDir, "team-leader-review.md");
	mkdirSync(dirname(jsonPath), { recursive: true });
	writeFileSync(jsonPath, `${JSON.stringify(decision, null, 2)}\n`, "utf-8");
	mkdirSync(dirname(reviewPath), { recursive: true });
	if (sequence === 1 || !existsSync(reviewPath)) {
		writeFileSync(reviewPath, "# TeamLeader Supervisor Review\n\n", "utf-8");
	}
	appendFileSync(
		reviewPath,
		[
			`## ${String(sequence).padStart(3, "0")} ${decision.checkpoint}`,
			`Decision: ${decision.decision}`,
			`Summary: ${decision.summary}`,
			"",
			"### Issues",
			decision.issues.length === 0
				? "None"
				: decision.issues.map((issue) => `- ${issue.id}: ${issue.severity}: ${issue.message}`).join("\n"),
			"",
			"### Recommended Actions",
			decision.recommendedActions.length === 0
				? "None"
				: decision.recommendedActions.map((action) => `- ${action}`).join("\n"),
			"",
		].join("\n"),
		"utf-8",
	);
	return jsonPath;
}
