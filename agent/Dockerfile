FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY agent.js ./
COPY lib ./lib
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV DATA_DIR=/app/data
USER node
EXPOSE 8098
CMD [ "node", "agent.js" ]
