/**
 * ChatGPT / Claude memory-export parsing — pure functions (unit-tested, no
 * I/O). The CLI (`mycobrain-ingest --from chatgpt-export|claude-export`) feeds
 * these the parsed conversations.json and ingests one document per
 * conversation, so months of assistant history become provenance-tracked,
 * deduplicated, searchable memory.
 *
 * ChatGPT exports store each conversation as a TREE (regenerations create
 * branches): `mapping` of nodes + `current_node` marking the active leaf. We
 * walk parent links from the active leaf (the canonical transcript) and fall
 * back to create_time order when the pointer is missing or corrupt.
 */

export interface ExportConversation {
  id: string;
  title: string;
  text: string;
  createdAt: string | null;
  updatedAt: string | null;
  messageCount: number;
}

const ts = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) {
    return new Date(v * 1000).toISOString();
  }
  if (typeof v === "string" && v.trim()) {
    const s = v.trim();
    const asNum = Number(s);
    if (Number.isFinite(asNum) && asNum > 1e9) return new Date(asNum * 1000).toISOString();
    const d = new Date(s.replace("Z", "+00:00"));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
};

const partText = (part: unknown): string => {
  if (typeof part === "string") return part.trim();
  if (part && typeof part === "object") {
    for (const key of ["text", "content", "name"]) {
      const v = (part as Record<string, unknown>)[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "";
};

interface Turn {
  role: string;
  text: string;
  createTime: unknown;
}

function chatGptMessage(node: unknown): Turn | null {
  if (!node || typeof node !== "object") return null;
  const message = (node as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  const author = m.author as Record<string, unknown> | undefined;
  const role = typeof author?.role === "string" ? author.role : "";
  const content = m.content as Record<string, unknown> | undefined;
  let text = "";
  if (content && Array.isArray(content.parts)) {
    text = content.parts.map(partText).filter(Boolean).join("\n").trim();
  } else if (typeof content?.text === "string") {
    text = content.text.trim();
  }
  if (!role || !text) return null;
  return { role, text, createTime: m.create_time };
}

/** Walk the active branch (current_node → parents), oldest first. */
function activePathNodeIds(
  obj: Record<string, unknown>,
  mapping: Record<string, unknown>
): string[] {
  let current = obj.current_node;
  if (typeof current !== "string" || !(current in mapping)) return [];
  const path: string[] = [];
  const seen = new Set<string>();
  while (typeof current === "string" && current in mapping && !seen.has(current)) {
    seen.add(current);
    path.push(current);
    const node = mapping[current];
    current =
      node && typeof node === "object"
        ? ((node as Record<string, unknown>).parent as string | undefined)
        : undefined;
  }
  return path.reverse();
}

function renderConversation(
  kind: "ChatGPT" | "Claude",
  id: string,
  title: string,
  createdAt: string | null,
  updatedAt: string | null,
  turns: Turn[]
): ExportConversation {
  const lines = [`${kind} Conversation: ${title}`, `Conversation ID: ${id}`];
  if (createdAt) lines.push(`Created: ${createdAt}`);
  if (updatedAt) lines.push(`Updated: ${updatedAt}`);
  lines.push("");
  for (const t of turns) {
    const when = ts(t.createTime);
    const label = t.role.charAt(0).toUpperCase() + t.role.slice(1);
    lines.push(when ? `${label} (${when}):` : `${label}:`);
    lines.push(t.text);
    lines.push("");
  }
  return {
    id,
    title,
    text: lines.join("\n").trim(),
    createdAt,
    updatedAt,
    messageCount: turns.length,
  };
}

/** Parse an OpenAI/ChatGPT data-export conversations.json array. */
export function parseChatGptConversations(raw: unknown): ExportConversation[] {
  if (!Array.isArray(raw)) {
    throw new Error("ChatGPT conversations.json must contain a JSON array");
  }
  const out: ExportConversation[] = [];
  for (const objRaw of raw) {
    if (!objRaw || typeof objRaw !== "object") continue;
    const obj = objRaw as Record<string, unknown>;
    const title = typeof obj.title === "string" && obj.title.trim()
      ? obj.title.trim()
      : "Untitled ChatGPT conversation";
    const mapping =
      obj.mapping && typeof obj.mapping === "object"
        ? (obj.mapping as Record<string, unknown>)
        : {};
    let nodeIds = activePathNodeIds(obj, mapping);
    if (nodeIds.length === 0) {
      nodeIds = Object.keys(mapping).sort((a, b) => {
        const t = (id: string): number => {
          const m = (mapping[id] as Record<string, unknown> | undefined)?.message;
          const ct = (m as Record<string, unknown> | undefined)?.create_time;
          return typeof ct === "number" ? ct : Number.POSITIVE_INFINITY;
        };
        return t(a) - t(b) || a.localeCompare(b);
      });
    }
    const turns = nodeIds
      .map((id) => chatGptMessage(mapping[id]))
      .filter((t): t is Turn => t !== null);
    const id = typeof obj.id === "string" && obj.id ? obj.id : `untitled-${out.length}`;
    const conv = renderConversation(
      "ChatGPT", id, title, ts(obj.create_time), ts(obj.update_time), turns
    );
    if (turns.length > 0) out.push(conv);
  }
  return out;
}

/** Parse a claude.ai data-export conversations.json array. */
export function parseClaudeConversations(raw: unknown): ExportConversation[] {
  if (!Array.isArray(raw)) {
    throw new Error("Claude conversations.json must contain a JSON array");
  }
  const out: ExportConversation[] = [];
  for (const objRaw of raw) {
    if (!objRaw || typeof objRaw !== "object") continue;
    const obj = objRaw as Record<string, unknown>;
    const title = typeof obj.name === "string" && obj.name.trim()
      ? obj.name.trim()
      : "Untitled Claude conversation";
    const messages = Array.isArray(obj.chat_messages) ? obj.chat_messages : [];
    const turns: Turn[] = [];
    for (const mRaw of messages) {
      if (!mRaw || typeof mRaw !== "object") continue;
      const m = mRaw as Record<string, unknown>;
      const role = typeof m.sender === "string" && m.sender ? m.sender : "unknown";
      let text = typeof m.text === "string" ? m.text.trim() : "";
      if (!text && Array.isArray(m.content)) {
        text = m.content.map(partText).filter(Boolean).join("\n").trim();
      }
      if (!text) continue;
      turns.push({ role, text, createTime: m.created_at });
    }
    const id = typeof obj.uuid === "string" && obj.uuid ? obj.uuid : `untitled-${out.length}`;
    const conv = renderConversation(
      "Claude", id, title,
      ts(obj.created_at), ts(obj.updated_at), turns
    );
    if (turns.length > 0) out.push(conv);
  }
  return out;
}
