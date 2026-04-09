/**
 * Channel abstraction for multi-platform IM messaging.
 *
 * Each platform (Telegram, CLI, etc.) implements the Channel interface
 * to bridge between the platform's message format and the bot's internal
 * InboundMessage/OutboundMessage types.
 */

export interface Attachment {
	/** Local file path after download */
	localPath: string;
	/** Original filename */
	filename: string;
	/** MIME type if known */
	mimeType?: string;
}

export interface InboundMessage {
	/** Unique message ID (platform-specific) */
	id: string;
	/** Channel type identifier (e.g., "telegram", "cli") */
	channelType: string;
	/** Conversation/chat identifier */
	chatId: string;
	/** Sender identifier */
	senderId: string;
	/** Sender display name */
	senderName: string;
	/** Message text content */
	text: string;
	/** Message timestamp (ms since epoch) */
	timestamp: number;
	/** Attached files */
	attachments: Attachment[];
}

export interface OutboundMessage {
	/** Target conversation/chat */
	chatId: string;
	/** Message text content */
	text: string;
	/** Attached files to send */
	attachments?: Attachment[];
	/** ID of message to reply to */
	replyToId?: string;
}

export type MessageHandler = (message: InboundMessage) => void;

export interface Channel {
	/** Channel type identifier */
	readonly type: string;

	/** Start listening for messages */
	start(): Promise<void>;

	/** Stop listening and clean up */
	stop(): Promise<void>;

	/** Send a message to the platform */
	send(message: OutboundMessage): Promise<string | undefined>;

	/** Update a previously sent message */
	updateMessage(chatId: string, messageId: string, text: string): Promise<void>;

	/** Register handler for incoming messages */
	onMessage(handler: MessageHandler): void;
}
