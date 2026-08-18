#!/usr/bin/env node
/**
 * Tabby MCP Server 测试脚本（无需 LLM，直接走 MCP 协议）
 *
 * 用途：绕过大模型，直接对本地 Tabby MCP server 发起 tools/list / tools/call，
 *       用于回归测试会话定位、聚焦状态等逻辑（如 isFocusedPane 唯一性、exec_command 定位）。
 *
 * 用法：
 *   node scripts/mcp-test.cjs list [--port 3001]
 *      列出服务器全部工具
 *   node scripts/mcp-test.cjs call <toolName> '<jsonArgs>' [--port 3001]
 *      调用工具。示例：
 *        node scripts/mcp-test.cjs call get_session_list '{}'
 *        node scripts/mcp-test.cjs call exec_command '{"command":"hostname","sessionId":"<id>"}'
 *   node scripts/mcp-test.cjs regress [--port 3001]
 *      回归测试：isFocusedPane 唯一性 + exec_command 定位正确性（非零退出码 = 失败）
 *
 * 依赖：仓库 node_modules 中的 @modelcontextprotocol/sdk（Node >= 22，自带 fetch）
 *
 * 备选现成工具（官方，无需写代码）：MCP Inspector
 *   npx @modelcontextprotocol/inspector --cli http://localhost:3001/mcp --transport http \
 *     --method tools/call --tool-name exec_command \
 *     --tool-arg command=hostname --tool-arg sessionId=<id> --format json
 */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
const cmd = argv.find(a => !a.startsWith('--')) || 'list';
const portIdx = argv.indexOf('--port');
const PORT = portIdx !== -1 ? parseInt(argv[portIdx + 1], 10) : 3001;
const SERVER_URL = `http://localhost:${PORT}/mcp`;

// ---------- 连接 ----------
async function connect() {
    const client = new Client({ name: 'tabby-mcp-test', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL));
    try {
        await client.connect(transport, { timeout: 8000 });
    } catch (e) {
        console.error(`连接失败: ${SERVER_URL}`);
        console.error(`  原因: ${e.message || e}`);
        console.error(`  检查: 1) Tabby 是否已启动并启用了 MCP server`);
        console.error(`        2) MCP 端口是否正确（Tabby 设置 → MCP → Port，默认 3001），用 --port <端口> 指定`);
        console.error(`        3) 可用 netstat -ano | findstr LISTENING 确认端口`);
        process.exit(2);
    }
    return client;
}

function extractText(result) {
    if (result && Array.isArray(result.content)) {
        const textPart = result.content.find(c => c.type === 'text');
        if (textPart) return textPart.text;
    }
    return JSON.stringify(result, null, 2);
}

// ---------- list ----------
async function cmdList() {
    const client = await connect();
    try {
        const { tools } = await client.listTools();
        console.log(`共 ${tools.length} 个工具:`);
        for (const t of tools) {
            const firstLine = (t.description || '').split('\n')[0];
            console.log(`  - ${t.name.padEnd(28)} ${firstLine.slice(0, 70)}`);
        }
    } finally {
        await client.close();
    }
}

// ---------- call ----------
async function cmdCall(toolName, jsonArgs) {
    const client = await connect();
    try {
        const result = await client.callTool({ name: toolName, arguments: jsonArgs });
        console.log(extractText(result));
    } finally {
        await client.close();
    }
}

// ---------- regress（回归断言） ----------
async function cmdRegress() {
    let failed = false;
    const client = await connect();
    try {
        // 1) tools/list
        const { tools } = await client.listTools();
        console.log(`[1/3] tools/list → ${tools.length} 个工具`);

        // 2) get_session_list: isFocusedPane 唯一性
        const sessText = extractText(await client.callTool({ name: 'get_session_list', arguments: {} }));
        let sessions;
        try {
            sessions = JSON.parse(sessText);
        } catch {
            sessions = JSON.parse(JSON.stringify(sessText));
        }
        const focused = sessions.filter(s => s && s.isFocusedPane === true);
        console.log(`[2/3] get_session_list → ${sessions.length} 个会话, isFocusedPane=true: ${focused.length} 个`);
        if (focused.length > 1) {
            console.error('  ✗ FAIL: isFocusedPane 不唯一（多 split 布局 bug），聚焦会话应为 0 或 1 个');
            failed = true;
        } else {
            console.log(`  ✓ ${focused.length === 1 ? `聚焦会话唯一: ${focused[0].title}` : '无聚焦标记（无 split 或均未聚焦，符合预期）'}`);
        }

        // 3) exec_command 定位正确性：用第一个会话的 sessionId 执行 hostname
        if (sessions.length === 0) {
            console.error('  ✗ SKIP: 无会话可测');
            failed = true;
        } else {
            const target = sessions[0];
            console.log(`[3/3] exec_command(hostname) 定位 → sessionId=${target.sessionId} (${target.title})`);
            const execText = extractText(await client.callTool({
                name: 'exec_command',
                arguments: { command: 'hostname', sessionId: target.sessionId, waitForOutput: true, timeout: 15000 }
            }));
            let parsed = null;
            try { parsed = JSON.parse(execText); } catch { /* 保持 null */ }
            console.log(`  → 返回: ${(execText || '').slice(0, 200)}`);
            if (parsed && parsed.sessionId && parsed.sessionId !== target.sessionId) {
                console.error(`  ✗ FAIL: 期望执行于 ${target.sessionId}, 实际返回 ${parsed.sessionId}`);
                failed = true;
            } else if (parsed && parsed.error) {
                console.error(`  ✗ FAIL: 执行报错: ${parsed.error}`);
                failed = true;
            } else {
                console.log('  ✓ 定位正确');
            }
        }
    } finally {
        await client.close();
    }
    if (failed) {
        console.error('\n=== 回归结果: FAIL ===');
        process.exit(1);
    }
    console.log('\n=== 回归结果: PASS ===');
}

// ---------- 主入口 ----------
(async () => {
    switch (cmd) {
        case 'list':
            await cmdList();
            break;
        case 'call': {
            const toolName = argv[argv.indexOf('call') + 1];
            const jsonArgsRaw = argv[argv.indexOf('call') + 2];
            if (!toolName) {
                console.error('用法: node scripts/mcp-test.cjs call <toolName> \'<jsonArgs>\' [--port N]');
                process.exit(1);
            }
            let jsonArgs = {};
            if (jsonArgsRaw) {
                try {
                    jsonArgs = JSON.parse(jsonArgsRaw);
                } catch {
                    console.error(`参数不是合法 JSON: ${jsonArgsRaw}`);
                    process.exit(1);
                }
            }
            await cmdCall(toolName, jsonArgs);
            break;
        }
        case 'regress':
            await cmdRegress();
            break;
        default:
            console.error(`未知命令: ${cmd}（支持 list / call / regress）`);
            process.exit(1);
    }
})().catch(e => {
    console.error('脚本错误:', e.message || e);
    process.exit(1);
});
