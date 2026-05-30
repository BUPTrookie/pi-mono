/**
 * @mariozechner/pi-agent-team
 *
 * Multi-agent team orchestrator for full-stack development.
 */

export { createBashSafetyGuard, explainUnsafeBash } from "./agent/bash-safety.js";
export { createOwnershipGuard, isPathOwned } from "./agent/file-ownership.js";
export { runTeamAgent, type TeamAgentConfig } from "./agent/team-agent.js";
export { buildToolPool } from "./agent/tool-pool.js";
export { createRoleRegistry } from "./roles/role-registry.js";
export { buildRoleSystemPrompt, getSystemPrompt } from "./roles/system-prompts.js";
export { TaskGraph } from "./task/task-graph.js";
export { TaskScheduler } from "./task/task-scheduler.js";
export {
	createRepairTasks,
	createRoleRegistry as createPlanRoleRegistry,
	llmPlannerRunner,
	parsePlannerOutput,
	taskFromSpec,
	writeContracts,
} from "./team/planner.js";
export { TeamLead } from "./team/team-lead.js";
export { createTeamRun, runTeam } from "./team/team-runner.js";
export { type RuntimeValidationOptions, validateTeamOutput, validateTeamOutputWithChecks } from "./team/validator.js";
export { runTeamTui } from "./tui/team-tui.js";
export type {
	AgentRoleName,
	ApprovalDecision,
	ContractSpec,
	GeneratedContracts,
	InterventionMode,
	PlannerDiagnostic,
	PlannerOptions,
	PlannerResult,
	PlannerRunner,
	RepairTask,
	RoleDefinition,
	RoleSpec,
	Task,
	TaskResult,
	TaskSpec,
	TaskStatus,
	TeamConfig,
	TeamEvent,
	TeamEventListener,
	TeamPlan,
	TeamResult,
	TeamRun,
	ValidationIssue,
	ValidationSeverity,
} from "./types.js";
export { createLogger } from "./utils/logger.js";
