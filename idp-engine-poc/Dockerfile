# Same image runs the API (APP_ROLE=api) and the worker (APP_ROLE=worker).
FROM node:22.21.1-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# Installs musl builds of sharp and @napi-rs/canvas; postinstall runs `prisma generate`.
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
