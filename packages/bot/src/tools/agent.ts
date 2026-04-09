/**
 * Agent tool for spawning sub-agents.
 *
 * Allows the main bot to delegate complex tasks to specialized sub-agents
 * that run their own independent agentic loops.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { SubAgentResult } from "../sub-agent.js";

const agentSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you are delegating (shown to user as status)" }),
	agent_type: Type.String({ description: "Type of sub-agent to spawn" }),
	task: Type.String({
		description:
			"Detailed task description for the sub-agent. Include all necessary context — sub-agents cannot see your conversation history.",
	}),
	run_in_background: Type.Optional(
		Type.Boolean({ description: "If true, run asynchronously and return immediately. Default: false (blocking)." }),
	),
});

export interface AgentToolDependencies {
	/** Available agent type names for validation */
	agentTypeNames: string[];
	/** Execute a synchronous sub-agent (blocks until done) */
	runSync: (agentType: string, task: string, signal?: AbortSignal) => Promise<SubAgentResult>;
	/** Start an async sub-agent (returns task ID immediately) */
	runAsync: (agentType: string, task: string, description: string) => string;
}

export function createAgentTool(deps: AgentToolDependencies): AgentTool<typeof agentSchema> {
	const typeList = deps.agentTypeNames.map((n) => `"${n}"`).join(", ");
	return {
		name: "agent",
		label: "agent",
		description: `Spawn a sub-agent to handle a complex task independently. Available types: ${typeList}. Sub-agents have their own context and tool set. Include all necessary context in the task description.`,
		parameters: agentSchema,
		execute: async (
			_toolCallId: string,
			params: {
				label: string;
				agent_type: string;
				task: string;
				run_in_background?: boolean;
			},
			signal?: AbortSignal,
		) => {
			const { agent_type, task, run_in_background, label } = params;

			// Validate agent type
			if (!deps.agentTypeNames.includes(agent_type)) {
				throw new Error(`Unknown agent type "${agent_type}". Available types: ${typeList}`);
			}

			if (run_in_background) {
				const taskId = deps.runAsync(agent_type, task, label);
				return {
					content: [
						{
							type: "text" as const,
							text: `Async agent started (task ${taskId}, type: ${agent_type}). You will be notified when it completes.`,
						},
					],
					details: { taskId, agentType: agent_type, async: true },
				};
			}

			// Synchronous execution
			const result = await deps.runSync(agent_type, task, signal);

			if (result.success) {
				return {
					content: [
						{
							type: "text" as const,
							text: result.text || "(sub-agent produced no output)",
						},
					],
					details: { agentType: agent_type, turnsUsed: result.turnsUsed, async: false },
				};
			}

			throw new Error(
				`Sub-agent failed: ${result.error || "unknown error"}${result.text ? `\n\nPartial output:\n${result.text}` : ""}`,
			);
		},
	};
}
