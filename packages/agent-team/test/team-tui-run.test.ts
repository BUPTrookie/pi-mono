import { describe, expect, it, vi } from "vitest";
import { createTeamRun } from "../src/team/team-runner.js";
import { runTeamTui } from "../src/tui/team-tui.js";
import type { TeamConfig, TeamRun } from "../src/types.js";

const mocks = vi.hoisted(() => {
	const tuiInstances: FakeTui[] = [];
	const fakeRun: TeamRun = {
		start: vi.fn(async () => ({ success: true, outputDir: "out", tasks: [], totalTurns: 0 })),
		subscribe: vi.fn(() => () => undefined),
		pause: vi.fn(),
		resume: vi.fn(),
		abort: vi.fn(),
		approve: vi.fn(),
		intervene: vi.fn(),
	};

	class FakeTui {
		addChild = vi.fn();
		setFocus = vi.fn();
		start = vi.fn();
		stop = vi.fn();
		requestRender = vi.fn();

		constructor() {
			tuiInstances.push(this);
		}
	}

	class FakeProcessTerminal {}

	return { FakeProcessTerminal, FakeTui, fakeRun, tuiInstances };
});

vi.mock("@mariozechner/pi-tui", () => ({
	Key: { ctrl: (key: string) => `ctrl+${key}` },
	ProcessTerminal: mocks.FakeProcessTerminal,
	TUI: mocks.FakeTui,
	matchesKey: (data: string, key: string) => data === key || (data === "\x03" && key === "ctrl+c"),
	truncateToWidth: (line: string, width: number) => line.slice(0, width),
}));

vi.mock("../src/team/team-runner.js", () => ({
	createTeamRun: vi.fn(() => mocks.fakeRun),
}));

function config(): TeamConfig {
	return {
		requirement: "Build a CLI",
		outputDir: "out",
		model: { provider: "openai", model: "fake" },
	};
}

describe("runTeamTui", () => {
	it("focuses the team run component so keyboard controls are delivered", async () => {
		mocks.tuiInstances.length = 0;
		vi.mocked(createTeamRun).mockClear();

		await runTeamTui(config());

		const tui = mocks.tuiInstances[0];
		const component = tui.addChild.mock.calls[0]?.[0];
		expect(component).toBeDefined();
		expect(tui.setFocus).toHaveBeenCalledWith(component);
	});

	it("does not enable approval flow by default", async () => {
		vi.mocked(createTeamRun).mockClear();

		await runTeamTui(config());

		expect(vi.mocked(createTeamRun).mock.calls[0]?.[0].interventionMode).toBeUndefined();
	});

	it("preserves explicit intervention mode", async () => {
		vi.mocked(createTeamRun).mockClear();

		await runTeamTui({ ...config(), interventionMode: "interactive" });

		expect(vi.mocked(createTeamRun).mock.calls[0]?.[0].interventionMode).toBe("interactive");
	});
});
