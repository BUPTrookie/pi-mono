import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import type { TeamAgentRunner } from "../src/team/team-lead.js";
import { TeamLead } from "../src/team/team-lead.js";
import type { TeamConfig, TeamEvent } from "../src/types.js";

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

function config(outputDir: string): TeamConfig {
	return {
		requirement: "Create a CLI utility that formats JSON files",
		outputDir,
		model: { provider: "openai", model: "fake" },
		maxParallelAgents: 2,
		maxRepairRounds: 1,
	};
}

function tempProject(): string {
	return join(tmpdir(), `agent-team-lead-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("TeamLead dynamic run", () => {
	it("emits run, plan, validation, repair, and completion events", async () => {
		const outputDir = tempProject();
		mkdirSync(outputDir, { recursive: true });
		const events: TeamEvent[] = [];
		const runner: TeamAgentRunner = async (_description, agentConfig) => {
			if (agentConfig.taskId?.startsWith("repair-")) {
				mkdirSync(join(agentConfig.outputDir, "src"), { recursive: true });
				writeFileSync(join(agentConfig.outputDir, "src/index.js"), "console.log('ok')", "utf-8");
				writeFileSync(
					join(agentConfig.outputDir, "package.json"),
					JSON.stringify({ scripts: { start: "node src/index.js" } }),
					"utf-8",
				);
				writeFileSync(join(agentConfig.outputDir, "README.md"), "# Project\n", "utf-8");
			}
			return { taskId: agentConfig.taskId ?? "", success: true, output: "ok", filesCreated: [], turnsUsed: 1 };
		};

		const lead = new TeamLead(
			config(outputDir),
			model,
			() => "key",
			(event) => events.push(event),
			{
				waitIfPaused: async () => undefined,
				requestApproval: async () => "reject",
				getInterventions: () => [],
			},
			runner,
		);
		const result = await lead.orchestrate();

		expect(result.success).toBe(true);
		expect(events.map((event) => event.type)).toContain("run_start");
		expect(events.map((event) => event.type)).toContain("plan_created");
		expect(events.map((event) => event.type)).toContain("validation_start");
		expect(events.map((event) => event.type)).toContain("repair_requested");
		expect(events[events.length - 1].type).toBe("run_end");
	});
});
