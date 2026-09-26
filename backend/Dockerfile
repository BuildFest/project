# Build context is the REPO ROOT (not backend/): the image needs db/ for
# migrations. Locally: docker build -f backend/Dockerfile .
FROM node:22-slim AS build
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/backend/dist ./dist
COPY db /app/db
USER node
CMD ["node", "dist/server.js"]
