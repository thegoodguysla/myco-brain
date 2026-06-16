# Demo corpus

A small, interconnected set of fictional documents (an AI marketing agency and
its client) used to populate a fresh Brain with realistic, cross-referenced
content. Ingest the folder, then query it from any connected agent — see the
[quickstart](../../docs/quickstart.md) for example prompts.

All names, clients, and numbers here are fictional.

The corpus deliberately contains a **contradiction**: `team.md` says Devin
Osei works for Lumen; the later `update-2026-06-02.md` says he now works for
Harbor & Co. With the extraction worker running (local Ollama is enough), the
trust engine supersedes the old fact instead of overwriting it — ask any
connected agent *"Who does Devin Osei work for? What changed, and how do you
know?"* and `brain_why` will show the superseded edge, the active one, and
the source documents for both.
