FROM node:24-alpine AS build
RUN corepack enable && corepack prepare pnpm@11.3.0 --activate
WORKDIR /app

COPY package.json ./
RUN pnpm install --no-frozen-lockfile --ignore-scripts

COPY tsconfig.json client.ts model-config.ts presentation-instructions.ts index.ts ./
RUN pnpm exec tsc && pnpm prune --prod --ignore-scripts

FROM node:24-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build --chown=app:app /app/package.json ./
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/node_modules ./node_modules
ENV NODE_ENV=production
USER app
EXPOSE 8088
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8088/health').then(r => {if(!r.ok) process.exit(1)}).catch(() => process.exit(1))"
CMD ["node", "dist/index.js"]
