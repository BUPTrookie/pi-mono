/**
 * Events watcher for scheduled and triggered tasks.
 *
 * Watches {dataDir}/events/ for JSON event files. The LLM creates these files
 * via bash to schedule reminders, recurring tasks, or trigger immediate actions.
 *
 * Adapted from mom's events.ts.
 */

import { Cron } from "croner";
import { existsSync, type FSWatcher, mkdirSync, readdirSync, statSync, unlinkSync, watch } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

// ============================================================================
// Event Types
// ============================================================================

export interface ImmediateEvent {
	type: "immediate";
	channelType: string;
	chatId: string;
	text: string;
}

export interface OneShotEvent {
	type: "one-shot";
	channelType: string;
	chatId: string;
	text: string;
	at: string; // ISO 8601 with timezone offset
}

export interface PeriodicEvent {
	type: "periodic";
	channelType: string;
	chatId: string;
	text: string;
	schedule: string; // cron syntax
	timezone: string; // IANA timezone
}

export type BotEvent = ImmediateEvent | OneShotEvent | PeriodicEvent;

/** Callback invoked when an event fires. */
export type EventCallback = (channelType: string, chatId: string, text: string) => void;

// ============================================================================
// EventsWatcher
// ============================================================================

const DEBOUNCE_MS = 100;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 100;

export class EventsWatcher {
	private timers: Map<string, NodeJS.Timeout> = new Map();
	private crons: Map<string, Cron> = new Map();
	private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
	private startTime: number;
	private watcher: FSWatcher | null = null;
	private knownFiles: Set<string> = new Set();

	constructor(
		private eventsDir: string,
		private onEvent: EventCallback,
	) {
		this.startTime = Date.now();
	}

	start(): void {
		if (!existsSync(this.eventsDir)) {
			mkdirSync(this.eventsDir, { recursive: true });
		}

		console.log(`Events watcher started: ${this.eventsDir}`);

		// Scan existing files
		this.scanExisting();

		// Watch for new/changed files
		this.watcher = watch(this.eventsDir, (_eventType, filename) => {
			if (!filename || !filename.endsWith(".json")) return;
			this.debounce(filename, () => this.handleFileChange(filename));
		});
	}

	stop(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}

		for (const timer of this.debounceTimers.values()) clearTimeout(timer);
		this.debounceTimers.clear();

		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();

		for (const cron of this.crons.values()) cron.stop();
		this.crons.clear();

