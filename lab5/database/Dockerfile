FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY seed.js ./

CMD ["npm", "run", "seed"]
