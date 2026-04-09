/**
 * Memory manager: layered memory with daily logs, long-term MEMORY.md, and BM25 search.
 *
 * Architecture:
 *   - Long-term memory: MEMORY.md (global + per-conversation), manually maintained by LLM
 *   - Daily logs: memory/YYYY-MM-DD.md, append-only session notes
 *   - BM25 search: keyword search across all memory files
 *   - Pre-compaction flush: auto-saves context excerpts before compaction threshold
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

/** A single search result chunk with source attribution. */
export interface SearchResult {
	file: string;
	lineStart: number;
	text: string;
	score: number;
}

/** BM25 parameters */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** Max bytes of today's daily log to include in system prompt */
const DAILY_LOG_CAP = 2048;

/** Extract text content from an AgentMessage, handling all content shape variants. */
function extractText(msg: AgentMessage): string | undefined {
	// Only user and assistant messages have content we care about
	if (msg.role !== "user" && msg.role !== "assistant") return undefined;
	const content = (msg as { content: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const texts: string[] = [];
	for (const part of content) {
		if (typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part) {
			texts.push(part.text as string);
		}
	}
	return texts.length > 0 ? texts.join(" ") : undefined;
}

/**
 * Tokenize text for BM25 scoring.
 * English: lowercase + split on whitespace/punctuation.
 * CJK: character bigrams (covers Chinese, Japanese, Korean).
 */
function tokenize(text: string): string[] {
	const tokens: string[] = [];
	const lower = text.toLowerCase();

	// Split into runs of CJK vs non-CJK
	// CJK Unified Ideographs: U+4E00-U+9FFF
	// CJK Extension A: U+3400-U+4DBF
	// Hangul Syllables: U+AC00-U+D7AF
	// Hiragana: U+3040-U+309F, Katakana: U+30A0-U+30FF
	const cjkPattern = /[\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;

	let i = 0;
	let wordBuf = "";

	while (i < lower.length) {
		const ch = lower[i];
		if (cjkPattern.test(ch)) {
			// Flush any pending word
			if (wordBuf) {
				tokens.push(wordBuf);
				wordBuf = "";
			}
			// Emit bigram if possible, otherwise single char
			if (i + 1 < lower.length && cjkPattern.test(lower[i + 1])) {
				tokens.push(lower[i] + lower[i + 1]);
			}
			// Always emit single char too for recall
			tokens.push(ch);
			i++;
		} else if (/[a-z0-9]/.test(ch)) {
			wordBuf += ch;
			i++;
		} else {
			// Whitespace or punctuation: flush word
			if (wordBuf) {
				tokens.push(wordBuf);
				wordBuf = "";
			}
			i++;
		}
	}
	if (wordBuf) {
		tokens.push(wordBuf);
	}

	return tokens;
}

/** Split content into chunks by heading or double-newline, ~200-500 chars each. */
function splitChunks(content: string, file: string): Array<{ text: string; lineStart: number; file: string }> {
	const lines = content.split("\n");
	const chunks: Array<{ text: string; lineStart: number; file: string }> = [];

	let currentChunk: string[] = [];
	let chunkStart = 1;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const isHeading = /^#{1,6}\s/.test(line);
		const isBlankFollowedByBlank = line.trim() === "" && i > 0 && lines[i - 1]?.trim() === "";

		// Start new chunk on heading or double-blank
		if ((isHeading || isBlankFollowedByBlank) && currentChunk.length > 0) {
			const text = currentChunk.join("\n").trim();
			if (text) {
				chunks.push({ text, lineStart: chunkStart, file });
			}
			currentChunk = [];
			chunkStart = i + 1;
		}

		currentChunk.push(line);

		// Also split if chunk gets too large (~500 chars)
		const chunkText = currentChunk.join("\n");
		if (chunkText.length > 500 && currentChunk.length > 1) {
			const text = chunkText.trim();
			if (text) {
				chunks.push({ text, lineStart: chunkStart, file });
			}
			currentChunk = [];
			chunkStart = i + 2;
		}
	}

	// Final chunk
	if (currentChunk.length > 0) {
		const text = currentChunk.join("\n").trim();
		if (text) {
			chunks.push({ text, lineStart: chunkStart, file });
		}
	}

	return chunks;
}

/** Compute BM25 scores for query against chunks. */
function bm25Search(
	query: string,
	chunks: Array<{ text: string; lineStart: number; file: string }>,
	limit: number,
): SearchResult[] {
	const queryTokens = tokenize(query);
	if (queryTokens.length === 0 || chunks.length === 0) return [];

	const N = chunks.length;

	// Tokenize all chunks and compute document frequencies
	const chunkTokens = chunks.map((c) => tokenize(c.text));
	const docFreq = new Map<string, number>();
	for (const tokens of chunkTokens) {
		const seen = new Set(tokens);
		for (const t of seen) {
			docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
		}
	}

	// Average document length
	const avgdl = chunkTokens.reduce((sum, t) => sum + t.length, 0) / N;

	// Score each chunk
	const scored: SearchResult[] = [];
	for (let i = 0; i < chunks.length; i++) {
		const tokens = chunkTokens[i];
		const dl = tokens.length;
		if (dl === 0) continue;

		// Term frequencies in this chunk
		const tf = new Map<string, number>();
		for (const t of tokens) {
			tf.set(t, (tf.get(t) ?? 0) + 1);
		}

		let score = 0;
		for (const qt of queryTokens) {
			const df = docFreq.get(qt) ?? 0;
			const termFreq = tf.get(qt) ?? 0;
			if (termFreq === 0) continue;

			const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
			score += idf * ((termFreq * (BM25_K1 + 1)) / (termFreq + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl))));
		}

		if (score > 0) {
			scored.push({
				file: chunks[i].file,
				lineStart: chunks[i].lineStart,
				text: chunks[i].text,
				score,
			});
		}
	}

	// Sort descending by score, return top-N
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit);
}

