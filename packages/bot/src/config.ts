/**
 * Configuration types and loading for the bot.
 */

import { existsSync, readFileSync } from "fs";

export interface TelegramConfig {
	/** Bot token from BotFather */
	token: string;
	/** Allowed user IDs (empty = allow all) */
	allowedUsers: string[];
}

export interface ModelConfig {
	/** Provider name (e.g., "anthropic", "openai") */
	provider: string;
	/** Model name (e.g., "claude-sonnet-4-5") */
	model: string;
	/** Thinking level */
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	/** Override the model's base URL (e.g., "https://open.bigmodel.cn/api/paas/v4" for China mainland GLM) */
	baseUrl?: string;
	/** API key (alternative to env var) */
	apiKey?: string;
}

export interface FeishuConfig {
	/** App ID from Feishu Open Platform */
	appId: string;
	/** App Secret from Feishu Open Platform */
	appSecret: string;
	/** Allowed open_id list (empty = allow all) */
	allowedUsers: string[];
	/** Use Lark (international) instead of Feishu (China) */
	useLark?: boolean;
}

export interface McpServerConfig {
	/** Command to start the MCP server */
	command: string;
	/** Arguments to pass to the command */
	args?: string[];
	/** Environment variables for the process */
	env?: Record<string, string>;
}

export interface CodexConfig {
	/** Enable codex app-server integration */
	enabled: boolean;
	/** Codex model (e.g., "o3", "gpt-4.1") */
	model?: string;
	/** Sandbox mode */
	sandbox?: "read-only" | "workspace-write" | "danger-full-access";
	/** Working directory for codex (defaults to process.cwd()) */
	cwd?: string;
}

export interface SandboxConfig {
	/** Enable OS-level sandbox (macOS sandbox-exec / Linux bubblewrap) */
	enabled: boolean;
	/** Network restrictions */
	network?: {
		/** Domains allowed for outbound connections (e.g., "npmjs.org", "*.github.com") */
		allowedDomains?: string[];
		/** Domains explicitly blocked */
		deniedDomains?: string[];
	};
	/** Filesystem restrictions */
	filesystem?: {
		/** Paths denied for reading (e.g., "~/.ssh", "~/.aws") */
		denyRead?: string[];
		/** Paths allowed for writing (e.g., ".", "/tmp") */
		allowWrite?: string[];
		/** Paths denied for writing within allowed areas (e.g., ".env", "*.pem") */
		denyWrite?: string[];
	};
}

export interface AgentTypeConfig {
	/** Human-readable description */
	description?: string;
	/** System prompt override */
	systemPrompt?: string;
	/** Allowed tool names */
	allowedTools?: string[];
	/** Model override */
	model?: { provider: string; model: string };
	/** Thinking level override */
	thinkingLevel?: ModelConfig["thinkingLevel"];
	/** Max turns before forced stop */
	maxTurns?: number;
}

export interface BotConfig {
	/** Data directory for sessions and state */
	dataDir: string;
	/** Model configuration */
	model: ModelConfig;
	/** Telegram configuration (if enabled) */
	telegram?: TelegramConfig;
	/** Feishu configuration (if enabled) */
	feishu?: FeishuConfig;
	/** MCP servers configuration */
	mcpServers?: Record<string, McpServerConfig>;
	/** Codex app-server integration */
	codex?: CodexConfig;
	/** Tavily API key for web search */
	tavilyApiKey?: string;
	/** OS-level sandbox configuration */
	sandbox?: SandboxConfig;
	/** Custom agent type definitions (merged with built-in types) */
	agentTypes?: Record<string, AgentTypeConfig>;
}

const DEFAULT_CONFIG: BotConfig = {
	dataDir: "~/.bot/data",
	model: {
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		thinkingLevel: "off",
	},
};

/**
 * Resolve ~ to home directory and environment variables in a string.
 */
function resolveValue(value: string): string {
	// Resolve ~
	if (value.startsWith("~")) {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		value = home + value.slice(1);
	}

	// Resolve ${ENV_VAR} patterns
	value = value.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
		return process.env[name] || "";
	});

	return value;
}

/**
 * Deep resolve environment variables in config values.
 */
function resolveConfig(obj: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (typeof value === "string") {
			result[key] = resolveValue(value);
		} else if (value && typeof value === "object" && !Array.isArray(value)) {
			result[key] = resolveConfig(value as Record<string, unknown>);
		} else if (Array.isArray(value)) {
			result[key] = value.map((item) => (typeof item === "string" ? resolveValue(item) : item));
		} else {
			result[key] = value;
		}
	}
	return result;
}

export function loadConfig(configPath?: string): BotConfig {
	if (!configPath) {
		return { ...DEFAULT_CONFIG, dataDir: resolveValue(DEFAULT_CONFIG.dataDir) };
	}

	if (!existsSync(configPath)) {
		throw new Error(`Config file not found: ${configPath}`);
	}

	const raw = JSON.parse(readFileSync(configPath, "utf-8"));
	const resolved = resolveConfig(raw) as unknown as BotConfig;

	return {
		...DEFAULT_CONFIG,
		...resolved,
		model: { ...DEFAULT_CONFIG.model, ...(resolved.model || {}) },
	};
}
