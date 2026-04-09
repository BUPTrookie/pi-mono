/**
 * Telegram channel implementation using grammy.
 *
 * Handles text messages, photos, documents.
 * Long messages are split at 4096 chars (Telegram's limit).
 */

import { mkdirSync, writeFileSync } from "fs";
import { Bot } from "grammy";
import { join } from "path";
import { BaseChannel } from "./base-channel.js";
import type { Attachment, Channel, OutboundMessage } from "./types.js";

const TELEGRAM_MAX_LENGTH = 4096;

export interface TelegramChannelOptions {
	token: string;
	allowedUsers: string[];
	attachmentsDir: string;
}

export class TelegramChannel extends BaseChannel implements Channel {
	readonly type = "telegram";
	private bot: Bot;
	private allowedUsers: Set<string>;
	private attachmentsDir: string;

	constructor(options: TelegramChannelOptions) {
		super();
		this.bot = new Bot(options.token);
		this.allowedUsers = new Set(options.allowedUsers);
		this.attachmentsDir = options.attachmentsDir;
		mkdirSync(this.attachmentsDir, { recursive: true });
	}

	async start(): Promise<void> {
		// Handle text messages
		this.bot.on("message:text", async (ctx) => {
			if (!this.isAllowed(ctx.from.id.toString())) {
				await ctx.reply("You are not authorized to use this bot.");
				return;
			}

			this.emit({
				id: ctx.message.message_id.toString(),
				channelType: "telegram",
				chatId: ctx.chat.id.toString(),
				senderId: ctx.from.id.toString(),
				senderName: ctx.from.first_name || ctx.from.username || "unknown",
				text: ctx.message.text,
				timestamp: ctx.message.date * 1000,
				attachments: [],
			});
		});

		// Handle photos
		this.bot.on("message:photo", async (ctx) => {
			if (!this.isAllowed(ctx.from.id.toString())) return;

			const photos = ctx.message.photo;
			if (!photos || photos.length === 0) return;

			// Get largest photo
			const photo = photos[photos.length - 1];
			const attachments: Attachment[] = [];

			try {
				const file = await ctx.api.getFile(photo.file_id);
				if (file.file_path) {
					const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
					const localPath = join(this.attachmentsDir, `${Date.now()}-${file.file_path.split("/").pop()}`);

					const response = await fetch(url);
					if (response.ok) {
						const buffer = Buffer.from(await response.arrayBuffer());
						writeFileSync(localPath, buffer);

						attachments.push({
							localPath,
							filename: file.file_path.split("/").pop() || "photo.jpg",
							mimeType: "image/jpeg",
						});
					}
				}
			} catch (err) {
				console.error("Failed to download photo:", err);
			}

			this.emit({
				id: ctx.message.message_id.toString(),
				channelType: "telegram",
				chatId: ctx.chat.id.toString(),
				senderId: ctx.from.id.toString(),
				senderName: ctx.from.first_name || ctx.from.username || "unknown",
				text: ctx.message.caption || "(photo)",
				timestamp: ctx.message.date * 1000,
				attachments,
			});
		});

		// Handle documents
		this.bot.on("message:document", async (ctx) => {
			if (!this.isAllowed(ctx.from.id.toString())) return;

			const doc = ctx.message.document;
			if (!doc) return;

			const attachments: Attachment[] = [];

			try {
				const file = await ctx.api.getFile(doc.file_id);
				if (file.file_path) {
					const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
					const localPath = join(this.attachmentsDir, `${Date.now()}-${doc.file_name || "document"}`);

					const response = await fetch(url);
					if (response.ok) {
						const buffer = Buffer.from(await response.arrayBuffer());
						writeFileSync(localPath, buffer);

						attachments.push({
							localPath,
							filename: doc.file_name || "document",
							mimeType: doc.mime_type,
						});
					}
				}
			} catch (err) {
				console.error("Failed to download document:", err);
			}

			this.emit({
				id: ctx.message.message_id.toString(),
				channelType: "telegram",
				chatId: ctx.chat.id.toString(),
				senderId: ctx.from.id.toString(),
				senderName: ctx.from.first_name || ctx.from.username || "unknown",
				text: ctx.message.caption || `(file: ${doc.file_name || "document"})`,
				timestamp: ctx.message.date * 1000,
				attachments,
			});
		});

		// Start polling (non-blocking)
		this.bot.start({
			drop_pending_updates: true,
			onStart: () => {
				console.log("Telegram bot started");
			},
		});
	}

	async stop(): Promise<void> {
		this.bot.stop();
	}

	async send(message: OutboundMessage): Promise<string | undefined> {
		const parts = splitMessage(message.text);

		let firstMessageId: number | undefined;
		for (const part of parts) {
			const sent = await this.bot.api.sendMessage(Number(message.chatId), part, {
				reply_parameters: message.replyToId ? { message_id: Number(message.replyToId) } : undefined,
			});
			if (!firstMessageId) {
				firstMessageId = sent.message_id;
			}
		}

		return firstMessageId?.toString();
	}

	async updateMessage(chatId: string, messageId: string, text: string): Promise<void> {
		const truncated =
			text.length > TELEGRAM_MAX_LENGTH ? `${text.substring(0, TELEGRAM_MAX_LENGTH - 20)}\n\n(truncated)` : text;

		try {
			await this.bot.api.editMessageText(Number(chatId), Number(messageId), truncated);
		} catch (err) {
			// Telegram throws if text didn't change -- ignore
			const errMsg = err instanceof Error ? err.message : String(err);
			if (!errMsg.includes("message is not modified")) {
				throw err;
			}
		}
	}

	private isAllowed(userId: string): boolean {
		if (this.allowedUsers.size === 0) return true;
		return this.allowedUsers.has(userId);
	}
}

function splitMessage(text: string): string[] {
	if (text.length <= TELEGRAM_MAX_LENGTH) return [text];

	const parts: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= TELEGRAM_MAX_LENGTH) {
			parts.push(remaining);
			break;
		}

		// Try to split at a newline
		let splitIdx = remaining.lastIndexOf("\n", TELEGRAM_MAX_LENGTH - 20);
		if (splitIdx < TELEGRAM_MAX_LENGTH / 2) {
			// No good newline found, split at space
			splitIdx = remaining.lastIndexOf(" ", TELEGRAM_MAX_LENGTH - 20);
		}
		if (splitIdx < TELEGRAM_MAX_LENGTH / 2) {
			// No good split point, force split
			splitIdx = TELEGRAM_MAX_LENGTH - 20;
		}

		parts.push(remaining.substring(0, splitIdx));
		remaining = remaining.substring(splitIdx).trimStart();
	}

	return parts;
}
