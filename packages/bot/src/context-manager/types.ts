/**
 * Shared types and constants for the context management system.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";

// ============================================================================
// Token estimation (chars/4 heuristic, matching coding-agent's estimateTokens)
// ============================================================================

/**
 * Estimate token count for a single message.
 * Uses chars/4 heuristic (conservative, overestimates).
 */
export function estimateMessageTokens(message: AgentMessage): number {
	let chars = 0;

	if (message.role === "user") {
		const content = message.content as string | Array<{ type: string; text?: string; data?: string }>;
		if (typeof content === "string") {
			chars = content.length;
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (block.type === "text" && block.text) {
					chars += block.text.length;
				} else if (block.type === "image") {
					chars += 4800; // ~1200 tokens * 4 chars/token
				}
			}
		}
	} else if (message.role === "assistant") {
		for (const block of message.content) {
			if (block.type === "text") {
				chars += block.text.length;
			} else if (block.type === "thinking") {
				chars += block.thinking.length;
			} else if (block.type === "toolCall") {
				chars += JSON.stringify(block.arguments).length + (block.name?.length ?? 0);
			}
		}
	} else if (message.role === "toolResult") {
		for (const block of message.content) {
			if (block.type === "text") {
				chars += block.text.length;
			} else if (block.type === "image") {
				chars += 4800;
			}
		}
	}

	return Math.ceil(chars / 4);
}

/**
 * Estimate total tokens for a message array.
 */
export function estimateTotalTokens(messages: AgentMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		total += estimateMessageTokens(msg);
	}
	return total;
}

// ============================================================================
// Content helpers
// ============================================================================

/**
 * Get the total character count of text content blocks.
 */
export function getTextContentLength(content: (TextContent | ImageContent)[]): number {
	let len = 0;
	for (const block of content) {
		if (block.type === "text") {
			len += block.text.length;
		}
	}
	return len;
}

// ============================================================================
// Constants
// ============================================================================

/** Thresholds as fractions of contextWindow */
export const THRESHOLD_MICROCOMPACT = 0.6;
export const THRESHOLD_SNIP = 0.7;
export const THRESHOLD_COLLAPSE = 0.8;

/** Tools whose results can be cleared by microcompact */
export const COMPACTABLE_TOOLS = new Set(["bash", "read", "write", "edit", "web_search", "memory_search"]);

/** Number of recent compactable tool results to keep intact */
export const MICROCOMPACT_KEEP_RECENT = 5;

/** Max characters for a single tool result (read excluded) */
export const TOOL_RESULT_LIMITS: Record<string, number> = {
	bash: 30_000,
	read: Number.POSITIVE_INFINITY,
	web_search: 30_000,
	edit: 50_000,
	write: 50_000,
	agent: 50_000,
	memory_search: 30_000,
};

/** Default single result limit for unlisted tools */
export const DEFAULT_SINGLE_RESULT_LIMIT = 50_000;

/** Max total characters for all tool results in a single message */
export const MAX_RESULTS_PER_MESSAGE_CHARS = 150_000;

/** Preview length when truncating a result */
export const TRUNCATED_PREVIEW_CHARS = 2000;

/** Number of recent turns to keep intact (not snipped or collapsed) */
export const KEEP_RECENT_TURNS = 5;

/** Placeholder texts */
export const CLEARED_RESULT_TEXT = "[Old tool result content cleared]";
export const TRUNCATED_RESULT_SUFFIX = "\n\n... (result truncated, original was {size} chars)";

/** Collapse summary prompt */
export const COLLAPSE_SYSTEM_PROMPT = `You are a conversation summarizer. Given a segment of conversation between a user and an assistant, produce a concise summary that preserves:
- What the user asked for
- What actions were taken (tools called, files read/modified)
- Key results and decisions
- Any errors encountered and how they were resolved

Be concise but preserve all actionable details. Respond with just the summary text, no XML tags or formatting.
Match the user's language (if Chinese, summarize in Chinese; if English, in English).`;

export const COLLAPSE_MAX_TOKENS = 500;
