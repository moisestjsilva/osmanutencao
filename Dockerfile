FROM node:24-alpine

RUN apk add --no-cache curl wget

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

# Dados persistentes (SQLite, uploads, sessão WhatsApp) ficam em /data -> volume do Coolify
RUN mkdir -p /data/uploads /data/whatsapp_auth
VOLUME ["/data"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "--no-warnings", "server/server.js"]

