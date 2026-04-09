/**
 * Level 3: Context Collapse — fold old conversation segments into summaries.
 *
 * More granular than full compaction: each old segment gets its own
 * independent summary. Recent turns are preserved intact. Summaries
 * are cached in memory so they don't need to be regenerated each turn.
 */

import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import type { Model, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import { COLLAPSE_MAX_TOKENS, COLLAPSE_SYSTEM_PROMPT, estimateMessageTokens, KEEP_RECENT_TURNS } from "./types.js";

type GetApiKeyFn = (provider: string) => Promise<string | undefined> | string | undefined;

/**
 * A segment of consecutive messages that can be collapsed.
 */
interface Segment {
	startIndex: number;
	endIndex: number; // exclusive
	tokens: number;
}

/**
 * In-memory cache for collapsed segment summaries.
 * Key is a hash of the segment's message content.
 */
const collapseCache = new Map<string, string>();

/**
 * Generate a simple hash for a segment to use as cache key.
 */
function segmentKey(messages: AgentMessage[], start: number, end: number): string {
	let key = `${end - start}:`;
	for (let i = start; i < end && i < start + 3; i++) {
		const msg = messages[i];
		if (msg.role === "user") {
			const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
			key += content.slice(0, 100);
		} else if (msg.role === "assistant") {
			for (const block of msg.content) {
				if (block.type === "text") {
					key += block.text.slice(0, 100);
					break;
				}
			}
		}
	}
	return key;
}

/**
 * Serialize a segment of messages into text for the summarization prompt.
 */
function serializeSegment(messages: AgentMessage[], start: number, end: number): string {
	const lines: string[] = [];
	for (let i = start; i < end; i++) {
		const msg = messages[i];
		if (msg.role === "user") {
			const text = typeof msg.content === "string" ? msg.content : "";
			lines.push(`[User]: ${text.slice(0, 1000)}`);
		} else if (msg.role === "assistant") {
			const parts: string[] = [];
			for (const block of msg.content) {
				if (block.type === "text") {
					parts.push(block.text.slice(0, 1000));
				} else if (block.type === "toolCall") {
					parts.push(`[Called tool: ${block.name}]`);
				}
			}
			lines.push(`[Assistant]: ${parts.join(" ")}`);
		} else if (msg.role === "toolResult") {
			const tr = msg as ToolResultMessage;
			const text = tr.content
				.filter((b): b is TextContent => b.type === "text")
				.map((b) => b.text.slice(0, 500))
				.join(" ");
			lines.push(`[Tool result (${tr.toolName})]: ${text}`);
		}
	}
	return lines.join("\n");
}

/**
 * Parse messages into segments, where each segment starts with a user message.
 */
function parseSegments(messages: AgentMessage[]): Segment[] {
	const segments: Segment[] = [];
	let segStart = -1;

	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === "user") {
			if (segStart >= 0) {
				let tokens = 0;
				for (let j = segStart; j < i; j++) {
					tokens += estimateMessageTokens(messages[j]);
				}
				segments.push({ startIndex: segStart, endIndex: i, tokens });
			}
			segStart = i;
		}
	}

	// Last segment
	if (segStart >= 0 && segStart < messages.length) {
		let tokens = 0;
		for (let j = segStart; j < messages.length; j++) {
			tokens += estimateMessageTokens(messages[j]);
		}
		segments.push({ startIndex: segStart, endIndex: messages.length, tokens });
	}

	return segments;
}

/**
 * Generate a summary for a conversation segment using an LLM call.
 */
async function generateSegmentSummary(
	messages: AgentMessage[],
	start: number,
	end: number,
	model: Model<any>,
	streamFn: StreamFn,
	getApiKey: GetApiKeyFn,
): Promise<string> {
	const serialized = serializeSegment(messages, start, end);
	if (!serialized.trim()) {
		return "(empty segment)";
	}

	try {
		const apiKey = await getApiKey(model.api);
		const stream = await streamFn(
			model,
			{
				systemPrompt: COLLAPSE_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: `Summarize this conversation segment:\n\n${serialized}`,
						timestamp: Date.now(),
					},
				],
			},
			{ maxTokens: COLLAPSE_MAX_TOKENS, apiKey },
		);

		const result = await stream.result();
		const text = result.content
			.filter((b): b is TextContent => b.type === "text")
			.map((b) => b.text)
			.join("\n");

		return text.trim() || "(no summary generated)";
	} catch {
		// If LLM call fails, create a basic summary from message types
		const userMsgs = messages.slice(start, end).filter((m) => m.role === "user").length;
		const toolCalls = messages.slice(start, end).filter((m) => m.role === "toolResult").length;
		return `[Collapsed: ${userMsgs} user message(s), ${toolCalls} tool call(s)]`;
	}
}

/**
 * Collapse old conversation segments into summaries.
 *
 * Keeps the most recent KEEP_RECENT_TURNS segments intact.
 * Older segments are replaced with LLM-generated summaries.
 * Summaries are cached to avoid regeneration on subsequent turns.
 *
 * Returns a new message array.
 */
export async function collapseOldSegments(
	messages: AgentMessage[],
	model: Model<any>,
	streamFn: StreamFn,
	getApiKey: GetApiKeyFn,
	keepRecentSegments: number = KEEP_RECENT_TURNS,
): Promise<AgentMessage[]> {
	const segments = parseSegments(messages);

	if (segments.length <= keepRecentSegments) {
		return messages;
	}

	const protectedStart = segments.length - keepRecentSegments;
	const result: AgentMessage[] = [];

	for (let s = 0; s < segments.length; s++) {
		const seg = segments[s];

		if (s >= protectedStart) {
			// Recent segment — keep intact
			for (let i = seg.startIndex; i < seg.endIndex; i++) {
				result.push(messages[i]);
			}
			continue;
		}

		// Old segment — collapse into summary
		const cacheKey = segmentKey(messages, seg.startIndex, seg.endIndex);
		let summary = collapseCache.get(cacheKey);

		if (!summary) {
			summary = await generateSegmentSummary(messages, seg.startIndex, seg.endIndex, model, streamFn, getApiKey);
			collapseCache.set(cacheKey, summary);
		}

		// Replace segment with a single collapsed message
		const collapsed: AgentMessage = {
			role: "user",
			content: `<collapsed>${summary}</collapsed>`,
			timestamp: Date.now(),
		};
		result.push(collapsed);
	}

	return result;
}
