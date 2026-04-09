FROM node:20-slim

RUN npm install -g @railway/cli

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js ./

EXPOSE 8080

CMD ["node", "server.js"]
