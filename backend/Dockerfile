# Build from the repository root so prompts/, brands/ and posts/ are included:
#   docker build -f backend/Dockerfile -t dr-halima-backend .
FROM node:22-alpine
WORKDIR /app
COPY prompts ./prompts
COPY brands ./brands
COPY posts ./posts
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev
COPY backend/src ./backend/src
COPY backend/config ./backend/config
# Generated images live in /app/assets — mount a persistent volume there in production.
RUN mkdir -p /app/assets && chown node:node /app/assets
ENV NODE_ENV=production
EXPOSE 8080
USER node
CMD ["node", "backend/src/server.js"]
