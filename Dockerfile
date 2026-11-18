FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
# The contracts import streams BASE's yearly zips through unzip; busybox's can't read zip64.
RUN apk add --no-cache unzip
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY data ./data
# Blog posts published on deploy (src/db/seed.ts).
COPY content ./content
USER node
CMD ["node", "dist/server.js"]
