#!/usr/bin/env node

/**
 * Bot CLI entry point.
 *
 * Usage:
 *   bot --cli                     # CLI mode (stdin/stdout)
 *   bot --config config.json      # Gateway mode (Telegram, etc.)
 *
 * Options:
 *   --cli               Run in CLI mode for development/testing
 *   --config <path>     Path to config file
 *   --model <model>     Model name (default: claude-sonnet-4-5)
 *   --provider <name>   Provider name (default: anthropic)
 *   --data-dir <path>   Data directory (default: ~/.bot/data)
 */

import { mkdirSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { AgentRunner } from "./agent-runner.js";
import { CliChannel } from "./channels/cli.js";
import { FeishuChannel } from "./channels/feishu.js";
import { TelegramChannel } from "./channels/telegram.js";
import { CodexClient } from "./codex-client.js";
import type { BotConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { EventsWatcher } from "./events-watcher.js";
import { McpManager } from "./mcp-manager.js";
import { MessageBus } from "./message-bus.js";

function parseArgs(args: string[]): {
	cli: boolean;
	configPath?: string;
	model?: string;
	provider?: string;
	dataDir?: string;
	baseUrl?: string;
	apiKey?: string;
} {
	const result: ReturnType<typeof parseArgs> = { cli: false };

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--cli") {
			result.cli = true;
		} else if (arg === "--config" && i + 1 < args.length) {
			result.configPath = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			result.model = args[++i];
		} else if (arg === "--provider" && i + 1 < args.length) {
			result.provider = args[++i];
		} else if (arg === "--data-dir" && i + 1 < args.length) {
			result.dataDir = args[++i];
		} else if (arg === "--base-url" && i + 1 < args.length) {
			result.baseUrl = args[++i];
		} else if (arg === "--api-key" && i + 1 < args.length) {
			result.apiKey = args[++i];
		}
	}

	return result;
}

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2));

	if (!parsed.cli && !parsed.configPath) {
		console.error("Usage: bot --cli | bot --config <path>");
		console.error("");
		console.error("Options:");
		console.error("  --cli               CLI mode (stdin/stdout)");
		console.error("  --config <path>     Config file path");
		console.error("  --model <model>     Model name (default: claude-sonnet-4-5)");
		console.error("  --provider <name>   Provider name (default: anthropic)");
		console.error("  --data-dir <path>   Data directory (default: ~/.bot/data)");
		console.error("  --base-url <url>    Override model base URL");
		console.error("  --api-key <key>     API key (alternative to env var)");
		process.exit(1);
	}

	// Build config
	let config: BotConfig;

	if (parsed.configPath) {
		config = loadConfig(parsed.configPath);
	} else {
		const home = homedir();
		config = {
			dataDir: resolve(parsed.dataDir || `${home}/.bot/data`),
			model: {
				provider: parsed.provider || "anthropic",
				model: parsed.model || "claude-sonnet-4-5",
				thinkingLevel: "off",
			},
		};
	}

	// CLI overrides
	if (parsed.model) config.model.model = parsed.model;
	if (parsed.provider) config.model.provider = parsed.provider;
	if (parsed.dataDir) config.dataDir = resolve(parsed.dataDir);
	if (parsed.baseUrl) config.model.baseUrl = parsed.baseUrl;
	if (parsed.apiKey) config.model.apiKey = parsed.apiKey;

	// Ensure data directory exists
	mkdirSync(config.dataDir, { recursive: true });

	console.log(`Data directory: ${config.dataDir}`);
	console.log(`Model: ${config.model.provider}/${config.model.model}`);
	console.log(`Base URL: ${config.model.baseUrl || "(default)"}`);
	console.log(`API key: ${config.model.apiKey ? "***configured***" : "(not set)"}`);

	// Start MCP servers if configured
	let mcpManager: McpManager | undefined;
	if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
		mcpManager = new McpManager(config.mcpServers);
		await mcpManager.start();
	}

	// Start codex client if configured
	let codexClient: CodexClient | undefined;
	if (config.codex?.enabled) {
		codexClient = new CodexClient({
			cwd: config.codex.cwd || process.cwd(),
			model: config.codex.model,
			sandbox: config.codex.sandbox || "workspace-write",
		});
		try {
			await codexClient.start();
			console.log("Codex app-server started");
		} catch (err) {
			console.error("Failed to start codex app-server:", err instanceof Error ? err.message : err);
			codexClient = undefined;
		}
	}

	// Create core components
	const bus = new MessageBus();
	const runner = new AgentRunner(config, mcpManager, codexClient, (channelType, chatId, text) => {
		bus.enqueueMessage({
			id: `async-agent-${Date.now()}`,
			channelType,
			chatId,
			senderId: "ASYNC-AGENT",
			senderName: "ASYNC-AGENT",
			text,
			timestamp: Date.now(),
			attachments: [],
		});
	});

	// Start events watcher
	const eventsDir = join(config.dataDir, "events");
	const eventsWatcher = new EventsWatcher(eventsDir, (channelType, chatId, text) => {
		bus.enqueueMessage({
			id: `event-${Date.now()}`,
			channelType,
			chatId,
			senderId: "EVENT",
			senderName: "EVENT",
			text,
			timestamp: Date.now(),
			attachments: [],
		});
	});
	eventsWatcher.start();

	// Set up channels
	if (parsed.cli) {
		const cliChannel = new CliChannel();
		runner.registerChannel(cliChannel);
		bus.registerChannel(cliChannel);
		bus.setProcessor((message) => runner.processMessage(message));
		await cliChannel.start();
	} else {
		// Gateway mode - start configured channels
		bus.setProcessor((message) => runner.processMessage(message));
		let hasChannel = false;

		if (config.telegram) {
			const telegramChannel = new TelegramChannel({
				token: config.telegram.token,
				allowedUsers: config.telegram.allowedUsers,
				attachmentsDir: resolve(config.dataDir, "telegram", "_attachments"),
			});
			runner.registerChannel(telegramChannel);
			bus.registerChannel(telegramChannel);
			await telegramChannel.start();
			console.log("Telegram channel started");
			hasChannel = true;
		}

		if (config.feishu) {
			const feishuChannel = new FeishuChannel({
				appId: config.feishu.appId,
				appSecret: config.feishu.appSecret,
				allowedUsers: config.feishu.allowedUsers,
				attachmentsDir: resolve(config.dataDir, "feishu", "_attachments"),
				useLark: config.feishu.useLark,
			});
			runner.registerChannel(feishuChannel);
			bus.registerChannel(feishuChannel);
			await feishuChannel.start();
			console.log("Feishu channel started");
			hasChannel = true;
		}

		if (!hasChannel) {
			console.error("No channels configured. Add telegram/feishu config or use --cli.");
			process.exit(1);
		}
	}

	// Handle graceful shutdown
	const shutdown = async () => {
		console.log("\nShutting down...");
		eventsWatcher.stop();
		if (codexClient) {
			await codexClient.stop();
		}
		if (mcpManager) {
			await mcpManager.stop();
		}
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
