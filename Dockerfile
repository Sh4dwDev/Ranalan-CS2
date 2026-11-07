FROM node:26-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
ENV DATA_DIR=/data SERVERS_FILE=/config/servers.json
CMD ["node", "src/server.js"]
