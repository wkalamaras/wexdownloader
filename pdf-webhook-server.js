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
const FUELREPORTWEBHOOK = process.env.FUELREPORTWEBHOOK;
const EFSREPORTWEBHOOK = process.env.EFSREPORTWEBHOOK;
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
    console.log(`📡 Fetching message from Missive API...`);
    console.log(`   URL: ${url}`);
    
    try {
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${MISSIVE_API_KEY}`,
                'Accept': 'application/json'
            },
            timeout: 10000
        });
        
        console.log('✓ Successfully fetched message details from Missive');
        
        // Log the structure for debugging
        if (response.data?.messages) {
            if (typeof response.data.messages === 'object' && !Array.isArray(response.data.messages)) {
                console.log('   Messages is an object (single message)');
                if (response.data.messages.body) {
                    console.log('   Message body found in messages.body');
                    // Log first 200 chars of body for debugging
                    const bodyPreview = response.data.messages.body.substring(0, 200);
                    console.log(`   Body preview: ${bodyPreview}...`);
                }
            } else if (Array.isArray(response.data.messages)) {
                console.log(`   Messages is an array with ${response.data.messages.length} item(s)`);
            }
        } else {
            console.log('   Response structure:', Object.keys(response.data));
        }
        
        return response.data;
    } catch (error) {
        console.error('❌ Failed to fetch from Missive API:', error.message);
        if (error.response) {
            console.error('   Response status:', error.response.status);
            console.error('   Response data:', JSON.stringify(error.response.data).substring(0, 200));
        }
        throw new Error(`Failed to fetch message from Missive: ${error.message}`);
    }
}

// Extract download URL from message body
function extractDownloadUrl(messageData) {
    console.log('🔍 Extracting URL from message body...');
    
    let body = '';
    
    // Check for body in different possible locations based on Missive API response structure
    // The API returns { messages: { body: "..." } } where messages is an OBJECT not array
    if (messageData.messages && typeof messageData.messages === 'object' && !Array.isArray(messageData.messages)) {
        // messages is an object (single message)
        body = messageData.messages.body || '';
        console.log('   Found body in messages.body (object format)');
    } else if (messageData.messages && Array.isArray(messageData.messages) && messageData.messages.length > 0) {
        // messages is an array (multiple messages)
        body = messageData.messages[0].body || '';
        console.log('   Found body in messages[0].body (array format)');
    } else if (messageData.message?.body) {
        body = messageData.message.body;
        console.log('   Found body in message.body');
    } else if (messageData.body) {
        body = messageData.body;
        console.log('   Found body in root body');
    }
    
    if (!body) {
        console.error('❌ No message body found in response');
        console.error('   Available keys:', Object.keys(messageData));
        throw new Error('No message body found in Missive response');
    }
    
    // Primary method: Extract href URL and decode HTML entities
    const hrefMatch = body.match(/href="([^"]+)"/);
    if (hrefMatch && hrefMatch[1]) {
        // Decode HTML entities (especially &amp; to &)
        let url = hrefMatch[1].replace(/&amp;/g, '&');
        console.log(`✓ Extracted download URL: ${url}`);
        return url;
    }
    
    // Fallback patterns if href extraction fails
    console.log('   Primary extraction failed, trying fallback patterns...');
    const patterns = [
        /Download at:\s*<a[^>]*href="([^"]+)"/i,
        /https:\/\/manage\.fleetone\.com\/[^\s"'<>]+getJobFile[^\s"'<>]+/gi,
        /(https?:\/\/[^\s"'<>]+\.pdf[^\s"'<>]*)/gi
    ];
    
    for (const pattern of patterns) {
        const matches = body.match(pattern);
        if (matches) {
            let url = matches[1] || matches[0];
            // Decode HTML entities
            url = url.replace(/&amp;/g, '&');
            console.log(`✓ Extracted download URL (fallback): ${url}`);
            return url;
        }
    }
    
    // Log the body for debugging if no URL found
    console.error('❌ Could not find URL in message body');
    console.error('   Body content (first 500 chars):');
    console.error('   ' + body.substring(0, 500));
    throw new Error('No download URL found in message body');
}

// Determine webhook URL and type based on filename
function determineWebhookConfig(fileName) {
    console.log(`🎯 Determining webhook routing for file: ${fileName}`);
    
    let webhookUrl;
    let reportType;
    
    if (fileName.toLowerCase().includes('grandtotalreport')) {
        webhookUrl = FUELREPORTWEBHOOK;
        reportType = 'FuelReport';
        console.log('   ✓ File contains "GrandTotalReport" - routing to FUELREPORTWEBHOOK');
    } else {
        webhookUrl = EFSREPORTWEBHOOK;
        reportType = 'EFSReport';
        console.log('   ✓ File does not contain "GrandTotalReport" - routing to EFSREPORTWEBHOOK');
    }
    
    if (!webhookUrl) {
        const envVar = reportType === 'FuelReport' ? 'FUELREPORTWEBHOOK' : 'EFSREPORTWEBHOOK';
        throw new Error(`${envVar} environment variable is not configured`);
    }
    
    console.log(`   Webhook URL: ${webhookUrl}`);
    console.log(`   Report Type: ${reportType}`);
    
    return { webhookUrl, reportType };
}

async function downloadWithRetry(page, url, tempDir, retries = 0) {
    try {
        console.log(`📥 Download attempt ${retries + 1}/${MAX_RETRIES + 1}`);
        console.log(`   URL: ${url}`);
        
        // Set up download handler before navigation
        const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
        
        // Navigate to the URL
        page.goto(url, { 
            waitUntil: 'commit',
            timeout: 30000 
        }).catch(err => {
            // Ignore navigation errors for direct downloads
            console.log('   Navigation completed (direct download expected)');
        });
        
        // Wait for download to complete
        const download = await downloadPromise;
        const downloadPath = await download.path();
        const fileName = download.suggestedFilename();
        
        console.log(`✓ Downloaded file: ${fileName}`);
        console.log(`   Path: ${downloadPath}`);
        
        return { downloadPath, fileName };
        
    } catch (error) {
        console.error(`❌ Download attempt ${retries + 1} failed: ${error.message}`);
        
        if (retries < MAX_RETRIES) {
            console.log(`   Retrying in ${RETRY_DELAY/1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            
            // Refresh the page before retry
            try {
                await page.reload({ timeout: 5000 });
                console.log('   Page reloaded for retry');
            } catch (reloadError) {
                console.log('   Page reload failed, continuing with retry');
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
    
    // Store request data for processing
    const requestData = Array.isArray(req.body) ? req.body[0] : req.body;
    
    // Quick validation
    if (!requestData) {
        return res.status(400).json({ 
            error: 'Invalid request format',
            details: 'Request body is empty or invalid'
        });
    }
    
    // Check for message ID and conversation ID
    let messageId;
    let conversationId;
    
    if (requestData.latest_message?.id) {
        messageId = requestData.latest_message.id;
    } else if (requestData.body?.latest_message?.id) {
        messageId = requestData.body.latest_message.id;
    }
    
    if (requestData.conversation?.id) {
        conversationId = requestData.conversation.id;
    } else if (requestData.body?.conversation?.id) {
        conversationId = requestData.body.conversation.id;
    }
    
    if (!messageId) {
        return res.status(400).json({ 
            error: 'Missing message ID',
            details: 'Could not find message ID in request'
        });
    }
    
    // Immediately respond with 200 to acknowledge receipt
    res.status(200).json({ 
        success: true,
        message: 'Webhook received, processing download',
        messageId: messageId,
        conversationId: conversationId || null,
        timestamp: new Date().toISOString()
    });
    
    // Process the download asynchronously (after response sent)
    processDownloadAsync(requestData, messageId, conversationId).catch(error => {
        console.error('❌ Async processing failed:', error);
    });
});

// Async function to process the download after responding
async function processDownloadAsync(requestData, messageId, conversationId) {
    let context;
    let page;
    let tempDir;
    let downloadPath;
    
    try {
        // Log processing details
        console.log('📨 Processing download asynchronously:');
        console.log(`   Message ID: ${messageId}`);
        console.log(`   Conversation ID from webhook: ${conversationId || 'Not provided'}`);
        console.log('   Request data keys:', Object.keys(requestData));
        
        // Log the full request body for debugging (optional)
        if (process.env.DEBUG === 'true') {
            console.log('\n📋 Full Request Body (first 2000 chars):');
            const bodyStr = JSON.stringify(requestData, null, 2);
            console.log(bodyStr.substring(0, 2000));
            if (bodyStr.length > 2000) {
                console.log('... (truncated)');
            }
        }
        
        let webhookUrl;
        
        // Check for webhook URL (may come from n8n wrapper)
        if (requestData.webhookUrl) {
            webhookUrl = requestData.webhookUrl;
            console.log('   Found webhookUrl in request');
        }
        
        console.log(`   Webhook URL from request: ${webhookUrl || 'None (will use env vars based on filename)'}`);
        console.log(`   Execution Mode: ${requestData.executionMode || 'not specified'}`);
        
        // Fetch message details from Missive API
        const messageData = await fetchMissiveMessage(messageId);
        
        // Get the correct conversation ID from the API response
        // The API returns it at messages.conversation.id
        if (messageData?.messages?.conversation?.id) {
            conversationId = messageData.messages.conversation.id;
            console.log(`✓ Updated conversation ID from API: ${conversationId}`);
        }
        
        // Extract download URL from message
        const downloadUrl = extractDownloadUrl(messageData);
        
        // Ensure browser is initialized
        const browser = await initBrowser();
        
        // Create temp directory within persistent directory
        tempDir = path.join(PERSISTENT_DIR, `download-${Date.now()}-${Math.random().toString(36).substring(7)}`);
        await fs.mkdir(tempDir, { recursive: true });
        console.log(`📁 Created temp directory: ${tempDir}`);
        
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
        
        // Determine webhook URL and type based on filename
        const webhookConfig = determineWebhookConfig(fileName);
        webhookUrl = webhookConfig.webhookUrl;  // Override any provided webhook URL
        const reportType = webhookConfig.reportType;
        
        // Read the file as binary
        const fileBuffer = await fs.readFile(downloadPath);
        console.log(`📊 File size: ${(fileBuffer.length / 1024).toFixed(2)} KB`);
        
        // Send file to output webhook with retry
        let webhookResponse;
        let webhookRetries = 0;
        
        while (webhookRetries <= MAX_RETRIES) {
            try {
                console.log(`📤 Sending to webhook (attempt ${webhookRetries + 1}/${MAX_RETRIES + 1})...`);
                console.log(`   URL: ${webhookUrl}`);
                console.log(`   Report Type: ${reportType}`);
                console.log(`   Conversation ID: ${conversationId || 'Not provided'}`);
                console.log(`   Message ID: ${messageId}`);
                
                const formData = new FormData();
                formData.append('file', fileBuffer, {
                    filename: fileName,
                    contentType: 'application/pdf'
                });
                formData.append('type', reportType);
                formData.append('conversationId', conversationId || '');
                formData.append('messageId', messageId);
                
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
                console.error(`❌ Webhook attempt ${webhookRetries} failed: ${webhookError.message}`);
                
                if (webhookRetries > MAX_RETRIES) {
                    throw new Error(`Failed to send to webhook after ${MAX_RETRIES} attempts: ${webhookError.message}`);
                }
                
                console.log(`   Retrying in ${RETRY_DELAY/1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            }
        }
        
        console.log(`✅ Success! Report processed and sent`);
        console.log(`   File: ${fileName}`);
        console.log(`   Type: ${reportType}`);
        console.log(`   Size: ${(fileBuffer.length / 1024).toFixed(2)} KB`);
        console.log(`   Webhook Status: ${webhookResponse.status}`);
        console.log(`   Download Retries: 0`);
        console.log(`   Webhook Retries: ${webhookRetries > 0 ? webhookRetries - 1 : 0}`);
        
    } catch (error) {
        console.error('❌ Error processing download asynchronously:', error);
        console.error('   Stack:', error.stack);
        // Since we already responded, just log the error
    } finally {
        // Clean up temp files and directory
        if (downloadPath) {
            try {
                await fs.unlink(downloadPath);
                console.log('🧹 Cleaned up downloaded file');
            } catch (err) {
                console.error('   Error deleting temp file:', err.message);
            }
        }
        
        if (tempDir) {
            try {
                // List and clean any remaining files
                const files = await fs.readdir(tempDir);
                if (files.length > 0) {
                    console.log(`🧹 Cleaning ${files.length} remaining files...`);
                    for (const file of files) {
                        try {
                            await fs.unlink(path.join(tempDir, file));
                        } catch (err) {
                            console.error(`   Error deleting ${file}:`, err.message);
                        }
                    }
                }
                await fs.rmdir(tempDir);
                console.log('🧹 Cleaned up temp directory');
            } catch (err) {
                console.error('   Error deleting temp directory:', err.message);
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
}

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
            missiveApiConfigured: !!MISSIVE_API_KEY,
            fuelReportWebhookConfigured: !!FUELREPORTWEBHOOK,
            efsReportWebhookConfigured: !!EFSREPORTWEBHOOK
        },
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Endpoint to manually restart browser
app.post('/restart-browser', async (req, res) => {
    try {
        console.log('🔄 Restarting browser...');
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
        console.error('❌ Failed to restart browser:', error.message);
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
    console.log(`WexDownloader Server v4.0`);
    console.log(`${'='.repeat(60)}`);
    console.log(`📋 Configuration:`);
    console.log(`   Port: ${PORT}`);
    console.log(`   Persistent Directory: ${PERSISTENT_DIR}`);
    console.log(`   Browser Mode: ${HEADLESS ? 'Headless' : 'Visible'}`);
    console.log(`   Max Retries: ${MAX_RETRIES}`);
    console.log(`   Missive API: ${MISSIVE_API_KEY ? '✓ Configured' : '✗ Not configured (WARNING)'}`);
    console.log(`   Fuel Report Webhook: ${FUELREPORTWEBHOOK ? '✓ Configured' : '✗ Not configured'}`);
    console.log(`   EFS Report Webhook: ${EFSREPORTWEBHOOK ? '✓ Configured' : '✗ Not configured'}`);
    console.log(`\n📡 Endpoints:`);
    console.log(`   POST http://localhost:${PORT}/processreport`);
    console.log(`   GET  http://localhost:${PORT}/health`);
    console.log(`   POST http://localhost:${PORT}/restart-browser`);
    console.log(`${'='.repeat(60)}\n`);
    
    // Ensure persistent directory exists
    await ensurePersistentDir();
    
    // Initialize browser on startup
    await initBrowser();
});