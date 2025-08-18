# Use the official Playwright image which has browsers pre-installed
FROM mcr.microsoft.com/playwright:v1.40.0-focal

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy application files
COPY pdf-webhook-server.js ./
COPY .env.example ./

# Install Chromium browser specifically
RUN npx playwright install chromium

# Create a non-root user to run the app (if not using root)
RUN groupadd -r appuser && useradd -r -g appuser appuser \
    && chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Expose the port (default 3053, can be overridden with PORT env var)
EXPOSE 3053

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3053) + '/health', (r) => {r.statusCode === 200 ? process.exit(0) : process.exit(1)})"

# Start the application
CMD ["node", "pdf-webhook-server.js"]