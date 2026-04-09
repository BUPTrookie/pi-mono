/**
 * Level 5: Reactive/Emergency compact — last resort truncation.
 *
 * When all other levels have failed and context is still too large,
 * aggressively truncate to fit within the target token budget.
 * Preserves message structure integrity (user/assistant/toolResult pairing).
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import { CLEARED_RESULT_TEXT, estimateTotalTokens } from "./types.js";

/**
 * Emergency truncation — aggressively reduce context to fit target.
 *
 * Strategy (in order):
 * 1. Clear ALL old tool result contents (not just compactable ones)
 * 2. Remove all messages except the most recent 3 turns
 * 3. Truncate long text content in remaining messages
 *
 * Returns a new message array.
 */
export function emergencyTruncate(messages: AgentMessage[], targetTokens: number): AgentMessage[] {
	let result = [...messages];
	let currentTokens = estimateTotalTokens(result);

	if (currentTokens <= targetTokens) {
		return result;
	}

	// Step 1: Clear ALL tool result contents (keep only last 2)
	const toolResultIndices: number[] = [];
	for (let i = result.length - 1; i >= 0; i--) {
		if (result[i].role === "toolResult") {
			toolResultIndices.push(i);
		}
	}

	const keepCount = 2;
	for (let k = keepCount; k < toolResultIndices.length; k++) {
		const idx = toolResultIndices[k];
		const tr = result[idx] as ToolResultMessage;
		const cleared: TextContent = { type: "text", text: CLEARED_RESULT_TEXT };
		result[idx] = { ...tr, content: [cleared] };
	}

	currentTokens = estimateTotalTokens(result);
	if (currentTokens <= targetTokens) {
		return result;
	}

	// Step 2: Keep only the most recent 3 user messages and their responses
	// Find the 3rd-from-last user message
	const userIndices: number[] = [];
	for (let i = result.length - 1; i >= 0; i--) {
		if (result[i].role === "user") {
			userIndices.push(i);
		}
	}

	if (userIndices.length > 3) {
		const cutIndex = userIndices[2]; // 3rd from last user message
		const summary: AgentMessage = {
			role: "user",
			content: `[Emergency: removed ${cutIndex} older messages to fit context window]`,
			timestamp: Date.now(),
		};
		result = [summary, ...result.slice(cutIndex)];
	}

	currentTokens = estimateTotalTokens(result);
	if (currentTokens <= targetTokens) {
		return result;
	}

	// Step 3: Truncate long text blocks in all messages
	const maxTextChars = 2000;
	result = result.map((msg) => {
		if (msg.role === "assistant") {
			const content = msg.content.map((block) => {
				if (block.type === "text" && block.text.length > maxTextChars) {
					return { ...block, text: `${block.text.slice(0, maxTextChars)}\n... (truncated)` };
				}
				return block;
			});
			return { ...msg, content };
		}
		if (msg.role === "user" && typeof msg.content === "string" && msg.content.length > maxTextChars) {
			return { ...msg, content: `${msg.content.slice(0, maxTextChars)}\n... (truncated)` };
		}
		if (msg.role === "toolResult") {
			const tr = msg as ToolResultMessage;
			const content = tr.content.map((block) => {
				if (block.type === "text" && block.text.length > maxTextChars) {
					return { ...block, text: `${block.text.slice(0, maxTextChars)}\n... (truncated)` };
				}
				return block;
			});
			return { ...tr, content };
		}
		return msg;
	});

	return result;
}
