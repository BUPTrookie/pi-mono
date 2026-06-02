import { describe, expect, it, vi } from "vitest";
import { TeamRunComponent } from "../src/tui/team-tui.js";
import type { TeamEvent, TeamRun } from "../src/types.js";

function runStub(): TeamRun {
	return createRunStub();
}

function createRunStub(): TeamRun & {
	pause: ReturnType<typeof vi.fn>;
	resume: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
	approve: ReturnType<typeof vi.fn>;
} {
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

const testTask = {
	id: "test-cli",
	role: "tester",
	subject: "Test CLI",
	description: "Test it",
	dependencies: ["build-cli"],
	status: "pending" as const,
	expectedOutputs: ["docs/e2e-report.md"],
	acceptanceCriteria: ["reported"],
};

describe("TeamRunComponent", () => {
	it("renders a dashboard header, progress summary, task table, approval, and recent logs", () => {
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
					roles: [
						{ name: "builder", profile: "project-setup", description: "Builds", ownedDirectories: ["."] },
						{ name: "tester", profile: "e2e-verifier", description: "Tests", ownedDirectories: ["docs"] },
					],
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
						{
							id: "test-cli",
							role: "tester",
							subject: "Test CLI",
							description: "Test it",
							dependencies: ["build-cli"],
							ownedDirectories: ["docs"],
							expectedOutputs: ["docs/e2e-report.md"],
							acceptanceCriteria: ["reported"],
						},
					],
					contracts: [],
					validationRules: [],
				},
				timestamp: 2,
			},
			{ type: "task_start", task, timestamp: 3 },
			{
				type: "agent_event",
				taskId: "build-cli",
				role: "builder",
				event: {
					type: "tool_execution_start",
					toolCallId: "tool-1",
					toolName: "write",
					args: { path: "src/index.js" },
				},
				timestamp: 3,
			},
			{ type: "task_progress", taskId: "build-cli", message: "Blocked bash: unsafe command", timestamp: 4 },
			{
				type: "task_end",
				task: { ...task, status: "completed" },
				result: {
					taskId: "build-cli",
					success: true,
					output: "ok",
					filesCreated: ["src/index.js", "package.json"],
					turnsUsed: 3,
				},
				timestamp: 5,
			},
			{ type: "task_start", task: { ...testTask, status: "in_progress" }, timestamp: 6 },
			{
				type: "approval_requested",
				requestId: "approval-1",
				taskId: "test-cli",
				reason: "Run npm install",
				command: "npm install",
				timestamp: 7,
			},
			{ type: "validation_start", round: 1, timestamp: 8 },
			{ type: "supervision_start", checkpoint: "validation_end", round: 1, timestamp: 9 },
			{
				type: "supervision_end",
				checkpoint: "validation_end",
				decision: {
					checkpoint: "validation_end",
					decision: "warn",
					summary: "Supervisor found a routing risk",
					issues: [
						{
							id: "supervisor-risk",
							severity: "warning",
							message: "Check owner",
							ownerTaskId: "test-cli",
							file: "docs/e2e-report.md",
						},
					],
					recommendedActions: ["Review e2e report"],
				},
				timestamp: 10,
			},
		];

		for (const event of events) component.push(event);

		const rendered = component.render(100).map(stripAnsi).join("\n");
		expect(rendered).toContain("agent-team dynamic run");
		expect(rendered).toContain("status: validating");
		expect(rendered).toContain("elapsed:");
		expect(rendered).toContain("openai/fake");
		expect(rendered).toContain("parallel: 2");
		expect(rendered).toContain("output: C:/tmp/out/project");
		expect(rendered).toContain("progress");
		expect(rendered).toContain("completed: 1");
		expect(rendered).toContain("running: 1");
		expect(rendered).toContain("failed: 0");
		expect(rendered).toContain("pending: 0");
		expect(rendered).toContain("active: test-cli");
		expect(rendered).toContain("validation round: 1");
		expect(rendered).toContain("issues: 0");
		expect(rendered).toContain("build-cli");
		expect(rendered).toContain("builder/project-setup");
		expect(rendered).toContain("completed");
		expect(rendered).toContain("files: 2");
		expect(rendered).toContain("turns: 3");
		expect(rendered).toContain("test-cli");
		expect(rendered).toContain("tester/e2e-verifier");
		expect(rendered).toContain("running");
		expect(rendered).toContain("approvals: approval-1");
		expect(rendered).toContain("tool: build-cli write src/index.js");
		expect(rendered).toContain("supervision: warn validation_end");
		expect(rendered).toContain("Supervisor found a routing risk");
		expect(rendered).toContain("Blocked bash: unsafe command");
		expect(rendered).toContain("keys: p pause/resume | a approve | r reject | ctrl+c abort");
	});

	it("surfaces failed tasks and validation issues in the summary and logs", () => {
		const component = new TeamRunComponent(runStub(), {
			outputDir: "out",
			modelLabel: "fake",
			maxParallelAgents: 1,
		});
		component.push({ type: "run_start", requirement: "Build", outputDir: "out/project", timestamp: 1000 });
		component.push({
			type: "plan_created",
			plan: {
				id: "plan",
				summary: "Build",
				roles: [{ name: "builder", profile: "project-setup", description: "Builds", ownedDirectories: ["."] }],
				tasks: [
					{
						id: "build-cli",
						role: "builder",
						subject: "Build CLI",
						description: "Build it",
						dependencies: [],
						ownedDirectories: ["."],
						expectedOutputs: ["src/index.js"],
						acceptanceCriteria: ["exists"],
					},
				],
				contracts: [],
				validationRules: [],
			},
			timestamp: 1001,
		});
		component.push({ type: "task_start", task, timestamp: 1002 });
		component.push({
			type: "task_end",
			task: { ...task, status: "failed" },
			result: {
				taskId: "build-cli",
				success: false,
				output: "",
				filesCreated: [],
				error: "worker failed",
				turnsUsed: 1,
			},
			timestamp: 1003,
		});
		component.push({
			type: "validation_end",
			round: 2,
			issues: [
				{
					id: "missing-output",
					severity: "error",
					message: "Missing src/index.js",
					ownerTaskId: "build-cli",
					file: "src/index.js",
				},
			],
			timestamp: 1004,
		});
		component.push({
			type: "repair_requested",
			round: 3,
			issues: [
				{
					id: "missing-output",
					severity: "error",
					message: "Missing src/index.js",
					ownerTaskId: "build-cli",
					file: "src/index.js",
				},
			],
			tasks: [],
			timestamp: 1005,
		});

		const rendered = component.render(100).map(stripAnsi).join("\n");
		expect(rendered).toContain("status: repairing");
		expect(rendered).toContain("completed: 0");
		expect(rendered).toContain("failed: 1");
		expect(rendered).toContain("validation round: 2");
		expect(rendered).toContain("issues: 1");
		expect(rendered).toContain("worker failed");
		expect(rendered).toContain("missing-output owner: build-cli file: src/index.js");
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

	it("handles pause, approval, rejection, and abort keys when focused", () => {
		const run = createRunStub();
		const component = new TeamRunComponent(run);
		component.handleInput("p");
		component.push({ type: "run_paused", timestamp: 1 });
		component.handleInput("p");
		component.push({
			type: "approval_requested",
			requestId: "approval-1",
			taskId: "test-cli",
			reason: "Run safe command",
			command: "npm test",
			timestamp: 1,
		});
		component.handleInput("a");
		component.push({
			type: "approval_requested",
			requestId: "approval-2",
			taskId: "test-cli",
			reason: "Run risky command",
			command: "npm install",
			timestamp: 2,
		});
		component.handleInput("r");
		component.handleInput("\x03");

		expect(run.pause).toHaveBeenCalled();
		expect(run.resume).toHaveBeenCalled();
		expect(run.approve).toHaveBeenCalledWith("approval-1", "approve");
		expect(run.approve).toHaveBeenCalledWith("approval-2", "reject");
		expect(run.abort).toHaveBeenCalled();
	});
});
