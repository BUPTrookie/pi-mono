/**
 * Feishu (Lark) channel implementation using @larksuiteoapi/node-sdk.
 *
 * Uses WebSocket long connection mode -- no public IP or webhook needed.
 * Handles text messages, images, and files.
 */

import * as lark from "@larksuiteoapi/node-sdk";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { BaseChannel } from "./base-channel.js";
import type { Attachment, Channel, OutboundMessage } from "./types.js";

export interface FeishuChannelOptions {
	appId: string;
	appSecret: string;
	/** Allowed open_id list (empty = allow all) */
	allowedUsers: string[];
	/** Directory for downloaded attachments */
	attachmentsDir: string;
	/** Use Lark (international) instead of Feishu (China) */
	useLark?: boolean;
}

export class FeishuChannel extends BaseChannel implements Channel {
	readonly type = "feishu";
	private client: InstanceType<typeof lark.Client>;
	private wsClient: InstanceType<typeof lark.WSClient>;
	private allowedUsers: Set<string>;
	private attachmentsDir: string;
	/** Deduplication cache (Feishu has at-least-once delivery) */
	private processedIds = new Map<string, number>();
	private readonly MAX_CACHE_SIZE = 1000;

	constructor(options: FeishuChannelOptions) {
		super();
		const domain = options.useLark ? lark.Domain.Lark : lark.Domain.Feishu;

		this.client = new lark.Client({
			appId: options.appId,
			appSecret: options.appSecret,
			appType: lark.AppType.SelfBuild,
			domain,
		});

		this.wsClient = new lark.WSClient({
			appId: options.appId,
			appSecret: options.appSecret,
			domain,
			loggerLevel: lark.LoggerLevel.info,
		});

		this.allowedUsers = new Set(options.allowedUsers);
		this.attachmentsDir = options.attachmentsDir;
		mkdirSync(this.attachmentsDir, { recursive: true });
	}

	async start(): Promise<void> {
		const eventDispatcher = new lark.EventDispatcher({}).register({
			"im.message.receive_v1": async (data) => {
				try {
					await this.handleMessage(data);
				} catch (err) {
					console.error("Feishu message handler error:", err);
				}
			},
		});

		await this.wsClient.start({ eventDispatcher });
		console.log("Feishu bot started (WebSocket mode)");
	}

	async stop(): Promise<void> {
		this.wsClient.close();
	}

	async send(message: OutboundMessage): Promise<string | undefined> {
		const receiveIdType = message.chatId.startsWith("oc_") ? "chat_id" : "open_id";

		const res = await this.client.im.v1.message.create({
			params: { receive_id_type: receiveIdType },
			data: {
				receive_id: message.chatId,
				content: JSON.stringify({ text: message.text }),
				msg_type: "text",
			},
		});

		return (res.data as any)?.message_id;
	}

	async updateMessage(_chatId: string, messageId: string, text: string): Promise<void> {
		try {
			await this.client.im.v1.message.patch({
				path: { message_id: messageId },
				data: {
					content: JSON.stringify({ text }),
				},
			});
		} catch (err) {
			// Feishu may reject edits for certain message types; fall back to new message
			const errMsg = err instanceof Error ? err.message : String(err);
			if (errMsg.includes("not support") || errMsg.includes("permission")) {
				console.warn("Feishu message patch failed, sending new message:", errMsg);
			} else {
				throw err;
			}
		}
	}

