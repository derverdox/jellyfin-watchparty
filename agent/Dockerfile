FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY agent.js ./
USER node
CMD ["node", "agent.js"]
