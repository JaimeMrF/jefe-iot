FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY test.js ./
ENV NODE_ENV=production
CMD ["node", "src/index.js"]
