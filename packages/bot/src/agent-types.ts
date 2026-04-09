/**
 * Agent type registry for sub-agent definitions.
 *
 * Each agent type defines a system prompt, allowed tools, and execution limits
 * for a specialized sub-agent that the main bot can spawn.
 */

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

export interface AgentTypeDefinition {
	/** Unique identifier for this agent type */
	name: string;
	/** Human-readable description (shown to the LLM in tool docs) */
	description: string;
	/** System prompt for this agent type */
	systemPrompt: string;
	/** Allowed tool names. undefined = all tools (minus "agent"). */
	allowedTools?: string[];
	/** Model override. If undefined, uses parent's model. */
	modelOverride?: { provider: string; model: string };
	/** Thinking level override */
	thinkingLevelOverride?: ThinkingLevel;
	/** Maximum turns before forced stop. Default: 20 */
	maxTurns?: number;
}

export type AgentTypeRegistry = Map<string, AgentTypeDefinition>;

/**
 * Create the default set of built-in agent types.
 */
export function createDefaultAgentTypes(): AgentTypeRegistry {
	const registry: AgentTypeRegistry = new Map();

	registry.set("researcher", {
		name: "researcher",
		description: "Searches the web and memory, reads files, gathers and summarizes information",
		systemPrompt: `You are a research assistant. Your job is to find information and return a clear, structured summary.

Rules:
- Search thoroughly before answering. Use web_search for current information, memory_search for past context.
- Use bash for quick lookups (date, calculations, file listing).
- Use read to inspect file contents when needed.
- Return a concise, well-organized summary of your findings.
- If you cannot find the answer, say so clearly instead of guessing.
- Match the user's language (Chinese/English).`,
		allowedTools: ["web_search", "memory_search", "read", "bash"],
		maxTurns: 10,
	});

	registry.set("writer", {
		name: "writer",
		description: "Reads, writes, and edits files based on detailed instructions",
		systemPrompt: `You are a writing assistant. Your job is to create or modify files based on the instructions given.

Rules:
- Read existing files before modifying them to understand context.
- Make precise, minimal changes. Do not modify content the user did not ask about.
- Use edit for surgical changes, write for new files or full rewrites.
- Use bash for file operations (mkdir, mv, etc.) when needed.
- When done, briefly describe what you changed.
- Match the user's language (Chinese/English).`,
		allowedTools: ["read", "write", "edit", "bash"],
		maxTurns: 15,
	});

	registry.set("general", {
		name: "general",
		description: "General-purpose sub-agent with access to all tools for complex multi-step tasks",
		systemPrompt: `You are a general-purpose assistant handling a delegated task. Complete it thoroughly using whatever tools are needed.

Rules:
- Be thorough but efficient. Use the right tool for each step.
- Search before guessing at facts (web_search for current info, memory_search for past context).
- Read files before modifying them.
- When done, provide a clear summary of what you accomplished.
- Match the user's language (Chinese/English).`,
		maxTurns: 20,
	});

	return registry;
}

/**
 * Merge user-defined agent type overrides from config into the registry.
 */
export function mergeAgentTypeConfig(
	registry: AgentTypeRegistry,
	configTypes: Record<string, Partial<Omit<AgentTypeDefinition, "name">>>,
): void {
	for (const [name, overrides] of Object.entries(configTypes)) {
		const existing = registry.get(name);
		if (existing) {
			// Merge overrides into existing definition
			registry.set(name, { ...existing, ...overrides, name });
		} else {
			// New type from config — requires at least description and systemPrompt
			if (!overrides.description || !overrides.systemPrompt) {
				console.warn(
					`Agent type "${name}" in config missing required fields (description, systemPrompt), skipping`,
				);
				continue;
			}
			registry.set(name, {
				name,
				description: overrides.description,
				systemPrompt: overrides.systemPrompt,
				allowedTools: overrides.allowedTools,
				modelOverride: overrides.modelOverride,
				thinkingLevelOverride: overrides.thinkingLevelOverride,
				maxTurns: overrides.maxTurns,
			});
		}
	}
}
