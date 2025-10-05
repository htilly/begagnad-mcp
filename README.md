# Begagnad MCP

A Model Context Protocol (MCP) server for searching Sweden's two largest second-hand marketplaces: Blocket and Tradera.

## What it does

Enables AI agents like Claude to search and retrieve listings from Swedish second-hand marketplaces. Returns unified data including titles, descriptions, prices, images, seller information, and direct links to listings.

## Setup

### Using the public endpoint

A live instance is available at `https://begagnad-mcp.bjesus.workers.dev/sse`

Configure Claude Desktop by editing `~/.config/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "begagnad": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://begagnad-mcp.bjesus.workers.dev/sse"
      ]
    }
  }
}
```

Restart Claude Desktop to load the server.

### Deploy your own instance

1. Install dependencies:
   ```bash
   npm install
   ```

2. Login to Cloudflare:
   ```bash
   wrangler login
   ```

3. Deploy:
   ```bash
   npm run deploy
   ```

4. Update your Claude Desktop config with your deployment URL.

### Local development

```bash
npm start
```

Server runs at `http://localhost:8788/sse`

### Configuration

Tradera API credentials can be set as Cloudflare secrets:

```bash
wrangler secret put TRADERA_APP_ID
wrangler secret put TRADERA_APP_KEY
```

## Available tools

- `search_blocket` - Search Blocket marketplace
  - Parameters: `query` (string), `limit` (number, optional)
  
- `get_blocket_item` - Get details for a specific Blocket listing
  - Parameters: `ad_id` (string)
  
- `search_tradera` - Search Tradera marketplace
  - Parameters: `query` (string), `page` (number, optional)
  
- `get_tradera_item` - Get details for a specific Tradera listing
  - Parameters: `item_id` (string)
  
- `search_both` - Search both marketplaces simultaneously
  - Parameters: `query` (string), `blocket_limit` (number, optional)

## Example usage

Ask Claude:
- "Find me a Linksys router with OpenWRT installed"
- "Search for a red pickup truck under 20000 SEK"
- "Show me vintage furniture in Stockholm"

## Data format

Returns unified data structure:
- Item ID, title, description
- Price (SEK), location
- Images (URLs)
- Seller name and rating
- Direct link to listing
- Source marketplace (Blocket or Tradera)

## APIs

- Blocket API: `https://blocket-api.se/v1/`
- Tradera API: `https://api.tradera.com/v3/`

## License

MIT
