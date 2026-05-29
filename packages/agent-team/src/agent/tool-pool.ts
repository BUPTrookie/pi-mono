import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";
import type { RoleDefinition } from "../types.js";

// AgentTool uses a typebox TSchema generic parameter — each tool has a different schema type,
// so we use a mapped record. The 'any' here is the schema constraint, not an escape hatch.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolFactory = (cwd: string) => AgentTool<any>;

const TOOL_FACTORIES: Record<string, ToolFactory> = {
	read: (cwd) => createReadTool(cwd),
	write: (cwd) => createWriteTool(cwd),
	edit: (cwd) => createEditTool(cwd),
	bash: (cwd) => createBashTool(cwd),
	grep: (cwd) => createGrepTool(cwd),
	find: (cwd) => createFindTool(cwd),
	ls: (cwd) => createLsTool(cwd),
};

/**
 * Build the tool pool for a role, filtering to only allowed tools.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildToolPool(role: RoleDefinition, outputDir: string): AgentTool<any>[] {
	const allowed = new Set(role.allowedTools);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const tools: AgentTool<any>[] = [];

	for (const [name, factory] of Object.entries(TOOL_FACTORIES)) {
		if (allowed.has(name)) {
			tools.push(factory(outputDir));
		}
	}

	return tools;
}
