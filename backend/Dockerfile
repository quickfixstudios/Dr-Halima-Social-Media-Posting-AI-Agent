# Build from the repository root so the shared /prompts folder is included:
#   docker build -f backend/Dockerfile -t dr-halima-backend .
FROM node:22-alpine
WORKDIR /app
COPY prompts ./prompts
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev
COPY backend/src ./backend/src
ENV NODE_ENV=production PROMPTS_DIR=/app/prompts
EXPOSE 8080
USER node
CMD ["node", "backend/src/server.js"]
