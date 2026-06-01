import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type {
	ApprovalDecision,
	PlannerRunner,
	TeamConfig,
	TeamEvent,
	TeamEventListener,
	TeamResult,
	TeamRun,
} from "../types.js";
import { createExecutionRecorder, type ExecutionRecorder } from "./execution-recorder.js";
import { type SupervisorRunner, type TeamAgentRunner, TeamLead, type TeamValidatorRunner } from "./team-lead.js";

interface PendingApproval {
	resolve: (decision: ApprovalDecision) => void;
}

type ApiKeyResolver = (provider: string) => Promise<string | undefined> | string | undefined;

export interface TeamRunOverrides {
	model?: Model<Api>;
	plannerRunner?: PlannerRunner;
	agentRunner?: TeamAgentRunner;
	validatorRunner?: TeamValidatorRunner;
	supervisorRunner?: SupervisorRunner;
	getApiKey?: ApiKeyResolver;
	recorderFactory?: (outputDir: string) => ExecutionRecorder;
}

function deriveProjectSlug(requirement: string): string {
	const words = requirement
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, "")
		.split(/\s+/)
		.filter(
			(word) =>
				word &&
				![
					"a",
					"an",
					"the",
					"build",
					"create",
					"make",
					"with",
					"for",
					"and",
					"to",
					"of",
					"in",
					"on",
					"that",
					"simple",
					"app",
					"application",
				].includes(word),
		);
	const slug = words.slice(0, 4).join("-");
	if (!slug) return `project-${Date.now()}`;
	return slug;
}

function uniqueDir(basePath: string, name: string): string {
	const candidate = join(basePath, name);
	if (!existsSync(candidate)) return candidate;
	let i = 2;
	while (existsSync(join(basePath, `${name}-${i}`))) i++;
	return join(basePath, `${name}-${i}`);
}

/**
 * Resolve a model reference using ModelRegistry.
 * Supports:
 *   - provider + model: find("zai", "glm-5.1")
 *   - model only: search all providers for exact match, pick the first
 *   - "provider/model" format in model string: parse and resolve
 *   - model + baseUrl: apply baseUrl override
 */
function resolveModel(
	registry: ModelRegistry,
	provider: string | undefined,
	modelId: string,
	baseUrl?: string,
): Model<Api> {
	// Parse "provider/model" format
	let resolvedProvider = provider;
	let resolvedModelId = modelId;
	if (!resolvedProvider && modelId.includes("/")) {
		const slashIdx = modelId.indexOf("/");
		resolvedProvider = modelId.substring(0, slashIdx);
		resolvedModelId = modelId.substring(slashIdx + 1);
	}

	// Exact match with provider
	if (resolvedProvider) {
		const exact = registry.find(resolvedProvider, resolvedModelId);
		if (exact) {
			return baseUrl ? { ...exact, baseUrl } : exact;
		}

		// Provider exists but model not found — build a custom model from provider template.
		// Custom endpoints (baseUrl) often only support /chat/completions, so force
		// openai-completions api for max compatibility.
		const providerModels = registry.getAll().filter((m) => m.provider === resolvedProvider);
		if (providerModels.length > 0) {
			const completionsTemplate = providerModels.find((m) => (m as any).api === "openai-completions");
			const template = completionsTemplate ?? { ...providerModels[0], api: "openai-completions" };
			return {
				...template,
				id: resolvedModelId,
				name: resolvedModelId,
				baseUrl: baseUrl ?? template.baseUrl,
			} as Model<Api>;
		}
	}

	// No provider — search all providers for model ID
	const allModels = registry.getAll();
	const match = allModels.find((m) => m.id === resolvedModelId);
	if (match) {
		return baseUrl ? { ...match, baseUrl } : match;
	}

	throw new Error(
		`Model not found: ${resolvedProvider ? `${resolvedProvider}/` : ""}${resolvedModelId}. ` +
			`Use a known provider/model from ModelRegistry, or create agent-team.json with model config.`,
	);
}

class DynamicTeamRun implements TeamRun {
	private listeners: TeamEventListener[] = [];
	private started = false;
	private lead?: TeamLead;
	private paused = false;
	private pauseWaiters: Array<() => void> = [];
	private approvals = new Map<string, PendingApproval>();
	private interventions: string[] = [];
	private approvalCounter = 0;
	private recorder?: ExecutionRecorder;

	constructor(
		private config: TeamConfig,
		private overrides: TeamRunOverrides = {},
	) {}

