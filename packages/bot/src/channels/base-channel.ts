/**
 * Base channel implementation providing common handler management.
 */

import type { InboundMessage, MessageHandler } from "./types.js";

export abstract class BaseChannel {
	private handlers: MessageHandler[] = [];

	protected emit(message: InboundMessage): void {
		for (const handler of this.handlers) {
			handler(message);
		}
	}

	onMessage(handler: MessageHandler): void {
		this.handlers.push(handler);
	}
}
