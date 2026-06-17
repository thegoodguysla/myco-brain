#!/usr/bin/env node
/**
 * export-detection check — PURE. Pins how the ~/Downloads watcher tells a ChatGPT
 * export from a Claude one by the file names inside the zip, and that it bails to
 * null on ambiguous/unrelated archives (so it never mis-ingests a random zip).
 */
const { detectExportKind } = await import("../dist/ingest-cli.lib.js");

let failed = 0;
const ok = (msg) => console.log(`ok    ${msg}`);
const fail = (msg) => { failed++; console.error(`FAIL  ${msg}`); };
const eq = (a, b, msg) => (a === b ? ok(msg) : fail(`${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`));

eq(detectExportKind(["conversations.json", "chat.html", "user.json", "message_feedback.json"]), "chatgpt-export", "ChatGPT export detected via chat.html/user.json");
eq(detectExportKind(["conversations.json", "projects.json", "users.json"]), "claude-export", "Claude export detected via projects.json/users.json");
eq(detectExportKind(["conversations.json"]), "chatgpt-export", "bare conversations.json defaults to ChatGPT");
eq(detectExportKind(["report.pdf", "photo.jpg"]), null, "unrelated zip -> null (never mis-ingests)");
eq(detectExportKind([]), null, "empty zip -> null");
eq(detectExportKind(["export/chat.html", "export/conversations.json"]), "chatgpt-export", "nested paths are matched by basename");
// ambiguous: both ChatGPT and Claude markers present -> null (don't guess)
eq(detectExportKind(["chat.html", "projects.json"]), null, "ambiguous (both markers) -> null");

console.log(failed === 0 ? "\n=== PASS (export-detect) ===" : `\n=== FAIL (${failed}) ===`);
process.exit(failed === 0 ? 0 : 1);
