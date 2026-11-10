FROM node:22-alpine
WORKDIR /app
# Aylol Telecom is reached through curl (HTTP/2).
RUN apk add --no-cache curl
COPY package.json server.js ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/agents.db
VOLUME /data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
