/**
 * brain_self_check — the agent-callable "self-check that talks".
 *
 * One pull-only call that surfaces all three magic moments as STRUCTURED data the
 * LLM renders at the current mode's volume:
 *   - working   -> "it's working" (live document/chunk/embedding counts)
 *   - pending   -> "I need you to approve this" (the review backlog, as ProposedWrites)
 *   - problems  -> "I found a problem, here's the fix" (semantic off / backfill behind /
 *                  extraction backlog / pending blocking) each with a concrete fix
 *
 * Pull-only (never auto-injected), so it honors the token contract: it costs tokens
 * only when the agent invokes it (e.g. at session start in ambient/audit, or when the
 * user asks "how's the brain?"). Every number is read from the brain, not estimated.
 * The policy/types live in ../self-check.ts.
 */
import { z } from "zod";
import { withSession, type SessionContext } from "../db.js";
import { getEmbeddingProvider, activeEmbeddingTable } from "../embed.js";
import { resolveEffectiveMode } from "../surfacing-store.js";
import { buildProposedWrite, type ProposedWrite } from "../self-check.js";
import { confidenceBand, type SurfacingMode } from "../surfacing.js";
import { agentMemoryBreakdown, breakdownSummary, type AgentBreakdownEntry } from "../agent-provenance.js";

export const SelfCheckInput = z.object({
  pending_limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .default(5)
    .describe("Max pending approvals to return inline."),
});
export type SelfCheckInput = z.infer<typeof SelfCheckInput>;

export interface SelfCheckProblem {
  id: string;
  severity: "warn" | "fail";
  title: string;
  detail: string;
  fix: string;
}

export interface SelfCheckResult {
  mode: SurfacingMode;
  working: {
    documents: number;
    chunks: number;
    embedded_chunks: number | null;
    message: string;
    // Per-source-agent memory counts — makes cross-agent compounding visible
    // ("30 Claude Code, 8 Cursor"). Empty when only one agent has contributed.
    by_source: AgentBreakdownEntry[];
  };
  pending: {
    total: number;
    entities: number;
    relations: number;
    types: number;
    items: ProposedWrite[];
  };
  problems: SelfCheckProblem[];
  summary: string;
}

export async function selfCheck(
  ctx: SessionContext,
  input: SelfCheckInput
): Promise<SelfCheckResult> {
  return withSession(ctx, async (client) => {
    const ws = ctx.workspaceId;
    const mode = await resolveEffectiveMode(client, ws);
    const num = async (sql: string): Promise<number> =>
      Number((await client.query(sql, [ws])).rows[0]?.n ?? 0);

    const documents = await num(
      `SELECT count(*) n FROM hyobjects WHERE workspace_id = $1`
    );
    const chunks = await num(
      `SELECT count(*) n FROM chunks WHERE workspace_id = $1`
    );

    const provider = getEmbeddingProvider();
    let embedded_chunks: number | null = null;
    if (provider) {
      const tbl = activeEmbeddingTable();
      if (tbl) {
        embedded_chunks = await num(
          `SELECT count(*) n FROM ${tbl} e
             JOIN chunks c ON c.chunk_id = e.chunk_id
            WHERE c.workspace_id = $1`
        );
      }
    }

    const pe = await num(
      `SELECT count(*) n FROM proposed_entities WHERE workspace_id = $1 AND state = 'pending'`
    );
    const pr = await num(
      `SELECT count(*) n FROM proposed_relations WHERE workspace_id = $1 AND state = 'pending'`
    );
    const pt = await num(
      `SELECT count(*) n FROM schema_proposals WHERE workspace_id = $1 AND state = 'pending'`
    );
    const pendingTotal = pe + pr + pt;

    const items: ProposedWrite[] = [];
    if (pendingTotal > 0) {
      const rows = (
        await client.query(
          `SELECT pe.canonical_name AS name, ek.name AS kind,
                  pe.confidence AS conf, h.name AS src
             FROM proposed_entities pe
             LEFT JOIN entity_kinds ek ON ek.kind_id = pe.kind_id
             LEFT JOIN hyobjects h ON h.hyobject_id = pe.source_hyobject_id
            WHERE pe.workspace_id = $1 AND pe.state = 'pending'
            ORDER BY pe.confidence DESC
            LIMIT $2`,
          [ws, input.pending_limit]
        )
      ).rows;
      for (const r of rows) {
        items.push(
          buildProposedWrite({
            summary: `${r.name}${r.kind ? ` (${r.kind})` : ""}`,
            source: r.src ?? "extraction",
            confidenceBand: confidenceBand(r.conf != null ? Number(r.conf) : null),
          })
        );
      }
    }

    const problems: SelfCheckProblem[] = [];
    if (!provider) {
      problems.push({
        id: "no_embedding_provider",
        severity: "warn",
        title: "Semantic search is off",
        detail:
          "No embedding provider is configured, so recall is keyword-only (BM25).",
        fix: "Set BRAIN_OLLAMA_BASE_URL (keyless, local) or BRAIN_OPENAI_API_KEY, then backfill embeddings.",
      });
    } else if (
      embedded_chunks !== null &&
      chunks > 0 &&
      embedded_chunks < chunks
    ) {
      problems.push({
        id: "embeddings_behind",
        severity: "warn",
        title: "Some content isn't embedded yet",
        detail: `${embedded_chunks}/${chunks} chunks embedded; older content stays keyword-only until backfilled.`,
        fix: "Run the embeddings backfill to cover existing content.",
      });
    }

    let backlog = 0;
    try {
      backlog = await num(
        `SELECT count(*) n FROM chunk_extraction_status ces
           JOIN chunks c ON c.chunk_id = ces.chunk_id
          WHERE c.workspace_id = $1 AND ces.status IN ('pending','failed')`
      );
    } catch {
      /* table may be absent on very old schemas — ignore */
    }
    if (backlog > 0) {
      problems.push({
        id: "extraction_backlog",
        severity: "warn",
        title: "Knowledge-graph extraction is behind",
        detail: `${backlog} chunks are awaiting entity/relation extraction.`,
        fix: "Ensure the extraction worker is running and a provider (Ollama/Anthropic) is configured.",
      });
    }

    if (pendingTotal > 0) {
      problems.push({
        id: "pending_approvals",
        severity: "warn",
        title: `${pendingTotal} item${pendingTotal === 1 ? "" : "s"} awaiting your approval`,
        detail: `${pe} entities, ${pr} relations, ${pt} new types are pending review. Facts of unknown kinds wait here until approved.`,
        fix: "Approve in chat, or run: mycobrain review (use --all to bulk-approve).",
      });
    }

    const bySource = await agentMemoryBreakdown(client, ws);
    const crossAgent = breakdownSummary(bySource);
    const working = {
      documents,
      chunks,
      embedded_chunks,
      by_source: bySource,
      message:
        documents > 0
          ? `Memory is live: ${documents} documents, ${chunks} chunks${
              embedded_chunks != null ? `, ${embedded_chunks} embedded` : ""
            }.${crossAgent ? ` Across agents — ${crossAgent}.` : ""}`
          : "Memory is empty — ingest something to get started.",
    };

    const summary =
      problems.length === 0
        ? `Myco healthy. ${working.message}`
        : `Myco needs attention: ${problems.map((p) => p.title).join("; ")}.`;

    return {
      mode,
      working,
      pending: { total: pendingTotal, entities: pe, relations: pr, types: pt, items },
      problems,
      summary,
    };
  });
}
