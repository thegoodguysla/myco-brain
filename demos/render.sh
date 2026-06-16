#!/bin/bash
# Demo-as-code renderer. From mcp-server: `npm run demo:render -- <name|all>`
# Pipeline: VHS (deterministic terminal capture from tapes/) → ffmpeg
# (size-capped GIF, X cut, YouTube cut) → optional ElevenLabs narration mux
# (requires ELEVENLABS_API_KEY; silent cuts render regardless).
#
# Prereqs: vhs, ffmpeg, node, a built mcp-server (dist/), a migrated stack on
# DATABASE_URL (defaults to the docker-compose quickstart values).
set -euo pipefail
cd "$(dirname "$0")/.."   # myco-brain root

NAME="${1:-all}"
mkdir -p demos/out

render_one() {
  local name="$1"
  local tape="demos/tapes/${name}.tape"
  [ -f "$tape" ] || { echo "no tape: $tape"; exit 1; }

  echo "==> [$name] capture (vhs)"
  vhs "$tape"

  local gif="demos/out/${name}.gif"
  local mp4="demos/out/${name}.mp4"

  # README GIF must stay <10MB — re-encode from the mp4 with a tuned palette
  # if VHS's gif is too heavy.
  local size
  size=$(stat -f%z "$gif" 2>/dev/null || stat -c%s "$gif")
  if [ "$size" -gt 9500000 ]; then
    echo "==> [$name] GIF ${size}B too heavy — palette re-encode"
    ffmpeg -y -loglevel error -i "$mp4" \
      -vf "fps=12,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" \
      "$gif"
  fi

  # X cut: H.264 + faststart (and narration when available).
  local xcut="demos/out/${name}-x.mp4"
  if [ -n "${ELEVENLABS_API_KEY:-}" ] && [ -f "demos/narration/${name}.txt" ]; then
    local vo="demos/out/${name}-vo.mp3"
    # Cache narration: only re-synthesize when the script text changed.
    if [ ! -f "$vo" ] || [ "demos/narration/${name}.txt" -nt "$vo" ]; then
      echo "==> [$name] narration (ElevenLabs)"
      node demos/scripts/narrate.mjs "$name"
    else
      echo "==> [$name] narration cached"
    fi
    # Never clip the voiceover: if it outlasts the video, freeze the last
    # frame for the difference (+0.5s breath).
    local vdur adur pad
    vdur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$mp4")
    adur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$vo")
    pad=$(python3 -c "print(max(0, ${adur} - ${vdur} + 0.5))")
    ffmpeg -y -loglevel error -i "$mp4" -i "$vo" \
      -vf "tpad=stop_mode=clone:stop_duration=${pad}" \
      -c:v libx264 -pix_fmt yuv420p -movflags +faststart \
      -c:a aac "$xcut"
  else
    echo "==> [$name] no ELEVENLABS_API_KEY — silent X cut"
    ffmpeg -y -loglevel error -i "$mp4" \
      -c:v libx264 -pix_fmt yuv420p -movflags +faststart -an "$xcut"
  fi

  # YouTube cut: highest-quality H.264 — narrated when a voiceover exists.
  local vo_yt="demos/out/${name}-vo.mp3"
  if [ -f "$vo_yt" ]; then
    local vdur_yt adur_yt pad_yt
    vdur_yt=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$mp4")
    adur_yt=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$vo_yt")
    pad_yt=$(python3 -c "print(max(0, ${adur_yt} - ${vdur_yt} + 0.5))")
    ffmpeg -y -loglevel error -i "$mp4" -i "$vo_yt" \
      -vf "tpad=stop_mode=clone:stop_duration=${pad_yt}" \
      -c:v libx264 -crf 18 -pix_fmt yuv420p -movflags +faststart \
      -c:a aac "demos/out/${name}-youtube.mp4"
  else
    ffmpeg -y -loglevel error -i "$mp4" \
      -c:v libx264 -crf 18 -pix_fmt yuv420p -movflags +faststart \
      "demos/out/${name}-youtube.mp4"
  fi

  # Keep the committed README assets in sync with the latest render.
  if [ -d demos/media ]; then cp "$gif" "demos/media/${name}.gif"; fi

  echo "==> [$name] done:"
  ls -lh demos/out/${name}* | awk '{print "    " $9 "  " $5}'
}

if [ "$NAME" = "all" ]; then
  for t in demos/tapes/*.tape; do
    render_one "$(basename "$t" .tape)"
  done
else
  render_one "$NAME"
fi
