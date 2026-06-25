/**
 * brain_set_mode — the hook for natural-language surfacing controls.
 *
 * The agent calls this when the user gives a visibility/control instruction:
 *   "run silently" / "turn off stats"        -> mode: "silent"
 *   "show your sources" / "this is for a client" -> mode: "audit"
 *   "just confirm it's working"               -> mode: "ambient"
 *   "audit THIS task" (one-off)               -> mode: "audit", persist: false
 *
 * persist:true (default) saves the mode as the workspace default so it follows the
 * user across every client connected to the same brain. persist:false applies to
 * this session only. Either way the in-process session override takes effect now.
 */
import { z } from "zod";
import { withSession, type SessionContext } from "../db.js";
import {
  setSessionMode,
  setSessionScope,
  setWorkspaceSurfacing,
  resolveEffectiveMode,
  resolveEffectiveScope,
  type SurfacingScope,
} from "../surfacing-store.js";
import type { SurfacingMode } from "../surfacing.js";

export const SetModeInput = z.object({
  mode: z
    .enum(["silent", "ambient", "audit"])
    .optional()
    .describe(
      "Visibility mode. silent = invisible, ~0 tokens (default); ambient = one cheap status line when memory shaped the answer; audit = full provenance, for client/legal/financial work."
    ),
  scope: z
    .object({ project: z.string().nullable().optional() })
    .nullable()
    .optional()
    .describe("Optional: narrow what Myco draws on (e.g. a project). null clears scope."),
  persist: z
    .boolean()
    .default(true)
    .describe(
      "true (default): save as the workspace default so it follows the user across clients. false: this session only (e.g. 'audit for this task')."
    ),
});
export type SetModeInput = z.infer<typeof SetModeInput>;

export interface SetModeResult {
  mode: SurfacingMode;
  scope: SurfacingScope | null;
  persisted: boolean;
  message: string;
}

export async function setMode(
  ctx: SessionContext,
  input: SetModeInput
): Promise<SetModeResult> {
  return withSession(ctx, async (client) => {
    // In-process session override takes effect immediately.
    if (input.mode !== undefined) setSessionMode(input.mode);
    if (input.scope !== undefined) setSessionScope(input.scope ?? null);

    // Persist as the workspace default unless this is a one-off.
    if (input.persist) {
      const patch: { mode?: SurfacingMode; scope?: SurfacingScope | null } = {};
      if (input.mode !== undefined) patch.mode = input.mode;
      if (input.scope !== undefined) patch.scope = input.scope ?? null;
      if (Object.keys(patch).length > 0) {
        await setWorkspaceSurfacing(client, ctx.workspaceId, patch);
      }
    }

    const mode = await resolveEffectiveMode(client, ctx.workspaceId);
    const scope = await resolveEffectiveScope(client, ctx.workspaceId);
    return {
      mode,
      scope,
      persisted: !!input.persist,
      message: `Surfacing mode is now "${mode}"${
        input.persist ? " (saved as the workspace default)" : " (this session only)"
      }.`,
    };
  });
}
