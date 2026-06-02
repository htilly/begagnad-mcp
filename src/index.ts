import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type Env,
  searchBlocket,
  getBlocketItem,
  searchTradera,
  getTraderaItem,
} from "./core.js";

// Define our MCP agent with tools
export class BegagnadMCP extends McpAgent {
  server = new McpServer({
    name: "Begagnad - Swedish Second-Hand Marketplace Search",
    version: "1.0.0",
  });

  // env is inherited from McpAgent base class

  async init() {
    // Search Blocket
    this.server.tool(
      "search_blocket",
      {
        query: z
          .string()
          .describe(
            "Search query (e.g., 'Linksys router OpenWRT', 'red pickup truck')",
          ),
        limit: z
          .number()
          .optional()
          .default(20)
          .describe("Maximum number of results (default: 20, max: 99)"),
      },
      async ({ query, limit }) => {
        try {
          const items = await searchBlocket(query, limit);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ count: items.length, items }, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    );

    // Get Blocket item
    this.server.tool(
      "get_blocket_item",
      {
        ad_id: z.string().describe("The Blocket ad ID"),
      },
      async ({ ad_id }) => {
        try {
          const item = await getBlocketItem(ad_id);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(item, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    );

    // Search Tradera
    this.server.tool(
      "search_tradera",
      {
        query: z
          .string()
          .describe(
            "Search query (e.g., 'Linksys router OpenWRT', 'red pickup truck')",
          ),
        page: z
          .number()
          .optional()
          .default(1)
          .describe("Page number for pagination (default: 1)"),
      },
      async ({ query, page }) => {
        try {
          const items = await searchTradera(query, this.env as Env, page);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ count: items.length, items }, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    );

    // Get Tradera item
    this.server.tool(
      "get_tradera_item",
      {
        item_id: z.string().describe("The Tradera item ID"),
      },
      async ({ item_id }) => {
        try {
          const item = await getTraderaItem(item_id, this.env as Env);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(item, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    );

    // Search both marketplaces
    this.server.tool(
      "search_both",
      {
        query: z
          .string()
          .describe(
            "Search query (e.g., 'Linksys router OpenWRT', 'red pickup truck')",
          ),
        blocket_limit: z
          .number()
          .optional()
          .default(20)
          .describe("Maximum number of Blocket results (default: 20)"),
      },
      async ({ query, blocket_limit }) => {
        try {
          const [blocketItems, traderaItems] = await Promise.all([
            searchBlocket(query, blocket_limit),
            searchTradera(query, this.env as Env, 1),
          ]);

          const allItems = [...blocketItems, ...traderaItems];

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    total: allItems.length,
                    blocket_count: blocketItems.length,
                    tradera_count: traderaItems.length,
                    items: allItems,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    );
  }
}

// Throttle rapid SSE reconnections per IP within a Worker instance
const lastSSEConnect = new Map<string, number>();
const SSE_MIN_INTERVAL_MS = 10_000;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      // Rate-limit new SSE connections to prevent reconnection storms
      if (request.method === "GET" && url.pathname === "/sse") {
        const ip = request.headers.get("cf-connecting-ip") || "unknown";
        const now = Date.now();
        const last = lastSSEConnect.get(ip) || 0;
        if (now - last < SSE_MIN_INTERVAL_MS) {
          return new Response("Too many reconnections", {
            status: 429,
            headers: { "Retry-After": "10" },
          });
        }
        lastSSEConnect.set(ip, now);
      }

      const response = await BegagnadMCP.serveSSE("/sse").fetch(
        request,
        env,
        ctx,
      );

      // Inject a retry directive into the SSE stream so clients wait
      // 30 seconds before reconnecting instead of retrying immediately
      if (
        request.method === "GET" &&
        url.pathname === "/sse" &&
        response.body &&
        response.headers.get("content-type")?.includes("text/event-stream")
      ) {
        const reader = response.body.getReader();
        const encoder = new TextEncoder();

        const wrappedStream = new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode("retry: 30000\n\n"));
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
            } finally {
              controller.close();
            }
          },
        });

        return new Response(wrappedStream, {
          status: response.status,
          headers: response.headers,
        });
      }

      return response;
    }

    if (url.pathname === "/mcp") {
      return BegagnadMCP.serve("/mcp").fetch(request, env, ctx);
    }

    // Root path - show info
    if (url.pathname === "/") {
      return new Response(
        JSON.stringify(
          {
            name: "Begagnad MCP Server",
            description:
              "Search Swedish second-hand marketplaces (Blocket & Tradera)",
            endpoints: {
              sse: "/sse",
              mcp: "/mcp",
            },
            tools: [
              "search_blocket",
              "get_blocket_item",
              "search_tradera",
              "get_tradera_item",
              "search_both",
            ],
          },
          null,
          2,
        ),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response("Not found", { status: 404 });
  },
};
