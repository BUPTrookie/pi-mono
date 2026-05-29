#!/usr/bin/env node

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { resolve } from "path";
import { runTeam } from "./team/team-runner.js";
import { runTeamTui } from "./tui/team-tui.js";
import type { TeamConfig } from "./types.js";

function isThinkingLevel(value: string): value is ThinkingLevel {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	);
}

function parseArgs(args: string[]): Partial<TeamConfig> & { help?: boolean; interactive?: boolean } {
	const result: ReturnType<typeof parseArgs> = {};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--requirement" && i + 1 < args.length) {
			result.requirement = args[++i];
		} else if (arg === "--output" && i + 1 < args.length) {
			result.outputDir = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			if (!result.model) result.model = { provider: "anthropic", model: "" };
			result.model.model = args[++i];
		} else if (arg === "--provider" && i + 1 < args.length) {
			if (!result.model) result.model = { provider: "", model: "claude-sonnet-4-6" };
			result.model.provider = args[++i];
		} else if (arg === "--api-key" && i + 1 < args.length) {
			if (!result.model) result.model = { provider: "anthropic", model: "claude-sonnet-4-6" };
			result.model.apiKey = args[++i];
		} else if (arg === "--base-url" && i + 1 < args.length) {
			if (!result.model) result.model = { provider: "anthropic", model: "claude-sonnet-4-6" };
			result.model.baseUrl = args[++i];
		} else if (arg === "--max-parallel" && i + 1 < args.length) {
			result.maxParallelAgents = parseInt(args[++i], 10);
		} else if (arg === "--thinking-level" && i + 1 < args.length) {
			const thinkingLevel = args[++i];
			if (isThinkingLevel(thinkingLevel)) result.thinkingLevel = thinkingLevel;
		} else if (arg === "--max-repair-rounds" && i + 1 < args.length) {
			result.maxRepairRounds = parseInt(args[++i], 10);
		} else if (arg === "--intervention-mode" && i + 1 < args.length) {
			const mode = args[++i];
			if (mode === "none" || mode === "approval" || mode === "interactive") result.interventionMode = mode;
		} else if (arg === "--interactive") {
			result.interactive = true;
			result.interventionMode = "interactive";
		}
	}

	return result;
}

function printHelp(): void {
	console.log(`agent-team - Multi-agent team for full-stack development

Usage:
  agent-team --requirement "Build a todo app" --output ./output

Options:
  --requirement <text>   Project requirement description (required)
  --output <path>        Output directory (required)
  --model <id>           Model ID (default: claude-sonnet-4-6)
  --provider <name>      Provider name (default: anthropic)
  --api-key <key>        API key (alternative to env var)
  --base-url <url>       Override model base URL
  --max-parallel <n>     Max parallel agents (default: 2)
  --max-repair-rounds <n> Max validation repair rounds (default: 2)
  --thinking-level <lvl> Thinking level: off, minimal, low, medium, high, xhigh (default: off)
  --intervention-mode <mode> none, approval, interactive (default: none)
  --interactive          Run the first-party TUI and enable approvals
  -h, --help             Show this help message
`);
}

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2));

	if (parsed.help) {
		printHelp();
		process.exit(0);
	}

	if (!parsed.requirement) {
		console.error("Error: --requirement is required");
		printHelp();
		process.exit(1);
	}

	if (!parsed.outputDir) {
		console.error("Error: --output is required");
		printHelp();
		process.exit(1);
	}

	const config: TeamConfig = {
		requirement: parsed.requirement,
		outputDir: resolve(parsed.outputDir),
		model: {
			provider: parsed.model?.provider ?? "anthropic",
			model: parsed.model?.model ?? "claude-sonnet-4-6",
			apiKey: parsed.model?.apiKey,
			baseUrl: parsed.model?.baseUrl,
		},
		maxParallelAgents: parsed.maxParallelAgents ?? 2,
		maxRepairRounds: parsed.maxRepairRounds ?? 2,
		interventionMode: parsed.interventionMode ?? "none",
		thinkingLevel: parsed.thinkingLevel,
	};

	console.log(`Requirement: ${config.requirement}`);
	console.log(`Output base: ${config.outputDir}`);
	console.log(`Model: ${config.model.provider}/${config.model.model}`);
	console.log("");

	const result = parsed.interactive ? await runTeamTui(config) : await runTeam(config);

	console.log("");
	console.log("=== Team Result ===");
	console.log(`Success: ${result.success}`);
	console.log(`Output directory: ${result.outputDir}`);
	console.log(`Total turns: ${result.totalTurns}`);
	console.log(`Tasks completed: ${result.tasks.filter((t) => t.success).length}/${result.tasks.length}`);
	console.log(`Validation issues: ${result.validationIssues?.length ?? 0}`);

	if (result.error) {
		console.error(`Error: ${result.error}`);
	}

	process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
