/**
 * Level 1: Microcompact — clear old tool result contents.
 *
 * Keeps the most recent N compactable tool results intact,
 * replaces older ones with a placeholder. This preserves the
 * conversation structure (the model knows "I read this file")
 * but removes the actual content to free context space.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import { CLEARED_RESULT_TEXT, COMPACTABLE_TOOLS, MICROCOMPACT_KEEP_RECENT } from "./types.js";

/**
 * Check if a toolResult message has already been cleared.
 */
function isAlreadyCleared(msg: ToolResultMessage): boolean {
	if (msg.content.length === 1 && msg.content[0].type === "text") {
		return msg.content[0].text === CLEARED_RESULT_TEXT;
	}
	return false;
}

/**
 * Clear old tool result contents, keeping the most recent N intact.
 *
 * Only affects tools in COMPACTABLE_TOOLS. Tool results from
 * non-compactable tools (agent, codex, etc.) are never cleared.
 *
 * Returns a new message array (does not mutate input).
 */
export function microcompact(messages: AgentMessage[], keepRecent: number = MICROCOMPACT_KEEP_RECENT): AgentMessage[] {
	// Find all compactable toolResult indices (from end)
	const compactableIndices: number[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "toolResult" && COMPACTABLE_TOOLS.has((msg as ToolResultMessage).toolName)) {
			compactableIndices.push(i);
		}
	}

	// compactableIndices is in reverse order (newest first)
	// Keep the first `keepRecent` indices (newest), clear the rest
	const indicesToClear = new Set(compactableIndices.slice(keepRecent));

	if (indicesToClear.size === 0) {
		return messages; // Nothing to clear
	}

	const result: AgentMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (indicesToClear.has(i) && msg.role === "toolResult") {
			const trMsg = msg as ToolResultMessage;
			if (isAlreadyCleared(trMsg)) {
				result.push(msg); // Already cleared, keep as-is
			} else {
				// Replace content with cleared placeholder
				const cleared: TextContent = { type: "text", text: CLEARED_RESULT_TEXT };
				result.push({ ...trMsg, content: [cleared] });
			}
		} else {
			result.push(msg);
		}
	}

	return result;
}
