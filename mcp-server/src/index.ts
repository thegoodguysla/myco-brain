#!/usr/bin/env node
/**
 * Brain MCP Server — @brain/mcp-server
 *
 * Exposes 11 core tools over MCP stdio transport:
 *   brain_context_pack   — primary context assembly
 *   brain_search         — hybrid search (vector + full-text + filters)
 *   brain_why            — provenance chain inspection
 *   brain_neighbors      — knowledge graph traversal
 *   brain_ingest         — file/URL/text ingestion
 *   brain_propose_fact   — agent fact proposals
 *   brain_annotate       — agent breadcrumb notes
 *   brain_save_memory    — simplified agent memory ingestion
 *   brain_recall_memory  — agent-scoped semantic recall
 *   brain_get_related    — relational context query with provenance
 *   brain_stats          — workspace memory-health snapshot
 *
 * Authentication: BRAIN_API_KEY (brain_<workspaceId>_<agentId>_<secret>)
 *             or  BRAIN_SERVICE_ROLE_KEY (Supabase service-role JWT)
 *
 * Database: DATABASE_URL or SUPABASE_DB_URL (PostgreSQL connection string)
 */
import "dotenv/config";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ATTRIBUTION_CONTRACT_CLAUSE } from "./attribution.js";
import { RUNTIME_CONTRACT } from "./agent-instructions.js";
import { z } from "zod";

import { resolveAuth } from "./auth.js";
import { withLogging } from "./logger.js";
import { closePool, queryWithSslFallback } from "./db.js";
import { canonicalizeAgentContext } from "./agent-identity.js";

import { contextPack, ContextPackInput } from "./tools/context-pack.js";
import { search, SearchInput } from "./tools/search.js";
import { why, WhyInput } from "./tools/why.js";
import { neighbors, NeighborsInput } from "./tools/neighbors.js";
import { ingest, IngestInput } from "./tools/ingest.js";
import { proposeFact, ProposeFactInput } from "./tools/propose-fact.js";
import { annotate, AnnotateInput } from "./tools/annotate.js";
import { saveMemory, SaveMemoryInput } from "./tools/save-memory.js";
import { recallMemory, RecallMemoryInput } from "./tools/recall-memory.js";
import { getRelated, GetRelatedInput } from "./tools/get-related.js";
import { stats, StatsInput } from "./tools/stats.js";
import { setMode, SetModeInput } from "./tools/set-mode.js";
import { selfCheck, SelfCheckInput } from "./tools/check.js";
import { getRetrievalObservabilitySnapshot } from "./retrieval-observability.js";

// ---------------------------------------------------------------------------
// Tool manifest
// ---------------------------------------------------------------------------

