FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY sim/package.json sim/package.json
COPY server/package.json server/package.json
COPY pareto/package.json pareto/package.json
COPY plasma-lab/package.json plasma-lab/package.json

RUN npm ci --workspaces --include-workspace-root

COPY sim sim
COPY server server
COPY pareto pareto
COPY plasma-lab plasma-lab

RUN npm run build

ENV NODE_ENV=production
WORKDIR /app/server

CMD ["node", "dist/index.js"]
