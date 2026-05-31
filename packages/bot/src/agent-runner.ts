/**
 * Agent runner: creates and manages Agent + AgentSession per conversation.
 *
 * Adapted from mom's agent.ts. Each conversation gets its own runner with
 * a cached Agent + AgentSession pair. Events from the session are mapped
 * to channel send/update operations.
 */

import { Agent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import {
	type Api,
	getModels,
	type ImageContent,
	type KnownProvider,
	type Model,
	streamSimple,
} from "@mariozechner/pi-ai";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	createExtensionRuntime,
	formatSkillsForPrompt,
	loadSkillsFromDir,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { mkdir } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { type AgentTypeRegistry, createDefaultAgentTypes, mergeAgentTypeConfig } from "./agent-types.js";
import type { Channel, InboundMessage } from "./channels/types.js";
import type { CodexClient } from "./codex-client.js";
import type { BotConfig } from "./config.js";
import { createTransformContext } from "./context-manager.js";
import type { McpManager } from "./mcp-manager.js";
import { NotificationQueue } from "./notification-queue.js";
import { type Executor, HostExecutor, SandboxExecutor } from "./sandbox.js";
import { createBotSettingsManager, SessionStore } from "./session-store.js";
import { runSubAgent } from "./sub-agent.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createAgentTool } from "./tools/agent.js";
import { createBotTools } from "./tools/index.js";

const IMAGE_MIME_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

function resolveModel(provider: string, modelId: string): Model<Api> {
	const models = getModels(provider as KnownProvider);
	const model = models.find((m) => m.id === modelId || m.name === modelId);
	if (!model) {
		throw new Error(`Model not found: ${provider}/${modelId}. Available: ${models.map((m) => m.id).join(", ")}`);
	}
	return model as Model<Api>;
}

function getImageMimeType(filename: string): string | undefined {
	return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

/** Resolve the package's bundled skills directory (../skills/ relative to dist/) */
const BUILTIN_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

/**
 * Load skills from built-in, global, and conversation-level directories.
 * Each layer overrides the previous on name collision:
 *   built-in < global ({dataDir}/skills/) < conversation ({dataDir}/{channel}/{chatId}/skills/)
 */
function loadBotSkills(dataDir: string, channelType: string, chatId: string): Skill[] {
	const skillMap = new Map<string, Skill>();

	// Built-in skills shipped with the package
	if (existsSync(BUILTIN_SKILLS_DIR)) {
		for (const skill of loadSkillsFromDir({ dir: BUILTIN_SKILLS_DIR, source: "builtin" }).skills) {
			skillMap.set(skill.name, skill);
		}
	}

	// Global skills: {dataDir}/skills/
	const globalSkillsDir = join(dataDir, "skills");
	for (const skill of loadSkillsFromDir({ dir: globalSkillsDir, source: "global" }).skills) {
		skillMap.set(skill.name, skill);
	}

	// Conversation-level skills: {dataDir}/{channelType}/{chatId}/skills/
	const chatSkillsDir = join(dataDir, channelType, chatId, "skills");
	for (const skill of loadSkillsFromDir({ dir: chatSkillsDir, source: "conversation" }).skills) {
		skillMap.set(skill.name, skill);
	}

	return Array.from(skillMap.values());
}

interface RunnerEntry {
	session: AgentSession;
	agent: Agent;
	sessionManager: SessionManager;
}

export class AgentRunner {
	private runners = new Map<string, RunnerEntry>();
	private channels = new Map<string, Channel>();
	private executor: Executor;
	private sessionStore: SessionStore;
	private model: Model<any>;
	private config: BotConfig;
	private mcpManager?: McpManager;
	private codexClient?: CodexClient;
	private agentTypeRegistry: AgentTypeRegistry;
	private sandboxEnabled: boolean;
	private onAsyncNotification?: (channelType: string, chatId: string, text: string) => void;

	constructor(
		config: BotConfig,
		mcpManager?: McpManager,
		codexClient?: CodexClient,
		onAsyncNotification?: (channelType: string, chatId: string, text: string) => void,
		sandboxEnabled?: boolean,
	) {
		this.config = config;
		this.mcpManager = mcpManager;
		this.codexClient = codexClient;
		this.onAsyncNotification = onAsyncNotification;
		this.sandboxEnabled = sandboxEnabled ?? false;
		this.executor = sandboxEnabled ? new SandboxExecutor() : new HostExecutor();
		this.sessionStore = new SessionStore(config.dataDir);
		const model = resolveModel(config.model.provider, config.model.model);
		// Allow overriding base URL (e.g., for China mainland BigModel endpoint)
		if (config.model.baseUrl) {
			this.model = { ...model, baseUrl: config.model.baseUrl };
		} else {
			this.model = model;
		}

		// Initialize agent type registry
		this.agentTypeRegistry = createDefaultAgentTypes();
		if (config.agentTypes) {
			mergeAgentTypeConfig(this.agentTypeRegistry, config.agentTypes);
		}
	}

	/**
	 * Register a channel for outbound messaging.
	 */
	registerChannel(channel: Channel): void {
		this.channels.set(channel.type, channel);
	}

	/**
	 * Process an inbound message from any channel.
	 */
	async processMessage(message: InboundMessage): Promise<void> {
		const channel = this.channels.get(message.channelType);
		if (!channel) {
			console.error(`No channel registered for type: ${message.channelType}`);
			return;
		}

		const runner = this.getOrCreateRunner(message.channelType, message.chatId);

		// Ensure directory exists
		const convDir = this.sessionStore.getConversationDir(message.channelType, message.chatId);
		await mkdir(convDir.root, { recursive: true });

		// Reload messages from context
		const loaded = runner.sessionManager.buildSessionContext();
		if (loaded.messages.length > 0) {
			runner.agent.state.messages = loaded.messages;
		}

		// Pre-compaction flush: save context excerpts to daily log before it gets too large
		const memoryManager = this.sessionStore.getMemoryManager();
		const contextWindow = this.model.contextWindow ?? 200000;
		memoryManager.flushContext(message.channelType, message.chatId, runner.agent.state.messages, contextWindow);

		// Refresh skills and system prompt with current memory
		const memory = this.sessionStore.getMemory(message.channelType, message.chatId);
		const skills = loadBotSkills(this.config.dataDir, message.channelType, message.chatId);
		const skillsText = skills.length > 0 ? formatSkillsForPrompt(skills) : undefined;
		const agentTypes = Array.from(this.agentTypeRegistry.values()).map((t) => ({
			name: t.name,
			description: t.description,
		}));
		const systemPrompt = buildSystemPrompt({
			dataDir: this.config.dataDir,
			channelType: message.channelType,
			chatId: message.chatId,
			memory,
			botName: "bot",
			skillsText,
			codexEnabled: !!this.codexClient?.isRunning,
			agentTypes,
		});
		runner.session.agent.state.systemPrompt = systemPrompt;

		// Build user message with timestamp and sender prefix
		const now = new Date();
		const pad = (n: number) => n.toString().padStart(2, "0");
		const offset = -now.getTimezoneOffset();
		const offsetSign = offset >= 0 ? "+" : "-";
		const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
		const offsetMins = pad(Math.abs(offset) % 60);
		const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
		let userMessage = `[${timestamp}] [${message.senderName}]: ${message.text}`;

		// Handle attachments
		const imageAttachments: ImageContent[] = [];
		const nonImagePaths: string[] = [];

		for (const attachment of message.attachments) {
			const mimeType = getImageMimeType(attachment.filename);
			if (mimeType && existsSync(attachment.localPath)) {
				try {
					imageAttachments.push({
						type: "image",
						mimeType,
						data: readFileSync(attachment.localPath).toString("base64"),
					});
				} catch {
					nonImagePaths.push(attachment.localPath);
				}
			} else {
				nonImagePaths.push(attachment.localPath);
			}
		}

		if (nonImagePaths.length > 0) {
			userMessage += `\n\n<attachments>\n${nonImagePaths.join("\n")}\n</attachments>`;
		}

		// Send "thinking..." indicator
		let statusMessageId: string | undefined;
		try {
			statusMessageId = await channel.send({
				chatId: message.chatId,
				text: "...",
				replyToId: message.id,
			});
		} catch {
			// Non-critical
		}

		// Track response text for final update
		let finalText = "";
		let hasError = false;
		let errorMessage = "";

		// Set up per-run event tracking
		const pendingTools = new Map<string, { toolName: string; startTime: number }>();

		const unsubscribe = runner.session.subscribe((event) => {
			if (event.type === "compaction_start") {
				if (statusMessageId) {
					channel.updateMessage(message.chatId, statusMessageId, "... compacting context").catch(() => {});
				}
			} else if (event.type === "tool_execution_start") {
				const e = event as AgentEvent & { type: "tool_execution_start" };
				const args = e.args as { label?: string };
				const label = args.label || e.toolName;
				pendingTools.set(e.toolCallId, { toolName: e.toolName, startTime: Date.now() });

				// Fire-and-forget status update
				if (statusMessageId) {
					channel.updateMessage(message.chatId, statusMessageId, `... ${label}`).catch(() => {});
				}
			} else if (event.type === "tool_execution_end") {
				const e = event as AgentEvent & { type: "tool_execution_end" };
				pendingTools.delete(e.toolCallId);
			} else if (event.type === "message_end") {
				const e = event as AgentEvent & { type: "message_end" };
				if (e.message.role === "assistant") {
					const assistantMsg = e.message as any;

					if (assistantMsg.stopReason === "error") {
						hasError = true;
						errorMessage = assistantMsg.errorMessage || "Unknown error";
					}

					const content = e.message.content;
					const textParts: string[] = [];
					for (const part of content) {
						if (part.type === "text") {
							textParts.push((part as any).text);
						}
					}

					const text = textParts.join("\n");
					if (text.trim()) {
						finalText = text;
					}
				}
			}
		});

		try {
			await runner.session.prompt(
				userMessage,
				imageAttachments.length > 0 ? { images: imageAttachments } : undefined,
			);
		} catch (err) {
			hasError = true;
			errorMessage = err instanceof Error ? err.message : String(err);
		}

		unsubscribe();

		// Send final response
		if (hasError) {
			const errorText = `Sorry, something went wrong: ${errorMessage}`;
			if (statusMessageId) {
				try {
					await channel.updateMessage(message.chatId, statusMessageId, errorText);
				} catch {
					await channel.send({ chatId: message.chatId, text: errorText });
				}
			} else {
				await channel.send({ chatId: message.chatId, text: errorText });
			}
		} else if (finalText.trim()) {
			if (statusMessageId) {
				try {
					await channel.updateMessage(message.chatId, statusMessageId, finalText);
				} catch {
					await channel.send({ chatId: message.chatId, text: finalText });
				}
			} else {
				await channel.send({ chatId: message.chatId, text: finalText });
			}
		} else {
			// No text response (only tool calls maybe)
			if (statusMessageId) {
				try {
					await channel.updateMessage(message.chatId, statusMessageId, "(done)");
				} catch {
					// Ignore
				}
			}
		}
	}

	private getOrCreateRunner(channelType: string, chatId: string): RunnerEntry {
		const key = `${channelType}:${chatId}`;
		const existing = this.runners.get(key);
		if (existing) return existing;

		const entry = this.createRunner(channelType, chatId);
		this.runners.set(key, entry);
		return entry;
	}

	private createRunner(channelType: string, chatId: string): RunnerEntry {
		const memoryManager = this.sessionStore.getMemoryManager();

		// 1. Create base tools (without agent tool — added after agent is created)
		const botTools = createBotTools({
			executor: this.executor,
			memoryManager,
			channelType,
			chatId,
			codexClient: this.codexClient,
			tavilyApiKey: this.config.tavilyApiKey,
		});
		const mcpTools = this.mcpManager?.getTools() ?? [];
		const tools: AgentTool<any>[] = [...botTools, ...mcpTools];

		const memory = this.sessionStore.getMemory(channelType, chatId);
		const skills = loadBotSkills(this.config.dataDir, channelType, chatId);
		const skillsText = skills.length > 0 ? formatSkillsForPrompt(skills) : undefined;
		const agentTypes = Array.from(this.agentTypeRegistry.values()).map((t) => ({
			name: t.name,
			description: t.description,
		}));

		const systemPrompt = buildSystemPrompt({
			dataDir: this.config.dataDir,
			channelType,
			chatId,
			memory,
			botName: "bot",
			skillsText,
			codexEnabled: !!this.codexClient?.isRunning,
			agentTypes,
			sandboxEnabled: this.sandboxEnabled,
		});

		// Session manager with fixed context.jsonl per conversation
		const convDir = this.sessionStore.getConversationDir(channelType, chatId);
		const sessionManager = SessionManager.open(convDir.contextFile, convDir.root);
		const settingsManager = createBotSettingsManager(this.config.dataDir);

		// Auth storage and model registry
		const authStorage = AuthStorage.create(join(homedir(), ".pi", "bot", "auth.json"));
		if (this.config.model.apiKey) {
			authStorage.setRuntimeApiKey(this.config.model.provider, this.config.model.apiKey);
		}
		const modelRegistry = ModelRegistry.create(authStorage);

		const getApiKey = async (provider: string) => {
			// Config apiKey takes priority
			if (this.config.model.apiKey) {
				return this.config.model.apiKey;
			}
			const key = await authStorage.getApiKey(provider);
			if (!key) {
				throw new Error(`No API key found for ${provider}. Set the appropriate environment variable.`);
			}
			return key;
		};

		// 2. Create context manager (transformContext hook)
		const transformContext = createTransformContext({
			contextWindow: this.model.contextWindow ?? 200_000,
			model: this.model,
			streamFn: streamSimple,
			getApiKey,
		});

		// 3. Create agent (without agent tool yet)
		const agent = new Agent({
			initialState: {
				systemPrompt,
				model: this.model,
				thinkingLevel: this.config.model.thinkingLevel,
				tools,
			},
			convertToLlm,
			transformContext,
			getApiKey,
		});

		// 4. Create notification queue for async sub-agents
		const notificationQueue = this.onAsyncNotification
			? new NotificationQueue(channelType, chatId, this.onAsyncNotification)
			: undefined;

		// 5. Create agent tool (needs agent.streamFn and agent.getApiKey)
		const agentTool = createAgentTool({
			agentTypeNames: Array.from(this.agentTypeRegistry.keys()),
			runSync: async (agentTypeName, task, signal) => {
				const agentType = this.agentTypeRegistry.get(agentTypeName)!;
				const subModel = agentType.modelOverride
					? resolveModel(agentType.modelOverride.provider, agentType.modelOverride.model)
					: this.model;
				return runSubAgent(task, {
					agentType,
					toolPool: [...botTools, ...mcpTools],
					model: subModel,
					streamFn: agent.streamFn,
					getApiKey: agent.getApiKey!,
					convertToLlm,
					parentSignal: signal,
				});
			},
			runAsync: (agentTypeName, task, description) => {
				if (!notificationQueue) {
					throw new Error("Async agents not available (no notification handler configured)");
				}
				const agentType = this.agentTypeRegistry.get(agentTypeName)!;
				const subModel = agentType.modelOverride
					? resolveModel(agentType.modelOverride.provider, agentType.modelOverride.model)
					: this.model;
				return notificationQueue.startAsync(agentTypeName, description, () =>
					runSubAgent(task, {
						agentType,
						toolPool: [...botTools, ...mcpTools],
						model: subModel,
						streamFn: agent.streamFn,
						getApiKey: agent.getApiKey!,
						convertToLlm,
					}),
				);
			},
		});

		// 6. Add agent tool to the tools array and update the agent
		tools.push(agentTool);
		agent.state.tools = tools;

		// Load existing messages
		const loaded = sessionManager.buildSessionContext();
		if (loaded.messages.length > 0) {
			agent.state.messages = loaded.messages;
		}

		// Stub resource loader (same pattern as mom)
		const resourceLoader: ResourceLoader = {
			getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => systemPrompt,
			getAppendSystemPrompt: () => [],
			extendResources: () => {},
			reload: async () => {},
		};

		const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

		// Create AgentSession wrapper
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: process.cwd(),
			modelRegistry,
			resourceLoader,
			baseToolsOverride,
		});

		return { session, agent, sessionManager };
	}
}
