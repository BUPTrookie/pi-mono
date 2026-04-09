/**
 * Level 0: Tool result budget enforcement.
 *
 * Two controls:
 * 1. Per-result limit: individual tool results are truncated based on tool type
 * 2. Per-message aggregate budget: total tool results in one message capped
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import {
	DEFAULT_SINGLE_RESULT_LIMIT,
	getTextContentLength,
	MAX_RESULTS_PER_MESSAGE_CHARS,
	TOOL_RESULT_LIMITS,
	TRUNCATED_PREVIEW_CHARS,
} from "./types.js";

/**
 * Truncate a single text content block to a character limit.
 * Returns a preview with a truncation notice.
 */
function truncateTextContent(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const preview = text.slice(0, TRUNCATED_PREVIEW_CHARS);
	return `${preview}\n\n... (result truncated, original was ${text.length} chars)`;
}

/**
 * Enforce per-result character limit on tool result content.
 * Returns new content array (or original if no truncation needed).
 */
export function enforceToolResultLimit(
	toolName: string,
	content: (TextContent | ImageContent)[],
): (TextContent | ImageContent)[] {
	const limit = TOOL_RESULT_LIMITS[toolName] ?? DEFAULT_SINGLE_RESULT_LIMIT;
	if (limit === Number.POSITIVE_INFINITY) return content;

	const totalChars = getTextContentLength(content);
	if (totalChars <= limit) return content;

	// Truncate — merge all text into one block and truncate
	const allText = content
		.filter((b): b is TextContent => b.type === "text")
		.map((b) => b.text)
		.join("\n");

	const truncated = truncateTextContent(allText, limit);
	// Keep non-text blocks (images), replace text with truncated version
	const nonText = content.filter((b) => b.type !== "text");
	return [{ type: "text", text: truncated }, ...nonText];
}

/**
 * Enforce per-message aggregate budget on tool results.
 *
 * Scans all messages, and for any message containing multiple tool results
 * where the total exceeds MAX_RESULTS_PER_MESSAGE_CHARS, truncates the
 * largest results first until under budget.
 *
 * Returns a new message array (does not mutate input).
 */
export function enforceMessageBudget(messages: AgentMessage[]): AgentMessage[] {
	const result: AgentMessage[] = [];

	// Group consecutive toolResult messages (they belong to the same assistant turn)
	let i = 0;
	while (i < messages.length) {
		const msg = messages[i];
		if (msg.role !== "toolResult") {
			result.push(msg);
			i++;
			continue;
		}

		// Collect all consecutive toolResult messages
		const toolResults: ToolResultMessage[] = [];
		while (i < messages.length && messages[i].role === "toolResult") {
			toolResults.push(messages[i] as ToolResultMessage);
			i++;
		}

		// Calculate total chars across this batch
		const sizes = toolResults.map((tr) => ({
			msg: tr,
			chars: getTextContentLength(tr.content),
			toolName: tr.toolName,
		}));

		const totalChars = sizes.reduce((sum, s) => sum + s.chars, 0);

		if (totalChars <= MAX_RESULTS_PER_MESSAGE_CHARS) {
			// Under budget — keep all as-is
			for (const tr of toolResults) {
				result.push(tr);
			}
			continue;
		}

		// Over budget — truncate largest results first (skip read tools)
		const sortedBySize = [...sizes]
			.filter((s) => (TOOL_RESULT_LIMITS[s.toolName] ?? DEFAULT_SINGLE_RESULT_LIMIT) !== Number.POSITIVE_INFINITY)
			.sort((a, b) => b.chars - a.chars);

		const truncatedSet = new Set<ToolResultMessage>();
		let currentTotal = totalChars;

		for (const entry of sortedBySize) {
			if (currentTotal <= MAX_RESULTS_PER_MESSAGE_CHARS) break;
			const savings = entry.chars - TRUNCATED_PREVIEW_CHARS - 60; // ~60 chars for truncation notice
			if (savings <= 0) continue;
			truncatedSet.add(entry.msg);
			currentTotal -= savings;
		}

		for (const tr of toolResults) {
			if (truncatedSet.has(tr)) {
				const allText = tr.content
					.filter((b): b is TextContent => b.type === "text")
					.map((b) => b.text)
					.join("\n");
				const truncated = truncateTextContent(allText, TRUNCATED_PREVIEW_CHARS);
				const newContent: (TextContent | ImageContent)[] = [
					{ type: "text", text: truncated },
					...tr.content.filter((b) => b.type !== "text"),
				];
				result.push({ ...tr, content: newContent });
			} else {
				result.push(tr);
			}
		}
	}

	return result;
}
