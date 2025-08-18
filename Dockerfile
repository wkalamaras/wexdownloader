# Use the official Playwright image which has browsers pre-installed
FROM mcr.microsoft.com/playwright:v1.40.0-focal

# Create app directory
WORKDIR /app

# Copy only package files first (for better caching)
COPY package*.json ./

# Install dependencies (this layer will be cached if package.json doesn't change)
RUN npm ci --only=production

# Install Chromium browser (this will also be cached)
RUN npx playwright install chromium

# Copy application files (these change more frequently)
COPY pdf-webhook-server.js ./
COPY .env.example ./
COPY docker-entrypoint.sh ./

# Create temp directory and setup entrypoint
RUN mkdir -p /app/temp \
    && chmod +x docker-entrypoint.sh

# Create a non-root user to run the app
RUN groupadd -r appuser && useradd -r -g appuser appuser \
    && chown -R appuser:appuser /app

# For Coolify persistent volumes, run as root to handle permissions
# Comment out USER directive to run as root
# USER appuser

# Expose the port
EXPOSE 3053

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3053) + '/health', (r) => {r.statusCode === 200 ? process.exit(0) : process.exit(1)})"

# Use entrypoint script to handle permissions
ENTRYPOINT ["./docker-entrypoint.sh"]