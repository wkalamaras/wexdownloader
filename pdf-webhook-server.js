require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const axios = require('axios');
const FormData = require('form-data');

const app = express();

// Environment variables with defaults
const PORT = process.env.PORT || 3053;
const PERSISTENT_DIR = process.env.PERSISTENT_DIR || path.join(os.tmpdir(), 'wexdownloader-temp');
const HEADLESS = process.env.HEADLESS !== 'false'; // Default true unless explicitly set to false
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3');
const MISSIVE_API_KEY = process.env.MISSIVE_API_KEY;
const RETRY_DELAY = 2000; // 2 seconds

// Validate required environment variables
if (!MISSIVE_API_KEY) {
    console.warn('⚠️  WARNING: MISSIVE_API_KEY is not set. The server will not be able to fetch message details.');
    console.warn('⚠️  Please set MISSIVE_API_KEY in your .env file or environment variables.');
}

// Global browser instance that stays running
let globalBrowser = null;

app.use(express.json({ limit: '50mb' }));

// Ensure persistent directory exists
async function ensurePersistentDir() {
    try {
        await fs.access(PERSISTENT_DIR);
        console.log(`✓ Using persistent directory: ${PERSISTENT_DIR}`);
    } catch {
        await fs.mkdir(PERSISTENT_DIR, { recursive: true });
        console.log(`✓ Created persistent directory: ${PERSISTENT_DIR}`);
    }
}

// Initialize browser on startup
async function initBrowser() {
    if (!globalBrowser) {
        console.log(`Initializing browser (headless: ${HEADLESS})...`);
        globalBrowser = await chromium.launch({
            headless: HEADLESS
        });
        console.log('✓ Browser initialized and ready');
    }
    return globalBrowser;
}

// Ensure browser is closed on process exit
process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...');
    if (globalBrowser) {
        await globalBrowser.close();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    if (globalBrowser) {
        await globalBrowser.close();
    }
    process.exit(0);
});

// Fetch message details from Missive API
async function fetchMissiveMessage(messageId) {
    if (!MISSIVE_API_KEY) {
        throw new Error('MISSIVE_API_KEY is not configured');
    }

    const url = `https://public.missiveapp.com/v1/messages/${messageId}?includeBody=true&includeConversation=true`;
    console.log(`Fetching message details from Missive API for message: ${messageId}`);
    
    try {
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${MISSIVE_API_KEY}`,
                'Accept': 'application/json'
            },
            timeout: 10000
        });
        
        console.log('✓ Successfully fetched message details from Missive');
        return response.data;
    } catch (error) {
        console.error('Failed to fetch from Missive API:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
        throw new Error(`Failed to fetch message from Missive: ${error.message}`);
    }
}

// Extract download URL from message body
function extractDownloadUrl(messageData) {
    // Look for the download URL in the message body
    // This regex looks for URLs that contain "getJobFile" or similar patterns
    const body = messageData.message?.body || messageData.body || '';
    
    // Multiple patterns to try
    const patterns = [
        /https:\/\/manage\.fleetone\.com\/[^\s"'<>]+getJobFile[^\s"'<>]+/gi,
        /Download at:\s*(https?:\/\/[^\s"'<>]+)/gi,
        /href="(https?:\/\/[^\s"]+getJobFile[^\s"]+)"/gi,
        /(https?:\/\/[^\s"'<>]+\.pdf[^\s"'<>]*)/gi
    ];
    
    for (const pattern of patterns) {
        const matches = body.match(pattern);
        if (matches && matches.length > 0) {
            // Clean up the URL
            let url = matches[0];
            url = url.replace(/^.*?(https?:\/\/)/, '$1'); // Remove any prefix
            url = url.replace(/["'<>].*$/, ''); // Remove any suffix
            console.log(`✓ Extracted download URL: ${url}`);
            return url;
        }
    }
    
    throw new Error('No download URL found in message body');
}

async function downloadWithRetry(page, url, tempDir, retries = 0) {
    try {
        console.log(`Download attempt ${retries + 1}/${MAX_RETRIES + 1} for URL: ${url}`);
        
        // Set up download handler before navigation
        const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
        
        // Navigate to the URL
        page.goto(url, { 
            waitUntil: 'commit',
            timeout: 30000 
        }).catch(err => {
            // Ignore navigation errors for direct downloads
            console.log('Navigation completed (direct download expected)');
        });
        
        // Wait for download to complete
        const download = await downloadPromise;
        const downloadPath = await download.path();
        const fileName = download.suggestedFilename();
        
        console.log(`✓ Downloaded file: ${fileName}`);
        
        return { downloadPath, fileName };
        
    } catch (error) {
        if (retries < MAX_RETRIES) {
            console.log(`Download attempt ${retries + 1} failed, retrying in ${RETRY_DELAY/1000} seconds...`);
            console.log(`Error was: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            
            // Refresh the page before retry
            try {
                await page.reload({ timeout: 5000 });
            } catch (reloadError) {
                console.log('Page reload failed, continuing with retry');
            }
            
            return downloadWithRetry(page, url, tempDir, retries + 1);
        }
        throw error;
    }
}

