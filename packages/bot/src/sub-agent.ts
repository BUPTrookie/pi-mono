/**
 * Sub-agent execution engine.
 *
 * Creates an isolated Agent instance, runs a task with its own agentic loop,
 * and returns the result. Supports abort propagation and turn limiting.
 */

import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@mariozechner/pi-agent-core";
import type { Message, Model } from "@mariozechner/pi-ai";
import type { AgentTypeDefinition } from "./agent-types.js";

export interface SubAgentConfig {
	/** Agent type definition controlling prompt, tools, and limits */
	agentType: AgentTypeDefinition;
	/** Full tool pool from the parent (will be filtered by agentType.allowedTools) */
	toolPool: AgentTool<any>[];
	/** Model for the sub-agent */
	model: Model<any>;
	/** Stream function from the parent agent */
	streamFn: StreamFn;
	/** API key resolver from the parent */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** Convert function for LLM messages */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** Parent abort signal — sub-agent aborts when parent does */
	parentSignal?: AbortSignal;
}

export interface SubAgentResult {
	/** Whether the sub-agent completed successfully */
	success: boolean;
	/** Final text response from the sub-agent */
	text: string;
	/** Full message history (for debugging) */
	messages: AgentMessage[];
	/** Error message if failed */
	error?: string;
	/** Number of turns used */
	turnsUsed: number;
}

/**
 * Filter tools for a sub-agent based on its type definition.
 * Always removes the "agent" tool to prevent recursion.
 */
function filterTools(toolPool: AgentTool<any>[], allowedTools?: string[]): AgentTool<any>[] {
	let filtered = toolPool.filter((t) => t.name !== "agent");
	if (allowedTools) {
		const allowed = new Set(allowedTools);
		filtered = filtered.filter((t) => allowed.has(t.name));
	}
	return filtered;
}

/**
 * Extract the final text from an agent's message history.
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
 * Run a sub-agent to completion.
 *
 * Creates a new Agent instance with an isolated context, runs the task,
 * and returns the result. The sub-agent's tool pool is filtered according
 * to its type definition, and the "agent" tool is always removed.
 */
export async function runSubAgent(task: string, config: SubAgentConfig): Promise<SubAgentResult> {
	const { agentType, toolPool, model, streamFn, getApiKey, convertToLlm, parentSignal } = config;
	const maxTurns = agentType.maxTurns ?? 20;
	const tools = filterTools(toolPool, agentType.allowedTools);

	const agent = new Agent({
		initialState: {
			systemPrompt: agentType.systemPrompt,
			model,
			thinkingLevel: agentType.thinkingLevelOverride ?? "off",
			tools,
		},
		streamFn,
		getApiKey,
		convertToLlm,
	});

	// Propagate parent abort
	let onParentAbort: (() => void) | undefined;
	if (parentSignal) {
		if (parentSignal.aborted) {
			return { success: false, text: "", messages: [], error: "Parent aborted", turnsUsed: 0 };
		}
		onParentAbort = () => agent.abort();
		parentSignal.addEventListener("abort", onParentAbort, { once: true });
	}

	// Track turns and enforce maxTurns
	let turnsUsed = 0;
	const unsubscribe = agent.subscribe((event) => {
		if (event.type === "turn_end") {
			turnsUsed++;
			if (turnsUsed >= maxTurns) {
				agent.abort();
			}
		}
	});

	try {
		await agent.prompt(task);
		const text = extractFinalText(agent.state.messages);
		return {
			success: true,
			text,
			messages: agent.state.messages,
			turnsUsed,
		};
	} catch (err) {
		const isAborted = turnsUsed >= maxTurns || parentSignal?.aborted;
		const text = extractFinalText(agent.state.messages);
		return {
			success: !isAborted && !!text,
			text,
			messages: agent.state.messages,
			error: isAborted
				? turnsUsed >= maxTurns
					? `Sub-agent reached maximum turns (${maxTurns})`
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
