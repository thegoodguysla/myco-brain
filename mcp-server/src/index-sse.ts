// @ts-nocheck
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { createBrainMcpServer } from "./server-factory.js";
import { closePool, queryWithSslFallback } from "./db.js";

type ActiveTransport = StreamableHTTPServerTransport | SSEServerTransport;

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;
  return JSON.parse(raw);
}

function parseRequestTarget(req: IncomingMessage): { pathname: string; searchParams: URLSearchParams } {
  const requestTarget = req.url ?? "/";
  const [pathnamePart, searchPart] = requestTarget.split("?", 2);
  const pathname = pathnamePart && pathnamePart.length > 0 ? pathnamePart : "/";
  const searchParams = new URLSearchParams(searchPart ?? "");
  return { pathname, searchParams };
}

export async function runSseServer(): Promise<void> {
  const port = Number(process.env.PORT ?? "3000");
  const host = process.env.HOST ?? "0.0.0.0";
  const mcp = createBrainMcpServer();
  const transports = new Map<string, ActiveTransport>();

  const closeAllTransports = async () => {
    for (const [sessionId, transport] of transports) {
      try {
        await transport.close();
      } catch (error) {
        console.error(`Failed closing transport ${sessionId}:`, error);
      } finally {
        transports.delete(sessionId);
      }
    }
  };

  const httpServer = createServer(async (req, res) => {
    try {
      const { pathname: requestPath, searchParams } = parseRequestTarget(req);

      if ((req.method === "GET" || req.method === "HEAD") && (requestPath === "/health" || requestPath === "/healthz")) {
        let db: "ok" | "error" = "ok";
        let error: string | undefined;
        try {
          await queryWithSslFallback("SELECT 1");
        } catch (err) {
          db = "error";
          error = (err as Error).message;
        }
        const payload = {
          status: db === "ok" ? "ok" : "error",
          service: "brain-mcp-server",
          transport: "sse",
          uptime_seconds: Math.floor(process.uptime()),
          db,
          ...(error ? { error } : {}),
        };
        const statusCode = db === "ok" ? 200 : 503;
        if (req.method === "HEAD") {
          res.statusCode = statusCode;
          res.end();
          return;
        }
        writeJson(res, statusCode, payload);
        return;
      }

      if (requestPath === "/mcp") {
        const parsedBody = req.method === "POST" ? await readJsonBody(req) : undefined;
        const sessionIdHeader = req.headers["mcp-session-id"];
        const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

        let transport: StreamableHTTPServerTransport | undefined;
        const existing = sessionId ? transports.get(sessionId) : undefined;
        if (existing instanceof StreamableHTTPServerTransport) {
          transport = existing;
        } else if (req.method === "POST" && sessionId == null && parsedBody != null && isInitializeRequest(parsedBody)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              transports.set(newSessionId, transport!);
            },
          });
          transport.onclose = () => {
            if (transport?.sessionId) transports.delete(transport.sessionId);
          };
          await mcp.connect(transport);
        } else {
          writeJson(res, 400, {
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: No valid session ID provided" },
            id: null,
          });
          return;
        }

        await transport.handleRequest(req, res, parsedBody);
        return;
      }

      if (requestPath === "/sse" && req.method === "GET") {
        const transport = new SSEServerTransport("/messages", res);
        transports.set(transport.sessionId, transport);
        transport.onclose = () => {
          transports.delete(transport.sessionId);
        };
        await mcp.connect(transport);
        return;
      }

      if (requestPath === "/messages" && req.method === "POST") {
        const sessionId = searchParams.get("sessionId");
        if (!sessionId) {
          res.statusCode = 400;
          res.end("Missing sessionId parameter");
          return;
        }
        const existing = transports.get(sessionId);
        if (!(existing instanceof SSEServerTransport)) {
          res.statusCode = 404;
          res.end("Session not found");
          return;
        }
        const parsedBody = await readJsonBody(req);
        await existing.handlePostMessage(req, res, parsedBody);
        return;
      }

      writeJson(res, 404, { error: "not_found" });
    } catch (error) {
      console.error("MCP SSE server request failed:", error);
      writeJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  });

  const shutdown = async () => {
    await closeAllTransports();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await closePool();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });
  console.error(`[brain] MCP SSE server listening on http://${host}:${port}`);
}

void runSseServer().catch((error) => {
  console.error("Failed to start Brain MCP SSE server:", error);
  process.exit(1);
});
