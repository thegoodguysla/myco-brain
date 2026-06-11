FROM node:20-slim AS builder

WORKDIR /app

# Copy the lockfile too and use `npm ci` — deterministic and far faster than
# `npm install` (which re-resolves the whole tree and can stall on slow networks).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json .
COPY src ./src

RUN npm run build

RUN npm prune --omit=dev

FROM node:20-slim

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json .

CMD ["node", "dist/index.js"]
