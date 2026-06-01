import { describe, expect, it, vi } from "vitest";
import { TeamRunComponent } from "../src/tui/team-tui.js";
import type { TeamEvent, TeamRun } from "../src/types.js";

function runStub(): TeamRun {
	return {
		start: async () => ({ success: true, outputDir: "out", tasks: [], totalTurns: 0 }),
		subscribe: () => () => undefined,
		pause: vi.fn(),
		resume: vi.fn(),
		abort: vi.fn(),
		approve: vi.fn(),
		intervene: vi.fn(),
	};
}

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

const task = {
	id: "build-cli",
	role: "builder",
	subject: "Build CLI",
	description: "Build it",
	dependencies: ["setup"],
	status: "in_progress" as const,
	expectedOutputs: ["src/index.js"],
	acceptanceCriteria: ["exists"],
};

describe("TeamRunComponent", () => {
	it("renders run status, task table, validation round, approval, and recent logs", () => {
		const component = new TeamRunComponent(runStub(), {
			outputDir: "C:/tmp/out",
			modelLabel: "openai/fake",
			maxParallelAgents: 2,
		});
		const events: TeamEvent[] = [
			{ type: "run_start", requirement: "Build a CLI", outputDir: "C:/tmp/out/project", timestamp: 1 },
			{
				type: "plan_created",
				plan: {
					id: "plan",
					summary: "Build a CLI",
					roles: [{ name: "builder", profile: "project-setup", description: "Builds", ownedDirectories: ["."] }],
					tasks: [
						{
							id: "build-cli",
							role: "builder",
							subject: "Build CLI",
							description: "Build it",
							dependencies: ["setup"],
							ownedDirectories: ["."],
							expectedOutputs: ["src/index.js"],
							acceptanceCriteria: ["exists"],
						},
					],
					contracts: [],
					validationRules: [],
				},
				timestamp: 2,
			},
			{ type: "task_start", task, timestamp: 3 },
			{ type: "task_progress", taskId: "build-cli", message: "Blocked bash: unsafe command", timestamp: 4 },
			{
				type: "approval_requested",
				requestId: "approval-1",
				taskId: "build-cli",
				reason: "Run npm install",
				command: "npm install",
				timestamp: 5,
			},
			{ type: "validation_start", round: 1, timestamp: 6 },
		];

		for (const event of events) component.push(event);

		const rendered = component.render(100).map(stripAnsi).join("\n");
		expect(rendered).toContain("agent-team dynamic run");
		expect(rendered).toContain("openai/fake");
		expect(rendered).toContain("parallel: 2");
		expect(rendered).toContain("validation round: 1");
		expect(rendered).toContain("build-cli");
		expect(rendered).toContain("builder");
		expect(rendered).toContain("in_progress");
		expect(rendered).toContain("approval pending: approval-1");
		expect(rendered).toContain("Blocked bash: unsafe command");
	});

	it("keeps rendered lines within the requested width", () => {
		const component = new TeamRunComponent(runStub(), { outputDir: "out", modelLabel: "fake", maxParallelAgents: 1 });
		component.push({
			type: "run_start",
			requirement: "Build a very long thing".repeat(10),
			outputDir: "out",
			timestamp: 1,
		});

		const lines = component.render(32).map(stripAnsi);

		expect(lines.every((line) => line.length <= 32)).toBe(true);
	});
});
