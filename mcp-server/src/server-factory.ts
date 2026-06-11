import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const JsonArgs = z.object({}).passthrough();

type ToolModule = Record<string, unknown>;

type AuthModule = {
  resolveAuth: (args: { apiKey?: string; workspaceId?: string; agentId?: string }) => { ctx: unknown };
};

type AgentIdentityModule = {
  canonicalizeAgentContext: (ctx: unknown) => Promise<unknown>;
};

type LoggerModule = {
  withLogging: <T>(
    name: string,
    workspaceId: string,
    actorId: string,
    rawArgs: Record<string, unknown>,
    fn: () => Promise<T>
  ) => Promise<T>;
};

async function invokeTool(
  toolName: string,
  args: Record<string, unknown>,
  modulePath: string,
  schemaExport: string,
  handlerExport: string
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const [authMod, identityMod, loggerMod, toolMod] = (await Promise.all([
    import("./auth.js"),
    import("./agent-identity.js"),
    import("./logger.js"),
    import(modulePath),
  ])) as [AuthModule, AgentIdentityModule, LoggerModule, ToolModule];

  const auth = authMod.resolveAuth({
    apiKey: args.api_key as string | undefined,
    workspaceId: args.workspace_id as string | undefined,
    agentId: args.agent_id as string | undefined,
  });
  const ctx = await identityMod.canonicalizeAgentContext(auth.ctx as unknown);
  const inputSchema = toolMod[schemaExport] as unknown as { parse: (value: unknown) => unknown };
  const handler = toolMod[handlerExport] as unknown as (
    ctx: unknown,
    input: unknown
  ) => Promise<unknown>;
  const input = inputSchema.parse(args);

  const typedCtx = ctx as { workspaceId: string; actorId: string };
  const result = await loggerMod.withLogging(
    toolName,
    typedCtx.workspaceId,
    typedCtx.actorId,
    args,
    () => handler(ctx, input)
  );
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

function registerLazyTool(
  server: McpServer,
  toolName: string,
  description: string,
  modulePath: string,
  schemaExport: string,
  handlerExport: string
): void {
  server.tool(toolName, description, JsonArgs.shape, async (rawArgs) => {
    const args = JsonArgs.parse(rawArgs) as Record<string, unknown>;
    return invokeTool(toolName, args, modulePath, schemaExport, handlerExport);
  });
}

export function createBrainMcpServer(): McpServer {
  const server = new McpServer({ name: "brain", version: "0.1.0" });

  registerLazyTool(
    server,
    "brain_context_pack",
    "Primary context assembly. Runs hybrid search and returns chunks, entities, people, and session notes.",
    "./tools/context-pack.js",
    "ContextPackInput",
    "contextPack"
  );
  registerLazyTool(
    server,
    "brain_search",
    "Hybrid search with structured filters.",
    "./tools/search.js",
    "SearchInput",
    "search"
  );
  registerLazyTool(
    server,
    "brain_why",
    "Provenance chain inspection for objects, entities, and relations.",
    "./tools/why.js",
    "WhyInput",
    "why"
  );
  registerLazyTool(
    server,
    "brain_neighbors",
    "Knowledge graph traversal for neighboring nodes.",
    "./tools/neighbors.js",
    "NeighborsInput",
    "neighbors"
  );
  registerLazyTool(
    server,
    "brain_ingest",
    "Ingest text, URLs, or files into the knowledge base.",
    "./tools/ingest.js",
    "IngestInput",
    "ingest"
  );
  registerLazyTool(
    server,
    "brain_propose_fact",
    "Propose new entities or relations for review.",
    "./tools/propose-fact.js",
    "ProposeFactInput",
    "proposeFact"
  );
  registerLazyTool(
    server,
    "brain_annotate",
    "Save a session breadcrumb note.",
    "./tools/annotate.js",
    "AnnotateInput",
    "annotate"
  );
  registerLazyTool(
    server,
    "brain_save_memory",
    "Save agent memory for later recall.",
    "./tools/save-memory.js",
    "SaveMemoryInput",
    "saveMemory"
  );
  registerLazyTool(
    server,
    "brain_recall_memory",
    "Recall agent-scoped memory from the knowledge base.",
    "./tools/recall-memory.js",
    "RecallMemoryInput",
    "recallMemory"
  );
  registerLazyTool(
    server,
    "brain_get_related",
    "Return related entities, documents, and provenance.",
    "./tools/get-related.js",
    "GetRelatedInput",
    "getRelated"
  );
  registerLazyTool(
    server,
    "brain_stats",
    "Memory health snapshot: document, entity, relation, and source-backed counts.",
    "./tools/stats.js",
    "StatsInput",
    "stats"
  );

  return server;
}
