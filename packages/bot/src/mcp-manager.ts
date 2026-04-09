/**
 * MCP (Model Context Protocol) manager.
 *
 * Connects to configured MCP servers, discovers their tools,
 * and wraps them as AgentTools for the bot's agent.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type TSchema, Type } from "@sinclair/typebox";
import type { McpServerConfig } from "./config.js";

interface McpConnection {
	name: string;
	client: Client;
	transport: StdioClientTransport;
}

export class McpManager {
	private connections: McpConnection[] = [];
	private tools: AgentTool[] = [];

	constructor(private servers: Record<string, McpServerConfig>) {}

	/**
	 * Connect to all configured MCP servers and discover their tools.
	 */
	async start(): Promise<void> {
		const entries = Object.entries(this.servers);
		if (entries.length === 0) return;

		for (const [name, config] of entries) {
			try {
				await this.connectServer(name, config);
			} catch (err) {
				console.error(`Failed to connect MCP server "${name}":`, err instanceof Error ? err.message : err);
			}
		}
	}

	/**
	 * Disconnect all MCP servers.
	 */
	async stop(): Promise<void> {
		for (const conn of this.connections) {
			try {
				await conn.client.close();
			} catch {
				// Ignore close errors
			}
		}
		this.connections = [];
		this.tools = [];
	}

	/**
	 * Get all discovered MCP tools as AgentTools.
	 */
	getTools(): AgentTool[] {
		return this.tools;
	}

	private async connectServer(name: string, config: McpServerConfig): Promise<void> {
		const transport = new StdioClientTransport({
			command: config.command,
			args: config.args,
			env: config.env ? ({ ...process.env, ...config.env } as Record<string, string>) : undefined,
		});

		const client = new Client({ name: `bot-mcp-${name}`, version: "1.0.0" });
		await client.connect(transport);

		this.connections.push({ name, client, transport });

		// Discover tools
		const result = await client.listTools();
		for (const tool of result.tools) {
			this.tools.push(this.wrapMcpTool(name, client, tool));
		}

		console.log(`MCP server "${name}": connected, ${result.tools.length} tool(s)`);
	}

	private wrapMcpTool(
		serverName: string,
		client: Client,
		mcpTool: { name: string; description?: string; inputSchema?: Record<string, unknown> },
	): AgentTool {
		const toolName = `mcp__${serverName}__${mcpTool.name}`;

		// Convert MCP JSON Schema to TypeBox schema
		const parameters = this.convertSchema(mcpTool.inputSchema);

		return {
			name: toolName,
			label: mcpTool.name,
			description: mcpTool.description || `MCP tool: ${mcpTool.name} (server: ${serverName})`,
			parameters,
			execute: async (_toolCallId: string, params: unknown): Promise<AgentToolResult<undefined>> => {
				const args = params as Record<string, unknown>;
				const result = await client.callTool({ name: mcpTool.name, arguments: args });
				const textParts: string[] = [];
				if (Array.isArray(result.content)) {
					for (const part of result.content) {
						if (part.type === "text") {
							textParts.push((part as { type: "text"; text: string }).text);
						}
					}
				}
				return {
					content: [{ type: "text", text: textParts.join("\n") || "(no output)" }],
					details: undefined,
				};
			},
		};
	}

	private convertSchema(inputSchema?: Record<string, unknown>): TSchema {
		if (!inputSchema || !inputSchema.properties) {
			return Type.Object({});
		}

		// Build TypeBox schema from JSON Schema properties
		const props: Record<string, TSchema> = {};
		const properties = inputSchema.properties as Record<string, Record<string, unknown>>;
		const required = (inputSchema.required as string[]) || [];

		for (const [key, prop] of Object.entries(properties)) {
			let schema: TSchema;
			const type = prop.type as string;
			const description = prop.description as string | undefined;

			switch (type) {
				case "string":
					schema = Type.String();
					break;
				case "number":
				case "integer":
					schema = Type.Number();
					break;
				case "boolean":
					schema = Type.Boolean();
					break;
				case "array":
					schema = Type.Array(Type.Unknown());
					break;
				case "object":
					schema = Type.Record(Type.String(), Type.Unknown());
					break;
				default:
					schema = Type.Unknown();
					break;
			}

			if (description) {
				schema = { ...schema, description };
			}

			if (!required.includes(key)) {
				schema = Type.Optional(schema);
			}

			props[key] = schema;
		}

		return Type.Object(props);
	}
}
