import pg from "pg";
import { getPool, closePool, type SessionContext } from "./db.js";
import { getRelated } from "./tools/get-related.js";

const TEST_WORKSPACE_ID = "00000000-0000-0000-0000-000000005575";
const TEST_AGENT_ID = "the-575-load-test-agent";
const RELATION_COUNT = 1000;
const RUNS = 120;
const WARMUP_RUNS = 20;
const P95_BUDGET_MS = 200;

const ctx: SessionContext = {
  workspaceId: TEST_WORKSPACE_ID,
  principalRole: "agent",
  actorId: TEST_AGENT_ID,
  actorKind: "agent",
};

type Seeded = {
  sourceEntityId: string;
  sourceDocId: string;
};

const esc = (v: string) => `'${v.replace(/'/g, "''")}'`;

async function withTestTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL app.workspace_id = ${esc(TEST_WORKSPACE_ID)}`);
    await client.query(`SET LOCAL app.principal_role = ${esc("service")}`);
    await client.query(`SET LOCAL app.actor_id = ${esc(TEST_AGENT_ID)}`);
    await client.query(`SET LOCAL app.actor_kind = ${esc("agent")}`);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

async function seedData(): Promise<Seeded> {
  return withTestTx(async (client) => {
    await client.query(
      `INSERT INTO workspaces (workspace_id, name, slug, plan)
       VALUES ($1, 'THE-575 Load Test Workspace', 'the-575-load-test', 'pro')
       ON CONFLICT (workspace_id) DO UPDATE SET name = EXCLUDED.name`,
      [TEST_WORKSPACE_ID]
    );

    const entityKind = await client.query(`SELECT kind_id FROM entity_kinds ORDER BY kind_id ASC LIMIT 1`);
    const hyType = await client.query(`SELECT type_id FROM hyobject_types ORDER BY type_id ASC LIMIT 1`);
    const hySubtype = await client.query(`SELECT subtype_id FROM hyobject_subtypes ORDER BY subtype_id ASC LIMIT 1`);
    const sharing = await client.query(`SELECT sharing_type_id FROM sharing_types ORDER BY sharing_type_id ASC LIMIT 1`);

    if (!entityKind.rows[0] || !hyType.rows[0] || !hySubtype.rows[0] || !sharing.rows[0]) {
      throw new Error("required seed rows missing");
    }

    const srcDoc = await client.query(
      `INSERT INTO hyobjects (workspace_id, type_id, subtype_id, sharing_type_id, name)
       VALUES ($1, $2, $3, $4, 'THE-575 Source Doc')
       RETURNING hyobject_id`,
      [TEST_WORKSPACE_ID, hyType.rows[0].type_id, hySubtype.rows[0].subtype_id, sharing.rows[0].sharing_type_id]
    );
    const sourceDocId = srcDoc.rows[0].hyobject_id as string;

    const srcEntity = await client.query(
      `INSERT INTO entities (workspace_id, kind_id, canonical_name)
       VALUES ($1, $2, 'THE-575 Source Entity')
       RETURNING entity_id`,
      [TEST_WORKSPACE_ID, entityKind.rows[0].kind_id]
    );
    const sourceEntityId = srcEntity.rows[0].entity_id as string;

    const targetEntityRows = await client.query(
      `INSERT INTO entities (workspace_id, kind_id, canonical_name)
       SELECT $1, $2, 'THE-575 Target Entity ' || gs::text
       FROM generate_series(1, $3) gs
       RETURNING entity_id`,
      [TEST_WORKSPACE_ID, entityKind.rows[0].kind_id, RELATION_COUNT]
    );

    const targetEntityIds = targetEntityRows.rows.map((r) => r.entity_id as string);
    for (const targetEntityId of targetEntityIds) {
      await client.query(
        `INSERT INTO entity_relations (
          workspace_id, entity1_id, entity2_id, predicate, source_hyobject_id, confidence
        ) VALUES ($1, $2, $3, 'related_to', $4, 0.92)`,
        [TEST_WORKSPACE_ID, sourceEntityId, targetEntityId, sourceDocId]
      );
    }

    return { sourceEntityId, sourceDocId };
  });
}

async function cleanupData(): Promise<void> {
  await withTestTx(async (client) => {
    await client.query(`DELETE FROM entity_mentions WHERE workspace_id = $1`, [TEST_WORKSPACE_ID]);
    await client.query(`DELETE FROM entity_relations WHERE workspace_id = $1`, [TEST_WORKSPACE_ID]);
    await client.query(`DELETE FROM entities WHERE workspace_id = $1`, [TEST_WORKSPACE_ID]);
    await client.query(`DELETE FROM hyobjects WHERE workspace_id = $1`, [TEST_WORKSPACE_ID]);
    await client.query(`DELETE FROM workspaces WHERE workspace_id = $1`, [TEST_WORKSPACE_ID]);
  });
}

async function main(): Promise<void> {
  let seeded: Seeded | null = null;
  try {
    seeded = await seedData();
    const samples: number[] = [];

    for (let i = 0; i < RUNS + WARMUP_RUNS; i += 1) {
      const t0 = performance.now();
      const result = await getRelated(ctx, {
        subject_id: seeded.sourceEntityId,
        subject_kind: "entity",
        direction: "both",
        min_confidence: 0,
        include_vc: false,
        vc_limit_per_edge: 0,
        limit: RELATION_COUNT,
      });
      const elapsed = performance.now() - t0;

      if (result.count !== RELATION_COUNT) {
        throw new Error(`expected ${RELATION_COUNT} relations, got ${result.count}`);
      }
      if (i >= WARMUP_RUNS) {
        samples.push(elapsed);
      }
    }

    const edgeCaseStart = performance.now();
    const edgeCase = await getRelated(ctx, {
      subject_id: seeded.sourceEntityId,
      subject_kind: "entity",
      direction: "both",
      min_confidence: 0,
      include_vc: false,
      vc_limit_per_edge: 0,
      target_kinds: ["person"],
      limit: RELATION_COUNT,
    });
    const edgeCaseMs = performance.now() - edgeCaseStart;
    if (edgeCase.count !== 0) {
      throw new Error(`edge case expected 0 relations, got ${edgeCase.count}`);
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const p99 = percentile(sorted, 99);
    const max = sorted[sorted.length - 1] ?? 0;

    console.log(
      JSON.stringify(
        {
          ticket: "THE-575",
          relation_count: RELATION_COUNT,
          runs: RUNS,
          warmup_runs: WARMUP_RUNS,
          p50_ms: Number(p50.toFixed(2)),
          p95_ms: Number(p95.toFixed(2)),
          p99_ms: Number(p99.toFixed(2)),
          max_ms: Number(max.toFixed(2)),
          edge_case_zero_match_ms: Number(edgeCaseMs.toFixed(2)),
          pass: p95 < P95_BUDGET_MS,
          budget_ms: P95_BUDGET_MS,
        },
        null,
        2
      )
    );

    if (p95 >= P95_BUDGET_MS) {
      process.exitCode = 1;
    }
  } finally {
    if (seeded) {
      await cleanupData();
    }
    await closePool();
  }
}

void main().catch((err) => {
  console.error("[the-575-load-test] failed:", err);
  process.exit(1);
});
