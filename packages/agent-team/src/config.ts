import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { InterventionMode, PermissionMode, SupervisionMode, TeamConfig } from "./types.js";

export interface AgentTeamConfigFile {
	outputDir?: string;
	model?: {
		provider?: string;
		model?: string;
		apiKey?: string;
		baseUrl?: string;
	};
	maxParallelAgents?: number;
	thinkingLevel?: ThinkingLevel;
	maxRepairRounds?: number;
	interventionMode?: InterventionMode;
	supervisionMode?: SupervisionMode;
	permissionMode?: PermissionMode;
}

const CONFIG_FILENAMES = ["agent-team.json"];

function readConfigFile(path: string): AgentTeamConfigFile | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as AgentTeamConfigFile;
	} catch (err) {
		console.warn(`Warning: Failed to parse config file ${path}: ${err instanceof Error ? err.message : err}`);
		return undefined;
	}
}

/**
 * Search for config file in this order:
 * 1. Explicit path (if provided)
 * 2. ./agent-team.json (current working directory)
 * 3. ~/.pi/agent-team.json (user home)
 */
export function findConfigFile(explicitPath?: string): AgentTeamConfigFile | undefined {
	if (explicitPath) {
		const resolved = resolve(explicitPath);
		const config = readConfigFile(resolved);
		if (!config) {
			console.warn(`Warning: Config file not found or invalid: ${resolved}`);
		}
		return config;
	}

	for (const filename of CONFIG_FILENAMES) {
		const cwdPath = resolve(filename);
		const config = readConfigFile(cwdPath);
		if (config) return config;
	}

	const homePath = join(homedir(), ".pi", "agent-team.json");
	return readConfigFile(homePath);
}

/**
 * Merge config file settings with CLI arguments.
 * CLI arguments take precedence over config file values.
 */
export function mergeConfig(
	fileConfig: AgentTeamConfigFile | undefined,
	cliModel?: { provider?: string; model?: string; apiKey?: string; baseUrl?: string },
	cliOptions?: {
		maxParallelAgents?: number;
		thinkingLevel?: ThinkingLevel;
		maxRepairRounds?: number;
		interventionMode?: InterventionMode;
		supervisionMode?: SupervisionMode;
		permissionMode?: PermissionMode;
	},
): Pick<
	TeamConfig,
	| "model"
	| "maxParallelAgents"
	| "thinkingLevel"
	| "maxRepairRounds"
	| "interventionMode"
	| "supervisionMode"
	| "permissionMode"
> {
	const fileModel = fileConfig?.model;

	return {
		model: {
			provider: cliModel?.provider ?? fileModel?.provider,
			model: cliModel?.model ?? fileModel?.model ?? "claude-sonnet-4-6",
			apiKey: cliModel?.apiKey ?? fileModel?.apiKey,
			baseUrl: cliModel?.baseUrl ?? fileModel?.baseUrl,
		},
		maxParallelAgents: cliOptions?.maxParallelAgents ?? fileConfig?.maxParallelAgents,
		thinkingLevel: cliOptions?.thinkingLevel ?? fileConfig?.thinkingLevel,
		maxRepairRounds: cliOptions?.maxRepairRounds ?? fileConfig?.maxRepairRounds,
		interventionMode: cliOptions?.interventionMode ?? fileConfig?.interventionMode,
		supervisionMode: cliOptions?.supervisionMode ?? fileConfig?.supervisionMode,
		permissionMode: cliOptions?.permissionMode ?? fileConfig?.permissionMode ?? "open",
	};
}
