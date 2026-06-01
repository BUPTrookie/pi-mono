import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/main.js";

describe("agent-team CLI args", () => {
	it("enables interactive TUI by default", () => {
		const parsed = parseArgs(["Build a todo app"]);

		expect(parsed.requirement).toBe("Build a todo app");
		expect(parsed.interactive).toBe(true);
	});

	it("allows explicitly disabling the interactive TUI", () => {
		const parsed = parseArgs(["Build a todo app", "--no-interactive"]);

		expect(parsed.requirement).toBe("Build a todo app");
		expect(parsed.interactive).toBe(false);
	});

	it("keeps --interactive as an explicit alias for interactive mode", () => {
		const parsed = parseArgs(["Build a todo app", "--interactive"]);

		expect(parsed.interactive).toBe(true);
		expect(parsed.options?.interventionMode).toBe("interactive");
	});
});
