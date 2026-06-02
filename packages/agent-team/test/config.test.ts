import { describe, expect, it } from "vitest";
import { mergeConfig } from "../src/config.js";

describe("agent-team config", () => {
	it("defaults milestone supervision on merged runtime config", () => {
		const merged = mergeConfig(undefined);

		expect(merged.supervisionMode).toBe("milestone");
	});

	it("allows config or CLI to disable supervision", () => {
		expect(mergeConfig({ supervisionMode: "off" }).supervisionMode).toBe("off");
		expect(mergeConfig({ supervisionMode: "milestone" }, undefined, { supervisionMode: "off" }).supervisionMode).toBe(
			"off",
		);
	});
});
