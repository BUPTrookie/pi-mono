import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { Agent, type AgentEvent, type AgentMessage, type StreamFn } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
import type { ApprovalDecision, InterventionMode, RoleDefinition, TaskCheckResult, TaskResult } from "../types.js";
import { createBashSafetyGuard } from "./bash-safety.js";
import { createOwnershipGuard } from "./file-ownership.js";
import { buildToolPool } from "./tool-pool.js";

export interface TeamAgentConfig {
	role: RoleDefinition;
	model: Model<any>;
	outputDir: string;
	streamFn: StreamFn;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	parentSignal?: AbortSignal;
	thinkingLevel?: ThinkingLevel;
	taskId?: string;
	interventionMode?: InterventionMode;
	onAgentEvent?: (event: AgentEvent) => void;
	onTaskProgress?: (message: string) => void;
	requestApproval?: (request: { taskId: string; reason: string; command: string }) => Promise<ApprovalDecision>;
}

/**
 * Extract the final assistant text from message history.
 */
function extractFinalText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const parts: string[] = [];
			for (const block of msg.content) {
				if (block.type === "text") {
					parts.push(block.text);
				}
			}
			const text = parts.join("\n").trim();
			if (text) return text;
		}
	}
	return "";
}

/**
 * Extract file paths created/modified by the agent from tool call history.
 */
function extractFilesCreated(messages: AgentMessage[]): string[] {
	const files = new Set<string>();
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const block of msg.content) {
			if (block.type === "toolCall") {
				const args = block.arguments as { path?: string };
				if ((block.name === "write" || block.name === "edit") && args.path) {
					files.add(args.path);
				}
			}
		}
	}
	return [...files];
}

