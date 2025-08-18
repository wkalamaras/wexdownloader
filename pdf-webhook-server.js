const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3053;
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 seconds

// Global browser instance that stays running
let globalBrowser = null;

app.use(express.json());

// Initialize browser on startup
async function initBrowser() {
    if (!globalBrowser) {
        console.log('Initializing browser...');
        globalBrowser = await chromium.launch({
            headless: true
        });
        console.log('Browser initialized and ready');
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

async function downloadWithRetry(page, url, tempDir, retries = 0) {
    try {
        // Set up download handler before navigation
        const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
        
        // Navigate to the URL
        const navigationPromise = page.goto(url, { 
            waitUntil: 'commit',
            timeout: 30000 
        }).catch(err => {
            // Ignore navigation errors for direct downloads
            console.log('Navigation completed (direct download)');
        });
        
        // Wait for download to complete
        const download = await downloadPromise;
        const downloadPath = await download.path();
        const fileName = download.suggestedFilename();
        
        console.log(`Downloaded file: ${fileName}`);
        
        return { downloadPath, fileName };
        
    } catch (error) {
        if (retries < MAX_RETRIES) {
            console.log(`Download attempt ${retries + 1} failed, retrying in ${RETRY_DELAY/1000} seconds...`);
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
    const inputUrl = req.headers['inputurl'];
    const outputWebhook = req.headers['output'];
    
    if (!inputUrl || !outputWebhook) {
        return res.status(400).json({ 
            error: 'Missing required headers: INPUTURL and OUTPUT' 
        });
    }
    
    console.log(`\n[${new Date().toISOString()}] New download request`);
    console.log(`Input URL: ${inputUrl}`);
    console.log(`Output webhook: ${outputWebhook}`);
    
    let context;
    let page;
    let tempDir;
    let downloadPath;
    
    try {
        // Ensure browser is initialized
        const browser = await initBrowser();
        
        // Create temp directory for downloads
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-download-'));
        
        // Create a new context for this download
        context = await browser.newContext({
            acceptDownloads: true,
            // Set download path for this context
            downloadsPath: tempDir
        });
        
        page = await context.newPage();
        
        // Download with retry logic
        const result = await downloadWithRetry(page, inputUrl, tempDir);
        downloadPath = result.downloadPath;
        const fileName = result.fileName;
        
        // Read the file as binary
        const fileBuffer = await fs.readFile(downloadPath);
        console.log(`File size: ${(fileBuffer.length / 1024).toFixed(2)} KB`);
        
        // Send file to output webhook with retry
        let webhookResponse;
        let webhookRetries = 0;
        
        while (webhookRetries <= MAX_RETRIES) {
            try {
                const formData = new FormData();
                formData.append('file', fileBuffer, {
                    filename: fileName,
                    contentType: 'application/pdf'
                });
                
                webhookResponse = await axios.post(outputWebhook, formData, {
                    headers: {
                        ...formData.getHeaders(),
                        'Content-Length': formData.getLengthSync()
                    },
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity,
                    timeout: 30000
                });
                
                console.log(`File sent successfully to webhook (status: ${webhookResponse.status})`);
                break;
                
            } catch (webhookError) {
                webhookRetries++;
                if (webhookRetries > MAX_RETRIES) {
                    throw new Error(`Failed to send to webhook after ${MAX_RETRIES} attempts: ${webhookError.message}`);
                }
                console.log(`Webhook attempt ${webhookRetries} failed, retrying...`);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            }
        }
        
        res.json({ 
            success: true, 
            message: 'File downloaded and sent successfully',
            fileName: fileName,
            fileSize: `${(fileBuffer.length / 1024).toFixed(2)} KB`,
            webhookResponse: webhookResponse.status,
            downloadRetries: 0,
            webhookRetries: webhookRetries > 0 ? webhookRetries - 1 : 0
        });
        
    } catch (error) {
        console.error('Error processing download:', error);
        res.status(500).json({ 
            error: 'Failed to process download', 
            details: error.message 
        });
    } finally {
        // Clean up temp files and directory
        if (downloadPath) {
            try {
                await fs.unlink(downloadPath);
                console.log('Cleaned up downloaded file');
            } catch (err) {
                console.error('Error deleting temp file:', err);
            }
        }
        
        if (tempDir) {
            try {
                // List files in temp dir before deletion (for debugging)
                const files = await fs.readdir(tempDir);
                if (files.length > 0) {
                    console.log(`Warning: ${files.length} files remaining in temp directory`);
                    for (const file of files) {
                        try {
                            await fs.unlink(path.join(tempDir, file));
                        } catch (err) {
                            console.error(`Error deleting ${file}:`, err);
                        }
                    }
                }
                await fs.rmdir(tempDir);
                console.log('Cleaned up temp directory');
            } catch (err) {
                console.error('Error deleting temp directory:', err);
            }
        }
        
        // Close the context and page (not the browser)
        if (page) {
            await page.close();
        }
        if (context) {
            await context.close();
        }
    }
});

// Health check endpoint
app.get('/health', async (req, res) => {
    const browserStatus = globalBrowser ? 'running' : 'not initialized';
    res.json({ 
        status: 'healthy', 
        port: PORT,
        browser: browserStatus,
        uptime: process.uptime()
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
        res.json({ success: true, message: 'Browser restarted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to restart browser', details: error.message });
    }
});

app.listen(PORT, async () => {
    console.log(`\n========================================`);
    console.log(`PDF Webhook Server v2.0`);
    console.log(`========================================`);
    console.log(`Server listening on port ${PORT}`);
    console.log(`Endpoints:`);
    console.log(`  POST http://localhost:${PORT}/processreport`);
    console.log(`  GET  http://localhost:${PORT}/health`);
    console.log(`  POST http://localhost:${PORT}/restart-browser`);
    console.log(`\nHeaders required for /processreport:`);
    console.log(`  INPUTURL: <URL to download>`);
    console.log(`  OUTPUT: <Webhook URL to send file>`);
    console.log(`========================================\n`);
    
    // Initialize browser on startup
    await initBrowser();
});