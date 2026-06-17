import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  type Env,
  searchBlocket,
  getBlocketItem,
  searchTradera,
  getTraderaItem,
  configureTraderaRateLimitStore,
} from "./core.js";

// Config: check common locations so it works both with and without Docker
const USER_CONFIG_PATH = path.join(os.homedir(), ".config", "begagnad-mcp", "config.json");
const CONFIG_CANDIDATES = [
  process.env.CONFIG_PATH,
  "/data/config.json",
  USER_CONFIG_PATH,
].filter(Boolean) as string[];
const RATE_LIMIT_STATE_PATH = process.env.TRADERA_RATE_LIMIT_STATE_PATH
  || path.join(path.dirname(process.env.CONFIG_PATH || USER_CONFIG_PATH), "tradera-rate-limit.json");

configureTraderaRateLimitStore({
  load: () => {
    try {
      const raw = fs.readFileSync(RATE_LIMIT_STATE_PATH, "utf8");
      const parsed = JSON.parse(raw) as { timestamps?: unknown[] };
      return (parsed.timestamps || []).filter((value): value is number => typeof value === "number");
    } catch {
      return [];
    }
  },
  save: (timestamps) => {
    fs.mkdirSync(path.dirname(RATE_LIMIT_STATE_PATH), { recursive: true });
    fs.writeFileSync(RATE_LIMIT_STATE_PATH, JSON.stringify({ timestamps }, null, 2));
  },
});

function loadConfig(): Env {
  let fileConfig: Partial<Env> = {};
  for (const p of CONFIG_CANDIDATES) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(p, "utf8"));
      break;
    } catch {
      // try next
    }
  }
  return {
    TRADERA_APP_ID: process.env.TRADERA_APP_ID || fileConfig.TRADERA_APP_ID || "",
    TRADERA_APP_KEY: process.env.TRADERA_APP_KEY || fileConfig.TRADERA_APP_KEY || "",
    TRADERA_RATE_LIMIT_MAX_CALLS: process.env.TRADERA_RATE_LIMIT_MAX_CALLS,
    TRADERA_RATE_LIMIT_WINDOW_MS: process.env.TRADERA_RATE_LIMIT_WINDOW_MS,
  };
}

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
    try {
      const items = await searchBlocket(query, limit);
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
    try {
      const item = await getBlocketItem(ad_id);
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
      return { content: [{ type: "text", text: "Tradera API keys not configured. Set TRADERA_APP_ID and TRADERA_APP_KEY." }], isError: true };
    }
    try {
      const items = await searchTradera(query, env, page);
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
    try {
      const item = await getTraderaItem(item_id, env);
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
    try {
      const results = await Promise.allSettled([
        searchBlocket(query, blocket_limit),
        env.TRADERA_APP_ID && env.TRADERA_APP_KEY
          ? searchTradera(query, env, 1)
          : Promise.resolve([]),
      ]);
      const blocketItems = results[0].status === "fulfilled" ? results[0].value : [];
      const traderaItems = results[1].status === "fulfilled" ? results[1].value : [];
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

const transport = new StdioServerTransport();
await server.connect(transport);
