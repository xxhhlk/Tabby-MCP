#!/usr/bin/env node

/**
 * Tabby MCP STDIO Bridge
 * 
 * This script provides STDIO transport for MCP clients that don't support SSE.
 * It acts as a bridge between stdin/stdout and the Tabby MCP SSE server.
 * 
 * Usage:
 *   node stdio-bridge.js [--port 3001] [--host localhost]
 * 
 * For Claude Desktop mcp.json:
 *   {
 *     "mcpServers": {
 *       "tabby-mcp-server": {
 *         "command": "node",
 *         "args": ["/path/to/tabby-mcp-server/scripts/stdio-bridge.js"]
 *       }
 *     }
 *   }
 */

const http = require('http');
const https = require('https');
const readline = require('readline');

// Configuration
const DEFAULT_PORT = 3001;
const DEFAULT_HOST = 'localhost';

// Parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    let port = DEFAULT_PORT;
    let host = DEFAULT_HOST;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--port' && args[i + 1]) {
            port = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--host' && args[i + 1]) {
            host = args[i + 1];
            i++;
        }
    }

    return { port, host };
}

const config = parseArgs();
const baseUrl = `http://${config.host}:${config.port}`;

// Session ID for SSE connection
let sessionId = null;
let sseConnection = null;

// Log to stderr (so it doesn't interfere with STDIO protocol)
function log(message) {
    process.stderr.write(`[stdio-bridge] ${message}\n`);
}

// Send JSON-RPC response to stdout
function sendResponse(response) {
    const json = JSON.stringify(response);
    process.stdout.write(json + '\n');
}

// Make HTTP request to MCP server
function httpRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, baseUrl);

        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null });
                } catch (e) {
                    resolve({ status: res.statusCode, data: data });
                }
            });
        });

        req.on('error', reject);

        if (body) {
            req.write(JSON.stringify(body));
        }

        req.end();
    });
}

// Connect to SSE endpoint and handle events
function connectSSE() {
    return new Promise((resolve, reject) => {
        const url = new URL('/sse', baseUrl);

        log(`Connecting to SSE: ${url.href}`);

        const req = http.get(url.href, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`SSE connection failed: ${res.statusCode}`));
                return;
            }

            sseConnection = res;
            let buffer = '';

            res.on('data', (chunk) => {
                buffer += chunk.toString();

                // Process complete SSE events
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // Keep incomplete line in buffer

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            handleSSEMessage(data);
                        } catch (e) {
                            // Ignore parse errors (could be heartbeat)
                        }
                    } else if (line.includes('sessionId=')) {
                        // Extract session ID from endpoint event
                        const match = line.match(/sessionId=([a-zA-Z0-9-]+)/);
                        if (match) {
                            sessionId = match[1];
                            log(`Session ID: ${sessionId}`);
                            resolve(sessionId);
                        }
                    }
                }
            });

            res.on('error', (err) => {
                log(`SSE error: ${err.message}`);
            });

            res.on('close', () => {
                log('SSE connection closed');
                // Try to reconnect after a delay
                setTimeout(() => {
                    connectSSE().catch(err => log(`Reconnect failed: ${err.message}`));
                }, 5000);
            });

            // Set a timeout for initial session ID
            setTimeout(() => {
                if (!sessionId) {
                    // Try to extract from first endpoint event
                    resolve(null);
                }
            }, 2000);
        });

        req.on('error', reject);
    });
}

// Handle incoming SSE message
function handleSSEMessage(data) {
    // Forward SSE messages as JSON-RPC notifications
    sendResponse(data);
}

// Send message to MCP server via POST
async function sendToServer(message) {
    if (!sessionId) {
        log('No session ID, waiting for SSE connection...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (!sessionId) {
            throw new Error('No SSE session established');
        }
    }

    const response = await httpRequest('POST', `/messages?sessionId=${sessionId}`, message);
    return response;
}

// Handle JSON-RPC request from stdin
async function handleRequest(request) {
    try {
        // Forward to MCP server
        const response = await sendToServer(request);

        if (response.data) {
            sendResponse(response.data);
        }
    } catch (error) {
        log(`Error handling request: ${error.message}`);
        sendResponse({
            jsonrpc: '2.0',
            id: request.id,
            error: {
                code: -32603,
                message: error.message
            }
        });
    }
}

// Main entry point
async function main() {
    log(`Starting STDIO bridge for Tabby MCP at ${baseUrl}`);

    // Check if server is running
    try {
        const health = await httpRequest('GET', '/health');
        if (health.status !== 200) {
            log('Warning: MCP server may not be running. Start Tabby and enable MCP server.');
        } else {
            log('MCP server is running');
        }
    } catch (error) {
        log(`Warning: Cannot connect to MCP server at ${baseUrl}`);
        log('Make sure Tabby is running and MCP server is started.');
    }

    // Connect to SSE
    try {
        await connectSSE();
    } catch (error) {
        log(`SSE connection error: ${error.message}`);
    }

    // Read from stdin
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
    });

    rl.on('line', async (line) => {
        if (!line.trim()) return;

        try {
            const request = JSON.parse(line);
            await handleRequest(request);
        } catch (error) {
            log(`Invalid JSON: ${error.message}`);
        }
    });

    rl.on('close', () => {
        log('STDIO closed, exiting');
        process.exit(0);
    });

    // Handle termination
    process.on('SIGINT', () => {
        log('Received SIGINT, exiting');
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        log('Received SIGTERM, exiting');
        process.exit(0);
    });
}

main().catch(error => {
    log(`Fatal error: ${error.message}`);
    process.exit(1);
});
