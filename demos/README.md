# Demos-as-code

Every demo is version-controlled code that re-renders deterministically on any
release — no screen recording, no manual steps.

```bash
# prereqs: vhs, ffmpeg, node, built mcp-server (npm run build), a migrated
# stack on DATABASE_URL (defaults to the docker-compose quickstart values)
cd mcp-server
npm run demo:render -- watch-it-remember      # or: compounding-confidence | all
```

| Demo | What it shows | Source of truth |
|---|---|---|
| `watch-it-remember` | save → ask days later → recall → `brain_why` provenance trail | `test/quickstart-e2e.mjs` |
| `compounding-confidence` | corroboration raises confidence; a confident contradiction supersedes (never overwrites); the claims ledger keeps history | `npm run test:compounding` |

**Outputs per demo** (in `demos/out/`, gitignored): README GIF (<10MB, silent),
`-x.mp4` (X/social, H.264, narrated when `ELEVENLABS_API_KEY` is set — silent
otherwise), `.webm` (landing page), `-youtube.mp4` (high quality).

**How it works:** `tapes/*.tape` (VHS) capture `scripts/*.mjs` — presentation-
paced scenarios that drive the REAL tool code paths (no mocks) and pre-clean
their own rows so re-renders are deterministic. `render.sh` post-processes with
ffmpeg (palette-tuned GIF re-encode if >9.5MB, faststart MP4s) and muxes
ElevenLabs narration from `narration/*.txt` when a key is available.
