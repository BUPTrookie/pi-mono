/**
 * Message bus for routing inbound messages to the agent runner.
 *
 * Each conversation gets a serial queue to prevent concurrent agent execution
 * for the same chat. Modeled after mom's ChannelQueue pattern.
 */

import type { Channel, InboundMessage } from "./channels/types.js";

export type MessageProcessor = (message: InboundMessage) => Promise<void>;

/**
 * Per-conversation serial work queue.
 * Ensures only one message is processed at a time per conversation.
 */
class ConversationQueue {
	private chain: Promise<void> = Promise.resolve();
	private pending = 0;

	enqueue(work: () => Promise<void>): void {
		this.pending++;
		this.chain = this.chain.then(async () => {
			try {
				await work();
			} catch (err) {
				console.error("Queue work error:", err);
			} finally {
				this.pending--;
			}
		});
	}

	get size(): number {
		return this.pending;
	}
}

const MAX_QUEUE_SIZE = 5;

export class MessageBus {
	private queues = new Map<string, ConversationQueue>();
	private processor: MessageProcessor | null = null;

	/**
	 * Register a channel to receive its messages.
	 */
	registerChannel(channel: Channel): void {
		channel.onMessage((message) => this.handleMessage(message));
	}

	/**
	 * Set the message processor (agent runner).
	 */
	setProcessor(processor: MessageProcessor): void {
		this.processor = processor;
	}

	/**
	 * Enqueue a synthetic message (e.g., from events watcher).
	 */
	enqueueMessage(message: InboundMessage): boolean {
		if (!this.processor) return false;

		const key = `${message.channelType}:${message.chatId}`;
		let queue = this.queues.get(key);
		if (!queue) {
			queue = new ConversationQueue();
			this.queues.set(key, queue);
		}

		if (queue.size >= MAX_QUEUE_SIZE) {
			console.warn(`Queue full for ${key}, dropping event message`);
			return false;
		}

		const processor = this.processor;
		queue.enqueue(() => processor(message));
		return true;
	}

	private handleMessage(message: InboundMessage): void {
		if (!this.processor) {
			console.error("No message processor registered");
			return;
		}

		const key = `${message.channelType}:${message.chatId}`;
		let queue = this.queues.get(key);
		if (!queue) {
			queue = new ConversationQueue();
			this.queues.set(key, queue);
		}

		if (queue.size >= MAX_QUEUE_SIZE) {
			console.warn(`Queue full for ${key}, dropping message`);
			return;
		}

		const processor = this.processor;
		queue.enqueue(() => processor(message));
	}
}
