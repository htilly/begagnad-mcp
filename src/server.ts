import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type Env,
  searchBlocket,
  getBlocketItem,
  searchTradera,
  getTraderaItem,
  checkTraderaConnectivity,
  configureTraderaRateLimitStore,
  getTraderaRateLimitState,
} from "./core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.CONFIG_PATH || "/data/config.json";
const TRADERA_RATE_LIMIT_STATE_PATH = process.env.TRADERA_RATE_LIMIT_STATE_PATH
  || path.join(path.dirname(CONFIG_PATH), "tradera-rate-limit.json");
const PORT = parseInt(process.env.PORT || "3000", 10);
const TRADERA_HEALTH_CHECK_INTERVAL_MS = parsePositiveInt(
  process.env.TRADERA_HEALTH_CHECK_INTERVAL_MS,
  24 * 60 * 60 * 1000,
);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

configureTraderaRateLimitStore({
  load: () => {
    try {
      const raw = fs.readFileSync(TRADERA_RATE_LIMIT_STATE_PATH, "utf8");
      const parsed = JSON.parse(raw) as { timestamps?: unknown[] };
      return (parsed.timestamps || []).filter((value): value is number => typeof value === "number");
    } catch {
      return [];
    }
  },
  save: (timestamps) => {
    fs.mkdirSync(path.dirname(TRADERA_RATE_LIMIT_STATE_PATH), { recursive: true });
    fs.writeFileSync(TRADERA_RATE_LIMIT_STATE_PATH, JSON.stringify({ timestamps }, null, 2));
  },
});

// Config management — env vars take precedence, WebUI saves override
function loadConfig(): Env {
  let fileConfig: Partial<Env> = {};
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    fileConfig = JSON.parse(raw);
  } catch {
    // no config file yet
  }
  return {
    TRADERA_APP_ID: process.env.TRADERA_APP_ID || fileConfig.TRADERA_APP_ID || "",
    TRADERA_APP_KEY: process.env.TRADERA_APP_KEY || fileConfig.TRADERA_APP_KEY || "",
    TRADERA_RATE_LIMIT_MAX_CALLS: process.env.TRADERA_RATE_LIMIT_MAX_CALLS,
    TRADERA_RATE_LIMIT_WINDOW_MS: process.env.TRADERA_RATE_LIMIT_WINDOW_MS,
  };
}

function saveConfig(config: Partial<Env>) {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  let existing: Partial<Env> = {};
  try {
    existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    // no existing config
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...existing, ...config }, null, 2));
}

