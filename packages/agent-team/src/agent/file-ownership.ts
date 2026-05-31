import type { BeforeToolCallContext, BeforeToolCallResult } from "@mariozechner/pi-agent-core";
import { isAbsolute, normalize, relative, resolve } from "path";

/**
 * Check if absPath is within absDir (cross-platform, handles Windows case-insensitivity).
 */
function isWithin(absPath: string, absDir: string): boolean {
	const rel = relative(absDir, absPath);
	// relative() returns "" when paths are identical, or a path not starting with ".." when inside
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
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

function stripQuotes(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value;
}

function tokenizeCommand(command: string): string[] {
	return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(stripQuotes);
}

function extractRedirectionTargets(command: string): string[] {
	const targets: string[] = [];
	const pattern = /(?:&>|>>|\d?>|>)\s*("[^"]+"|'[^']+'|[^\s]+)/g;
	let match: RegExpExecArray | null = pattern.exec(command);
	while (match !== null) {
		const target = stripQuotes(match[1]);
		if (target && !target.startsWith("&")) targets.push(target);
		match = pattern.exec(command);
	}
	return targets;
}

function nonFlagTokens(tokens: string[]): string[] {
	return tokens.filter((token) => token && !token.startsWith("-"));
}

function extractSimpleCommandTargets(command: string): string[] {
	const targets: string[] = [];
	for (const segment of command.split(/\s*(?:&&|\|\||;|\r?\n)\s*/)) {
		const tokens = tokenizeCommand(segment);
		if (tokens.length === 0) continue;
		const commandName = tokens[0].toLowerCase();
		const args = tokens.slice(1);

		if (commandName === "touch" || commandName === "mkdir" || commandName === "md") {
			targets.push(...nonFlagTokens(args));
		} else if (commandName === "cp" || commandName === "mv") {
			const positional = nonFlagTokens(args);
			const target = positional.at(-1);
			if (target) targets.push(target);
		}
	}
	return targets;
}

function extractBashWriteTargets(command: string): string[] {
	return [...extractRedirectionTargets(command), ...extractSimpleCommandTargets(command)];
}

/**
 * Create a beforeToolCall hook that enforces file ownership.
 * Allows project self-check commands, but blocks write/edit/bash write targets outside owned directories.
 */
export function createOwnershipGuard(
	ownedDirectories: string[],
	outputDir: string,
): (context: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined> {
	const absoluteOwned = ownedDirectories.map((d) => resolve(outputDir, d));

	async function guard(context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> {
		const toolName = context.toolCall.name;
		const args = context.args as { command?: string; path?: string };
		const paths =
			toolName === "write" || toolName === "edit"
				? args.path
					? [args.path]
					: []
				: toolName === "bash"
					? extractBashWriteTargets(args.command ?? "")
					: [];
		if (paths.length === 0) return undefined;

		for (const path of paths) {
			const absPath = resolve(outputDir, path);
			const isOwned = isPathOwnedBy(absPath, absoluteOwned);

			if (!isOwned) {
				return {
					block: true,
					reason: `Cannot write to "${path}". This agent only owns: ${ownedDirectories.join(", ")}. All paths are relative to the project root.`,
				};
			}
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
