#!/usr/bin/env node

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { resolve } from "path";
import { findConfigFile, mergeConfig } from "./config.js";
import { runTeam } from "./team/team-runner.js";
import { runTeamTui } from "./tui/team-tui.js";
import type { InterventionMode, TeamConfig } from "./types.js";

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

function isInterventionMode(value: string): value is InterventionMode {
	return value === "none" || value === "approval" || value === "interactive";
}

interface ParsedArgs {
	requirement?: string;
	outputDir?: string;
	model?: { provider?: string; model?: string; apiKey?: string; baseUrl?: string };
	options?: {
		maxParallelAgents?: number;
		thinkingLevel?: ThinkingLevel;
		maxRepairRounds?: number;
		interventionMode?: InterventionMode;
	};
	configPath?: string;
	help?: boolean;
	interactive?: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
	const result: ParsedArgs = {};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--requirement" && i + 1 < args.length) {
			result.requirement = args[++i];
		} else if (arg === "--output" && i + 1 < args.length) {
			result.outputDir = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			if (!result.model) result.model = {};
			result.model.model = args[++i];
		} else if (arg === "--provider" && i + 1 < args.length) {
			if (!result.model) result.model = {};
			result.model.provider = args[++i];
		} else if (arg === "--api-key" && i + 1 < args.length) {
			if (!result.model) result.model = {};
			result.model.apiKey = args[++i];
		} else if (arg === "--base-url" && i + 1 < args.length) {
			if (!result.model) result.model = {};
			result.model.baseUrl = args[++i];
		} else if (arg === "--config" && i + 1 < args.length) {
			result.configPath = args[++i];
		} else if (arg === "--max-parallel" && i + 1 < args.length) {
			if (!result.options) result.options = {};
			result.options.maxParallelAgents = parseInt(args[++i], 10);
		} else if (arg === "--thinking-level" && i + 1 < args.length) {
			if (!result.options) result.options = {};
			const level = args[++i];
			if (isThinkingLevel(level)) result.options.thinkingLevel = level;
		} else if (arg === "--max-repair-rounds" && i + 1 < args.length) {
			if (!result.options) result.options = {};
			result.options.maxRepairRounds = parseInt(args[++i], 10);
		} else if (arg === "--intervention-mode" && i + 1 < args.length) {
			if (!result.options) result.options = {};
			const mode = args[++i];
			if (isInterventionMode(mode)) result.options.interventionMode = mode;
		} else if (arg === "--interactive") {
			result.interactive = true;
			if (!result.options) result.options = {};
			result.options.interventionMode = "interactive";
		}
	}

	return result;
}

function printHelp(): void {
	console.log(`agent-team - Multi-agent team for full-stack development

Usage:
  agent-team --requirement "Build a todo app" --output ./output

Configuration (in order of priority):
  1. CLI arguments (--model, --api-key, etc.)
  2. Config file: ./agent-team.json or ~/.pi/agent-team.json
  3. CLI defaults

Options:
  --requirement <text>       Project requirement description (required)
  --output <path>            Output directory (required)
  --config <path>            Path to config file (default: ./agent-team.json or ~/.pi/agent-team.json)
  --model <id>               Model ID, supports "provider/model" format (e.g. "zai/glm-5.1")
  --provider <name>          Provider name (overrides config file)
  --api-key <key>            API key (overrides config file)
  --base-url <url>           Override model base URL
  --max-parallel <n>         Max parallel agents (default: 2)
  --max-repair-rounds <n>    Max validation repair rounds (default: 2)
  --thinking-level <lvl>     Thinking level: off, minimal, low, medium, high, xhigh
  --intervention-mode <mode> none, approval, interactive (default: none)
  --interactive              Run the TUI and enable approvals
  -h, --help                 Show this help message
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

	// Load config file and merge with CLI args
	const fileConfig = findConfigFile(parsed.configPath);
	const merged = mergeConfig(fileConfig, parsed.model, parsed.options);

	const config: TeamConfig = {
		requirement: parsed.requirement,
		outputDir: resolve(parsed.outputDir),
		model: merged.model,
		maxParallelAgents: merged.maxParallelAgents,
		maxRepairRounds: merged.maxRepairRounds,
		interventionMode: merged.interventionMode,
		thinkingLevel: merged.thinkingLevel,
	};

	console.log(`Requirement: ${config.requirement}`);
	console.log(`Output base: ${config.outputDir}`);
	console.log(`Model: ${config.model.provider ? `${config.model.provider}/` : ""}${config.model.model}`);
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
