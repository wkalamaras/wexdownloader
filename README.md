# WexDownloader

A robust Express.js server that integrates with Missive to automatically download report files and forward them to webhook endpoints. Perfect for automated report processing workflows.

## Features

- **Missive Integration**: Automatically fetches message details and extracts download URLs
- **Persistent Browser Instance**: Keeps Playwright browser running between requests for faster processing
- **Configurable Retry Logic**: Automatic retry for both downloads and webhook delivery
- **Environment Variables**: Full configuration through environment variables
- **Clean Temp Management**: Automatically cleans up temporary files after processing
- **Health Monitoring**: Built-in health check endpoint for container orchestration
- **Docker Ready**: Optimized for deployment with Coolify, Kubernetes, or any container platform
- **Verbose Logging**: Detailed logging with visual indicators for debugging

## Quick Start

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

3. Create `.env` file:
```bash
cp .env.example .env
# Edit .env and add your MISSIVE_API_KEY
```

4. Start the server:
```bash
npm start
```

## API Endpoints

### `POST /processreport`

Processes a Missive webhook, downloads the linked file, and forwards it to a specified endpoint.

**Request Body:**
```json
{
  "body": {
    "latest_message": {
      "id": "475cde7c-6d2a-e9b8-0e5c-e07ab16fa677",
      "subject": "Your job 'Wex - Daily Fuel Total Report'",
      "preview": "Job completed...",
      "from_field": {
        "address": "emanager@efsllc.com"
      }
    },
    "conversation": {
      "id": "a04efb81-5235-42c3-b760-a2e242d1e775",
      "users": [...]
    }
  },
  "webhookUrl": "https://your-webhook-endpoint.com/receive",
  "executionMode": "production"
}
```

**Response:**
```json
{
  "success": true,
  "message": "File downloaded and sent successfully",
  "messageId": "475cde7c-6d2a-e9b8-0e5c-e07ab16fa677",
  "fileName": "TransactionReport.pdf",
  "fileSize": "245.67 KB",
  "webhookResponse": 200,
  "downloadRetries": 0,
  "webhookRetries": 0,
  "timestamp": "2024-01-15T12:34:56.789Z"
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
  "config": {
    "headless": true,
    "maxRetries": 3,
    "persistentDir": "/tmp/wexdownloader-temp",
    "missiveApiConfigured": true
  },
  "uptime": 3600,
  "timestamp": "2024-01-15T12:34:56.789Z"
}
```

### `POST /restart-browser`

Manually restart the Playwright browser instance if needed.

## Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PORT` | Server port | `3053` | No |
| `MISSIVE_API_KEY` | Missive API key for fetching message details | - | **Yes** |
| `PERSISTENT_DIR` | Directory for temporary downloads | `{temp}/wexdownloader-temp` | No |
| `HEADLESS` | Run browser in headless mode | `true` | No |
| `MAX_RETRIES` | Number of retry attempts | `3` | No |

## How It Works

1. **Webhook Reception**: Receives Missive webhook with message ID
2. **Message Fetch**: Uses Missive API to fetch full message details
3. **URL Extraction**: Extracts download URL from message body
4. **Browser Download**: Uses Playwright to download the file
5. **Webhook Forward**: Sends file as multipart/form-data to specified webhook
6. **Cleanup**: Removes temporary files and closes browser context

## Docker Deployment

### Build and Run

```bash
docker build -t wexdownloader .
docker run -p 3053:3053 \
  -e MISSIVE_API_KEY=your_api_key \
  -e PERSISTENT_DIR=/app/temp \
  wexdownloader
```

### Docker Compose

```yaml
version: '3.8'
services:
  wexdownloader:
    image: wexdownloader
    ports:
      - "3053:3053"
    environment:
      - MISSIVE_API_KEY=${MISSIVE_API_KEY}
      - PERSISTENT_DIR=/app/temp
      - HEADLESS=true
      - MAX_RETRIES=3
    volumes:
      - ./temp:/app/temp
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3053/health"]
      interval: 30s
      timeout: 3s
      retries: 3
```

### Coolify Deployment

1. Create a new service in Coolify
2. Connect this GitHub repository
3. Add environment variables in Coolify:
   - `MISSIVE_API_KEY`: Your Missive API key (required)
   - `PERSISTENT_DIR`: `/app/temp` (recommended)
   - `HEADLESS`: `true`
   - `MAX_RETRIES`: `3`
4. Deploy - Coolify will automatically detect the Dockerfile

## Missive Setup

1. Get your API key from Missive:
   - Go to Settings → API → Personal API tokens
   - Create a new token
   - Copy the token to your `.env` file

2. Set up webhook in Missive:
   - Create a new rule or integration
   - Set webhook URL to: `https://your-domain.com/processreport`
   - Configure trigger conditions

## Architecture

- **Persistent Browser**: Browser instance stays running between requests (~500ms saved per request)
- **Context Isolation**: Each request gets its own browser context for security
- **Temp Management**: Each download gets a unique directory within the persistent directory
- **Graceful Shutdown**: Properly closes browser on SIGINT/SIGTERM signals
- **Verbose Logging**: Detailed console output with visual indicators (✓, ✗, ⚠️)

## Error Handling

- Automatic retry for failed downloads (configurable via `MAX_RETRIES`)
- Automatic retry for failed webhook deliveries
- Comprehensive error logging with stack traces
- Proper cleanup even on failure
- HTTP status codes for different error scenarios

## Security

- Runs as non-root user in Docker container
- Input validation for all request parameters
- Isolated browser contexts per request
- No persistent storage of downloaded files
- API key stored as environment variable

## Troubleshooting

### Missive API Key Not Working
- Verify the API key is correct in your `.env` file
- Check that the key has proper permissions in Missive
- Look for error messages in console output

### Downloads Failing
- Check console logs for specific error messages
- Verify the URL extraction is working (check logs for "Extracted download URL")
- Try setting `HEADLESS=false` to see browser behavior
- Increase `MAX_RETRIES` if downloads are timing out

### Webhook Delivery Failing
- Verify the webhook URL is correct and accessible
- Check that the webhook accepts multipart/form-data
- Review webhook response in console logs
- Ensure file size isn't exceeding webhook limits

### Browser Issues
- Use `/restart-browser` endpoint to restart the browser
- Check available system memory
- Ensure all Playwright dependencies are installed in Docker

## Development

### Running Tests
```bash
npm test
```

### Debug Mode
```bash
# Set in .env file
HEADLESS=false
```

This will show the browser window during downloads for debugging.

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