export const TOOLS: Tool[] = [
  {
    name: "brain_context_pack",
    description:
      "Primary context assembly. Runs hybrid search and returns chunks, entities, people, session notes, and relational context for a natural language query. Call this first when you need information from the knowledge base.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language query" },
        embedding: {
          type: "array",
          items: { type: "number" },
          description: "Pre-computed query embedding (optional; 1536-dim for OpenAI, 768-dim for Ollama). Usually omit — the server embeds the query.",
        },
        limit: {
          type: "number",
          description: "Max chunks to return (default 10, max 50)",
        },
        context_token_budget: {
          type: "number",
          description: "Optional token budget for returned chunks; enables deterministic compaction",
        },
        include_entities: { type: "boolean", default: true },
        include_people: { type: "boolean", default: true },
        include_session_notes: { type: "boolean", default: false },
        include_relational_context: { type: "boolean", default: true },
        relational_limit: {
          type: "number",
          description: "Max relation edges to return (default 25, max 100)",
        },
        hyobject_types: {
          type: "array",
          items: { type: "number" },
          description: "Filter by type_ids",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "brain_search",
    description:
      "Hybrid search with structured filters. Supports vector similarity, full-text, and filters by type, people, entity, and date range.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        embedding: { type: "array", items: { type: "number" } },
        filters: {
          type: "object",
          properties: {
            type_ids: { type: "array", items: { type: "number" } },
            people_ids: { type: "array", items: { type: "string" } },
            entity_ids: { type: "array", items: { type: "string" } },
            created_after: { type: "string", format: "date-time" },
            created_before: { type: "string", format: "date-time" },
          },
        },
        limit: { type: "number" },
        offset: { type: "number" },
        sort: {
          type: "string",
          enum: ["score", "date_desc", "date_asc"],
        },
      },
      required: ["query"],
    },
  },
  {
    name: "brain_why",
    description:
      "Provenance chain inspection. Traces where a hyobject, entity, or person came from — including the VC audit trail, source documents, and promoted proposals.",
    inputSchema: {
      type: "object",
      properties: {
        hyobject_id: { type: "string", format: "uuid" },
        entity_id: { type: "string", format: "uuid" },
        people_id: { type: "string", format: "uuid" },
        entity_a_id: { type: "string", format: "uuid" },
        entity_b_id: { type: "string", format: "uuid" },
        limit_vc: { type: "number", description: "Max VC entries (default 20)" },
      },
    },
  },
  {
    name: "brain_neighbors",
    description:
      "Knowledge graph traversal. Returns the neighbourhood of a hyobject, entity, or person — edges and connected nodes.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", format: "uuid" },
        node_kind: { type: "string", enum: ["hyobject", "entity", "person"] },
        depth: { type: "number", enum: [1, 2] },
        relation_types: { type: "array", items: { type: "number" } },
        limit: { type: "number" },
      },
      required: ["node_id", "node_kind"],
    },
  },
  {
    name: "brain_ingest",
    description:
      "The default write path. Hand the engine a source (a document, transcript, thread, or decision record) and it extracts entities and relations, attaches a source and a confidence score to each, runs contradiction-and-supersession against existing facts, and folds them into the workspace graph. This is the primary way truth enters Myco: prefer it over asserting conclusions, and feed two or three independent sources when a fact matters so confidence compounds. Requires a configured extractor (local Ollama or Anthropic) to build the graph; without one the source is still stored and fully searchable, but no entities or relations are extracted.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["text", "url", "file"] },
        text: { type: "string", description: "Raw text (mode=text)" },
        url: { type: "string", description: "URL to ingest (mode=url)" },
        file_content_base64: { type: "string", description: "Base64 file bytes (mode=file)" },
        file_name: { type: "string" },
        mime_type: { type: "string" },
        name: { type: "string" },
        type_id: { type: "number" },
        subtype_id: { type: "number" },
        sharing_type_id: { type: "number" },
        tags: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["mode"],
    },
  },
  {
    name: "brain_propose_fact",
    description:
      "Submit a structured claim (subject, predicate, object) when you believe something is true but have no source to ingest. It enters a gated review queue as a candidate, not canonical truth, and is promoted when a reviewer approves it or a later ingested source naming the same entity corroborates it over the auto-promote threshold (default 0.6), arriving with that source attached. Register undocumented beliefs honestly here; use brain_ingest whenever a source exists.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["entity", "relation"] },
        // entity fields
        entity_kind_id: { type: "number" },
        canonical_name: { type: "string" },
        aliases: { type: "array", items: { type: "string" } },
        source_hyobject_id: { type: "string", format: "uuid" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        // relation fields
        subject_kind: { type: "string", enum: ["hyobject", "person", "entity"] },
        subject_id: { type: "string", format: "uuid" },
        object_kind: { type: "string", enum: ["hyobject", "person", "entity"] },
        object_id: { type: "string", format: "uuid" },
        predicate: { type: "string" },
        relation_type_id: { type: "number" },
      },
      required: ["kind"],
    },
  },
  {
    name: "brain_annotate",
    description:
      "Attach a lightweight note to the current session for continuity (observation, decision, question, or fact). Not extracted, not adjudicated, not durable workspace truth; retrievable via brain_context_pack with include_session_notes=true. Reach for brain_ingest when the thing you learned should outlive the session.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["observation", "decision", "question", "fact"],
        },
        content: { type: "string" },
        session_id: {
          type: "string",
          format: "uuid",
          description: "Existing session ID (optional)",
        },
        related_hyobject_id: { type: "string", format: "uuid" },
      },
      required: ["kind", "content"],
    },
  },
  {
    name: "brain_save_memory",
    description:
      "Your PRIVATE scratchpad, not workspace truth. An ungated, direct write scoped to YOUR agent only: confidence is hardcoded to 1.0, nothing is extracted, no provenance is recorded, and only you can recall it (brain_recall_memory). Use it strictly for private working notes within a session, never for facts the workspace or other agents should trust or cite. If a source backs the fact, ingest the source; if it is shared truth, it does not belong here.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The memory content to save",
        },
        tags: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Key-value tags for filtering (e.g. {project: 'myco', topic: 'graph'})",
        },
        source_label: {
          type: "string",
          description: "Label for the source of this memory (default: agent_memory)",
        },
        idempotency_key: {
          type: "string",
          description:
            "Optional unique key for retry-safe writes (same key = same write). Auto-generated if omitted.",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "brain_get_related",
    description:
      "Relational context query with provenance. Returns related nodes for a subject with edge metadata, direction, and VC/source provenance references.",
    inputSchema: {
      type: "object",
      properties: {
        subject_id: { type: "string", format: "uuid" },
        subject_kind: { type: "string", enum: ["hyobject", "entity", "person"] },
        target_kinds: {
          type: "array",
          items: { type: "string", enum: ["hyobject", "entity", "person"] },
        },
        relation_type_ids: { type: "array", items: { type: "number" } },
        min_confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Minimum relation confidence threshold (default 0)",
        },
        direction: { type: "string", enum: ["outbound", "inbound", "both"] },
        include_vc: { type: "boolean", default: true },
        vc_limit_per_edge: { type: "number", description: "Default 5, max 20" },
        limit: { type: "number", description: "Default 25, max 100" },
      },
      required: ["subject_id", "subject_kind"],
    },
  },
  {
    name: "brain_recall_memory",
    description:
      "Recall an agent's OWN saved memories and session notes only — NOT documents ingested into the workspace. For ingested files, documents, or general workspace knowledge, use brain_context_pack (preferred) or brain_search instead. Optionally filter to a specific agent. Returns the agent's memory chunks, matching entities, and recent session notes.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language query for recall",
        },
        embedding: {
          type: "array",
          items: { type: "number" },
          description: "Pre-computed query embedding (optional; 1536-dim for OpenAI, 768-dim for Ollama). Usually omit — the server embeds the query.",
        },
        agent_id: {
          type: "string",
          description: "Scope recall to a specific agent's memories. If omitted, searches caller's own memories.",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 10, max 50)",
        },
        include_entities: { type: "boolean", default: true },
        reranker: {
          type: "string",
          enum: ["none", "cohere"],
          default: "none",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "brain_stats",
    description:
      "Memory health snapshot for the workspace: documents and chunks stored, knowledge-graph size, how much of the graph is source-backed (provenance), proposed facts pending review, and idempotent write counts. Read-only. Use it to show that the memory is structured and traceable, not a noisy pile.",
    inputSchema: {
      type: "object",
      properties: {
      },
    },
  },
  {
    name: "brain_set_mode",
    description:
      "Set how visible Myco is (and optionally its scope). silent = invisible, ~0 tokens (default); ambient = one cheap status line when memory shaped the answer; audit = full provenance, for client/legal/financial work. Call this on a user visibility instruction: 'run silently'/'turn off stats' -> silent; 'just confirm it's working' -> ambient; 'show your sources'/'this is for a client' -> audit. Use persist:false for a one-off task ('audit THIS'); persist:true (default) saves it as the workspace default so it follows the user across clients.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["silent", "ambient", "audit"],
          description: "Visibility mode.",
        },
        scope: {
          type: "object",
          properties: { project: { type: ["string", "null"] } },
          description: "Optional: narrow what Myco draws on (e.g. a project).",
        },
        persist: {
          type: "boolean",
          description:
            "Save as workspace default (true, default) vs this session only (false).",
        },
      },
    },
  },
  {
    name: "brain_self_check",
    description:
      "Agent-callable health + attention check (the self-check that talks). Returns structured signals: working (live document/chunk/embedding counts = 'it's working'), pending (the review backlog awaiting the user's approval), and problems (semantic search off, embeddings/extraction behind, approvals blocking) each with a concrete fix. Pull-only and token-cheap. Call it at the start of a session in ambient/audit mode, or whenever the user asks 'how's the brain?' or something seems off. Surface problems + pending approvals to the user; never invent numbers.",
    inputSchema: {
      type: "object",
      properties: {
        pending_limit: {
          type: "number",
          description: "Max pending approvals to return inline (default 5).",
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

// Usage contract delivered to every connected agent at initialization — the
// MCP `instructions` field. This is what makes memory work well out of the
// box: clients surface it to their model, so agents know WHEN to recall,
// save, and cite without any per-project setup. Deeper policy: docs/agent-setup.md.
const SERVER_INSTRUCTIONS = `${RUNTIME_CONTRACT}
${ATTRIBUTION_CONTRACT_CLAUSE}`;

const { version: PACKAGE_VERSION } = createRequire(import.meta.url)(
  "../package.json"
) as { version: string };

const server = new Server(
  { name: "brain", version: PACKAGE_VERSION },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!args || typeof args !== "object") {
    return errorResponse("Missing tool arguments");
  }

  const rawArgs = args as Record<string, unknown>;

  // By default the stdio server derives identity ONLY from its environment
  // (BRAIN_API_KEY / BRAIN_SERVICE_ROLE_KEY) — caller-supplied api_key /
  // workspace_id / agent_id in the tool args are IGNORED, so a malicious or
  // prompt-injected agent cannot override identity to reach another workspace.
  // Multi-tenant gateways that legitimately pass per-request identity opt in
  // with BRAIN_TRUST_REQUEST_IDENTITY=1.
  const trustRequestIdentity = process.env.BRAIN_TRUST_REQUEST_IDENTITY === "1";
  let auth: ReturnType<typeof resolveAuth>;
  try {
    auth = resolveAuth(
      trustRequestIdentity
        ? {
            apiKey: rawArgs.api_key as string | undefined,
            workspaceId: rawArgs.workspace_id as string | undefined,
            agentId: rawArgs.agent_id as string | undefined,
          }
        : {}
    );
  } catch (err) {
    return errorResponse(`Auth error: ${(err as Error).message}`);
  }

  const ctx = await canonicalizeAgentContext(auth.ctx, {
    rawApiKey: auth.rawKey,
  });

  try {
    switch (name) {
      case "brain_context_pack": {
        const input = ContextPackInput.parse(rawArgs);
        const result = await withLogging(name, ctx.workspaceId, ctx.actorId, rawArgs, () =>
          contextPack(ctx, input)
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "brain_search": {
        const input = SearchInput.parse(rawArgs);
        const result = await withLogging(name, ctx.workspaceId, ctx.actorId, rawArgs, () =>
          search(ctx, input)
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "brain_why": {
        const input = WhyInput.parse(rawArgs);
        const result = await withLogging(name, ctx.workspaceId, ctx.actorId, rawArgs, () =>
          why(ctx, input)
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "brain_neighbors": {
        const input = NeighborsInput.parse(rawArgs);
        const result = await withLogging(name, ctx.workspaceId, ctx.actorId, rawArgs, () =>
          neighbors(ctx, input)
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "brain_ingest": {
        const input = IngestInput.parse(rawArgs);
        const result = await withLogging(name, ctx.workspaceId, ctx.actorId, rawArgs, () =>
          ingest(ctx, input)
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "brain_propose_fact": {
        const input = ProposeFactInput.parse(rawArgs);
        const result = await withLogging(name, ctx.workspaceId, ctx.actorId, rawArgs, () =>
          proposeFact(ctx, input)
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "brain_annotate": {
        const input = AnnotateInput.parse(rawArgs);
        const result = await withLogging(name, ctx.workspaceId, ctx.actorId, rawArgs, () =>
          annotate(ctx, input)
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "brain_save_memory": {
        const input = SaveMemoryInput.parse(rawArgs);
        const result = await withLogging(name, ctx.workspaceId, ctx.actorId, rawArgs, () =>
          saveMemory(ctx, input)
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "brain_recall_memory": {
        const input = RecallMemoryInput.parse(rawArgs);
        const result = await withLogging(name, ctx.workspaceId, ctx.actorId, rawArgs, () =>
          recallMemory(ctx, input)
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "brain_get_related": {
        const input = GetRelatedInput.parse(rawArgs);
        const result = await withLogging(name, ctx.workspaceId, ctx.actorId, rawArgs, () =>
          getRelated(ctx, input)
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "brain_stats": {
        const input = StatsInput.parse(rawArgs);
        const result = await withLogging(name, ctx.workspaceId, ctx.actorId, rawArgs, () =>
          stats(ctx, input)
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "brain_set_mode": {
        const input = SetModeInput.parse(rawArgs);
        const result = await withLogging(name, ctx.workspaceId, ctx.actorId, rawArgs, () =>
          setMode(ctx, input)
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "brain_self_check": {
        const input = SelfCheckInput.parse(rawArgs);
        const result = await withLogging(name, ctx.workspaceId, ctx.actorId, rawArgs, () =>
          selfCheck(ctx, input)
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      default:
        return errorResponse(`Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse(`Validation error: ${err.issues.map((i) => i.message).join("; ")}`);
    }
    console.error(`[brain] Tool ${name} error:`, err);
    return errorResponse(`Tool error: ${(err as Error).message}`);
  }
});

function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: `ERROR: ${message}` }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const healthPort = Number.parseInt(process.env.BRAIN_HEALTH_PORT ?? "", 10);
  let healthServer: ReturnType<typeof createServer> | null = null;
  if (Number.isFinite(healthPort) && healthPort > 0) {
    healthServer = createServer(async (req, res) => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";

      if ((method === "GET" || method === "HEAD") && (url === "/health" || url === "/healthz")) {
        const payload: {
          status: "ok" | "error";
          service: string;
          transport: string;
          uptime_seconds: number;
          db: "ok" | "error";
          retrieval_observability: ReturnType<typeof getRetrievalObservabilitySnapshot>;
          error?: string;
        } = {
          status: "ok",
          service: "brain-mcp-server",
          transport: "stdio",
          uptime_seconds: Math.floor(process.uptime()),
          db: "ok",
          retrieval_observability: getRetrievalObservabilitySnapshot(),
        };

        try {
          await queryWithSslFallback("SELECT 1");
        } catch (err) {
          payload.status = "error";
          payload.db = "error";
          payload.error = (err as Error).message;
        }

        const statusCode = payload.status === "ok" ? 200 : 503;
        const body = JSON.stringify(payload);
        res.statusCode = statusCode;
        res.setHeader("content-type", "application/json; charset=utf-8");
        if (method === "HEAD") {
          res.end();
          return;
        }
        res.end(body);
        return;
      }

      if ((method === "GET" || method === "HEAD") && url === "/health/retrieval") {
        const body = JSON.stringify({
          status: "ok",
          service: "brain-mcp-server",
          retrieval_observability: getRetrievalObservabilitySnapshot(),
        });
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        if (method === "HEAD") {
          res.end();
          return;
        }
        res.end(body);
        return;
      }

      res.statusCode = 404;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "not_found" }));
    });

    healthServer.listen(healthPort, "0.0.0.0", () => {
      console.error(`[brain] Health endpoint listening on http://0.0.0.0:${healthPort}/health`);
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[brain] MCP server running on stdio");

  process.on("SIGTERM", async () => {
    console.error("[brain] Shutting down...");
    if (healthServer) {
      await new Promise<void>((resolve) => healthServer?.close(() => resolve()));
    }
    await closePool();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[brain] Fatal error:", err);
  process.exit(1);
});
