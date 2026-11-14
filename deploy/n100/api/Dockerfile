FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY db ./db
COPY tsconfig.json ./

EXPOSE 8080
CMD ["sh", "-c", "node scripts/db-migrate.mjs && if [ \"$GYEOL_SEED_DEMO\" = \"true\" ]; then node scripts/seed-demo.mjs; fi && node apps/api/server.mjs"]
