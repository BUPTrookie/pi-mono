import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { Agent, type AgentEvent, type AgentMessage, type StreamFn } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
import type { ApprovalDecision, InterventionMode, RoleDefinition, TaskResult } from "../types.js";
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
			return text.includes("docs/contracts/") || text.includes("Acceptance criteria:");
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
				taskId: "",
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
	const unsubscribe = agent.subscribe((event) => {
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
		return {
			taskId: "",
			success: true,
			output: text,
			filesCreated,
			turnsUsed,
		};
	} catch (err) {
		const isAborted = turnsUsed >= maxTurns || parentSignal?.aborted;
		const text = extractFinalText(agent.state.messages);
		const filesCreated = extractFilesCreated(agent.state.messages);
		return {
			taskId: "",
			success: !isAborted && !!text,
			output: text,
			filesCreated,
			error: isAborted
				? turnsUsed >= maxTurns
					? `Agent reached maximum turns (${maxTurns})`
					: "Parent aborted"
				: err instanceof Error
					? err.message
					: String(err),
			turnsUsed,
		};
	} finally {
		unsubscribe();
		if (parentSignal && onParentAbort) {
			parentSignal.removeEventListener("abort", onParentAbort);
		}
	}
}