export class MemoryManager {
	constructor(private dataDir: string) {}

	/**
	 * Build memory content for the system prompt.
	 * Includes: global MEMORY.md + conversation MEMORY.md + today's daily log (capped to last 2KB).
	 */
	getSystemPromptMemory(channelType: string, chatId: string): string {
		const parts: string[] = [];

		// Global memory
		const globalMemoryPath = join(this.dataDir, channelType, "MEMORY.md");
		const globalContent = this.readFileSafe(globalMemoryPath);
		if (globalContent) {
			parts.push(`### Global Memory\n${globalContent}`);
		}

		// Conversation memory
		const chatMemoryPath = join(this.dataDir, channelType, chatId, "MEMORY.md");
		const chatContent = this.readFileSafe(chatMemoryPath);
		if (chatContent) {
			parts.push(`### Conversation Memory\n${chatContent}`);
		}

		// Today's daily log (capped to last 2KB)
		const today = this.todayString();
		const dailyLogPath = join(this.dataDir, channelType, chatId, "memory", `${today}.md`);
		const dailyContent = this.readFileSafe(dailyLogPath);
		if (dailyContent) {
			let capped = dailyContent;
			if (Buffer.byteLength(capped, "utf-8") > DAILY_LOG_CAP) {
				// Take last 2KB
				const buf = Buffer.from(capped, "utf-8");
				capped = `...\n${buf.subarray(buf.length - DAILY_LOG_CAP).toString("utf-8")}`;
				// Trim to first complete line after the cut
				const firstNewline = capped.indexOf("\n", 4);
				if (firstNewline > 0) {
					capped = `...\n${capped.substring(firstNewline + 1)}`;
				}
			}
			parts.push(`### Today's Log (${today})\n${capped}`);
		}

		if (parts.length === 0) {
			return "(no working memory yet)";
		}

		return parts.join("\n\n");
	}

