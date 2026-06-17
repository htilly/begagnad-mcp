import { parseStringPromise } from "xml2js";

export interface Env {
  TRADERA_APP_ID: string;
  TRADERA_APP_KEY: string;
  TRADERA_RATE_LIMIT_MAX_CALLS?: string;
  TRADERA_RATE_LIMIT_WINDOW_MS?: string;
}

export interface UnifiedItem {
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

const DEFAULT_TRADERA_RATE_LIMIT_MAX_CALLS = 100;
const DEFAULT_TRADERA_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const traderaRequestTimestamps: number[] = [];
let traderaRateLimitStore: {
  load: () => number[];
  save: (timestamps: number[]) => void;
} | null = null;
let traderaRateLimitStoreLoaded = false;

export function configureTraderaRateLimitStore(store: {
  load: () => number[];
  save: (timestamps: number[]) => void;
}) {
  traderaRateLimitStore = store;
  traderaRateLimitStoreLoaded = false;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getTraderaLimitConfig(env: Env) {
  return {
    maxCalls: parsePositiveInt(env.TRADERA_RATE_LIMIT_MAX_CALLS, DEFAULT_TRADERA_RATE_LIMIT_MAX_CALLS),
    windowMs: parsePositiveInt(env.TRADERA_RATE_LIMIT_WINDOW_MS, DEFAULT_TRADERA_RATE_LIMIT_WINDOW_MS),
  };
}

function pruneTraderaRequests(windowMs: number, now: number) {
  loadStoredTraderaRequests();
  const cutoff = now - windowMs;
  while (traderaRequestTimestamps.length > 0 && traderaRequestTimestamps[0] <= cutoff) {
    traderaRequestTimestamps.shift();
  }
}

function loadStoredTraderaRequests() {
  if (!traderaRateLimitStore || traderaRateLimitStoreLoaded) return;
  traderaRequestTimestamps.splice(0, traderaRequestTimestamps.length, ...traderaRateLimitStore.load());
  traderaRateLimitStoreLoaded = true;
}

function saveStoredTraderaRequests() {
  if (!traderaRateLimitStore) return;
  traderaRateLimitStore.save(traderaRequestTimestamps);
}

export function getTraderaRateLimitState(env: Env, now: number = Date.now()) {
  const { maxCalls, windowMs } = getTraderaLimitConfig(env);
  pruneTraderaRequests(windowMs, now);
  const oldest = traderaRequestTimestamps[0] ?? null;
  const remaining = Math.max(0, maxCalls - traderaRequestTimestamps.length);

  return {
    limit: maxCalls,
    windowMs,
    used: traderaRequestTimestamps.length,
    remaining,
    resetAt: oldest === null ? null : oldest + windowMs,
  };
}

function reserveTraderaCall(env: Env) {
  const now = Date.now();
  const state = getTraderaRateLimitState(env, now);

  if (state.remaining <= 0) {
    const reset = state.resetAt ? new Date(state.resetAt).toISOString() : "unknown";
    throw new Error(
      `Tradera API rate limit reached locally: ${state.limit} calls per ${Math.round(state.windowMs / 3_600_000)}h. Resets at ${reset}.`,
    );
  }

  traderaRequestTimestamps.push(now);
  saveStoredTraderaRequests();
}

async function fetchTradera(url: string, env: Env, init?: RequestInit): Promise<Response> {
  reserveTraderaCall(env);
  const response = await fetch(url, init);

  if (response.status === 429) {
    const state = getTraderaRateLimitState(env);
    throw new Error(
      `Tradera API rate limit exceeded by Tradera (HTTP 429). Local usage: ${state.used}/${state.limit} calls.`,
    );
  }

  return response;
}

export async function searchBlocket(
  query: string,
  limit: number = 20,
): Promise<UnifiedItem[]> {
  const url = `https://blocket-api.se/v1/search?query=${encodeURIComponent(query)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Blocket API error: ${response.status} ${response.statusText}`);
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
    seller: { name: "", rating: null },
    endDate: item.timestamp ? new Date(item.timestamp).toISOString() : null,
    source: "blocket" as const,
  }));
}

export async function getBlocketItem(adId: string): Promise<UnifiedItem> {
  const url = `https://blocket-api.se/v1/ad/recommerce?id=${adId}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Blocket API error: ${response.status} ${response.statusText}`);
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
    seller: { name: "", rating: null },
    endDate: item.timestamp ? new Date(item.timestamp).toISOString() : null,
    source: "blocket" as const,
  };
}

export async function searchTradera(
  query: string,
  env: Env,
  pageNumber: number = 1,
): Promise<UnifiedItem[]> {
  const url = `https://api.tradera.com/v3/searchservice.asmx/Search?query=${encodeURIComponent(query)}&categoryId=0&pageNumber=${pageNumber}&orderBy=Relevance&appId=${env.TRADERA_APP_ID}&appKey=${env.TRADERA_APP_KEY}`;

  const response = await fetchTradera(url, env);
  if (!response.ok) {
    throw new Error(`Tradera API error: ${response.status} ${response.statusText}`);
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
      price: item.BuyItNowPrice?.[0] || item.MaxBid?.[0] || item.NextBid?.[0] || null,
      currency: "SEK",
      location: "",
      url: item.ItemUrl?.[0] || "",
      images,
      condition,
      seller: {
        name: item.SellerAlias?.[0] || "",
        rating: item.SellerDsrAverage?.[0] ? parseFloat(item.SellerDsrAverage[0]) : null,
      },
      endDate: item.EndDate?.[0] || null,
      source: "tradera" as const,
      itemType: item.ItemType?.[0] || "",
    };
  });
}

export async function getTraderaItem(itemId: string, env: Env): Promise<UnifiedItem> {
  const url = `https://api.tradera.com/v3/publicservice.asmx/GetItem?itemId=${itemId}&appId=${env.TRADERA_APP_ID}&appKey=${env.TRADERA_APP_KEY}`;

  const response = await fetchTradera(url, env);
  if (!response.ok) {
    throw new Error(`Tradera API error: ${response.status} ${response.statusText}`);
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
}

export async function checkTraderaConnectivity(env: Env, init?: RequestInit): Promise<number> {
  const url = `https://api.tradera.com/v3/searchservice.asmx/Search?query=test&categoryId=0&pageNumber=1&orderBy=Relevance&appId=${env.TRADERA_APP_ID}&appKey=${env.TRADERA_APP_KEY}`;
  const response = await fetchTradera(url, env, init);
  return response.status;
}
