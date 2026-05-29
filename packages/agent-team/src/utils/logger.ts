import chalk from "chalk";

const ROLE_COLORS: Record<string, (text: string) => string> = {
	"team-lead": chalk.cyan,
	"api-builder": chalk.green,
	"ui-builder": chalk.hex("#FF6B6B"),
	"project-builder": chalk.yellow,
	"integration-writer": chalk.hex("#4ECDC4"),
};

export function createLogger(role: string) {
	const color = ROLE_COLORS[role] ?? chalk.white;
	const tag = color(`[${role}]`);

	return {
		info: (message: string) => console.log(`${tag} ${message}`),
		warn: (message: string) => console.warn(`${tag} ${chalk.yellow(message)}`),
		error: (message: string) => console.error(`${tag} ${chalk.red(message)}`),
		success: (message: string) => console.log(`${tag} ${chalk.green(message)}`),
	};
}

export type Logger = ReturnType<typeof createLogger>;
