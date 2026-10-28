# Build context: repository root (the server depends on ../shared).
FROM node:22-alpine
WORKDIR /app
COPY shared ./shared
COPY server/package.json ./server/package.json
RUN cd server && npm install --omit=dev --install-links --no-audit --no-fund
COPY server/src ./server/src
COPY web-client ./web-client
USER node
ENV HOST=0.0.0.0 PORT=8787 PR_DATA_FILE=/data/store.json PR_TRUST_PROXY=1
EXPOSE 8787
CMD ["node", "server/src/index.js"]
