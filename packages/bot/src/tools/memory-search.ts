/**
 * memory_search tool: BM25 keyword search across all memory files.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { MemoryManager } from "../memory-manager.js";

const memorySearchSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're searching for (shown to user)" }),
	query: Type.String({ description: "Search query (keywords or phrases)" }),
	limit: Type.Optional(Type.Number({ description: "Max results to return (default: 5)" })),
});

export function createMemorySearchTool(
	memoryManager: MemoryManager,
	channelType: string,
	chatId: string,
): AgentTool<typeof memorySearchSchema> {
	return {
		name: "memory_search",
		label: "memory_search",
		description:
			"Search across all memory files (MEMORY.md and daily logs) using keyword matching. " +
			"Use this to find past notes, decisions, or context from previous sessions. " +
			"Returns the most relevant chunks ranked by relevance score.",
		parameters: memorySearchSchema,
		execute: async (
			_toolCallId: string,
			{ query, limit }: { label: string; query: string; limit?: number },
		): Promise<{ content: TextContent[]; details: undefined }> => {
			const results = memoryManager.search(channelType, chatId, query, limit ?? 5);

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: "No matching memory found." }],
					details: undefined,
				};
			}

			const formatted = results
				.map((r, i) => {
					const header = `[${i + 1}] ${r.file}:${r.lineStart} (score: ${r.score.toFixed(2)})`;
					return `${header}\n${r.text}`;
				})
				.join("\n\n---\n\n");

			return {
				content: [{ type: "text", text: formatted }],
				details: undefined,
			};
		},
	};
}
