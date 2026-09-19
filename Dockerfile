FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium && npm cache clean --force
COPY src ./src
COPY public ./public
COPY sandbox ./sandbox
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "src/server.js"]
