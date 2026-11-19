FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# 3000 = HTTP API + Socket.IO, 1883 = MQTT, 8883 = MQTT over TLS (when certificates are configured)
EXPOSE 3000 1883 8883
CMD ["node", "dist/src/index.js"]
