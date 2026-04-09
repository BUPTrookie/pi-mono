/**
 * Web search tool.
 *
 * Supports two backends:
 *   - Tavily API (if tavilyApiKey provided) -- structured JSON, best quality
 *   - Google HTML scraping (fallback, no key needed) -- parses search result page
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

const searchSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're searching for (shown to user)" }),
	query: Type.String({ description: "Search query" }),
	maxResults: Type.Optional(Type.Number({ description: "Maximum number of results (1-10, default 5)" })),
	timeRange: Type.Optional(
		Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], {
			description: "Filter results by recency",
		}),
	),
});

type SearchParams = {
	label: string;
	query: string;
	maxResults?: number;
	timeRange?: "day" | "week" | "month" | "year";
};

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

// ---------------------------------------------------------------------------
// Tavily backend
// ---------------------------------------------------------------------------

async function searchTavily(
	apiKey: string,
	query: string,
	maxResults: number,
	timeRange?: string,
	signal?: AbortSignal,
): Promise<{ answer?: string; results: SearchResult[] }> {
	const body: Record<string, unknown> = {
		query,
		search_depth: "basic",
		max_results: maxResults,
		include_answer: true,
	};
	if (timeRange) body.time_range = timeRange;

	const response = await fetch("https://api.tavily.com/search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "");
		throw new Error(`Tavily search failed (${response.status}): ${errorText}`);
	}

	const data = (await response.json()) as {
		answer?: string;
		results: Array<{ title: string; url: string; content: string }>;
	};

	return {
		answer: data.answer || undefined,
		results: data.results.map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
	};
}

// ---------------------------------------------------------------------------
// Google HTML scraping backend (no API key needed)
// ---------------------------------------------------------------------------

const GOOGLE_TIME_RANGE_MAP: Record<string, string> = {
	day: "qdr:d",
	week: "qdr:w",
	month: "qdr:m",
	year: "qdr:y",
};

async function searchGoogle(
	query: string,
	maxResults: number,
	timeRange?: string,
	signal?: AbortSignal,
): Promise<{ results: SearchResult[] }> {
	const params = new URLSearchParams({
		q: query,
		num: String(Math.min(maxResults, 10)),
		hl: "en",
	});
	if (timeRange && GOOGLE_TIME_RANGE_MAP[timeRange]) {
		params.set("tbs", GOOGLE_TIME_RANGE_MAP[timeRange]);
	}

	const url = `https://www.google.com/search?${params.toString()}`;

	const response = await fetch(url, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			Accept: "text/html",
			"Accept-Language": "en-US,en;q=0.9",
		},
		signal,
	});

	if (!response.ok) {
		throw new Error(`Google search failed (${response.status})`);
	}

	const html = await response.text();
	return { results: parseGoogleHtml(html, maxResults) };
}

function parseGoogleHtml(html: string, maxResults: number): SearchResult[] {
	const results: SearchResult[] = [];

	// Google wraps each organic result in a div with class="g" or similar.
	// We look for patterns: <a href="/url?q=REAL_URL&..."><h3>TITLE</h3></a>
	// and nearby text for snippets.

	// Strategy: find all <a href="/url?q=..."><h3>...</h3></a> patterns
	const linkPattern = /<a[^>]*href="\/url\?q=([^"&]+)[^"]*"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/g;
	for (const match of html.matchAll(linkPattern)) {
		if (results.length >= maxResults) break;

		const url = decodeURIComponent(match[1]);
		const title = stripHtmlTags(match[2]).trim();

		if (!title || !url || url.startsWith("/")) continue;

		// Try to find a snippet near this match position
		const snippet = extractSnippet(html, match.index + match[0].length);

		results.push({ title, url, snippet });
	}

	// Fallback: try data-href patterns (alternative Google layout)
	if (results.length === 0) {
		const altPattern = /data-href="(https?:\/\/[^"]+)"[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/g;
		for (const altMatch of html.matchAll(altPattern)) {
			if (results.length >= maxResults) break;

			const url = altMatch[1];
			const title = stripHtmlTags(altMatch[2]).trim();

			if (!title || !url) continue;

			const snippet = extractSnippet(html, altMatch.index + altMatch[0].length);
			results.push({ title, url, snippet });
		}
	}

	return results;
}

function extractSnippet(html: string, startPos: number): string {
	// Look for text content in the next ~2000 chars after the title/link
	const searchWindow = html.slice(startPos, startPos + 2000);

	// Look for span or div with class containing "st" or snippet-like content
	// Common patterns: <span class="...">snippet text</span>
	// or just find the first substantial text block
	const spanPattern = /<(?:span|div)[^>]*>([^<]{40,})<\/(?:span|div)>/;
	const spanMatch = spanPattern.exec(searchWindow);
	if (spanMatch) {
		return stripHtmlTags(spanMatch[1]).trim().slice(0, 300);
	}

	// Fallback: grab any text content > 40 chars
	const textBlocks = searchWindow
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const sentences = textBlocks.split(/[.!?]\s/).filter((s) => s.length > 30);
	if (sentences.length > 0) {
		return sentences[0].trim().slice(0, 300);
	}

	return "";
}

function stripHtmlTags(html: string): string {
	return html
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ");
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createWebSearchTool(apiKey?: string): AgentTool<typeof searchSchema> {
	return {
		name: "web_search",
		label: "web_search",
		description:
			"Search the web for current information. Returns ranked results with titles, URLs, and content snippets. Use for questions about recent events, factual lookups, documentation, or anything requiring up-to-date information.",
		parameters: searchSchema,
		execute: async (
			_toolCallId: string,
			params: SearchParams,
			signal?: AbortSignal,
		): Promise<{ content: TextContent[]; details: undefined }> => {
			const maxResults = Math.min(Math.max(params.maxResults || 5, 1), 10);

			let answer: string | undefined;
			let results: SearchResult[];

			if (apiKey) {
				const tavily = await searchTavily(apiKey, params.query, maxResults, params.timeRange, signal);
				answer = tavily.answer;
				results = tavily.results;
			} else {
				const google = await searchGoogle(params.query, maxResults, params.timeRange, signal);
				results = google.results;
			}

			const parts: string[] = [];

			if (answer) {
				parts.push(`Answer: ${answer}\n`);
			}

			if (results.length === 0) {
				parts.push("No results found.");
			} else {
				for (let i = 0; i < results.length; i++) {
					const r = results[i];
					parts.push(`[${i + 1}] ${r.title}`);
					parts.push(`    ${r.url}`);
					if (r.snippet) {
						parts.push(`    ${r.snippet}`);
					}
					parts.push("");
				}
			}

			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: undefined,
			};
		},
	};
}
