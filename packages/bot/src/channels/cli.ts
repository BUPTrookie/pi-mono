/**
 * CLI channel for development and testing.
 * Reads from stdin, writes to stdout. Single fixed conversation (chatId = "cli").
 */

import chalk from "chalk";
import { createInterface } from "readline";
import { BaseChannel } from "./base-channel.js";
import type { Channel, OutboundMessage } from "./types.js";

export class CliChannel extends BaseChannel implements Channel {
	readonly type = "cli";
	private rl: ReturnType<typeof createInterface> | null = null;
	private messageCounter = 0;

	async start(): Promise<void> {
		this.rl = createInterface({
			input: process.stdin,
			output: process.stdout,
			prompt: chalk.green("> "),
		});

		this.rl.on("line", (line: string) => {
			const text = line.trim();
			if (!text) {
				this.rl?.prompt();
				return;
			}

			this.messageCounter++;
			this.emit({
				id: `cli-${this.messageCounter}`,
				channelType: "cli",
				chatId: "cli",
				senderId: "user",
				senderName: "user",
				text,
				timestamp: Date.now(),
				attachments: [],
			});
		});

		this.rl.on("close", () => {
			process.exit(0);
		});

		console.log(chalk.blue("Bot CLI mode. Type your messages below. Ctrl+C to exit.\n"));
		this.rl.prompt();
	}

	async stop(): Promise<void> {
		this.rl?.close();
		this.rl = null;
	}

	async send(message: OutboundMessage): Promise<string | undefined> {
		const id = `cli-out-${++this.messageCounter}`;
		console.log(`\n${chalk.cyan("bot:")} ${message.text}\n`);
		this.rl?.prompt();
		return id;
	}

	async updateMessage(_chatId: string, _messageId: string, text: string): Promise<void> {
		// CLI can't update messages, just print new content
		console.log(`\n${chalk.cyan("bot:")} ${text}\n`);
		this.rl?.prompt();
	}
}
