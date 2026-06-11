/**
 * Content sanitization — strips injected memory tags to prevent feedback loops.
 *
 * This is a defensive guard. If the system (or any upstream process) ever injects
 * metadata markers like [memory:id:xxx] or [[ref:yyy]] into content, those tags
 * would be re-ingested on subsequent brain_save_memory calls, creating a feedback
 * loop where metadata accumulates inside content.
 *
 */

/** Single-bracket system tags: [namespace:value] or [namespace:value:extra] */
const MEMORY_TAG_RE = /\[(?:memory|brain|mcp|system|hyobject|chunk|ref|source|id):[^\]]+\]/gi;

/** Double-bracket system tags with namespace prefix: [[namespace:value]] */
const WIKI_TAG_RE = /\[\[(?:memory|brain|mcp|system|hyobject|chunk|ref|source|id):[^\]]+\]\]/gi;

/** HTML comments (may contain injected metadata) */
const HTML_COMMENT_RE = /<!--.*?-->/gs;

/**
 * Strip injected memory tags from content.
 * Returns the sanitized string. Idempotent — safe to call multiple times.
 */
export function sanitize(content: string): string {
  let cleaned = content;
  // WIKI_TAG_RE must run FIRST — otherwise single-bracket regex
  // partially matches [[namespace:value]] and leaves stray [].
  cleaned = cleaned.replace(WIKI_TAG_RE, "");
  cleaned = cleaned.replace(MEMORY_TAG_RE, "");
  cleaned = cleaned.replace(HTML_COMMENT_RE, "");

  cleaned = cleaned.replace(/ {3,}/g, "  ");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  cleaned = cleaned.trim();

  return cleaned;
}
