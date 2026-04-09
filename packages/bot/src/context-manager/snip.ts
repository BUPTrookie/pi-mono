/**
 * Level 2: Snip — surgical removal of old conversation turns.
 *
 * Identifies "turns" (user message + assistant reply + tool results)
 * where all tool results have already been cleared by microcompact,
 * and removes the entire turn. This is more aggressive than microcompact
 * but less destructive than full compaction.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { CLEARED_RESULT_TEXT, estimateMessageTokens, KEEP_RECENT_TURNS } from "./types.js";

/**
 * A "turn" is a user message followed by an assistant message
 * and any tool results that belong to that assistant's tool calls.
 */
interface Turn {
	startIndex: number;
	endIndex: number; // exclusive
	tokens: number;
	allToolResultsCleared: boolean;
}

/**
 * Parse messages into turns.
 */
function parseTurns(messages: AgentMessage[]): Turn[] {
	const turns: Turn[] = [];
	let i = 0;

	while (i < messages.length) {
		const msg = messages[i];

		if (msg.role === "user") {
			const startIndex = i;
			let tokens = estimateMessageTokens(msg);
			i++;

			// Consume assistant message if present
			if (i < messages.length && messages[i].role === "assistant") {
				tokens += estimateMessageTokens(messages[i]);
				i++;

				// Consume all following toolResult messages
				let allCleared = true;
				let hasToolResults = false;
				while (i < messages.length && messages[i].role === "toolResult") {
					tokens += estimateMessageTokens(messages[i]);
					const tr = messages[i] as ToolResultMessage;
					hasToolResults = true;
					if (
						tr.content.length !== 1 ||
						tr.content[0].type !== "text" ||
						tr.content[0].text !== CLEARED_RESULT_TEXT
					) {
						allCleared = false;
					}
					i++;
				}

				turns.push({
					startIndex,
					endIndex: i,
					tokens,
					allToolResultsCleared: hasToolResults && allCleared,
				});
			} else {
				// User message without assistant response — keep it
				turns.push({
					startIndex,
					endIndex: i,
					tokens,
					allToolResultsCleared: false,
				});
			}
		} else {
			// Orphan assistant or toolResult (shouldn't happen in normal flow)
			// Treat as a single-message turn, not snippable
			turns.push({
				startIndex: i,
				endIndex: i + 1,
				tokens: estimateMessageTokens(msg),
				allToolResultsCleared: false,
			});
			i++;
		}
	}

	return turns;
}

/**
 * Snip old turns that have all tool results cleared.
 *
 * Keeps the most recent KEEP_RECENT_TURNS turns intact regardless.
 * For older turns where all tool results have been cleared by microcompact,
 * removes the entire turn and replaces the snipped region with a placeholder.
 *
 * Returns a new message array and the number of tokens freed.
 */
export function snipMessages(
	messages: AgentMessage[],
	keepRecentTurns: number = KEEP_RECENT_TURNS,
): { messages: AgentMessage[]; tokensFreed: number } {
	const turns = parseTurns(messages);

	if (turns.length <= keepRecentTurns) {
		return { messages, tokensFreed: 0 };
	}

	// Identify turns to snip (older than keepRecentTurns, all tool results cleared)
	const protectedStart = turns.length - keepRecentTurns;
	const snipIndices = new Set<number>();
	let tokensFreed = 0;

	for (let t = 0; t < protectedStart; t++) {
		if (turns[t].allToolResultsCleared) {
			snipIndices.add(t);
			tokensFreed += turns[t].tokens;
		}
	}

	if (snipIndices.size === 0) {
		return { messages, tokensFreed: 0 };
	}

	// Build new message array, replacing snipped turns with a placeholder
	const result: AgentMessage[] = [];
	let snipCount = 0;
	let snipTokens = 0;
	let inSnipRun = false;

	for (let t = 0; t < turns.length; t++) {
		const turn = turns[t];

		if (snipIndices.has(t)) {
			snipCount++;
			snipTokens += turn.tokens;
			inSnipRun = true;
		} else {
			// Emit placeholder for accumulated snipped turns
			if (inSnipRun) {
				const placeholder: AgentMessage = {
					role: "user",
					content: `[Removed ${snipCount} old conversation turn(s), ~${Math.round(snipTokens / 1000)}K tokens]`,
					timestamp: Date.now(),
				};
				result.push(placeholder);
				snipCount = 0;
				snipTokens = 0;
				inSnipRun = false;
			}
			// Copy all messages from this turn
			for (let i = turn.startIndex; i < turn.endIndex; i++) {
				result.push(messages[i]);
			}
		}
	}

	// Trailing snip run (unlikely but handle it)
	if (inSnipRun) {
		const placeholder: AgentMessage = {
			role: "user",
			content: `[Removed ${snipCount} old conversation turn(s), ~${Math.round(snipTokens / 1000)}K tokens]`,
			timestamp: Date.now(),
		};
		result.push(placeholder);
	}

	return { messages: result, tokensFreed };
}
