import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TeamPlan, ValidationIssue } from "../types.js";

function issue(
	id: string,
	message: string,
	options: Omit<ValidationIssue, "id" | "message"> = { severity: "error" },
): ValidationIssue {
	return { id, message, ...options };
}

function existsOutput(outputDir: string, relativePath: string): boolean {
	return existsSync(join(outputDir, relativePath));
}

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function collectFiles(root: string, limit = 300): string[] {
	const files: string[] = [];
	const visit = (dir: string): void => {
		if (files.length >= limit || !existsSync(dir)) return;
		for (const entry of readdirSync(dir)) {
			if (entry === "node_modules" || entry === ".git") continue;
			const full = join(dir, entry);
			const stat = statSync(full);
			if (stat.isDirectory()) {
				visit(full);
			} else {
				files.push(full);
			}
		}
	};
	visit(root);
	return files;
}

function readProjectText(outputDir: string): string {
	return collectFiles(outputDir)
		.filter((file) => !file.split(/[\\/]/).join("/").includes("/docs/contracts/"))
		.filter((file) => /\.(ts|tsx|js|jsx|json|md|html|css)$/i.test(file))
		.map((file) => {
			try {
				return readFileSync(file, "utf-8");
			} catch {
				return "";
			}
		})
		.join("\n");
}

function getOpenApiPaths(outputDir: string): string[] {
	const openApi = readJson(join(outputDir, "docs/contracts/openapi.json"));
	const paths = openApi?.paths;
	if (!paths || typeof paths !== "object") return [];
	return Object.keys(paths);
}

/**
 * Check whether an OpenAPI path (e.g. /api/polls/{pollId}/votes) is represented
 * in the project source text. Matches against multiple patterns:
 *   - The path with params removed and slashes collapsed: /api/polls/votes
 *   - Express-style route: /api/polls/:pollId/votes
 *   - Just the meaningful segments joined: polls/votes
 */
function isOpenApiPathRepresented(apiPath: string, projectText: string): boolean {
	// Pattern 1: collapse {param} segments — /api/polls/{pollId}/votes → /api/polls/votes
	const collapsed = apiPath.replace(/\/\{[^}]+\}/g, "/");
	if (projectText.includes(collapsed)) return true;

	// Pattern 2: Express :param style — /api/polls/:pollId/votes
	const expressStyle = apiPath.replace(/\{([^}]+)\}/g, ":$1");
	if (projectText.includes(expressStyle)) return true;

	// Pattern 3: meaningful segments only — ["polls", "votes"] or ["auth", "register"]
	const segments = apiPath.split("/").filter((s) => s && !s.startsWith("{") && s !== "api");
	if (segments.length >= 2) {
		const tail = segments.join("/");
		if (projectText.includes(tail)) return true;
	}

	return false;
}

export function validateTeamOutput(outputDir: string, plan: TeamPlan): ValidationIssue[] {
	const issues: ValidationIssue[] = [];

	for (const contract of plan.contracts) {
		if (contract.required && !existsOutput(outputDir, contract.path)) {
			issues.push(
				issue(`missing-contract-${contract.kind}`, `Required contract is missing: ${contract.path}`, {
					severity: "error",
					ownerTaskId: contract.ownerTaskId,
					file: contract.path,
				}),
			);
		}
	}

	for (const task of plan.tasks) {
		for (const expected of task.expectedOutputs) {
			if (!existsOutput(outputDir, expected)) {
				issues.push(
					issue(
						`missing-output-${task.id}-${expected.replace(/[^a-z0-9]+/gi, "-")}`,
						`Task ${task.id} did not produce expected output: ${expected}`,
						{ severity: "error", ownerRole: task.role, ownerTaskId: task.id, file: expected },
					),
				);
			}
		}
	}

	const packageJsonPath = join(outputDir, "package.json");
	if (existsSync(packageJsonPath)) {
		const packageJson = readJson(packageJsonPath);
		const scripts = packageJson?.scripts;
		if (!packageJson) {
			issues.push(
				issue("invalid-package-json", "Root package.json is not valid JSON.", {
					severity: "error",
					file: "package.json",
				}),
			);
		} else if (!scripts || typeof scripts !== "object" || Object.keys(scripts).length === 0) {
			issues.push(
				issue("missing-package-scripts", "Root package.json must expose at least one useful script.", {
					severity: "error",
					ownerTaskId: "task-api",
					ownerRole: "api-builder",
					file: "package.json",
				}),
			);
		}
	}

	const openApiPaths = getOpenApiPaths(outputDir);
	if (openApiPaths.length > 0) {
		const projectText = readProjectText(outputDir);
		for (const apiPath of openApiPaths) {
			if (isOpenApiPathRepresented(apiPath, projectText)) continue;
			issues.push(
				issue(
					`missing-openapi-path-${apiPath.replace(/[^a-z0-9]+/gi, "-")}`,
					`OpenAPI path is not represented in implementation: ${apiPath}`,
					{
						severity: "error",
						ownerTaskId: "task-api",
						ownerRole: "api-builder",
					},
				),
			);
		}
	}

	return issues;
}
