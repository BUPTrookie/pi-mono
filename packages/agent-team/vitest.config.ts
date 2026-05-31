import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		exclude: ["**/e2e-output*/**", "**/test-output*/**", "**/node_modules/**", "**/output/**"],
	},
});
