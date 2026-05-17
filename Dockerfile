FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates unzip \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .

# Override at build time with:
#   docker build --build-arg MCP_APPS_CONFIG=mcp-apps.local.json .
ARG MCP_APPS_CONFIG=mcp-apps.json
ENV MCP_APPS_CONFIG=${MCP_APPS_CONFIG}
ENV MCP_APPS_DIR=/app/mcp_apps
RUN npm run mcp:install
RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8765

COPY --from=build /app/package.json /app/package-lock.json* ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/mcp_apps ./mcp_apps
COPY --from=build /app/mcp-apps.installed.json ./mcp-apps.installed.json

EXPOSE 8765
CMD ["npm", "start"]
