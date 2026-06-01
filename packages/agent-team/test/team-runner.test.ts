import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import type { TeamAgentRunner } from "../src/team/team-lead.js";
import { createTeamRun } from "../src/team/team-runner.js";
import type { PlannerResult, PlannerRunner, TeamConfig } from "../src/types.js";

const model: Model<Api> = {
	id: "fake",
	name: "fake",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 1000,
};

function tempBase(): string {
	return join(tmpdir(), `agent-team-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function config(outputDir: string): TeamConfig {
	return {
		requirement: "Build a JSON formatter",
		outputDir,
		model: { provider: "openai", model: "fake", apiKey: "key" },
		maxParallelAgents: 2,
		maxRepairRounds: 0,
	};
}

function plannerResult(): PlannerResult {
	return {
		plan: {
			id: "runner-plan",
			summary: "Runner test plan",
			roles: [
				{
					name: "builder",
					profile: "project-setup",
					description: "Builds files",
					ownedDirectories: ["src", "."],
				},
				{
					name: "verifier",
					profile: "e2e-verifier",
					description: "Verifies output",
					ownedDirectories: ["tests/e2e", "docs/e2e-report.md"],
				},
			],
			tasks: [
				{
					id: "build-cli",
					role: "builder",
					subject: "Build CLI",
					description: "Build it",
					dependencies: [],
					ownedDirectories: ["src", "."],
					expectedOutputs: ["src/index.js"],
					acceptanceCriteria: ["exists"],
				},
				{
					id: "verify-e2e",
					role: "verifier",
					subject: "Verify",
					description: "Verify it",
					dependencies: ["build-cli"],
					ownedDirectories: ["tests/e2e", "docs/e2e-report.md"],
					expectedOutputs: ["docs/e2e-report.md"],
					acceptanceCriteria: ["reported"],
				},
			],
			contracts: [
				{ path: "docs/contracts/team-plan.json", kind: "team-plan", required: true },
				{ path: "docs/contracts/project-manifest.json", kind: "project-manifest", required: true },
			],
			validationRules: [],
		},
		contracts: { projectManifest: { goal: "Build a JSON formatter" } },
		diagnostics: [],
	};
}

function readJsonl(path: string): Array<Record<string, unknown>> {
	return readFileSync(path, "utf-8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("TeamRun execution recording", () => {
	it("persists ordered run events and per-task shards", async () => {
		const outputBase = tempBase();
		mkdirSync(outputBase, { recursive: true });
		const planner: PlannerRunner = async () => plannerResult();
		const runner: TeamAgentRunner = async (_description, agentConfig) => ({
			taskId: agentConfig.taskId ?? "",
			success: true,
			output: "ok",
			filesCreated: [`${agentConfig.taskId}.txt`],
			turnsUsed: 1,
		});
		const run = createTeamRun(config(outputBase), {
			model,
			plannerRunner: planner,
			agentRunner: runner,
			validatorRunner: async () => [],
			getApiKey: () => "key",
		});

		const result = await run.start();
		const logDir = join(result.outputDir, "docs", "agent-team");
		const events = readJsonl(join(logDir, "events.jsonl"));
		const buildEvents = readJsonl(join(logDir, "tasks", "build-cli.jsonl"));
		const verifierEvents = readJsonl(join(logDir, "tasks", "verify-e2e.jsonl"));

		expect(result.success).toBe(true);
		expect(events.map((entry) => entry.seq)).toEqual(events.map((_entry, index) => index + 1));
		expect(events.at(0)?.type).toBe("run_start");
		expect(events.at(-1)?.type).toBe("run_end");
		expect(buildEvents.some((entry) => entry.type === "task_start")).toBe(true);
		expect(buildEvents.some((entry) => entry.type === "task_end")).toBe(true);
		expect(verifierEvents.some((entry) => entry.type === "task_start")).toBe(true);
		expect(existsSync(join(logDir, "run-summary.md"))).toBe(true);
	});

	it("writes a failed run summary when a worker rejects", async () => {
		const outputBase = tempBase();
		mkdirSync(outputBase, { recursive: true });
		const runner: TeamAgentRunner = async (_description, agentConfig) => {
			if (agentConfig.taskId === "build-cli") throw new Error("worker failed");
			return { taskId: agentConfig.taskId ?? "", success: true, output: "ok", filesCreated: [], turnsUsed: 1 };
		};
		const run = createTeamRun(config(outputBase), {
			model,
			plannerRunner: async () => plannerResult(),
			agentRunner: runner,
			validatorRunner: async () => [],
			getApiKey: () => "key",
		});

		const result = await run.start();
		const summary = readFileSync(join(result.outputDir, "docs", "agent-team", "run-summary.md"), "utf-8");

		expect(result.success).toBe(false);
		expect(summary).toContain("Success: false");
		expect(summary).toContain("worker failed");
	});
});
