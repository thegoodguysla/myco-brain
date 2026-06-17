/**
 * The "copy agent instructions" artifact — the paste-anywhere operating manual
 * that teaches an agent to use Myco as the adjudication engine it is, not a
 * notepad. The MCP server hands a tight runtime contract to connected clients;
 * this is the richer version to drop into a CLAUDE.md, .cursorrules, or Codex
 * AGENTS.md. It is the single source of truth shared by `mycobrain-install`
 * (which prints it), docs/agent-instructions.md, and the website.
 *
 * The load-bearing line, carried verbatim across every surface:
 *   "The agent that feeds the engine well gets a workspace that grows more
 *    certain over time. The agent that dumps assertions gets noise."
 * Keep it tool-accurate — every brain_* name and mechanic below is real. If the
 * tool contract or the engine changes, change it here.
 */

export const DEFAULT_SERVER_NAME = "myco-brain";

/**
 * The tight contract injected into every connected agent at init. index.ts
 * appends the attribution clause to this; the eval harness scores against it.
 * Single-sourced here so the server and the eval never diverge.
 */
export const RUNTIME_CONTRACT = `Myco is not a notepad. It is an adjudication engine: the program writes the canonical facts - each with a source, a confidence score, and an audit trail. Feed it well; do not assert into it.
- Start a task? Call brain_context_pack FIRST - the workspace may already know what you're about to work out. Build on it, don't re-derive.
- Learned something durable? Hand over the SOURCE, not your conclusion: brain_ingest the doc/transcript/message and the engine extracts the facts with provenance and confidence. This is the default write path.
- When a fact matters, feed two or three INDEPENDENT sources - confidence compounds as they corroborate, capped below certainty. One source can't corroborate itself.
- Conflicts with what's stored? Never overwrite - ingest the new source and the program supersedes the old fact, keeping the history.
- A claim with no document? brain_propose_fact (waits in review; promoted by an approval or a later corroborating source). About to rely on a fact? brain_why first.
- brain_save_memory is your PRIVATE scratchpad - ungated, never extracted, never workspace truth. Never cite it.

The agent that feeds the engine well gets a workspace that grows more certain over time. The agent that dumps assertions gets noise.`;

