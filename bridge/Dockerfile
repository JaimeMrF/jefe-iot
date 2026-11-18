FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    HEALTH_PORT=8081
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
# Usuario sin privilegios (viene en la imagen oficial de node)
USER node
EXPOSE 8081
# /health responde 200 solo si el bridge esta conectado al broker MQTT
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8081)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "src/index.js"]
