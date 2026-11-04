FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && mkdir -p data cache && chown -R node:node /app
COPY --chown=node:node server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
ENV PORT=8097 DATA_DIR=/app/data CACHE_DIR=/app/cache
USER node
EXPOSE 8097
CMD ["node", "server.js"]