	subscribe(listener: TeamEventListener): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index !== -1) this.listeners.splice(index, 1);
		};
	}

	pause(): void {
		if (this.paused) return;
		this.paused = true;
		this.emit({ type: "run_paused", timestamp: Date.now() });
	}

	resume(): void {
		if (!this.paused) return;
		this.paused = false;
		for (const waiter of this.pauseWaiters.splice(0)) {
			waiter();
		}
		this.emit({ type: "run_resumed", timestamp: Date.now() });
	}

	abort(): void {
		this.lead?.abort();
		this.resume();
		for (const [requestId, pending] of this.approvals.entries()) {
			pending.resolve("reject");
			this.emit({ type: "approval_resolved", requestId, decision: "reject", timestamp: Date.now() });
		}
		this.approvals.clear();
	}

	approve(requestId: string, decision: ApprovalDecision): void {
		const pending = this.approvals.get(requestId);
		if (!pending) return;
		this.approvals.delete(requestId);
		pending.resolve(decision);
		this.emit({ type: "approval_resolved", requestId, decision, timestamp: Date.now() });
	}

	intervene(message: string): void {
		const trimmed = message.trim();
		if (!trimmed) return;
		this.interventions.push(trimmed);
		this.emit({ type: "intervention", message: trimmed, timestamp: Date.now() });
	}

	async start(): Promise<TeamResult> {
		if (this.started) throw new Error("TeamRun.start() can only be called once.");
		this.started = true;

		const projectConfig = this.prepareProjectConfig();
		this.recorder = (this.overrides.recorderFactory ?? createExecutionRecorder)(projectConfig.outputDir);
		let result: TeamResult | undefined;

		try {
			const authStorage = AuthStorage.create(join(homedir(), ".pi", "auth.json"));
			const resolvedProvider = projectConfig.model.provider;
			if (projectConfig.model.apiKey && resolvedProvider) {
				authStorage.setRuntimeApiKey(resolvedProvider, projectConfig.model.apiKey);
			}
			const modelRegistry = ModelRegistry.create(authStorage);
			const model =
				this.overrides.model ??
				resolveModel(modelRegistry, resolvedProvider, projectConfig.model.model, projectConfig.model.baseUrl);

			// Set API key for the resolved provider if it differs from the configured one
			if (projectConfig.model.apiKey && model.provider !== resolvedProvider) {
				authStorage.setRuntimeApiKey(model.provider, projectConfig.model.apiKey);
			}

			const getApiKey =
				this.overrides.getApiKey ??
				(async (provider: string) => {
					if (projectConfig.model.apiKey) return projectConfig.model.apiKey;
					const key = await modelRegistry.getApiKeyForProvider(provider);
					if (!key) {
						throw new Error(
							`No API key found for ${provider}. Set the appropriate environment variable or configure auth storage.`,
						);
					}
					return key;
				});

			this.lead = new TeamLead({
				config: projectConfig,
				model,
				getApiKey,
				emit: (event) => this.emit(event),
				controls: {
					waitIfPaused: () => this.waitIfPaused(),
					requestApproval: (request) => this.requestApproval(request.taskId, request.reason, request.command),
					getInterventions: () => [...this.interventions],
				},
				agentRunner: this.overrides.agentRunner,
				plannerRunner: this.overrides.plannerRunner,
				validatorRunner: this.overrides.validatorRunner,
				supervisorRunner: this.overrides.supervisorRunner,
			});

			result = await this.lead.orchestrate();
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result = {
				success: false,
				outputDir: projectConfig.outputDir,
				tasks: [],
				totalTurns: 0,
				error: message,
			};
			this.emit({ type: "run_end", result, timestamp: Date.now() });
			return result;
		} finally {
			if (result) this.recorder.finish(result);
		}
	}

	private prepareProjectConfig(): TeamConfig {
		const baseDir = resolve(this.config.outputDir);
		mkdirSync(baseDir, { recursive: true });
		const projectDir = uniqueDir(baseDir, deriveProjectSlug(this.config.requirement));
		mkdirSync(projectDir, { recursive: true });
		return { ...this.config, outputDir: projectDir };
	}

	private emit(event: TeamEvent): void {
		this.recorder?.record(event);
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	private async waitIfPaused(): Promise<void> {
		if (!this.paused) return;
		await new Promise<void>((resolveWaiter) => {
			this.pauseWaiters.push(resolveWaiter);
		});
	}

	private async requestApproval(taskId: string, reason: string, command: string): Promise<ApprovalDecision> {
		if ((this.config.interventionMode ?? "none") === "none") return "reject";
		const requestId = `approval-${++this.approvalCounter}`;
		this.emit({ type: "approval_requested", requestId, taskId, reason, command, timestamp: Date.now() });
		return new Promise<ApprovalDecision>((resolveDecision) => {
			this.approvals.set(requestId, { resolve: resolveDecision });
		});
	}
}

export function createTeamRun(config: TeamConfig, overrides: TeamRunOverrides = {}): TeamRun {
	return new DynamicTeamRun(config, overrides);
}

export async function runTeam(config: TeamConfig): Promise<TeamResult> {
	return createTeamRun(config).start();
}
