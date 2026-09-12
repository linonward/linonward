FROM node:24-alpine AS build

ENV HUSKY=0

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/feishu/package.json ./apps/feishu/package.json

RUN pnpm install --frozen-lockfile

COPY apps/feishu ./apps/feishu

RUN pnpm --filter @linonward/feishu build

FROM node:24-alpine

ENV NODE_ENV=production

WORKDIR /app/apps/feishu

COPY --from=build --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/apps/feishu/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/feishu/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/feishu/dist ./dist

USER node

CMD ["node", "dist/index.js"]