		this.knownFiles.clear();
	}

	private debounce(filename: string, fn: () => void): void {
		const existing = this.debounceTimers.get(filename);
		if (existing) clearTimeout(existing);
		this.debounceTimers.set(
			filename,
			setTimeout(() => {
				this.debounceTimers.delete(filename);
				fn();
			}, DEBOUNCE_MS),
		);
	}

	private scanExisting(): void {
		let files: string[];
		try {
			files = readdirSync(this.eventsDir).filter((f) => f.endsWith(".json"));
		} catch {
			return;
		}
		for (const filename of files) {
			this.handleFile(filename);
		}
	}

	private handleFileChange(filename: string): void {
		const filePath = join(this.eventsDir, filename);
		if (!existsSync(filePath)) {
			this.handleDelete(filename);
		} else if (this.knownFiles.has(filename)) {
			this.cancelScheduled(filename);
			this.handleFile(filename);
		} else {
			this.handleFile(filename);
		}
	}

	private handleDelete(filename: string): void {
		if (!this.knownFiles.has(filename)) return;
		console.log(`Event deleted: ${filename}`);
		this.cancelScheduled(filename);
		this.knownFiles.delete(filename);
	}

	private cancelScheduled(filename: string): void {
		const timer = this.timers.get(filename);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(filename);
		}
		const cron = this.crons.get(filename);
		if (cron) {
			cron.stop();
			this.crons.delete(filename);
		}
	}

	private async handleFile(filename: string): Promise<void> {
		const filePath = join(this.eventsDir, filename);

		let event: BotEvent | null = null;
		for (let i = 0; i < MAX_RETRIES; i++) {
			try {
				const content = await readFile(filePath, "utf-8");
				event = this.parseEvent(content, filename);
				break;
			} catch {
				if (i < MAX_RETRIES - 1) {
					await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** i));
				}
			}
		}

		if (!event) {
			console.warn(`Failed to parse event: ${filename}`);
			this.deleteFile(filename);
			return;
		}

		this.knownFiles.add(filename);

		switch (event.type) {
			case "immediate":
				this.handleImmediate(filename, event);
				break;
			case "one-shot":
				this.handleOneShot(filename, event);
				break;
			case "periodic":
				this.handlePeriodic(filename, event);
				break;
		}
	}

	private parseEvent(content: string, filename: string): BotEvent {
		const data = JSON.parse(content);

		if (!data.type || !data.channelType || !data.chatId || !data.text) {
			throw new Error(`Missing required fields in ${filename}`);
		}

		switch (data.type) {
			case "immediate":
				return { type: "immediate", channelType: data.channelType, chatId: data.chatId, text: data.text };
			case "one-shot":
				if (!data.at) throw new Error(`Missing 'at' for one-shot in ${filename}`);
				return {
					type: "one-shot",
					channelType: data.channelType,
					chatId: data.chatId,
					text: data.text,
					at: data.at,
				};
			case "periodic":
				if (!data.schedule) throw new Error(`Missing 'schedule' for periodic in ${filename}`);
				if (!data.timezone) throw new Error(`Missing 'timezone' for periodic in ${filename}`);
				return {
					type: "periodic",
					channelType: data.channelType,
					chatId: data.chatId,
					text: data.text,
					schedule: data.schedule,
					timezone: data.timezone,
				};
			default:
				throw new Error(`Unknown event type '${data.type}' in ${filename}`);
		}
	}

	private handleImmediate(filename: string, event: ImmediateEvent): void {
		const filePath = join(this.eventsDir, filename);
		try {
			const stat = statSync(filePath);
			if (stat.mtimeMs < this.startTime) {
				console.log(`Stale immediate event, deleting: ${filename}`);
				this.deleteFile(filename);
				return;
			}
		} catch {
			return;
		}

		console.log(`Executing immediate event: ${filename}`);
		this.execute(filename, event);
	}

	private handleOneShot(filename: string, event: OneShotEvent): void {
		const atTime = new Date(event.at).getTime();
		const now = Date.now();

		if (atTime <= now) {
			console.log(`One-shot event in the past, deleting: ${filename}`);
			this.deleteFile(filename);
			return;
		}

		const delay = atTime - now;
		console.log(`Scheduling one-shot: ${filename} in ${Math.round(delay / 1000)}s`);

		const timer = setTimeout(() => {
			this.timers.delete(filename);
			console.log(`Executing one-shot: ${filename}`);
			this.execute(filename, event);
		}, delay);

		this.timers.set(filename, timer);
	}

	private handlePeriodic(filename: string, event: PeriodicEvent): void {
		try {
			const cron = new Cron(event.schedule, { timezone: event.timezone }, () => {
				console.log(`Executing periodic event: ${filename}`);
				this.execute(filename, event, false);
			});

			this.crons.set(filename, cron);
			const next = cron.nextRun();
			console.log(`Scheduled periodic: ${filename}, next: ${next?.toISOString() ?? "unknown"}`);
		} catch (err) {
			console.warn(`Invalid cron schedule for ${filename}:`, err instanceof Error ? err.message : err);
			this.deleteFile(filename);
		}
	}

	private execute(filename: string, event: BotEvent, deleteAfter: boolean = true): void {
		let scheduleInfo: string;
		switch (event.type) {
			case "immediate":
				scheduleInfo = "immediate";
				break;
			case "one-shot":
				scheduleInfo = event.at;
				break;
			case "periodic":
				scheduleInfo = event.schedule;
				break;
		}

		const text = `[EVENT:${filename}:${event.type}:${scheduleInfo}] ${event.text}`;
		this.onEvent(event.channelType, event.chatId, text);

		if (deleteAfter) {
			this.deleteFile(filename);
		}
	}

	private deleteFile(filename: string): void {
		const filePath = join(this.eventsDir, filename);
		try {
			unlinkSync(filePath);
		} catch {
			// Ignore
		}
		this.knownFiles.delete(filename);
	}
}
