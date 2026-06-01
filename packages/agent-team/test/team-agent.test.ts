import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { extractChecksRunFromAgentEvents } from "../src/agent/team-agent.js";

describe("team agent helpers", () => {
	it("extracts self-check commands from bash tool events", () => {
		const events: AgentEvent[] = [
			{
				type: "tool_execution_start",
				toolCallId: "read-1",
				toolName: "bash",
				args: { command: "ls src" },
			},
			{
				type: "tool_execution_end",
				toolCallId: "read-1",
				toolName: "bash",
				result: "src/index.js",
				isError: false,
			},
			{
				type: "tool_execution_start",
				toolCallId: "check-1",
				toolName: "bash",
				args: { command: "node --check src/index.js" },
			},
			{
				type: "tool_execution_end",
				toolCallId: "check-1",
				toolName: "bash",
				result: "ok",
				isError: false,
			},
			{
				type: "tool_execution_start",
				toolCallId: "check-2",
				toolName: "bash",
				args: { command: "npm run check" },
			},
			{
				type: "tool_execution_end",
				toolCallId: "check-2",
				toolName: "bash",
				result: "Command exited with code 2",
				isError: true,
			},
		];

		expect(extractChecksRunFromAgentEvents(events)).toEqual([
			{ command: "node --check src/index.js", exitCode: 0, summary: "ok", required: true },
			{ command: "npm run check", exitCode: 2, summary: "Command exited with code 2", required: true },
		]);
	});
});
