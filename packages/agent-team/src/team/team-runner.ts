import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { ApprovalDecision, TeamConfig, TeamEvent, TeamEventListener, TeamResult, TeamRun } from "../types.js";
import { TeamLead } from "./team-lead.js";

interface PendingApproval {
	resolve: (decision: ApprovalDecision) => void;
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

function resolveModelFromRegistry(
	registry: ModelRegistry,
	provider: string,
	modelId: string,
	baseUrl?: string,
): Model<Api> {
	const exact = registry.find(provider, modelId);
	if (exact) {
		// Custom baseUrl with a third-party endpoint must use openai-completions,
		// not openai-responses — most compatible endpoints only implement Chat Completions.
		if (baseUrl && exact.api === "openai-responses") {
			return { ...exact, baseUrl, api: "openai-completions" } as Model<Api>;
		}
		return baseUrl ? { ...exact, baseUrl } : exact;
	}

	const providerModels = registry.getAll().filter((model) => model.provider === provider);
	if (providerModels.length > 0) {
		const fallback = providerModels[0];
		// Same: custom baseUrl → force openai-completions
		const api = baseUrl && fallback.api === "openai-responses" ? ("openai-completions" as Api) : fallback.api;
		return {
			...fallback,
			id: modelId,
			name: modelId,
			api,
			baseUrl: baseUrl ?? fallback.baseUrl,
		} as Model<Api>;
	}

	throw new Error(
		`Model not found: ${provider}/${modelId}. Add the provider/model to models.json or use a known provider from ModelRegistry.`,
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

	constructor(private config: TeamConfig) {}

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
		const authStorage = AuthStorage.create(join(homedir(), ".pi", "auth.json"));
		if (projectConfig.model.apiKey) {
			authStorage.setRuntimeApiKey(projectConfig.model.provider, projectConfig.model.apiKey);
		}
		const modelRegistry = ModelRegistry.create(authStorage);
		const model = resolveModelFromRegistry(
			modelRegistry,
			projectConfig.model.provider,
			projectConfig.model.model,
			projectConfig.model.baseUrl,
		);

		const getApiKey = async (provider: string) => {
			if (projectConfig.model.apiKey) return projectConfig.model.apiKey;
			const key = await modelRegistry.getApiKeyForProvider(provider);
			if (!key) {
				throw new Error(
					`No API key found for ${provider}. Set the appropriate environment variable or configure auth storage.`,
				);
			}
			return key;
		};

		this.lead = new TeamLead(projectConfig, model, getApiKey, (event) => this.emit(event), {
			waitIfPaused: () => this.waitIfPaused(),
			requestApproval: (request) => this.requestApproval(request.taskId, request.reason, request.command),
			getInterventions: () => [...this.interventions],
		});

		return this.lead.orchestrate();
	}

	private prepareProjectConfig(): TeamConfig {
		const baseDir = resolve(this.config.outputDir);
		mkdirSync(baseDir, { recursive: true });
		const projectDir = uniqueDir(baseDir, deriveProjectSlug(this.config.requirement));
		mkdirSync(projectDir, { recursive: true });
		return { ...this.config, outputDir: projectDir };
	}

	private emit(event: TeamEvent): void {
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

export function createTeamRun(config: TeamConfig): TeamRun {
	return new DynamicTeamRun(config);
}

export async function runTeam(config: TeamConfig): Promise<TeamResult> {
	return createTeamRun(config).start();
}
