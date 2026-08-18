#!/usr/bin/env node
/**
 * Tabby MCP Server 测试脚本（无需 LLM，直接走 MCP 协议）
 *
 * 用途：绕过大模型，直接对本地 Tabby MCP server 发起 tools/list / tools/call，
 *       用于回归测试会话定位、聚焦状态等逻辑（如 isFocusedPane 唯一性、exec_command 定位）。
 *
 * 用法：
 *   node scripts/mcp-test.cjs list [--port 34266]
 *      列出服务器全部工具
 *   node scripts/mcp-test.cjs call <toolName> '<jsonArgs>' [--port 34266]
 *      调用工具。示例：
 *        node scripts/mcp-test.cjs call get_session_list '{}'
 *        node scripts/mcp-test.cjs call exec_command '{"command":"hostname","sessionId":"<id>"}'
 *   node scripts/mcp-test.cjs regress [--port 34266]
 *      回归测试（自动断言，非零退出码 = 失败）：
 *        1. tools/list
 *        2. get_session_list isFocusedPane 唯一性
 *        3. exec_command 带 sessionId 定位正确性
 *        4. select_tab 切换聚焦 → 验证 isFocusedPane 迁移且唯一
 *        5. exec_command 不带 locator → 验证落在刚切换的会话（fallback 认 activeTab）
 *        5.5 exec_command 带 tabId → 验证切换后带定位信息也落在目标
 *        6. 随机多切 3 个标签，逐个验证聚焦唯一迁移
 *        7. 随机多切后 exec_command 无 locator → 落在最后一个随机目标
 *        最后自动恢复原聚焦会话（不改变你的界面状态）
 *   node scripts/mcp-test.cjs verify [--port 34266]
 *      全面验证（10 步）：list_tabs 互通字段、exec_command 四种定位方式
 *      （sessionId/tabId/title/tabIndex）、无效 sessionId 错误行为、get_terminal_buffer、
 *      select_tab(tabId) 聚焦迁移；末尾恢复原聚焦会话
 *
 * 依赖：仓库 node_modules 中的 @modelcontextprotocol/sdk（Node >= 22，自带 fetch）
 *
 * 备选现成工具（官方，无需写代码）：MCP Inspector
 *   npx @modelcontextprotocol/inspector --cli http://localhost:34266/mcp --transport http \
 *     --method tools/call --tool-name exec_command \
 *     --tool-arg command=hostname --tool-arg sessionId=<id> --format json
 */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
const cmd = argv.find(a => !a.startsWith('--')) || 'list';
const portIdx = argv.indexOf('--port');
const PORT = portIdx !== -1 ? parseInt(argv[portIdx + 1], 10) : 34266;
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
        console.error(`        2) MCP 端口是否正确（Tabby 设置 → MCP → Port，本机默认 34266），用 --port <端口> 指定`);
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
async function getSessions(client) {
    const text = extractText(await client.callTool({ name: 'get_session_list', arguments: {} }));
    let sessions;
    try {
        sessions = JSON.parse(text);
    } catch {
        sessions = JSON.parse(JSON.stringify(text));
    }
    return sessions;
}

/** 执行 hostname 并返回解析后的结果对象 */
async function execHostname(client, args) {
    const text = extractText(await client.callTool({
        name: 'exec_command',
        arguments: { command: 'hostname', waitForOutput: true, timeout: 20000, ...args }
    }));
    try {
        return { raw: text, parsed: JSON.parse(text) };
    } catch {
        return { raw: text, parsed: null };
    }
}

