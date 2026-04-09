/**
 * Session store manages per-conversation directories and SessionManager instances.
 *
 * Directory structure:
 *   {dataDir}/{channelType}/{chatId}/
 *     context.jsonl   -- SessionManager data (LLM context)
 *     MEMORY.md       -- Long-term memory
 *     attachments/    -- Downloaded files
 *     scratch/        -- Agent working directory
 */

import { SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { MemoryManager } from "./memory-manager.js";

export interface ConversationDir {
	/** Root directory for this conversation */
	root: string;
	/** Path to context.jsonl */
	contextFile: string;
	/** Path to MEMORY.md */
	memoryFile: string;
	/** Path to attachments directory */
	attachmentsDir: string;
	/** Path to scratch directory */
	scratchDir: string;
}

export class SessionStore {
	private memoryManager: MemoryManager;

	constructor(private dataDir: string) {
		this.memoryManager = new MemoryManager(dataDir);
	}

	/** Get the MemoryManager instance. */
	getMemoryManager(): MemoryManager {
		return this.memoryManager;
	}

	/**
	 * Get or create directory structure for a conversation.
	 */
	getConversationDir(channelType: string, chatId: string): ConversationDir {
		const root = join(this.dataDir, channelType, chatId);
		mkdirSync(root, { recursive: true });

		const attachmentsDir = join(root, "attachments");
		mkdirSync(attachmentsDir, { recursive: true });

		const scratchDir = join(root, "scratch");
		mkdirSync(scratchDir, { recursive: true });

		return {
			root,
			contextFile: join(root, "context.jsonl"),
			memoryFile: join(root, "MEMORY.md"),
			attachmentsDir,
			scratchDir,
		};
	}

	/**
	 * Open a SessionManager for a conversation.
	 */
	openSessionManager(channelType: string, chatId: string): SessionManager {
		const dir = this.getConversationDir(channelType, chatId);
		return SessionManager.open(dir.contextFile, dir.root);
	}

	/**
	 * Read memory for a conversation.
	 * Delegates to MemoryManager which returns MEMORY.md (global + conversation)
	 * plus today's daily log (capped to last 2KB).
	 */
	getMemory(channelType: string, chatId: string): string {
		return this.memoryManager.getSystemPromptMemory(channelType, chatId);
	}
}

/**
 * Create a SettingsManager backed by a workspace settings.json file.
 * Adapted from mom's context.ts.
 */
type BotSettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];

class WorkspaceSettingsStorage implements BotSettingsStorage {
	private settingsPath: string;

	constructor(dataDir: string) {
		this.settingsPath = join(dataDir, "settings.json");
	}

	withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void {
		if (scope === "project") {
			fn(undefined);
			return;
		}

		const current = existsSync(this.settingsPath) ? readFileSync(this.settingsPath, "utf-8") : undefined;
		const next = fn(current);
		if (next === undefined) {
			return;
		}

		const dir = dirname(this.settingsPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(this.settingsPath, next, "utf-8");
	}
}

export function createBotSettingsManager(dataDir: string): SettingsManager {
	return SettingsManager.fromStorage(new WorkspaceSettingsStorage(dataDir));
}