function sanitizeTaskId(taskId: string): string {
	return taskId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractExitCode(result: unknown, isError: boolean): number | null {
	if (isRecord(result) && typeof result.exitCode === "number") return result.exitCode;
	const text = typeof result === "string" ? result : JSON.stringify(result ?? "");
	const match = /Command exited with code\s+(\d+)/i.exec(text);
	if (match) return Number(match[1]);
	return isError ? 1 : 0;
}

function summarizeToolResult(result: unknown): string {
	const text = typeof result === "string" ? result : JSON.stringify(result ?? "");
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return "completed";
	return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function isSelfCheckCommand(command: string): boolean {
	return /\b(?:node\s+--check|npm\s+(?:run\s+)?(?:check|test|build)|pnpm\s+(?:run\s+)?(?:check|test|build)|yarn\s+(?:run\s+)?(?:check|test|build)|bun\s+(?:run\s+)?(?:check|test|build)|vitest|tsc|eslint)\b/i.test(
		command,
	);
}

export function extractChecksRunFromAgentEvents(events: AgentEvent[]): TaskCheckResult[] {
	const commandsById = new Map<string, string>();
	const checks: TaskCheckResult[] = [];
	for (const event of events) {
		if (event.type === "tool_execution_start" && event.toolName === "bash") {
			const args = isRecord(event.args) ? event.args : {};
			const command = typeof args.command === "string" ? args.command.trim() : "";
			if (command) commandsById.set(event.toolCallId, command);
			continue;
		}
		if (event.type !== "tool_execution_end" || event.toolName !== "bash") continue;
		const command = commandsById.get(event.toolCallId);
		if (!command || !isSelfCheckCommand(command)) continue;
		checks.push({
			command,
			exitCode: extractExitCode(event.result, event.isError),
			summary: summarizeToolResult(event.result),
			required: true,
		});
	}
	return checks;
}

function writeTaskHandoff(outputDir: string, taskId: string, result: TaskResult): string {
	const relativePath = `docs/agent-team/tasks/${sanitizeTaskId(taskId)}-handoff.json`;
	const absolutePath = join(outputDir, relativePath);
	mkdirSync(dirname(absolutePath), { recursive: true });
	writeFileSync(
		absolutePath,
		`${JSON.stringify(
			{
				taskId,
				changedFiles: result.filesCreated,
				contractsSatisfied: result.success ? ["Task acceptance criteria reviewed by agent."] : [],
				checksRun: result.checksRun ?? [],
				knownRisks: result.error ? [result.error] : [],
			},
			null,
			2,
		)}\n`,
		"utf-8",
	);
	return relativePath;
}

/**
 * Contract-aware context transform that keeps project contract references and recent messages.
 */
function createContractAwareTransformContext(
	maxMessages: number,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
	return async (messages: AgentMessage[]) => {
		if (messages.length <= maxMessages) return messages;

		const systemMsg = messages[0];
		const recent = messages.slice(-(maxMessages - 1));
		const contractMessages = messages.slice(1, -recent.length).filter((message) => {
			if (message.role !== "user") return false;
			const text = Array.isArray(message.content)
				? message.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n")
				: String(message.content);
			return (
				text.includes("docs/contracts/") ||
				text.includes("Contract files to read first:") ||
				text.includes("Acceptance criteria:") ||
				text.includes("Expected outputs:")
			);
		});
		const merged = [systemMsg, ...contractMessages, ...recent];
		const seen = new Set<AgentMessage>();
		return merged.filter((message) => {
			if (seen.has(message)) return false;
			seen.add(message);
			return true;
		});
	};
}

/**
 * Run a team agent to completion for a specific task.
 * Follows the bot's runSubAgent pattern with ownership enforcement.
 */
export async function runTeamAgent(taskDescription: string, config: TeamAgentConfig): Promise<TaskResult> {
	const { role, model, outputDir, streamFn, getApiKey, parentSignal, thinkingLevel } = config;
	const maxTurns = role.maxTurns;

	const tools = buildToolPool(role, outputDir);
	const ownershipGuard = createOwnershipGuard(role.ownedDirectories, outputDir);
	const bashSafetyGuard = createBashSafetyGuard({
		taskId: config.taskId ?? role.name,
		interventionMode: config.interventionMode ?? "none",
		requestApproval: config.requestApproval,
	});

	const agent = new Agent({
		initialState: {
			systemPrompt: role.systemPrompt,
			model,
			thinkingLevel: thinkingLevel ?? "off",
			tools,
		},
		streamFn,
		getApiKey,
		convertToLlm,
		beforeToolCall: async (context) => {
			const ownershipResult = await ownershipGuard(context);
			if (ownershipResult?.block) {
				config.onTaskProgress?.(
					`Blocked ${context.toolCall.name}: ${ownershipResult.reason ?? "ownership violation"}`,
				);
				return ownershipResult;
			}
			const bashResult = await bashSafetyGuard(context);
			if (bashResult?.block) {
				config.onTaskProgress?.(`Blocked ${context.toolCall.name}: ${bashResult.reason ?? "unsafe command"}`);
			}
			return bashResult;
		},
		transformContext: createContractAwareTransformContext(120),
	});

	// Propagate parent abort
	let onParentAbort: (() => void) | undefined;
	if (parentSignal) {
		if (parentSignal.aborted) {
			return {
				taskId: config.taskId ?? "",
				success: false,
				output: "",
				filesCreated: [],
				error: "Parent aborted",
				turnsUsed: 0,
			};
		}
		onParentAbort = () => agent.abort();
		parentSignal.addEventListener("abort", onParentAbort, { once: true });
	}

	// Track turns and enforce maxTurns
	let turnsUsed = 0;
	const events: AgentEvent[] = [];
	const unsubscribe = agent.subscribe((event) => {
		events.push(event);
		config.onAgentEvent?.(event);
		if (event.type === "turn_end") {
			turnsUsed++;
			if (turnsUsed >= maxTurns) {
				agent.abort();
			}
		}
	});

	try {
		await agent.prompt(taskDescription);
		const text = extractFinalText(agent.state.messages);
		const filesCreated = extractFilesCreated(agent.state.messages);
		const result: TaskResult = {
			taskId: config.taskId ?? "",
			success: true,
			output: text,
			filesCreated,
			turnsUsed,
			checksRun: extractChecksRunFromAgentEvents(events),
		};
		result.handoffPath = writeTaskHandoff(outputDir, result.taskId || role.name, result);
		return result;
	} catch (err) {
		const parentAborted = parentSignal?.aborted ?? false;
		const reachedMaxTurns = turnsUsed >= maxTurns;
		const isAborted = parentAborted || reachedMaxTurns;
		const text = extractFinalText(agent.state.messages);
		const filesCreated = extractFilesCreated(agent.state.messages);
		const result: TaskResult = {
			taskId: config.taskId ?? "",
			success: !isAborted && !!text,
			output: text,
			filesCreated,
			error: isAborted
				? parentAborted
					? "Parent aborted"
					: `Agent reached maximum turns (${maxTurns})`
				: err instanceof Error
					? err.message
					: String(err),
			turnsUsed,
			checksRun: extractChecksRunFromAgentEvents(events),
		};
		result.handoffPath = writeTaskHandoff(outputDir, result.taskId || role.name, result);
		return result;
	} finally {
		unsubscribe();
		if (parentSignal && onParentAbort) {
			parentSignal.removeEventListener("abort", onParentAbort);
		}
	}
}
