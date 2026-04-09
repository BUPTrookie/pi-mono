/**
 * Tool registry for the bot package.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { CodexClient } from "../codex-client.js";
import type { MemoryManager } from "../memory-manager.js";
import type { Executor } from "../sandbox.js";
import { type AgentToolDependencies, createAgentTool } from "./agent.js";
import { createBashTool } from "./bash.js";
import { createCodexTool } from "./codex.js";
import { createEditTool } from "./edit.js";
import { createMemorySearchTool } from "./memory-search.js";
import { createReadTool } from "./read.js";
import { createWebSearchTool } from "./web-search.js";
import { createWriteTool } from "./write.js";

export type { AgentToolDependencies } from "./agent.js";

export interface BotToolsOptions {
	executor: Executor;
	memoryManager: MemoryManager;
	channelType: string;
	chatId: string;
	codexClient?: CodexClient;
	tavilyApiKey?: string;
	agentToolDeps?: AgentToolDependencies;
}

export function createBotTools(options: BotToolsOptions): AgentTool<any>[] {
	const { executor, memoryManager, channelType, chatId, codexClient, tavilyApiKey, agentToolDeps } = options;
	const tools: AgentTool<any>[] = [
		createReadTool(executor),
		createBashTool(executor),
		createEditTool(executor),
		createWriteTool(executor),
		createMemorySearchTool(memoryManager, channelType, chatId),
		createWebSearchTool(tavilyApiKey),
	];

	if (codexClient) {
		tools.push(createCodexTool(codexClient, channelType, chatId));
	}

	if (agentToolDeps) {
		tools.push(createAgentTool(agentToolDeps));
	}

	return tools;
}
