#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { findConfigFile, mergeConfig } from "./config.js";
import { runTeam } from "./team/team-runner.js";
import { runTeamTui } from "./tui/team-tui.js";
import type { ExecutionMode, InterventionMode, PermissionMode, SupervisionMode, TeamConfig } from "./types.js";

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

function isSupervisionMode(value: string): value is SupervisionMode {
	return value === "off" || value === "milestone";
}

function isPermissionMode(value: string): value is PermissionMode {
	return value === "open" || value === "owned";
}

function isExecutionMode(value: string): value is ExecutionMode {
	return value === "open" || value === "restricted";
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
		supervisionMode?: SupervisionMode;
		permissionMode?: PermissionMode;
		executionMode?: ExecutionMode;
	};
	configPath?: string;
	help?: boolean;
	interactive?: boolean;
}

export function parseArgs(args: string[]): ParsedArgs {
	const result: ParsedArgs = { interactive: true };
	let positionalCount = 0;

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
		} else if (arg === "--supervision-mode" && i + 1 < args.length) {
			if (!result.options) result.options = {};
			const mode = args[++i];
			if (isSupervisionMode(mode)) result.options.supervisionMode = mode;
		} else if (arg === "--permission-mode" && i + 1 < args.length) {
			if (!result.options) result.options = {};
			const mode = args[++i];
			if (isPermissionMode(mode)) result.options.permissionMode = mode;
		} else if (arg === "--execution-mode" && i + 1 < args.length) {
			if (!result.options) result.options = {};
			const mode = args[++i];
			if (isExecutionMode(mode)) result.options.executionMode = mode;
		} else if (arg === "--interactive") {
			result.interactive = true;
			if (!result.options) result.options = {};
			result.options.interventionMode = "interactive";
		} else if (arg === "--no-interactive") {
			result.interactive = false;
		} else if (!arg.startsWith("-") && positionalCount === 0) {
			result.requirement = arg;
			positionalCount++;
		}
	}

	return result;
}

function printHelp(): void {
	console.log(`agent-team - Multi-agent team for full-stack development

Usage:
  agent-team "Build a todo app"
  agent-team --requirement "Build a todo app" --output ./output
  agent-team "Build a todo app" --max-parallel 4

Configuration (in order of priority):
  1. CLI arguments (--model, --api-key, etc.)
  2. Config file: ./agent-team.json or ~/.pi/agent-team.json
  3. Built-in defaults

Options:
  [requirement]              Project requirement (positional, or use --requirement)
  --requirement <text>       Project requirement description
  --output <path>            Output directory (default: from config, or "./output")
  --config <path>            Path to config file (default: ./agent-team.json or ~/.pi/agent-team.json)
  --model <id>               Model ID, supports "provider/model" format (e.g. "zai/glm-5.1")
  --provider <name>          Provider name (overrides config file)
  --api-key <key>            API key (overrides config file)
  --base-url <url>           Override model base URL
  --max-parallel <n>         Max parallel agents (default: from config, or 2)
  --max-repair-rounds <n>    Max validation repair rounds (default: from config, or 2)
  --thinking-level <lvl>     Thinking level: off, minimal, low, medium, high, xhigh
  --intervention-mode <mode> none, approval, interactive (default: interactive with TUI)
  --supervision-mode <mode>  off, milestone (default: off)
  --permission-mode <mode>   open, owned (default: open; owned enforces role ownedDirectories)
  --execution-mode <mode>    open, restricted (default: open; approval flow still applies)
  --interactive              Run the TUI and enable approvals (default)
  --no-interactive           Run without the TUI
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
		console.error("Error: requirement is required (positional or --requirement <text>)");
		printHelp();
		process.exit(1);
	}

	const fileConfig = findConfigFile(parsed.configPath);

	// outputDir: CLI > config file > "./output"
	const outputDir = parsed.outputDir ?? fileConfig?.outputDir ?? "./output";

	const merged = mergeConfig(fileConfig, parsed.model, parsed.options);

	const config: TeamConfig = {
		requirement: parsed.requirement,
		outputDir: resolve(outputDir),
		model: merged.model,
		maxParallelAgents: merged.maxParallelAgents,
		maxRepairRounds: merged.maxRepairRounds,
		interventionMode: merged.interventionMode,
		supervisionMode: merged.supervisionMode,
		permissionMode: merged.permissionMode,
		executionMode: merged.executionMode,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err) => {
		console.error("Fatal error:", err);
		process.exit(1);
	});
}
