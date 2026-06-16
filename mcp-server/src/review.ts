#!/usr/bin/env node
/**
 * `mycobrain review` — curate what the LLM proposed before it becomes
 * canonical knowledge. This is the human-in-the-loop side of the trust dial:
 * in strict mode (BRAIN_REQUIRE_HUMAN_REVIEW=1) nothing lands without a
 * decision here, and in default mode novel entity kinds / relationship types
 * wait here until you approve them or turn on auto-promotion.
 *
 *   mycobrain review                 # list everything pending (default)
 *   mycobrain review approve <id>    # promote one proposal into the graph
 *   mycobrain review reject  <id>    # reject one proposal (kept, audited)
 *   mycobrain review approve --all   # promote every pending proposal
 *   mycobrain review reject  --all   # reject every pending proposal
 *
 * Zero-config against the quickstart stack (same defaults as the other CLIs).
 * Every action is workspace-scoped and recorded on the proposal row
 * (state + reviewed_at), so the audit trail stays intact — nothing is deleted.
 */
import "dotenv/config";
import pg from "pg";

const LOCALDEV_DATABASE_URL = "postgresql://brain:brain@localhost:5432/brain";
const LOCALDEV_API_KEY =
  "brain_00000000-0000-0000-0000-000000000001_00000000-0000-0000-0000-0000000000a1_localdev";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function workspaceFromKey(apiKey: string): string {
  const parts = apiKey.startsWith("brain_") ? apiKey.split("_") : [];
  if (!parts[1]) throw new Error("BRAIN_API_KEY is not a brain_<workspace>_<agent>_<secret> key.");
  return parts[1];
}

