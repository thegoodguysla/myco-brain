/**
 * Surfacing preference store — the brain owns mode + scope.
 *
 * Mode (silent | ambient | audit) and scope persist per WORKSPACE so behavior is
 * consistent across every client connected to the same brain (Claude, Cursor,
 * GPT, custom agents). A per-SESSION override (this stdio process == one client
 * session) lets the user say "audit for this task" without changing the workspace
 * default.
 *
 * Effective-mode precedence:
 *   session override > BRAIN_MODE env > workspace-persisted > Silent.
 *
 * Persisted under workspaces.settings->'surfacing' (jsonb) — no new table/migration.
 * Called inside withSession() in the server so RLS context is set; the workspace
 * row is the natural home for workspace-scoped config.
 */
import type pg from "pg";
import { coerceMode, DEFAULT_MODE, type SurfacingMode } from "./surfacing.js";

export interface SurfacingScope {
  workspace_id?: string | null;
  project?: string | null;
}

// ---- session override (in-memory; this process == one client session) ---------
let sessionMode: SurfacingMode | null = null;
let sessionScope: SurfacingScope | null = null;

export function setSessionMode(mode: SurfacingMode | null): void {
  sessionMode = mode;
}
export function getSessionMode(): SurfacingMode | null {
  return sessionMode;
}
export function setSessionScope(scope: SurfacingScope | null): void {
  sessionScope = scope;
}
export function getSessionScope(): SurfacingScope | null {
  return sessionScope;
}
/** Test helper: clear in-process session state. */
export function __resetSessionSurfacing(): void {
  sessionMode = null;
  sessionScope = null;
}

// ---- workspace-persisted prefs (workspaces.settings->'surfacing') -------------
export async function getWorkspaceSurfacing(
  client: pg.PoolClient,
  workspaceId: string
): Promise<{ mode: SurfacingMode | null; scope: SurfacingScope | null }> {
  const res = await client.query(
    `SELECT settings->'surfacing' AS s FROM workspaces WHERE workspace_id = $1`,
    [workspaceId]
  );
  const s = (res.rows[0]?.s ?? null) as
    | { mode?: string; scope?: SurfacingScope }
    | null;
  return { mode: coerceMode(s?.mode), scope: s?.scope ?? null };
}

/** Persist surfacing prefs by merging into workspaces.settings (jsonb). */
export async function setWorkspaceSurfacing(
  client: pg.PoolClient,
  workspaceId: string,
  patch: { mode?: SurfacingMode; scope?: SurfacingScope | null }
): Promise<void> {
  const clean: Record<string, unknown> = {};
  if (patch.mode !== undefined) clean.mode = patch.mode;
  if (patch.scope !== undefined) clean.scope = patch.scope;
  if (Object.keys(clean).length === 0) return;
  await client.query(
    `UPDATE workspaces
        SET settings = jsonb_set(
              COALESCE(settings, '{}'::jsonb),
              '{surfacing}',
              COALESCE(settings->'surfacing', '{}'::jsonb) || $2::jsonb,
              true
            )
      WHERE workspace_id = $1`,
    [workspaceId, JSON.stringify(clean)]
  );
}

// ---- effective resolution ----------------------------------------------------
export async function resolveEffectiveMode(
  client: pg.PoolClient,
  workspaceId: string
): Promise<SurfacingMode> {
  if (sessionMode) return sessionMode;
  const envMode = coerceMode(process.env.BRAIN_MODE);
  if (envMode) return envMode;
  const ws = await getWorkspaceSurfacing(client, workspaceId);
  return ws.mode ?? DEFAULT_MODE;
}

export async function resolveEffectiveScope(
  client: pg.PoolClient,
  workspaceId: string
): Promise<SurfacingScope | null> {
  if (sessionScope) return sessionScope;
  const ws = await getWorkspaceSurfacing(client, workspaceId);
  return ws.scope ?? null;
}