	private async handleMessage(data: any): Promise<void> {
		const sender = data.sender;
		const message = data.message;

		if (!sender || !message) return;

		// Skip bot messages
		if (sender.sender_type === "bot") return;

		const senderId = sender.sender_id?.open_id || sender.sender_id?.user_id || "";

		// ACL check
		if (this.allowedUsers.size > 0 && !this.allowedUsers.has(senderId)) {
			return;
		}

		// Deduplicate
		const messageId = message.message_id;
		if (this.processedIds.has(messageId)) return;
		this.processedIds.set(messageId, Date.now());
		this.trimCache();

		// Parse content based on message type
		const chatId = message.chat_id;
		const messageType = message.message_type as string;
		let text = "";
		const attachments: Attachment[] = [];

		try {
			const content = JSON.parse(message.content);

			if (messageType === "text") {
				text = content.text || "";
			} else if (messageType === "post") {
				// Rich text -- extract text from nested structure
				text = this.extractPostText(content);
			} else if (messageType === "image") {
				const imageKey = content.image_key;
				if (imageKey) {
					const localPath = await this.downloadResource(messageId, imageKey, "image");
					if (localPath) {
						attachments.push({
							localPath,
							filename: `${imageKey}.jpg`,
							mimeType: "image/jpeg",
						});
					}
				}
				text = "(image)";
			} else if (messageType === "file") {
				const fileKey = content.file_key;
				const fileName = content.file_name || "file";
				if (fileKey) {
					const localPath = await this.downloadResource(messageId, fileKey, "file");
					if (localPath) {
						attachments.push({
							localPath,
							filename: fileName,
						});
					}
				}
				text = `(file: ${fileName})`;
			} else {
				text = `(unsupported message type: ${messageType})`;
			}
		} catch {
			text = message.content || "(failed to parse message)";
		}

		// Strip @bot mentions from text
		if (message.mentions) {
			for (const mention of message.mentions) {
				text = text.replace(`@_user_${mention.id?.open_id}`, "").replace(mention.key, "").trim();
			}
		}

		if (!text && attachments.length === 0) return;

		// Determine reply target: for group chats use chat_id, for DMs use sender open_id
		const replyTarget = message.chat_type === "p2p" ? senderId : chatId;

		this.emit({
			id: messageId,
			channelType: "feishu",
			chatId: replyTarget,
			senderId,
			senderName: sender.sender_id?.user_id || senderId,
			text,
			timestamp: Number(message.create_time) || Date.now(),
			attachments,
		});
	}

	private extractPostText(content: any): string {
		const parts: string[] = [];

		// Handle localized post: { zh_cn: { title, content }, en_us: { ... } }
		const post = content.zh_cn || content.en_us || content;
		if (post.title) parts.push(post.title);

		if (Array.isArray(post.content)) {
			for (const paragraph of post.content) {
				if (!Array.isArray(paragraph)) continue;
				for (const element of paragraph) {
					if (element.tag === "text" && element.text) {
						parts.push(element.text);
					} else if (element.tag === "a" && element.text) {
						parts.push(`${element.text}(${element.href || ""})`);
					} else if (element.tag === "at" && element.user_name) {
						parts.push(`@${element.user_name}`);
					}
				}
			}
		}

		return parts.join(" ").trim() || "(empty post)";
	}

	private async downloadResource(messageId: string, fileKey: string, type: "image" | "file"): Promise<string | null> {
		try {
			const res = await this.client.im.v1.messageResource.get({
				path: { message_id: messageId, file_key: fileKey },
				params: { type },
			});

			const localPath = join(this.attachmentsDir, `${Date.now()}-${fileKey}`);

			// SDK returns { writeFile, getReadableStream, headers }
			if (res.writeFile) {
				await res.writeFile(localPath);
				return localPath;
			}

			// Fallback: use readable stream
			if (res.getReadableStream) {
				const stream = res.getReadableStream();
				const chunks: Buffer[] = [];
				for await (const chunk of stream) {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				}
				writeFileSync(localPath, Buffer.concat(chunks));
				return localPath;
			}
		} catch (err) {
			console.error(`Failed to download ${type} ${fileKey}:`, err);
		}
		return null;
	}

	private trimCache(): void {
		if (this.processedIds.size > this.MAX_CACHE_SIZE) {
			// Remove oldest entries
			const entries = Array.from(this.processedIds.entries());
			entries.sort((a, b) => a[1] - b[1]);
			const toRemove = entries.slice(0, entries.length - this.MAX_CACHE_SIZE);
			for (const [key] of toRemove) {
				this.processedIds.delete(key);
			}
		}
	}
}
