# WexDownloader

A robust Express.js server that downloads files (especially PDFs) using Playwright and forwards them to webhook endpoints. Perfect for automated report processing and file transfer workflows.

## Features

- **Persistent Browser Instance**: Keeps Playwright browser running between requests for faster processing
- **Retry Logic**: Automatic retry for both downloads and webhook delivery (up to 3 attempts)
- **Clean Temp Management**: Automatically cleans up temporary files after processing
- **Health Monitoring**: Built-in health check endpoint for container orchestration
- **Docker Ready**: Optimized for deployment with Coolify, Kubernetes, or any container platform
- **Error Resilience**: Comprehensive error handling and graceful shutdown

## API Endpoints

### `POST /processreport`
Downloads a file from a URL and sends it to a webhook endpoint.

**Required Headers:**
- `INPUTURL`: The URL to download the file from
- `OUTPUT`: The webhook URL to send the downloaded file to

**Example:**
```bash
curl -X POST https://your-domain.com/processreport \
  -H "INPUTURL: https://example.com/report.pdf" \
  -H "OUTPUT: https://webhook.site/your-endpoint"
```

**Response:**
```json
{
  "success": true,
  "message": "File downloaded and sent successfully",
  "fileName": "report.pdf",
  "fileSize": "245.67 KB",
  "webhookResponse": 200,
  "downloadRetries": 0,
  "webhookRetries": 0
}
```

### `GET /health`
Health check endpoint for monitoring and container orchestration.

**Response:**
```json
{
  "status": "healthy",
  "port": 3053,
  "browser": "running",
  "uptime": 3600
}
```

### `POST /restart-browser`
Manually restart the Playwright browser instance if needed.

## Installation

### Local Development

1. Clone the repository:
```bash
git clone https://github.com/wkalamaras/wexdownloader.git
cd wexdownloader
```

2. Install dependencies:
```bash
npm install
```

3. Start the server:
```bash
npm start
```

The server will start on port 3053 by default (configurable via `PORT` environment variable).

### Docker Deployment

1. Build the Docker image:
```bash
docker build -t wexdownloader .
```

2. Run the container:
```bash
docker run -p 3053:3053 wexdownloader
```

### Coolify Deployment

1. Create a new service in Coolify
2. Connect this GitHub repository
3. Coolify will automatically detect the Dockerfile and deploy
4. Configure your domain in Coolify settings
5. The health check is already configured in the Dockerfile

## Environment Variables

- `PORT`: Server port (default: 3053)

## How It Works

1. **Request Reception**: Server receives POST request with file URL and webhook destination
2. **Browser Context**: Creates isolated browser context for each download
3. **Download with Retry**: Attempts to download file with automatic retry on failure
4. **File Processing**: Reads downloaded file as binary data
5. **Webhook Delivery**: Sends file to specified webhook as multipart/form-data
6. **Cleanup**: Removes temporary files and closes browser context

## Architecture Decisions

- **Persistent Browser**: The Playwright browser instance stays running between requests to avoid startup overhead
- **Context Isolation**: Each request gets its own browser context for security and parallel processing
- **Temp Directory Management**: Each download gets a unique temp directory that's cleaned up after processing
- **Graceful Shutdown**: Properly closes browser on SIGINT/SIGTERM signals

## Error Handling

- Automatic retry for failed downloads (up to 3 attempts with 2-second delays)
- Automatic retry for failed webhook deliveries
- Comprehensive error logging
- Proper cleanup even on failure
- HTTP status codes for different error scenarios

## Performance Considerations

- Browser stays warm between requests (~500ms saved per request)
- Parallel request handling through browser contexts
- Automatic temp file cleanup prevents disk space issues
- Configurable timeouts for downloads and webhooks

## Security

- Runs as non-root user in Docker container
- Input validation for required headers
- Isolated browser contexts per request
- No persistent storage of downloaded files

## Monitoring

The `/health` endpoint provides:
- Service status
- Browser instance status  
- Service uptime
- Port configuration

Use this endpoint for:
- Container health checks
- Load balancer health probes
- Monitoring system integration

## Troubleshooting

### Browser won't start
- Ensure all Playwright dependencies are installed
- Check available system memory
- Try restarting with `/restart-browser` endpoint

### Downloads failing
- Verify the INPUTURL is accessible
- Check for authentication requirements
- Review retry logs for specific errors

### Webhook delivery failing
- Verify the OUTPUT URL is correct
- Check webhook endpoint is accepting multipart/form-data
- Review webhook response in logs

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License.

## Author

Will Kalamaras

## Support

For issues and questions, please open an issue on [GitHub](https://github.com/wkalamaras/wexdownloader/issues).