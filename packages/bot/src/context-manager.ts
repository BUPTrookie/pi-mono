/**
 * Context manager — orchestrates the multi-level context compression pipeline.
 *
 * Implements a `transformContext` function that runs before every LLM call,
 * progressively applying compression levels as context pressure increases:
 *
 *   Level 0: Tool result budget (per-message aggregate limit)
 *   Level 1: Microcompact (clear old tool results at 60% threshold)
 *   Level 2: Snip (remove cleared turns at 70% threshold)
 *   Level 3: Collapse (fold old segments into summaries at 80% threshold)
 *   Level 4: AutoCompact (handled by AgentSession, ~90% threshold)
 *   Level 5: Emergency truncate (last resort if still over budget)
 *
 * Each level only triggers if the previous levels haven't reduced
 * context below its threshold.
 */

import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { collapseOldSegments } from "./context-manager/collapse.js";
import { microcompact } from "./context-manager/microcompact.js";
import { emergencyTruncate } from "./context-manager/reactive-compact.js";
import { snipMessages } from "./context-manager/snip.js";
import { enforceMessageBudget } from "./context-manager/tool-result-budget.js";
import {
	estimateTotalTokens,
	THRESHOLD_COLLAPSE,
	THRESHOLD_MICROCOMPACT,
	THRESHOLD_SNIP,
} from "./context-manager/types.js";

type GetApiKeyFn = (provider: string) => Promise<string | undefined> | string | undefined;

export interface ContextManagerConfig {
	/** Model's context window size in tokens */
	contextWindow: number;
	/** Model used for collapse summaries */
	model: Model<any>;
	/** Stream function for LLM calls */
	streamFn: StreamFn;
	/** API key resolver */
	getApiKey: GetApiKeyFn;
}

/**
 * Create a `transformContext` function configured for the given context window.
 *
 * The returned function is called by the agent loop before every LLM call.
 * It progressively applies compression levels based on context pressure.
 */
export function createTransformContext(
	config: ContextManagerConfig,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
	const { contextWindow, model, streamFn, getApiKey } = config;

	return async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
		if (messages.length === 0) return messages;

		// Step 0: Enforce per-message aggregate budget
		let result = enforceMessageBudget(messages);

		// Estimate current token usage
		let tokens = estimateTotalTokens(result);

		// Step 1: Microcompact at 60% threshold
		if (tokens > contextWindow * THRESHOLD_MICROCOMPACT) {
			result = microcompact(result);
			tokens = estimateTotalTokens(result);
		}

		// Step 2: Snip at 70% threshold
		if (tokens > contextWindow * THRESHOLD_SNIP) {
			const snipped = snipMessages(result);
			result = snipped.messages;
			if (snipped.tokensFreed > 0) {
				tokens = estimateTotalTokens(result);
			}
		}

		// Step 3: Collapse at 80% threshold
		if (tokens > contextWindow * THRESHOLD_COLLAPSE) {
			// Check abort before expensive LLM calls
			if (!signal?.aborted) {
				result = await collapseOldSegments(result, model, streamFn, getApiKey);
				tokens = estimateTotalTokens(result);
			}
		}

		// Step 5: Emergency truncate if still way over
		// (Level 4 AutoCompact is handled by AgentSession after the loop)
		// Use 95% as emergency threshold — beyond what AgentSession's compaction handles
		if (tokens > contextWindow * 0.95) {
			const target = Math.floor(contextWindow * 0.85);
			result = emergencyTruncate(result, target);
		}

		return result;
	};
}
