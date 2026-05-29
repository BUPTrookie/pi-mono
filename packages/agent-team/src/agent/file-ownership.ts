import type { BeforeToolCallContext, BeforeToolCallResult } from "@mariozechner/pi-agent-core";
import { normalize, relative, resolve } from "path";

/**
 * Check if absPath is within absDir (cross-platform, handles Windows case-insensitivity).
 */
function isWithin(absPath: string, absDir: string): boolean {
	const rel = relative(absDir, absPath);
	// relative() returns "" when paths are identical, or a path not starting with ".." when inside
	return rel !== "" && !rel.startsWith("..") && !resolve(absDir, rel).startsWith("..");
}

/**
 * Check if absPath exactly equals absDir.
 */
function isExactMatch(absPath: string, absDir: string): boolean {
	return normalize(absPath) === normalize(absDir);
}

/**
 * Check if a path is owned by any of the owned directories.
 */
function isPathOwnedBy(absPath: string, absoluteOwned: string[]): boolean {
	return absoluteOwned.some((dir) => isExactMatch(absPath, dir) || isWithin(absPath, dir));
}

/**
 * Create a beforeToolCall hook that enforces file ownership.
 * Only allows write/edit operations within the agent's owned directories.
 */
export function createOwnershipGuard(
	ownedDirectories: string[],
	outputDir: string,
): (context: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined> {
	const absoluteOwned = ownedDirectories.map((d) => resolve(outputDir, d));

	async function guard(context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> {
		const toolName = context.toolCall.name;
		if (toolName !== "write" && toolName !== "edit") return undefined;

		const args = context.args as { path?: string };
		if (!args.path) return undefined;

		const absPath = resolve(outputDir, args.path);
		const isOwned = isPathOwnedBy(absPath, absoluteOwned);

		if (!isOwned) {
			return {
				block: true,
				reason: `Cannot write to "${args.path}". This agent only owns: ${ownedDirectories.join(", ")}. All paths are relative to the project root.`,
			};
		}
		return undefined;
	}

	return guard;
}

/**
 * Check if a path is within any of the owned directories (synchronous, for testing).
 */
export function isPathOwned(filePath: string, ownedDirectories: string[], outputDir: string): boolean {
	const absPath = resolve(outputDir, filePath);
	const absoluteOwned = ownedDirectories.map((d) => resolve(outputDir, d));
	return isPathOwnedBy(absPath, absoluteOwned);
}
