# CRM container for Azure Container Apps: page + API (src/server.mjs), and the migrate/status/backup jobs (src/job.mjs).
# On AWS the same code runs as Lambda functions from a zip (see .github/workflows/deploy.yml); this image isn't used there.
FROM node:22-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY api/src ./src
COPY db/migrations ./migrations
COPY web ./web
USER node
EXPOSE 8080
HEALTHCHECK NONE
CMD ["node", "src/server.mjs"]
