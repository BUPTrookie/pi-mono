import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskGraph } from "../src/task/task-graph.js";
import { createTeamPlan, taskFromSpec, writeContracts } from "../src/team/planner.js";

function tempProject(): string {
	return join(tmpdir(), `agent-team-planner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("dynamic planner", () => {
	it("creates a valid dynamic DAG from a full-stack requirement", () => {
		const plan = createTeamPlan("Build a todo app with CRUD API and responsive web UI");
		const graph = new TaskGraph();
		for (const task of plan.tasks.map(taskFromSpec)) {
			graph.addTask(task);
		}

		expect(plan.roles.map((role) => role.name)).toContain("api-builder");
		expect(plan.roles.map((role) => role.name)).toContain("ui-builder");
		expect(plan.tasks.length).toBeGreaterThanOrEqual(3);
		expect(graph.getReadyTasks().map((task) => task.id)).toEqual(["task-api"]);
	});

	it("does not encode the deleted fixed six-agent workflow", () => {
		const plan = createTeamPlan("Create a CLI utility that formats JSON files");
		const fixedRoles = ["pm", "architect", "db-engineer", "backend", "frontend", "devops"];

		expect(plan.roles.map((role) => role.name)).not.toEqual(fixedRoles);
		expect(plan.roles.some((role) => role.name === "pm")).toBe(false);
		expect(plan.tasks.some((task) => task.id === "task-pm")).toBe(false);
	});

	it("generates polling-specific contracts for realtime voting requirements", () => {
		const requirement =
			"Build a realtime polling system with user registration/login, session auth, poll expiration, one vote per user, SSE updates, search filters, and Tailwind dark theme";
		const outputDir = tempProject();
		mkdirSync(outputDir, { recursive: true });
		const plan = createTeamPlan(requirement);
		writeContracts(outputDir, requirement, plan);

		const openApi = JSON.parse(readFileSync(join(outputDir, "docs/contracts/openapi.json"), "utf-8")) as {
			paths: Record<string, unknown>;
		};
		const dataModel = JSON.parse(readFileSync(join(outputDir, "docs/contracts/data-model.json"), "utf-8")) as {
			entities: Array<{ name: string }>;
		};

		expect(Object.keys(openApi.paths)).toContain("/api/auth/register");
		expect(Object.keys(openApi.paths)).toContain("/api/polls");
		expect(Object.keys(openApi.paths)).toContain("/api/polls/{pollId}/votes");
		expect(Object.keys(openApi.paths)).toContain("/api/polls/{pollId}/events");
		expect(dataModel.entities.map((entity) => entity.name)).toEqual(["User", "Poll", "PollOption", "Vote"]);
	});
});
