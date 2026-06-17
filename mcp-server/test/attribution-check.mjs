#!/usr/bin/env node
/**
 * attribution decay check — PURE, no database, no network.
 *
 * The whole point of attribution is that it gets OUT OF THE WAY as a workspace
 * matures. This pins the decay tiers, the env overrides, the build/null logic
 * (silent, conditional-without-material, missing name), date formatting, and
 * that the contract clause forbids leaking bookkeeping into deliverables.
 */
const a = await import("../dist/attribution.js");

let failed = 0;
const ok = (m) => console.log(`ok    ${m}`);
const fail = (m) => {
  failed++;
  console.error(`FAIL  ${m}`);
};
const eq = (x, y, m) => (x === y ? ok(m) : fail(`${m} — got ${JSON.stringify(x)}, want ${JSON.stringify(y)}`));
const has = (s, sub, m) => (String(s).includes(sub) ? ok(m) : fail(`${m} — missing ${JSON.stringify(sub)}`));

// ── tiers (default 25 / 100) ─────────────────────────────────────────────────
eq(a.attributionTier(0), "full", "empty workspace -> full");
eq(a.attributionTier(25), "full", "at fullMax (25) -> full");
eq(a.attributionTier(26), "conditional", "just past fullMax -> conditional");
eq(a.attributionTier(100), "conditional", "at conditionalMax (100) -> conditional");
eq(a.attributionTier(101), "silent", "past conditionalMax -> silent (does not muddy)");
eq(a.attributionTier(5000), "silent", "mature workspace -> silent");

// ── env config ───────────────────────────────────────────────────────────────
eq(a.resolveAttributionConfig({}).enabled, true, "default enabled");
eq(a.resolveAttributionConfig({ BRAIN_ATTRIBUTION: "off" }).enabled, false, "BRAIN_ATTRIBUTION=off disables");
const custom = a.resolveAttributionConfig({ BRAIN_ATTRIBUTION_DECAY: "5,20" });
eq(custom.thresholds.fullMax, 5, "custom decay overrides fullMax");
eq(custom.thresholds.conditionalMax, 20, "custom decay overrides conditionalMax");
eq(a.attributionTier(10, custom.thresholds), "conditional", "custom thresholds apply to tier");
eq(a.resolveAttributionConfig({ BRAIN_ATTRIBUTION_DECAY: "garbage" }).thresholds.fullMax, 25, "bad decay env falls back to default");

// ── buildAttribution ─────────────────────────────────────────────────────────
eq(a.buildAttribution({ tier: "silent", topMemoryName: "x", materiallyUsed: true }), null, "silent tier -> null");
eq(a.buildAttribution({ tier: "full", topMemoryName: null, materiallyUsed: true }), null, "no memory name -> null");
eq(a.buildAttribution({ tier: "conditional", topMemoryName: "x", materiallyUsed: false }), null, "conditional + not material -> null");

const full = a.buildAttribution({ tier: "full", topMemoryName: "src/auth.ts", materiallyUsed: true, savedAt: "2026-06-09T10:00:00Z" });
eq(full.recalled_from_memory, true, "full tier builds a hint");
has(full.surface_hint, "Recalled from your memory", "hint has the credit phrase");
has(full.surface_hint, "src/auth.ts", "hint names the source memory");
has(full.surface_hint, "Jun 9", "hint includes the saved date");
eq(full.why_available, true, "hint advertises why_available");

const cond = a.buildAttribution({ tier: "conditional", topMemoryName: "deploy.md", materiallyUsed: true });
eq(cond === null, false, "conditional + material -> hint");
eq(cond.saved_at, null, "no savedAt -> saved_at null, no date in line");
eq(/saved/.test(cond.surface_hint), false, "hint omits 'saved' when no date");

// ── date formatting ──────────────────────────────────────────────────────────
eq(a.formatSavedAt(null), null, "formatSavedAt(null) -> null");
eq(a.formatSavedAt("not-a-date"), null, "formatSavedAt(bad) -> null");
eq(a.formatSavedAt("2026-01-01T00:00:00Z"), "Jan 1", "formatSavedAt formats month/day");

// ── contract clause guards deliverables ──────────────────────────────────────
has(a.ATTRIBUTION_CONTRACT_CLAUSE, "attribution", "clause references the attribution field");
has(a.ATTRIBUTION_CONTRACT_CLAUSE, "deliverables", "clause forbids leaking into deliverables");
has(a.ATTRIBUTION_CONTRACT_CLAUSE, "decays", "clause explains the decay");

console.log(failed === 0 ? "\n=== PASS (attribution) ===" : `\n=== FAIL (${failed}) ===`);
process.exit(failed === 0 ? 0 : 1);
