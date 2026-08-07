# Journal Vivo web — imagen mínima para el VPS (cero dependencias npm).
# Build:  docker build -t journal-vivo .
# Run:    docker run -d --name journal-vivo --restart unless-stopped -p 3400:3400 \
#           -e BINANCE_API_KEY=... -e BINANCE_API_SECRET=... -e JOURNAL_TOKEN=un-token-largo \
#           journal-vivo
FROM node:22-alpine
WORKDIR /app
COPY server.js lib-binance.js journal-meta.json package.json ./
COPY public ./public
ENV PORT=3400
EXPOSE 3400
CMD ["node", "server.js"]
