#!/bin/sh
# stdio mode when explicitly requested (e.g. docker run --rm -i -e MCP_STDIO=1 ...)
# HTTP server mode otherwise (docker compose up)
if [ "$MCP_STDIO" = "1" ]; then
  exec node dist/stdio.js
else
  exec node dist/server.js
fi
