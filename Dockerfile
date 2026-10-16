FROM ghcr.io/puppeteer/puppeteer:22.0.0

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

USER root

# Copy package dependency definitions
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy all project files
COPY . .

# Ensure snapshots and storage directories exist with write permissions
RUN mkdir -p snapshots && chown -R pptruser:pptruser /app

USER pptruser

EXPOSE 3000

CMD ["node", "server.js"]
