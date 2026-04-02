import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseStringPromise } from "xml2js";

// Environment interface
interface Env {
  TRADERA_APP_ID: string;
  TRADERA_APP_KEY: string;
}

// Unified item interface for both marketplaces
interface UnifiedItem {
  id: string;
  title: string;
  description: string;
  price: number | null;
  currency: string;
  location: string;
  url: string;
  images: string[];
  condition: string | null;
  seller: {
    name: string;
    rating: number | null;
  };
  endDate: string | null;
  source: "blocket" | "tradera";
  itemType?: string;
}

// Blocket API functions
async function searchBlocket(
  query: string,
  limit: number = 20,
): Promise<UnifiedItem[]> {
  const url = `https://blocket-api.se/v1/search?query=${encodeURIComponent(query)}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Blocket API error: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as any;

    if (!data.docs || !Array.isArray(data.docs)) {
      return [];
    }

    return data.docs.slice(0, limit).map((item: any) => ({
      id: String(item.id || item.ad_id || ""),
      title: item.heading || item.subject || "",
      description: "",
      price: item.price?.amount || null,
      currency: item.price?.currency_code || "SEK",
      location: item.location || "",
      url: item.canonical_url || "",
      images: item.image_urls || [],
      condition: null,
      seller: {
        name: "",
        rating: null,
      },
      endDate: item.timestamp ? new Date(item.timestamp).toISOString() : null,
      source: "blocket" as const,
    }));
  } catch (error) {
    throw new Error(
      `Failed to search Blocket: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function getBlocketItem(adId: string): Promise<UnifiedItem> {
  // Use the new /v1/ad/{type} endpoint
  // Most items are "recommerce" type
  const url = `https://blocket-api.se/v1/ad/recommerce?id=${adId}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Blocket API error: ${response.status} ${response.statusText}`,
      );
    }

    const item = (await response.json()) as any;

    if (!item) {
      throw new Error(`Item not found: ${adId}`);
    }

    return {
      id: String(item.id || item.ad_id || ""),
      title: item.heading || item.subject || "",
      description: item.body || "",
      price: item.price?.amount || null,
      currency: item.price?.currency_code || "SEK",
      location: item.location || "",
      url: item.canonical_url || "",
      images: item.image_urls || [],
      condition: null,
      seller: {
        name: "",
        rating: null,
      },
      endDate: item.timestamp ? new Date(item.timestamp).toISOString() : null,
      source: "blocket" as const,
    };
  } catch (error) {
    throw new Error(
      `Failed to get Blocket item: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Tradera API functions
async function searchTradera(
  query: string,
  env: Env,
  pageNumber: number = 1,
): Promise<UnifiedItem[]> {
  const url = `https://api.tradera.com/v3/searchservice.asmx/Search?query=${encodeURIComponent(query)}&categoryId=0&pageNumber=${pageNumber}&orderBy=Relevance&appId=${env.TRADERA_APP_ID}&appKey=${env.TRADERA_APP_KEY}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Tradera API error: ${response.status} ${response.statusText}`,
      );
    }

    const xmlText = await response.text();
    const result = await parseStringPromise(xmlText);

    const items = result?.SearchResult?.Items || [];

    return items.map((item: any) => {
      const imageLinks = item.ImageLinks?.[0]?.ImageLink || [];
      const images = imageLinks
        .filter((link: any) => link.Format?.[0] === "normal")
        .map((link: any) => link.Url?.[0])
        .filter(Boolean);

      const condition =
        item.AttributeValues?.[0]?.TermAttributeValues?.[0]?.TermAttributeValue?.find(
          (attr: any) => attr.Name?.[0] === "condition",
        )?.Values?.[0]?.string?.[0] || null;

      return {
        id: item.Id?.[0] || "",
        title: item.ShortDescription?.[0] || "",
        description: item.LongDescription?.[0] || "",
        price:
          item.BuyItNowPrice?.[0] ||
          item.MaxBid?.[0] ||
          item.NextBid?.[0] ||
          null,
        currency: "SEK",
        location: "",
        url: item.ItemUrl?.[0] || "",
        images,
        condition,
        seller: {
          name: item.SellerAlias?.[0] || "",
          rating: item.SellerDsrAverage?.[0]
            ? parseFloat(item.SellerDsrAverage[0])
            : null,
        },
        endDate: item.EndDate?.[0] || null,
        source: "tradera" as const,
        itemType: item.ItemType?.[0] || "",
      };
    });
  } catch (error) {
    throw new Error(
      `Failed to search Tradera: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function getTraderaItem(itemId: string, env: Env): Promise<UnifiedItem> {
  const url = `https://api.tradera.com/v3/publicservice.asmx/GetItem?itemId=${itemId}&appId=${env.TRADERA_APP_ID}&appKey=${env.TRADERA_APP_KEY}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Tradera API error: ${response.status} ${response.statusText}`,
      );
    }

    const xmlText = await response.text();
    const result = await parseStringPromise(xmlText);

    const item = result?.Item;

    if (!item) {
      throw new Error(`Item not found: ${itemId}`);
    }

    const imageLinks = item.DetailedImageLinks || [];
    const images = imageLinks
      .filter((link: any) => link.Format?.[0] === "normal")
      .map((link: any) => link.Url?.[0])
      .filter(Boolean);

    const condition =
      item.AttributeValues?.[0]?.TermAttributeValues?.[0]?.TermAttributeValue?.find(
        (attr: any) => attr.Id?.[0] === "121",
      )?.Values?.[0]?.string?.[0] || null;

    return {
      id: item.Id?.[0] || "",
      title: item.ShortDescription?.[0] || "",
      description:
        item.LongDescription?.[0]
          ?.replace(/<br>/g, "\n")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">") || "",
      price: item.MaxBid?.[0] || item.NextBid?.[0] || null,
      currency: "SEK",
      location: item.Seller?.[0]?.City?.[0] || "",
      url: item.ItemLink?.[0] || "",
      images,
      condition,
      seller: {
        name: item.Seller?.[0]?.Alias?.[0] || "",
        rating: item.Seller?.[0]?.TotalRating?.[0]
          ? parseFloat(item.Seller[0].TotalRating[0])
          : null,
      },
      endDate: item.EndDate?.[0] || null,
      source: "tradera" as const,
      itemType: item.ItemType?.[0] || "",
    };
  } catch (error) {
    throw new Error(
      `Failed to get Tradera item: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

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

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return BegagnadMCP.serveSSE("/sse").fetch(request, env, ctx);
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
