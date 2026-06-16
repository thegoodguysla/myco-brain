#!/usr/bin/env node
// ElevenLabs narration for a demo: reads demos/narration/<name>.txt, writes
// demos/out/<name>-vo.mp3. Requires ELEVENLABS_API_KEY (default stock voice).
import { readFileSync, writeFileSync } from "node:fs";
const name = process.argv[2];
const key = process.env.ELEVENLABS_API_KEY;
if (!name || !key) { console.error("usage: narrate.mjs <name> (needs ELEVENLABS_API_KEY)"); process.exit(1); }
const text = readFileSync(`demos/narration/${name}.txt`, "utf8").trim();
const voice = process.env.ELEVENLABS_VOICE_ID ?? "SAz9YHcvj6GT2YYXdXww"; // premade "River" (free-tier accessible)
const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
  method: "POST",
  headers: { "xi-api-key": key, "Content-Type": "application/json" },
  body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
});
if (!res.ok) { console.error(`ElevenLabs error ${res.status}: ${await res.text()}`); process.exit(1); }
writeFileSync(`demos/out/${name}-vo.mp3`, Buffer.from(await res.arrayBuffer()));
console.log(`wrote demos/out/${name}-vo.mp3`);
