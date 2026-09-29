FROM node:24-slim
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY server/owner ./owner
COPY www /app/www
ENV NODE_ENV=production DB_PATH=/data/safe-to-spend.db WEB_DIR=/app/www
VOLUME /data
EXPOSE 8787
CMD ["node", "src/server.js"]