// Build the MCP server with all tools
function createMcpServer() {
  const server = new McpServer({
    name: "Begagnad - Swedish Second-Hand Marketplace Search",
    version: "1.0.0",
  });

  server.tool(
    "search_blocket",
    {
      query: z.string().describe("Search query (e.g., 'Linksys router OpenWRT', 'red pickup truck')"),
      limit: z.number().optional().default(20).describe("Maximum number of results (default: 20, max: 99)"),
    },
    async ({ query, limit }) => {
      stats.blocket.calls++;
      try {
        const items = await searchBlocket(query, limit);
        stats.blocket.ok++;
        return { content: [{ type: "text", text: JSON.stringify({ count: items.length, items }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  );

  server.tool(
    "get_blocket_item",
    { ad_id: z.string().describe("The Blocket ad ID") },
    async ({ ad_id }) => {
      stats.blocket.calls++;
      try {
        const item = await getBlocketItem(ad_id);
        stats.blocket.ok++;
        return { content: [{ type: "text", text: JSON.stringify(item, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  );

  server.tool(
    "search_tradera",
    {
      query: z.string().describe("Search query"),
      page: z.number().optional().default(1).describe("Page number for pagination (default: 1)"),
    },
    async ({ query, page }) => {
      const env = loadConfig();
      if (!env.TRADERA_APP_ID || !env.TRADERA_APP_KEY) {
        return { content: [{ type: "text", text: "Tradera API keys not configured. Set them in the WebUI or via TRADERA_APP_ID / TRADERA_APP_KEY env vars." }], isError: true };
      }
      stats.tradera.calls++;
      try {
        const items = await searchTradera(query, env, page);
        stats.tradera.ok++;
        return { content: [{ type: "text", text: JSON.stringify({ count: items.length, items }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  );

  server.tool(
    "get_tradera_item",
    { item_id: z.string().describe("The Tradera item ID") },
    async ({ item_id }) => {
      const env = loadConfig();
      if (!env.TRADERA_APP_ID || !env.TRADERA_APP_KEY) {
        return { content: [{ type: "text", text: "Tradera API keys not configured." }], isError: true };
      }
      stats.tradera.calls++;
      try {
        const item = await getTraderaItem(item_id, env);
        stats.tradera.ok++;
        return { content: [{ type: "text", text: JSON.stringify(item, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  );

  server.tool(
    "search_both",
    {
      query: z.string().describe("Search query"),
      blocket_limit: z.number().optional().default(20).describe("Maximum number of Blocket results (default: 20)"),
    },
    async ({ query, blocket_limit }) => {
      const env = loadConfig();
      stats.blocket.calls++;
      if (env.TRADERA_APP_ID && env.TRADERA_APP_KEY) stats.tradera.calls++;
      try {
        const results = await Promise.allSettled([
          searchBlocket(query, blocket_limit),
          env.TRADERA_APP_ID && env.TRADERA_APP_KEY
            ? searchTradera(query, env, 1)
            : Promise.resolve([]),
        ]);

        const blocketItems = results[0].status === "fulfilled" ? results[0].value : [];
        const traderaItems = results[1].status === "fulfilled" ? results[1].value : [];
        if (results[0].status === "fulfilled") stats.blocket.ok++;
        if (results[1].status === "fulfilled" && (results[1].value as unknown[]).length >= 0) stats.tradera.ok++;
        const allItems = [...blocketItems, ...traderaItems];

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ total: allItems.length, blocket_count: blocketItems.length, tradera_count: traderaItems.length, items: allItems }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  );

  return server;
}

// Track active sessions and their metadata
interface SessionInfo {
  transport: SSEServerTransport | StreamableHTTPServerTransport;
  ip: string;
  connectedAt: number;
  type: "sse" | "http";
}
const sessions = new Map<string, SessionInfo>();

// Counters for API calls and connectivity
const stats = {
  blocket: { calls: 0, ok: 0, lastStatus: null as number | null, lastChecked: 0 },
  tradera: { calls: 0, ok: 0, lastStatus: null as number | null, lastChecked: 0 },
  totalConnections: 0,
};

async function checkConnectivity() {
  // Blocket — lightweight HEAD-like check
  try {
    const r = await fetch("https://blocket-api.se/v1/search?query=cykel&limit=1", { signal: AbortSignal.timeout(5000) });
    stats.blocket.lastStatus = r.status;
  } catch {
    stats.blocket.lastStatus = 0;
  }
  stats.blocket.lastChecked = Date.now();

  // Tradera — only if keys are configured
  const env = loadConfig();
  if (env.TRADERA_APP_ID && env.TRADERA_APP_KEY) {
    if (
      stats.tradera.lastChecked > 0
      && Date.now() - stats.tradera.lastChecked < TRADERA_HEALTH_CHECK_INTERVAL_MS
    ) {
      return;
    }
    try {
      stats.tradera.lastStatus = await checkTraderaConnectivity(env, { signal: AbortSignal.timeout(5000) });
    } catch {
      stats.tradera.lastStatus = 0;
    }
  } else {
    stats.tradera.lastStatus = null;
  }
  stats.tradera.lastChecked = Date.now();
}

// Check connectivity on startup and every 60s
checkConnectivity();
setInterval(checkConnectivity, 60_000);

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function serveFile(res: http.ServerResponse, filePath: string, contentType: string) {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  // CORS for local development
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim()
    || req.socket.remoteAddress
    || "unknown";

  // --- MCP Streamable HTTP endpoint (for supergateway / Claude Desktop) ---
  if (url.pathname === "/mcp") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (!session) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, ip: clientIp, connectedAt: Date.now(), type: "http" });
          stats.totalConnections++;
        },
        onsessionclosed: (sid) => {
          sessions.delete(sid);
        },
      });
      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    } else {
      await (session.transport as StreamableHTTPServerTransport).handleRequest(req, res);
    }
    return;
  }

  // --- MCP SSE endpoint ---
  // Handle POST to /sse as streamable HTTP (mcp-remote http-first strategy)
  // Only if the client sends a JSON body (MCP), not a browser form
  if (url.pathname === "/sse" && req.method === "POST" && req.headers["content-type"]?.includes("application/json")) {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (session) {
      await (session.transport as StreamableHTTPServerTransport).handleRequest(req, res);
    } else {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, ip: clientIp, connectedAt: Date.now(), type: "http" });
          stats.totalConnections++;
        },
        onsessionclosed: (sid) => { sessions.delete(sid); },
      });
      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    }
    return;
  }

  if (url.pathname === "/sse" && req.method === "GET") {
    const transport = new SSEServerTransport("/sse/message", res);
    sessions.set(transport.sessionId, { transport, ip: clientIp, connectedAt: Date.now(), type: "sse" });
    stats.totalConnections++;
    transport.onclose = () => sessions.delete(transport.sessionId);

    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);
    return;
  }

  if (url.pathname === "/sse/message" && req.method === "POST") {
    const sessionId = url.searchParams.get("sessionId") || "";
    const session = sessions.get(sessionId);
    if (!session) {
      json(res, 404, { error: "Session not found" });
      return;
    }
    await (session.transport as SSEServerTransport).handlePostMessage(req, res);
    return;
  }

  // --- API endpoints for WebUI ---
  if (url.pathname === "/api/config" && req.method === "GET") {
    const env = loadConfig();
    // Mask keys for display — only show whether they're set
    json(res, 200, {
      TRADERA_APP_ID: env.TRADERA_APP_ID ? env.TRADERA_APP_ID : "",
      TRADERA_APP_KEY: env.TRADERA_APP_KEY ? "•".repeat(env.TRADERA_APP_KEY.length) : "",
      tradera_configured: !!(env.TRADERA_APP_ID && env.TRADERA_APP_KEY),
    });
    return;
  }

  if (url.pathname === "/api/config" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body) as Partial<Env>;
      const update: Partial<Env> = {};
      if (typeof data.TRADERA_APP_ID === "string") update.TRADERA_APP_ID = data.TRADERA_APP_ID.trim();
      if (typeof data.TRADERA_APP_KEY === "string") update.TRADERA_APP_KEY = data.TRADERA_APP_KEY.trim();
      saveConfig(update);
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 400, { error: String(e) });
    }
    return;
  }

  if (url.pathname === "/api/search" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const { query, source, limit } = JSON.parse(body) as { query: string; source: string; limit?: number };
      const env = loadConfig();
      let items: unknown[] = [];

      if (source === "blocket" || source === "both") {
        const r = await searchBlocket(query, limit || 10);
        items = [...items, ...r];
      }
      if ((source === "tradera" || source === "both") && env.TRADERA_APP_ID && env.TRADERA_APP_KEY) {
        const r = await searchTradera(query, env, 1);
        items = [...items, ...r];
      }

      json(res, 200, { count: items.length, items });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return;
  }

  if (url.pathname === "/api/status" && req.method === "GET") {
    const env = loadConfig();
    const clients = Array.from(sessions.values()).map((s) => ({
      ip: s.ip,
      connectedAt: s.connectedAt,
      type: s.type,
      sessionId: s.transport.sessionId?.slice(0, 8) + "…",
    }));
    json(res, 200, {
      tradera_configured: !!(env.TRADERA_APP_ID && env.TRADERA_APP_KEY),
      active_sessions: sessions.size,
      clients,
    });
    return;
  }

  if (url.pathname === "/api/stats" && req.method === "GET") {
    const env = loadConfig();
    json(res, 200, {
      blocket: {
        up: stats.blocket.lastStatus !== null && (stats.blocket.lastStatus === 422 || (stats.blocket.lastStatus >= 200 && stats.blocket.lastStatus < 400)),
        lastStatus: stats.blocket.lastStatus,
        lastChecked: stats.blocket.lastChecked,
        calls: stats.blocket.calls,
        ok: stats.blocket.ok,
      },
      tradera: {
        configured: !!(env.TRADERA_APP_ID && env.TRADERA_APP_KEY),
        up: stats.tradera.lastStatus !== null && stats.tradera.lastStatus >= 200 && stats.tradera.lastStatus < 400,
        lastStatus: stats.tradera.lastStatus,
        lastChecked: stats.tradera.lastChecked,
        calls: stats.tradera.calls,
        ok: stats.tradera.ok,
        rateLimit: getTraderaRateLimitState(env),
      },
      connections: {
        active: sessions.size,
        total: stats.totalConnections,
      },
    });
    return;
  }

  // --- WebUI ---
  if (url.pathname === "/" || url.pathname === "/index.html") {
    serveFile(res, path.join(__dirname, "ui/index.html"), "text/html; charset=utf-8");
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Begagnad MCP server running at http://localhost:${PORT}`);
  console.log(`  WebUI:        http://localhost:${PORT}/`);
  console.log(`  MCP (HTTP):   http://localhost:${PORT}/mcp`);
  console.log(`  MCP (SSE):    http://localhost:${PORT}/sse`);
});