app.post('/processreport', async (req, res) => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[${new Date().toISOString()}] New process report request`);
    console.log(`${'='.repeat(60)}`);
    
    // Handle both array and single object input
    const requestData = Array.isArray(req.body) ? req.body[0] : req.body;
    
    if (!requestData || !requestData.body) {
        return res.status(400).json({ 
            error: 'Invalid request format',
            details: 'Request must contain a body object with Missive webhook data'
        });
    }
    
    const messageId = requestData.body?.latest_message?.id;
    const webhookUrl = requestData.webhookUrl;
    
    if (!messageId) {
        return res.status(400).json({ 
            error: 'Missing message ID',
            details: 'Could not find latest_message.id in request body'
        });
    }
    
    if (!webhookUrl) {
        return res.status(400).json({ 
            error: 'Missing webhook URL',
            details: 'webhookUrl is required in request'
        });
    }
    
    console.log(`Message ID: ${messageId}`);
    console.log(`Webhook URL: ${webhookUrl}`);
    console.log(`Execution Mode: ${requestData.executionMode || 'unknown'}`);
    
    let context;
    let page;
    let tempDir;
    let downloadPath;
    
    try {
        // Fetch message details from Missive API
        const messageData = await fetchMissiveMessage(messageId);
        
        // Extract download URL from message
        const downloadUrl = extractDownloadUrl(messageData);
        console.log(`Download URL extracted: ${downloadUrl}`);
        
        // Ensure browser is initialized
        const browser = await initBrowser();
        
        // Create temp directory within persistent directory
        tempDir = path.join(PERSISTENT_DIR, `download-${Date.now()}-${Math.random().toString(36).substring(7)}`);
        await fs.mkdir(tempDir, { recursive: true });
        console.log(`Created temp directory: ${tempDir}`);
        
        // Create a new context for this download
        context = await browser.newContext({
            acceptDownloads: true,
            downloadsPath: tempDir
        });
        
        page = await context.newPage();
        
        // Download with retry logic
        const result = await downloadWithRetry(page, downloadUrl, tempDir);
        downloadPath = result.downloadPath;
        const fileName = result.fileName;
        
        // Read the file as binary
        const fileBuffer = await fs.readFile(downloadPath);
        console.log(`✓ File size: ${(fileBuffer.length / 1024).toFixed(2)} KB`);
        
        // Send file to output webhook with retry
        let webhookResponse;
        let webhookRetries = 0;
        
        while (webhookRetries <= MAX_RETRIES) {
            try {
                console.log(`Sending to webhook (attempt ${webhookRetries + 1}/${MAX_RETRIES + 1})...`);
                
                const formData = new FormData();
                formData.append('file', fileBuffer, {
                    filename: fileName,
                    contentType: 'application/pdf'
                });
                
                webhookResponse = await axios.post(webhookUrl, formData, {
                    headers: {
                        ...formData.getHeaders(),
                        'Content-Length': formData.getLengthSync()
                    },
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity,
                    timeout: 30000
                });
                
                console.log(`✓ File sent successfully to webhook (status: ${webhookResponse.status})`);
                break;
                
            } catch (webhookError) {
                webhookRetries++;
                if (webhookRetries > MAX_RETRIES) {
                    throw new Error(`Failed to send to webhook after ${MAX_RETRIES} attempts: ${webhookError.message}`);
                }
                console.log(`Webhook attempt ${webhookRetries} failed: ${webhookError.message}`);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            }
        }
        
        const response = {
            success: true,
            message: 'File downloaded and sent successfully',
            messageId: messageId,
            fileName: fileName,
            fileSize: `${(fileBuffer.length / 1024).toFixed(2)} KB`,
            webhookResponse: webhookResponse.status,
            downloadRetries: 0,
            webhookRetries: webhookRetries > 0 ? webhookRetries - 1 : 0,
            timestamp: new Date().toISOString()
        };
        
        console.log(`✓ Success:`, response);
        res.json(response);
        
    } catch (error) {
        console.error('❌ Error processing download:', error);
        res.status(500).json({ 
            error: 'Failed to process download',
            details: error.message,
            messageId: messageId,
            timestamp: new Date().toISOString()
        });
    } finally {
        // Clean up temp files and directory
        if (downloadPath) {
            try {
                await fs.unlink(downloadPath);
                console.log('✓ Cleaned up downloaded file');
            } catch (err) {
                console.error('Error deleting temp file:', err.message);
            }
        }
        
        if (tempDir) {
            try {
                // List and clean any remaining files
                const files = await fs.readdir(tempDir);
                if (files.length > 0) {
                    console.log(`Cleaning ${files.length} remaining files...`);
                    for (const file of files) {
                        try {
                            await fs.unlink(path.join(tempDir, file));
                        } catch (err) {
                            console.error(`Error deleting ${file}:`, err.message);
                        }
                    }
                }
                await fs.rmdir(tempDir);
                console.log('✓ Cleaned up temp directory');
            } catch (err) {
                console.error('Error deleting temp directory:', err.message);
            }
        }
        
        // Close the context and page (not the browser)
        if (page) {
            await page.close();
        }
        if (context) {
            await context.close();
        }
        
        console.log(`${'='.repeat(60)}\n`);
    }
});

// Health check endpoint
app.get('/health', async (req, res) => {
    const browserStatus = globalBrowser ? 'running' : 'not initialized';
    res.json({ 
        status: 'healthy',
        port: PORT,
        browser: browserStatus,
        config: {
            headless: HEADLESS,
            maxRetries: MAX_RETRIES,
            persistentDir: PERSISTENT_DIR,
            missiveApiConfigured: !!MISSIVE_API_KEY
        },
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Endpoint to manually restart browser
app.post('/restart-browser', async (req, res) => {
    try {
        if (globalBrowser) {
            await globalBrowser.close();
            globalBrowser = null;
        }
        await initBrowser();
        res.json({ 
            success: true,
            message: 'Browser restarted successfully',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to restart browser',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Start server
app.listen(PORT, async () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`WexDownloader Server v3.0`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Configuration:`);
    console.log(`  Port: ${PORT}`);
    console.log(`  Persistent Directory: ${PERSISTENT_DIR}`);
    console.log(`  Browser Mode: ${HEADLESS ? 'Headless' : 'Visible'}`);
    console.log(`  Max Retries: ${MAX_RETRIES}`);
    console.log(`  Missive API: ${MISSIVE_API_KEY ? '✓ Configured' : '✗ Not configured (WARNING)'}`);
    console.log(`\nEndpoints:`);
    console.log(`  POST http://localhost:${PORT}/processreport`);
    console.log(`  GET  http://localhost:${PORT}/health`);
    console.log(`  POST http://localhost:${PORT}/restart-browser`);
    console.log(`${'='.repeat(60)}\n`);
    
    // Ensure persistent directory exists
    await ensurePersistentDir();
    
    // Initialize browser on startup
    await initBrowser();
});