export function renderAgentInstructions(serverName: string = DEFAULT_SERVER_NAME): string {
  return `# Working with Myco: the truth layer

Myco is a deterministic adjudication engine that sits under your workspace
(connected as the "${serverName}" MCP server) and holds its shared, durable
truth. The distinction that governs everything below: the program writes the
canonical facts, not you. Every fact Myco stores carries a source it came from,
a confidence score it earned, and an audit trail you can replay. You do not
assert facts into Myco. You feed it evidence, and it adjudicates. Treat truth as
something you accumulate evidence toward, not something you declare.

## The engine, in four mechanics

1. Compounding confidence (feed corroboration, not repetition). When two or
   three independent sources support the same fact, Myco combines their evidence
   with a damped noisy-OR and confidence rises - but the cap sits below 1.0, so
   the engine is never certain and dissent always has room to move it.
   Corroboration is deduplicated by source: the same document ingested twice
   does not self-corroborate. The lever: when a fact is load-bearing, don't say
   it louder - feed a second and third independent source. That is how you make
   the workspace measurably more sure.

2. Supersede, don't overwrite (contradiction is preserved). On functional
   predicates (works-for, reports-to, located-in - where only one value can be
   true at a time), a confident new fact that conflicts with a stored one does
   not replace it. The engine closes the old fact (valid_to = now()), damps its
   confidence, and records the change in a claims ledger with the new fact
   pointing back via superseded_by. Nothing is silently deleted; the history
   stays queryable. So when reality changes, you do not edit the old fact - you
   ingest the new source and let the engine retire the old one, reason on record.

3. Provenance is first-class (every fact answers "why" and "since when").
   brain_why returns the source chain behind a fact, its current confidence, and
   whether it is contested by a competing claim. A fact at 0.55 with one source
   is a lead; a fact at 0.9 across three independent sources is something you can
   stand on. Cite the source, not your recollection.

4. Propose -> review -> promote (gated claims, honestly). A structured claim
   with no underlying document goes through brain_propose_fact into a review
   queue - it is not canonical yet. It promotes one of two ways: a reviewer
   approves it (mycobrain review approve), or a later ingested source naming the
   same entity carries it over the workspace's auto-promote confidence threshold
   (default 0.6). Either way it arrives with the source attached. (A separate
   mechanic governs the schema itself: when a brand-new KIND of entity or
   relation keeps recurring - seen >= 3 times at confidence >= 0.8 - the engine
   can promote that new type into the catalog automatically. The vocabulary
   earns its way up from evidence, same as the facts do.)

## The write ladder (always climb from the top)

1. brain_ingest - the default, and the only path that builds the graph. Hand the
   program a source: a doc, transcript, thread, spec, decision record. The engine
   extracts entities and relations, attaches provenance and confidence to each,
   runs contradiction-and-supersession, and folds them into the graph. Prefer raw
   sources over your summary - the program extracts better truth from the original
   than from your paraphrase, and the source becomes the citation. (Needs a
   configured extractor - local Ollama or Anthropic. Without one the source is
   still stored and fully searchable, but no graph is built until you wire one up;
   run mycobrain-doctor to check.)

2. brain_propose_fact - when you have a claim but no document. A structured
   assertion (subject, predicate, object) into the gated review queue. Use it
   when something is true but undocumented; it stays a candidate until a reviewer
   approves it or a later ingested source corroborates it over the auto-promote
   threshold. Honest by design: a proposal is a candidate, not a fact.

3. brain_save_memory - your private scratchpad. The anti-pattern for truth. An
   ungated, direct write, hardcoded to confidence 1.0, scoped to YOUR agent
   identity, with NO extraction and NO provenance. Only you recall it
   (brain_recall_memory); it is invisible to the workspace and other agents, and
   must never be cited as shared truth. A sticky note, not a fact. Reach for it
   last and rarely.

4. brain_annotate - a session breadcrumb. Lightweight context for the current
   thread. Not durable workspace truth.

## Reading (before writing, and before relying)

- brain_context_pack - call FIRST on any task; returns relevant prior decisions,
  entities, and documents so you build on the workspace instead of duplicating it.
- brain_search - full-text / semantic search across ingested sources.
- brain_why - provenance: source chain, confidence, contested status.
- brain_neighbors / brain_get_related - walk the graph from an entity.
- brain_recall_memory - your own private notes only.
- brain_stats - workspace health and coverage.

## Power patterns

- Corroborate what matters. A decision, a constraint, a key relationship? Feed it
  from multiple independent sources so confidence compounds. Save the cheap
  single-source ingest for low-stakes context.
- Resolve conflicts by ingesting, never by editing. New reality -> new source ->
  let supersession run. You get the change and the trail of why.
- Cite from provenance, not memory. Run brain_why and quote the source. If a fact
  is contested or thinly sourced, say so rather than launder it into certainty.
- Promote beliefs with evidence. Propose the undocumented claim; when you later
  ingest the source that backs it, the engine closes the loop.
- Read before you write. context_pack first means you corroborate existing facts
  instead of forking near-duplicates the engine must then reconcile.

## When NOT to use brain_save_memory

It is the most tempting tool and the easiest way to pollute a workspace, because
it skips every safeguard the engine exists to provide. Do not use it to:
- Record anything the team or other agents should trust - it is private to you.
  Ingest the source instead.
- Store a fact that has a source - brain_ingest it so the fact arrives with
  provenance and earned confidence, not a hardcoded 1.0.
- Assert a contested or changing fact - save_memory cannot supersede or be
  superseded, and will drift out of sync with the adjudicated truth.
- Fake certainty - its 1.0 is a storage default, not earned confidence.
- Store secrets, credentials, or session chatter - never, in any tool.

Use it only for genuinely private, agent-local working notes ("I already checked
the staging logs this session") that no one else should see or cite.

The agent that feeds the engine well gets a workspace that grows more certain
over time. The agent that dumps assertions gets noise.
`;
}

export const AGENT_INSTRUCTIONS = renderAgentInstructions();