async function cmdRegress() {
    let failed = false;
    const client = await connect();
    try {
        // 1) tools/list
        const { tools } = await client.listTools();
        console.log(`[1/5] tools/list → ${tools.length} 个工具`);

        // 2) get_session_list: isFocusedPane 唯一性
        const sessions = await getSessions(client);
        const focused = sessions.filter(s => s && s.isFocusedPane === true);
        console.log(`[2/5] get_session_list → ${sessions.length} 个会话, isFocusedPane=true: ${focused.length} 个`);
        if (focused.length > 1) {
            console.error('  ✗ FAIL: isFocusedPane 不唯一（多 split 布局 bug），聚焦会话应为 0 或 1 个');
            failed = true;
        } else {
            console.log(`  ✓ ${focused.length === 1 ? `聚焦会话唯一: ${focused[0].title}` : '无聚焦标记（符合预期）'}`);
        }

        if (sessions.length === 0) {
            console.error('  ✗ SKIP: 无会话可测');
            failed = true;
        } else {
            const original = focused.length === 1 ? focused[0] : null;

            // 3) exec_command 带 sessionId 定位正确性（目标 = 一个非聚焦会话）
            const target = sessions.find(s => s !== original) || sessions[0];
            console.log(`[3/5] exec_command(hostname) 带 sessionId 定位 → ${target.title}`);
            let r = await execHostname(client, { sessionId: target.sessionId });
            console.log(`  → ${(r.raw || '').slice(0, 160)}`);
            if (!r.parsed || r.parsed.sessionId !== target.sessionId) {
                console.error(`  ✗ FAIL: 期望执行于 ${target.sessionId}, 实际 ${r.parsed ? r.parsed.sessionId : '无响应/解析失败'}`);
                failed = true;
            } else if (r.parsed.error) {
                console.warn(`  ⚠ 定位正确（sessionId 匹配），但命令执行报错: ${r.parsed.error}`);
            } else {
                console.log('  ✓ 定位正确');
            }

            // 4) select_tab 切换聚焦到 target
            console.log(`[4/5] select_tab 切换聚焦 → ${target.title}`);
            const stText = extractText(await client.callTool({ name: 'select_tab', arguments: { sessionId: target.sessionId } }));
            let st = null;
            try { st = JSON.parse(stText); } catch { /* 保持 null */ }
            console.log(`  → ${(stText || '').slice(0, 160)}`);
            if (!st || st.success !== true) {
                console.error(`  ✗ FAIL: select_tab 未返回 success: ${stText}`);
                failed = true;
            } else {
                // 5) 验证聚焦已迁移到 target 且唯一
                const sessions2 = await getSessions(client);
                const t2 = sessions2.find(s => s.sessionId === target.sessionId);
                const focused2 = sessions2.filter(s => s.isFocusedPane === true);
                const ok = t2 && t2.isFocusedPane === true && focused2.length === 1;
                console.log(`  → 切换后 isFocusedPane: ${focused2.length} 个 (${t2 ? t2.title : '?'}${t2 && t2.isFocusedPane ? ' ✓' : ' ✗'})`);
                if (!ok) {
                    console.error('  ✗ FAIL: select_tab 后聚焦未迁移到目标会话（或仍不唯一）');
                    failed = true;
                } else {
                    // 6) exec_command 不带 locator → 应落在刚切换的 target（fallback 走 activeTab）
                    console.log(`[5/5] exec_command(hostname) 无 locator → 应落在 ${target.title}`);
                    r = await execHostname(client, {});
                    console.log(`  → ${(r.raw || '').slice(0, 160)}`);
                    if (!r.parsed || r.parsed.sessionId !== target.sessionId) {
                        console.error(`  ✗ FAIL: 期望落在 ${target.sessionId}, 实际 ${r.parsed ? r.parsed.sessionId : '无响应/解析失败'}`);
                        failed = true;
                    } else if (r.parsed.error) {
                        console.warn(`  ⚠ 定位正确，但命令执行报错: ${r.parsed.error}`);
                    } else {
                        console.log('  ✓ 无 locator 落在切换后的目标（fallback 认 activeTab）');
                    }

                    // 5.5) 切换后 exec 带 tabId 定位 → 也应落在 target（定位信息与切换状态兼容）
                    console.log(`[5.5] exec_command(hostname) 带 tabId 定位 → 应落在 ${target.title}`);
                    r = await execHostname(client, { tabId: target.tabId });
                    console.log(`  → ${(r.raw || '').slice(0, 160)}`);
                    if (!r.parsed || r.parsed.sessionId !== target.sessionId) {
                        console.error(`  ✗ FAIL: 期望落在 ${target.sessionId}, 实际 ${r.parsed ? r.parsed.sessionId : '无响应/解析失败'}`);
                        failed = true;
                    } else if (r.parsed.error) {
                        console.warn(`  ⚠ 定位正确，但命令执行报错: ${r.parsed.error}`);
                    } else {
                        console.log('  ✓ 切换后带 tabId 定位正确');
                    }
                }
            }

            // 6) 随机多切标签：随机挑若干会话逐个 select_tab 切换，验证聚焦唯一迁移
            const others = sessions.filter(s => s !== original && s.sessionId !== target.sessionId);
            const shuffled = others.sort(() => Math.random() - 0.5).slice(0, Math.min(3, others.length));
            console.log(`[6/6] 随机切换 ${shuffled.length} 个标签: ${shuffled.map(s => s.title).join(' | ') || '(无更多会话)'}`);
            for (const s of shuffled) {
                const rsText = extractText(await client.callTool({ name: 'select_tab', arguments: { sessionId: s.sessionId } }));
                let rs = null;
                try { rs = JSON.parse(rsText); } catch { /* 保持 null */ }
                if (!rs || rs.success !== true) {
                    console.error(`  ✗ FAIL: 随机切换 ${s.title} 未 success: ${rsText}`);
                    failed = true;
                    continue;
                }
                const sessionsN = await getSessions(client);
                const focusedN = sessionsN.filter(x => x.isFocusedPane === true);
                const tN = sessionsN.find(x => x.sessionId === s.sessionId);
                const okN = focusedN.length === 1 && tN && tN.isFocusedPane === true;
                console.log(`  → ${s.title}: isFocusedPane ${focusedN.length} 个 ${okN ? '✓' : '✗'}${okN ? '' : ` (实际: ${focusedN.map(x => x.title).join(', ')})`}`);
                if (!okN) {
                    console.error(`  ✗ FAIL: 随机切换 ${s.title} 后聚焦未唯一迁移`);
                    failed = true;
                }
            }
            // 7) 随机多切后 exec_command 无 locator → 应落在最后一个随机目标
            if (shuffled.length > 0) {
                const last = shuffled[shuffled.length - 1];
                console.log(`[7/7] 随机多切后 exec_command 无 locator → 应落在 ${last.title}`);
                r = await execHostname(client, {});
                console.log(`  → ${(r.raw || '').slice(0, 160)}`);
                if (!r.parsed || r.parsed.sessionId !== last.sessionId) {
                    console.error(`  ✗ FAIL: 期望落在 ${last.sessionId}, 实际 ${r.parsed ? r.parsed.sessionId : '无响应/解析失败'}`);
                    failed = true;
                } else if (r.parsed.error) {
                    console.warn(`  ⚠ 定位正确，但命令执行报错: ${r.parsed.error}`);
                } else {
                    console.log('  ✓ 随机多切后定位正确（fallback 认 activeTab）');
                }
            }

            // 8) 恢复现场：切回原聚焦会话（避免测试改变用户聚焦状态）
            if (original && original.sessionId !== target.sessionId) {
                console.log(`[恢复] select_tab 切回 → ${original.title}`);
                const restText = extractText(await client.callTool({ name: 'select_tab', arguments: { sessionId: original.sessionId } }));
                const rest = (() => { try { return JSON.parse(restText); } catch { return null; } })();
                if (!rest || rest.success !== true) {
                    console.error(`  ⚠ 恢复失败: ${restText}`);
                }
            } else if (!original) {
                console.log('[恢复] 无原聚焦会话，跳过恢复');
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

// ---------- verify（全面验证修改过的定位/互通逻辑） ----------
async function cmdVerify() {
    let failed = false;
    const client = await connect();
    try {
        const { tools } = await client.listTools();
        console.log(`[1/10] tools/list → ${tools.length} 个工具`);

        // 2) list_tabs 互通字段（Injector 修复后不得报错）
        const ltText = extractText(await client.callTool({ name: 'list_tabs', arguments: {} }));
        const lt = JSON.parse(ltText);
        const okLt = lt.success === true && typeof lt.serverInstanceId === 'string' && Array.isArray(lt.tabs);
        console.log(`[2/10] list_tabs → success=${lt.success}, serverInstanceId=${lt.serverInstanceId}, count=${lt.tabs ? lt.tabs.length : '-'} ${okLt ? '✓' : '✗'}`);
        if (!okLt) { console.error('  ✗ FAIL: list_tabs 结构异常'); failed = true; }
        else if (lt.tabs.some(t => !t.tabId)) { console.error('  ✗ FAIL: 存在缺 tabId 的 tab'); failed = true; }

        // 3) get_session_list 取目标会话
        const sessions = await getSessions(client);
        if (!sessions.length) { console.error('  ✗ SKIP: 无会话'); failed = true; }
        else {
            const t = sessions[0];
            console.log(`[3/10] get_session_list 目标: ${t.title} (sessionId=${t.sessionId}, tabId=${t.tabId}, tabIndex=${t.tabIndex})`);
            if (!t.sessionId || !t.tabId) { console.error('  ✗ FAIL: 会话缺 sessionId/tabId'); failed = true; }

            // 4-7) exec_command 四种定位方式
            const ways = [
                ['sessionId', { sessionId: t.sessionId }],
                ['tabId', { tabId: t.tabId }],
                ['title', { title: t.title }],
                ['tabIndex', { tabIndex: t.tabIndex }]
            ];
            for (let i = 0; i < ways.length; i++) {
                const [label, loc] = ways[i];
                const r = await execHostname(client, loc);
                const ok = r.parsed && r.parsed.sessionId === t.sessionId;
                console.log(`[${4 + i}/10] exec_command 按 ${label} 定位 → ${ok ? '✓' : '✗'} ${(r.raw || '').slice(0, 90)}`);
                if (!ok) { console.error(`  ✗ FAIL: ${label} 定位错误`); failed = true; }
            }

            // 8) 无效 sessionId：必须报错，绝不 fallback
            console.log('[8/10] exec_command 无效 sessionId（应报错不 fallback）');
            const bad = await execHostname(client, { sessionId: '00000000-0000-4000-8000-000000000000' });
            const okBad = bad.parsed && bad.parsed.success === false && /No matching terminal session/.test(bad.parsed.error || '');
            console.log(`  → ${(bad.raw || '').slice(0, 120)} ${okBad ? '✓' : '✗'}`);
            if (!okBad) { console.error('  ✗ FAIL: 无效 sessionId 未正确报错（可能静默 fallback）'); failed = true; }

            // 9) get_terminal_buffer 带 sessionId（同一 locator 链路）
            console.log('[9/10] get_terminal_buffer 带 sessionId');
            const gtbText = extractText(await client.callTool({ name: 'get_terminal_buffer', arguments: { sessionId: t.sessionId, lastNLines: 3 } }));
            const gtb = JSON.parse(gtbText);
            const okGtb = gtb.success === true && gtb.sessionId === t.sessionId;
            console.log(`  → success=${gtb.success}, sessionId=${gtb.sessionId} ${okGtb ? '✓' : '✗'}`);
            if (!okGtb) { console.error('  ✗ FAIL: get_terminal_buffer 定位错误'); failed = true; }

            // 10) select_tab 按 tabId 切换并验证聚焦迁移
            console.log('[10/10] select_tab 按 tabId 切换聚焦');
            const stText = extractText(await client.callTool({ name: 'select_tab', arguments: { tabId: t.tabId } }));
            const st = JSON.parse(stText);
            if (!st || st.success !== true) {
                console.error(`  ✗ FAIL: select_tab(tabId) 未 success: ${stText}`);
                failed = true;
            } else {
                const s2 = await getSessions(client);
                const t2 = s2.find(x => x.sessionId === t.sessionId);
                const f2 = s2.filter(x => x.isFocusedPane === true);
                const okSt = t2 && t2.isFocusedPane === true && f2.length === 1;
                console.log(`  → 切换后 isFocusedPane ${f2.length} 个 ${okSt ? '✓' : '✗'}`);
                if (!okSt) { console.error('  ✗ FAIL: select_tab(tabId) 后聚焦未唯一迁移'); failed = true; }
            }

            // 恢复：切回测试前的聚焦会话
            const before = sessions.find(x => x.isFocusedPane === true);
            if (before && before.sessionId !== t.sessionId) {
                await client.callTool({ name: 'select_tab', arguments: { sessionId: before.sessionId } });
                console.log(`[恢复] 切回 ${before.title}`);
            }
        }
    } finally {
        await client.close();
    }
    if (failed) {
        console.error('\n=== 全面验证: FAIL ===');
        process.exit(1);
    }
    console.log('\n=== 全面验证: PASS ===');
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
        case 'verify':
            await cmdVerify();
            break;
        default:
            console.error(`未知命令: ${cmd}（支持 list / call / regress / verify）`);
            process.exit(1);
    }
})().catch(e => {
    console.error('脚本错误:', e.message || e);
    process.exit(1);
});