	/**
	 * BM25 search across all memory files for a conversation.
	 * Scans: global MEMORY.md, conversation MEMORY.md, and all daily logs.
	 */
	search(channelType: string, chatId: string, query: string, limit = 5): SearchResult[] {
		const allChunks: Array<{ text: string; lineStart: number; file: string }> = [];

		// Collect memory files
		const filesToScan: Array<{ path: string; label: string }> = [];

		// Global MEMORY.md
		const globalPath = join(this.dataDir, channelType, "MEMORY.md");
		if (existsSync(globalPath)) {
			filesToScan.push({ path: globalPath, label: "MEMORY.md (global)" });
		}

		// Conversation MEMORY.md
		const chatPath = join(this.dataDir, channelType, chatId, "MEMORY.md");
		if (existsSync(chatPath)) {
			filesToScan.push({ path: chatPath, label: "MEMORY.md (conversation)" });
		}

		// Daily logs
		const memoryDir = join(this.dataDir, channelType, chatId, "memory");
		if (existsSync(memoryDir)) {
			try {
				const entries = readdirSync(memoryDir);
				for (const entry of entries) {
					if (entry.endsWith(".md")) {
						filesToScan.push({ path: join(memoryDir, entry), label: `memory/${entry}` });
					}
				}
			} catch {
				// Ignore read errors
			}
		}

		// Split all files into chunks
		for (const { path, label } of filesToScan) {
			const content = this.readFileSafe(path);
			if (content) {
				allChunks.push(...splitChunks(content, label));
			}
		}

		return bm25Search(query, allChunks, limit);
	}

	/**
	 * Append an entry to today's daily log.
	 */
	appendDailyLog(channelType: string, chatId: string, entry: string): void {
		const memoryDir = join(this.dataDir, channelType, chatId, "memory");
		mkdirSync(memoryDir, { recursive: true });

		const today = this.todayString();
		const logPath = join(memoryDir, `${today}.md`);
		appendFileSync(logPath, `${entry}\n`, "utf-8");
	}

	/**
	 * Pre-compaction flush: extract recent messages and save to daily log.
	 * Called before prompt when context size exceeds 70% of the model's context window.
	 */
	flushContext(channelType: string, chatId: string, messages: AgentMessage[], contextWindow: number): void {
		const estimate = this.estimateTokens(messages);
		const threshold = contextWindow * 0.7;

		if (estimate <= threshold) return;

		// Extract last 10 user/assistant text messages
		const recentTexts: string[] = [];
		const textMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");
		const slice = textMessages.slice(-10);

		for (const msg of slice) {
			const text = extractText(msg);
			if (text) {
				const role = msg.role === "user" ? "User" : "Assistant";
				recentTexts.push(`**${role}**: ${text.substring(0, 500)}`);
			}
		}

		if (recentTexts.length === 0) return;

		const timestamp = new Date().toISOString();
		const entry = `<!-- AUTO-FLUSH ${timestamp} -->\n${recentTexts.join("\n")}`;
		this.appendDailyLog(channelType, chatId, entry);
	}

	/** Rough token estimate: char count / 4 */
	private estimateTokens(messages: AgentMessage[]): number {
		let chars = 0;
		for (const msg of messages) {
			const text = extractText(msg);
			if (text) {
				chars += text.length;
			}
		}
		return Math.ceil(chars / 4);
	}

	private todayString(): string {
		const now = new Date();
		const y = now.getFullYear();
		const m = String(now.getMonth() + 1).padStart(2, "0");
		const d = String(now.getDate()).padStart(2, "0");
		return `${y}-${m}-${d}`;
	}

	private readFileSafe(path: string): string | undefined {
		if (!existsSync(path)) return undefined;
		try {
			const content = readFileSync(path, "utf-8").trim();
			return content || undefined;
		} catch {
			return undefined;
		}
	}
}