/** Approve one proposal (whichever table its id is in). Returns a label. */
async function approveProposal(
  client: pg.Client,
  ws: string,
  id: string
): Promise<string> {
  // ── schema type proposal → promote into the live catalog ──────────────────
  const sp = (await client.query(
    `SELECT proposal_type, name, state FROM schema_proposals WHERE id=$1 AND workspace_id=$2`,
    [id, ws]
  )).rows[0];
  if (sp) {
    if (sp.state !== "pending") return `type "${sp.name}" already ${sp.state} — skipped`;
    const table = sp.proposal_type === "entity_kind" ? "entity_kinds" : "relation_types";
    const idCol = sp.proposal_type === "entity_kind" ? "kind_id" : "relation_type_id";
    const existing = (await client.query(
      `SELECT ${idCol} AS id FROM ${table} WHERE lower(regexp_replace(name,'[_-]+',' ','g'))=lower(regexp_replace($1,'[_-]+',' ','g')) LIMIT 1`,
      [sp.name]
    )).rows[0];
    let appliedId = existing?.id;
    if (appliedId === undefined) {
      appliedId = (await client.query(
        `INSERT INTO ${table} (${idCol}, name) VALUES ((SELECT coalesce(max(${idCol}),0)+1 FROM ${table}), $1) RETURNING ${idCol} AS id`,
        [sp.name]
      )).rows[0].id;
    }
    await client.query(
      `UPDATE schema_proposals SET state='approved', applied_id=$2, reviewed_at=now() WHERE id=$1`,
      [id, appliedId]
    );
    return `promoted new ${sp.proposal_type.replace("_", " ")} "${sp.name}" into the catalog`;
  }

  // ── entity proposal → resolve-or-create the canonical entity + mention ─────
  const pe = (await client.query(
    `SELECT kind_id, canonical_name, aliases, source_hyobject_id, confidence, state
       FROM proposed_entities WHERE id=$1 AND workspace_id=$2`,
    [id, ws]
  )).rows[0];
  if (pe) {
    if (pe.state !== "pending") return `entity "${pe.canonical_name}" already ${pe.state} — skipped`;
    // Deliberate human approval: exact (case-insensitive) match or create new.
    const exact = (await client.query(
      `SELECT entity_id FROM entities WHERE workspace_id=$1 AND lower(canonical_name)=lower($2) LIMIT 1`,
      [ws, pe.canonical_name]
    )).rows[0];
    let entityId = exact?.entity_id;
    if (!entityId) {
      entityId = (await client.query(
        `INSERT INTO entities (workspace_id, kind_id, canonical_name, aliases)
         VALUES ($1,$2,$3,$4) RETURNING entity_id`,
        [ws, pe.kind_id, pe.canonical_name, pe.aliases ?? []]
      )).rows[0].entity_id;
    }
    if (pe.source_hyobject_id) {
      await client.query(
        `INSERT INTO entity_mentions (workspace_id, entity_id, hyobject_id, confidence)
         VALUES ($1,$2,$3,$4)`,
        [ws, entityId, pe.source_hyobject_id, pe.confidence]
      );
    }
    await client.query(
      `UPDATE proposed_entities SET state='approved', promoted_entity_id=$2, reviewed_at=now() WHERE id=$1`,
      [id, entityId]
    );
    return `promoted entity "${pe.canonical_name}" into the graph`;
  }

  // ── relation proposal → create the canonical edge between existing nodes ───
  const pr = (await client.query(
    `SELECT subject_id, object_id, predicate, source_hyobject_id, confidence, state
       FROM proposed_relations WHERE id=$1 AND workspace_id=$2`,
    [id, ws]
  )).rows[0];
  if (pr) {
    if (pr.state !== "pending") return `relation already ${pr.state} — skipped`;
    const ends = await client.query(
      `SELECT entity_id, canonical_name FROM entities WHERE workspace_id=$1 AND entity_id = ANY($2::uuid[])`,
      [ws, [pr.subject_id, pr.object_id]]
    );
    if (ends.rowCount !== 2) {
      return `cannot approve relation — one or both endpoints aren't in the graph yet (approve those entities first)`;
    }
    const existing = (await client.query(
      `SELECT id FROM entity_relations
        WHERE workspace_id=$1 AND entity1_id=$2 AND entity2_id=$3 AND predicate=$4
          AND (valid_to IS NULL OR valid_to > now()) LIMIT 1`,
      [ws, pr.subject_id, pr.object_id, pr.predicate]
    )).rows[0];
    if (!existing) {
      await client.query(
        `INSERT INTO entity_relations (workspace_id, entity1_id, entity2_id, predicate, source_hyobject_id, confidence)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [ws, pr.subject_id, pr.object_id, pr.predicate, pr.source_hyobject_id, pr.confidence]
      );
    }
    await client.query(
      `UPDATE proposed_relations SET state='approved', reviewed_at=now() WHERE id=$1`,
      [id]
    );
    const names = new Map(ends.rows.map((r) => [r.entity_id, r.canonical_name]));
    return `promoted relation ${names.get(pr.subject_id)} —${pr.predicate}→ ${names.get(pr.object_id)}`;
  }

  throw new Error(`no pending proposal with id ${id} in this workspace`);
}

/**
 * Resolve a (possibly short) id prefix to the one full pending proposal id it
 * matches — so users can copy the 8-char id the list prints. Errors if the
 * prefix matches zero or more than one pending proposal.
 */
async function resolvePrefix(client: pg.Client, ws: string, prefix: string): Promise<string> {
  const matches: string[] = [];
  for (const table of ["proposed_entities", "proposed_relations", "schema_proposals"]) {
    const r = await client.query(
      `SELECT id::text FROM ${table} WHERE workspace_id=$1 AND state='pending' AND id::text LIKE $2 || '%'`,
      [ws, prefix]
    );
    matches.push(...r.rows.map((x) => x.id));
  }
  if (matches.length === 0) throw new Error(`no pending proposal matching id "${prefix}"`);
  if (matches.length > 1) throw new Error(`id "${prefix}" is ambiguous (${matches.length} matches) — use more characters`);
  return matches[0];
}

async function rejectProposal(client: pg.Client, ws: string, id: string): Promise<string> {
  for (const table of ["proposed_entities", "proposed_relations", "schema_proposals"]) {
    const r = await client.query(
      `UPDATE ${table} SET state='rejected', reviewed_at=now()
        WHERE id=$1 AND workspace_id=$2 AND state='pending' RETURNING id`,
      [id, ws]
    );
    if (r.rowCount && r.rowCount > 0) return `rejected (${table.replace("proposed_", "").replace("_proposals", " type")})`;
  }
  return `no pending proposal with id ${id} — nothing rejected`;
}

async function listPending(client: pg.Client, ws: string): Promise<number> {
  const ents = (await client.query(
    `SELECT pe.id, ek.name AS kind, pe.canonical_name, round(pe.confidence,2) AS conf, h.name AS src
       FROM proposed_entities pe
       LEFT JOIN entity_kinds ek ON ek.kind_id = pe.kind_id
       LEFT JOIN hyobjects h ON h.hyobject_id = pe.source_hyobject_id
      WHERE pe.workspace_id=$1 AND pe.state='pending' ORDER BY pe.confidence DESC LIMIT 50`,
    [ws]
  )).rows;
  const rels = (await client.query(
    `SELECT pr.id, s.canonical_name AS subj, pr.predicate, o.canonical_name AS obj, round(pr.confidence,2) AS conf
       FROM proposed_relations pr
       LEFT JOIN entities s ON s.entity_id = pr.subject_id
       LEFT JOIN entities o ON o.entity_id = pr.object_id
      WHERE pr.workspace_id=$1 AND pr.state='pending' ORDER BY pr.confidence DESC LIMIT 50`,
    [ws]
  )).rows;
  const types = (await client.query(
    `SELECT id, proposal_type, name, seen_count, round(confidence,2) AS conf
       FROM schema_proposals WHERE workspace_id=$1 AND state='pending'
      ORDER BY seen_count DESC, confidence DESC LIMIT 50`,
    [ws]
  )).rows;

  const total = ents.length + rels.length + types.length;
  if (total === 0) {
    console.log(`\n  ${C.green("Review queue is empty")} — nothing waiting for a decision.\n`);
    return 0;
  }
  console.log(`\n  ${C.bold("Pending review")} ${C.dim(`(workspace ${ws.slice(0, 8)}…)`)}\n`);
  if (types.length) {
    console.log(`  ${C.cyan(`New schema types (${types.length})`)}`);
    for (const t of types) {
      console.log(`    ${C.dim(t.id.slice(0, 8))}  ${t.proposal_type === "entity_kind" ? "kind" : "rel "} ${C.bold(t.name)}  ${C.dim(`seen ${t.seen_count}× · conf ${t.conf}`)}`);
    }
    console.log("");
  }
  if (ents.length) {
    console.log(`  ${C.cyan(`Entities (${ents.length})`)}`);
    for (const e of ents) {
      console.log(`    ${C.dim(e.id.slice(0, 8))}  ${C.bold(e.canonical_name)}  ${C.dim(`${e.kind ?? "?"} · conf ${e.conf}${e.src ? " · " + e.src : ""}`)}`);
    }
    console.log("");
  }
  if (rels.length) {
    console.log(`  ${C.cyan(`Relationships (${rels.length})`)}`);
    for (const r of rels) {
      console.log(`    ${C.dim(r.id.slice(0, 8))}  ${C.bold(`${r.subj ?? "?"} —${r.predicate}→ ${r.obj ?? "?"}`)}  ${C.dim(`conf ${r.conf}`)}`);
    }
    console.log("");
  }
  console.log(`  ${C.dim("approve:")} mycobrain review approve <id>   ${C.dim("·  reject:")} mycobrain review reject <id>`);
  console.log(`  ${C.dim("bulk:")}    mycobrain review approve --all   ${C.dim("(or --all to reject)")}\n`);
  return total;
}

async function allPendingIds(client: pg.Client, ws: string): Promise<string[]> {
  // Types first (so entities of newly-approved kinds make sense), then
  // entities, then relations (whose endpoints must exist first).
  const ids: string[] = [];
  for (const table of ["schema_proposals", "proposed_entities", "proposed_relations"]) {
    const r = await client.query(
      `SELECT id FROM ${table} WHERE workspace_id=$1 AND state='pending' ORDER BY created_at ASC`,
      [ws]
    );
    ids.push(...r.rows.map((x) => x.id));
  }
  return ids;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // Allow either `mycobrain-review approve x` or `mycobrain review approve x`.
  const cmd = args[0] === "review" ? args[1] : args[0];
  const arg = args[0] === "review" ? args[2] : args[1];

  if (!process.env.DATABASE_URL && !process.env.SUPABASE_DB_URL) {
    process.env.DATABASE_URL = LOCALDEV_DATABASE_URL;
  }
  const ws = workspaceFromKey(process.env.BRAIN_API_KEY || LOCALDEV_API_KEY);
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    if (!cmd || cmd === "list") {
      await listPending(client, ws);
      return;
    }
    if (cmd !== "approve" && cmd !== "reject") {
      console.error(`Unknown command "${cmd}". Use: list | approve <id> | reject <id> (add --all for bulk).`);
      process.exitCode = 1;
      return;
    }
    const act = cmd === "approve" ? approveProposal : rejectProposal;

    if (arg === "--all") {
      const ids = await allPendingIds(client, ws);
      if (ids.length === 0) { console.log("Nothing pending."); return; }
      console.log(`${cmd === "approve" ? "Approving" : "Rejecting"} ${ids.length} pending proposal(s)…`);
      let done = 0;
      for (const id of ids) {
        await client.query("BEGIN");
        try {
          const msg = await act(client, ws, id);
          await client.query("COMMIT");
          console.log(`  ${C.green("✓")} ${msg}`);
          done++;
        } catch (err) {
          await client.query("ROLLBACK");
          console.error(`  ${C.red("✗")} ${id.slice(0, 8)}: ${(err as Error).message}`);
        }
      }
      console.log(`\n${cmd === "approve" ? "Approved" : "Rejected"} ${done}/${ids.length}.`);
      return;
    }

    if (!arg) {
      console.error(`Usage: mycobrain review ${cmd} <id>   (or --all)`);
      process.exitCode = 1;
      return;
    }
    const fullId = await resolvePrefix(client, ws, arg);
    await client.query("BEGIN");
    try {
      const msg = await act(client, ws, fullId);
      await client.query("COMMIT");
      console.log(`${C.green("✓")} ${msg}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
