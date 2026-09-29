#!/usr/bin/env node
/**
 * Tabby MCP Server 测试脚本（无需 LLM，直接走 MCP 协议）
 *
 * 用途：绕过大模型，直接对本地 Tabby MCP server 发起 tools/list / tools/call，
 *       用于回归测试会话定位、聚焦状态等逻辑（如 isFocusedPane 唯一性、exec_command 定位）。
 *
 * 用法：
 *   node scripts/mcp-test.cjs list [--host 127.0.0.1] [--port 34266]
 *      列出服务器全部工具
 *   node scripts/mcp-test.cjs call <toolName> '<jsonArgs>' [--host H] [--port N]
 *      调用工具。示例：
 *        node scripts/mcp-test.cjs call get_session_list '{}'
 *        node scripts/mcp-test.cjs call exec_command '{"command":"hostname","sessionId":"<id>"}'
 *   node scripts/mcp-test.cjs regress [--host H] [--port N]
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
 *   node scripts/mcp-test.cjs verify [--host H] [--port N]
 *      全面验证（10 步 + 4 项新增能力）：list_tabs 互通字段、exec_command 四种定位方式
 *      （sessionId/tabId/title/tabIndex）、无效 sessionId 错误行为、get_terminal_buffer、
 *      select_tab(tabId) 聚焦迁移；末尾恢复原聚焦会话。
 *      另有 v1.7.1 新增能力检查：
 *        H1 submit_keyboard_interactive_response 无 prompt → 拒绝分支
 *        H2 GET /health 返回 instanceId
 *        H3 POST /api/tool/:name 默认关闭（404）
 *        H4 目标主机连通性（默认 127.0.0.1；并记录 localhost 可达性）
 *
 * 主机（--host / MCP_TEST_HOST，默认 127.0.0.1）：
 *   服务端只绑 127.0.0.1，本机直接跑用默认值即可。若脚本跑在另一台机器或沙箱里，
 *   127.0.0.1 指的是脚本自己而不是 Tabby 宿主，此时必须填宿主的可达地址，例如
 *     node scripts/mcp-test.cjs verify --host 192.168.56.8
 *   或用环境变量：MCP_TEST_HOST=192.168.56.8 node scripts/mcp-test.cjs verify
 *
 * 注意（审批会阻塞自动化）：
 *   结对编程模式开启且勾选确认时，exec_command / send_input / SFTP 操作会弹出确认框，
 *   无人点按会在 120 秒后自动拒绝。跑 regress / verify 前请确保
 *   Tabby 设置 → MCP → 结对编程模式 关闭（或至少取消「确认 SFTP 操作」），
 *   否则用例会因「用户拒绝」而失败。hostname 等只读命令在默认安全策略下自动放行。
 *
 * 依赖：仓库 node_modules 中的 @modelcontextprotocol/sdk（Node >= 22，自带 fetch）
 *
 * 备选现成工具（官方，无需写代码）：MCP Inspector
 *   npx @modelcontextprotocol/inspector --cli http://127.0.0.1:34266/mcp --transport http \
 *     --method tools/call --tool-name exec_command \
 *     --tool-arg command=hostname --tool-arg sessionId=<id> --format json
 */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const http = require('http');

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
// 子命令 = 第一个非 --flag、且不是某个 flag 的取值 的参数
const VALUE_FLAGS = ['--port', '--host'];
const cmd = argv.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(argv[i - 1])) || 'list';
const portIdx = argv.indexOf('--port');
const PORT = portIdx !== -1 ? parseInt(argv[portIdx + 1], 10) : 34266;
// 服务器只绑 127.0.0.1（见 mcpService.listenOnce）。用 localhost 在部分环境下
// 会解析成 IPv6 ::1 而连不上，所以默认固定用 IPv4 回环地址。
//
// --host 用于「脚本跑在另一台机器 / 沙箱里」的场景：此时 127.0.0.1 指向的是脚本
// 自己而不是 Tabby 所在的宿主，需要填宿主的可达地址（例如虚拟机的 host-only IP）。
// 也可以直接用环境变量 MCP_TEST_HOST。
const hostIdx = argv.indexOf('--host');
const HOST = hostIdx !== -1 ? argv[hostIdx + 1] : (process.env.MCP_TEST_HOST || '127.0.0.1');
const SERVER_URL = `http://${HOST}:${PORT}/mcp`;
const BASE_URL = `http://${HOST}:${PORT}`;

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

// ---------- HTTP 直连辅助（/health、/api/tool 等非 MCP 端点） ----------
function httpGet(path) {
    return new Promise((resolve) => {
        const req = http.get({ host: HOST, port: PORT, path, timeout: 4000 }, (res) => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', e => resolve({ status: 0, body: '', error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
    });
}

/** 探测主机是否可达（用于对比目标主机与 localhost 的解析差异） */
function probeHost(host) {
    return new Promise((resolve) => {
        const req = http.get({ host, port: PORT, path: '/health', timeout: 4000 }, (res) => {
            res.resume();
            resolve({ ok: true, status: res.statusCode });
        });
        req.on('error', e => resolve({ ok: false, error: e.code || e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    });
}

/** POST 一个 JSON 体（用于验证 /api/tool/:name 直连端点） */
function httpPost(path, body) {
    return new Promise((resolve) => {
        const payload = JSON.stringify(body || {});
        const req = http.request({
            host: HOST, port: PORT, path, method: 'POST', timeout: 4000,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', e => resolve({ status: 0, body: '', error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
        req.write(payload);
        req.end();
    });
}

// ---------- list ----------
async function cmdList() {
    const client = await connect();
    let failed = false;
    try {
        const { tools } = await client.listTools();
        console.log(`共 ${tools.length} 个工具:`);
        for (const t of tools) {
            const firstLine = (t.description || '').split('\n')[0];
            console.log(`  - ${t.name.padEnd(34)} ${firstLine.slice(0, 70)}`);
        }

        // 工具数量是「注册漏了/多了」的哨兵：源码注册 36 个
        // （terminal 9 + tabManagement 15 + sftp 12），但 get_session_environment
        // 默认不可见（需在设置里开启环境探测），所以 tools/list 默认返回 35。
        const REGISTERED = 36;
        const hiddenByDefault = 1; // get_session_environment
        const visible = tools.length;
        if (visible !== REGISTERED - hiddenByDefault && visible !== REGISTERED) {
            console.error(`\n✗ FAIL: tools/list 返回 ${visible} 个，期望 ${REGISTERED - hiddenByDefault}（默认）或 ${REGISTERED}（开启环境探测后）`);
            console.error(`        源码注册数：terminal 9 + tabManagement 15 + sftp 12 = ${REGISTERED}`);
            failed = true;
        } else {
            const note = visible === REGISTERED ? '（环境探测已开启，含 get_session_environment）' : '（get_session_environment 默认隐藏）';
            console.log(`\n✓ 工具数量 ${visible}${note}`);
        }

        const names = new Set(tools.map(t => t.name));
        for (const required of ['submit_keyboard_interactive_response', 'get_session_list', 'exec_command', 'send_input']) {
            if (!names.has(required)) {
                console.error(`✗ FAIL: 缺少工具 ${required}`);
                failed = true;
            }
        }
        if (names.has('submit_keyboard_interactive_response')) {
            console.log('✓ 含 submit_keyboard_interactive_response（SSH 键盘交互/MFA 应答）');
        }
    } finally {
        await client.close();
    }
    if (failed) process.exit(1);
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

        // 3) get_session_list 取多个不同会话作为目标（验证精确定位，非总命中第一个）
        const sessions = await getSessions(client);
        const targets = sessions.slice(0, Math.min(3, sessions.length));
        if (targets.length < 2) {
            console.error('  ✗ SKIP: 会话不足 2 个，无法验证多目标精确定位');
            failed = true;
        } else {
            const before = sessions.find(x => x.isFocusedPane === true);
            console.log(`[3/10] 目标会话（不同会话）: ${targets.map(x => `${x.title}[tabIndex=${x.tabIndex}]`).join(' | ')}`);
            // 字段完整性：本地自研（tabId / serverInstanceId / sessionLive）
            // + 上游 v1.7.1 新增（sshConnected / keyboardInteractivePending）
            const requiredFields = ['sessionId', 'tabId', 'serverInstanceId', 'sessionLive', 'sshConnected', 'keyboardInteractivePending'];
            for (const t of targets) {
                const missing = requiredFields.filter(f => !(f in t));
                if (missing.length) {
                    console.error(`  ✗ FAIL: ${t.title} 缺字段 ${missing.join(', ')}`);
                    failed = true;
                }
            }
            console.log(`  → 字段检查(${requiredFields.length}): ${requiredFields.map(f => `${f}=${JSON.stringify(targets[0][f])}`).join(', ')}`);

            // 4-7) exec_command 四种定位方式，各自命中不同目标会话
            const ways = [
                ['sessionId', targets[0], { sessionId: targets[0].sessionId }],
                ['tabId', targets[1], { tabId: targets[1].tabId }],
                ['title', targets[2], { title: targets[2].title }],
                ['tabIndex', targets[0], { tabIndex: targets[0].tabIndex }]
            ];
            for (let i = 0; i < ways.length; i++) {
                const [label, expect, loc] = ways[i];
                const r = await execHostname(client, loc);
                const ok = r.parsed && r.parsed.sessionId === expect.sessionId;
                console.log(`[${4 + i}/10] exec 按 ${label} 定位 → 期望 ${expect.title} ${ok ? '✓' : '✗'} ${(r.raw || '').slice(0, 70)}`);
                if (!ok) {
                    console.error(`  ✗ FAIL: ${label} 定位到 ${r.parsed ? r.parsed.sessionId : '无'}, 期望 ${expect.sessionId}（${expect.title}）`);
                    failed = true;
                } else if (r.parsed.error) {
                    console.warn(`  ⚠ 定位正确，命令执行报错: ${r.parsed.error}`);
                }
            }

            // 8) 无效 sessionId：必须报错，绝不 fallback
            console.log('[8/10] exec_command 无效 sessionId（应报错不 fallback）');
            const bad = await execHostname(client, { sessionId: '00000000-0000-4000-8000-000000000000' });
            const okBad = bad.parsed && bad.parsed.success === false && /No matching terminal session/.test(bad.parsed.error || '');
            console.log(`  → ${(bad.raw || '').slice(0, 120)} ${okBad ? '✓' : '✗'}`);
            if (!okBad) { console.error('  ✗ FAIL: 无效 sessionId 未正确报错（可能静默 fallback）'); failed = true; }

            // 9) get_terminal_buffer 带 sessionId（用第二个目标，验证不同会话）
            console.log('[9/10] get_terminal_buffer 带 sessionId');
            const gtbTarget = targets[1];
            const gtbText = extractText(await client.callTool({ name: 'get_terminal_buffer', arguments: { sessionId: gtbTarget.sessionId, lastNLines: 3 } }));
            const gtb = JSON.parse(gtbText);
            const okGtb = gtb.success === true && gtb.sessionId === gtbTarget.sessionId;
            console.log(`  → success=${gtb.success}, sessionId=${gtb.sessionId}（期望 ${gtbTarget.sessionId}） ${okGtb ? '✓' : '✗'}`);
            if (!okGtb) { console.error('  ✗ FAIL: get_terminal_buffer 定位错误'); failed = true; }

            // 10) select_tab 按 tabId 切换（用第三个目标）并验证聚焦迁移
            console.log('[10/10] select_tab 按 tabId 切换聚焦');
            const stTarget = targets[2];
            const stText = extractText(await client.callTool({ name: 'select_tab', arguments: { tabId: stTarget.tabId } }));
            const st = JSON.parse(stText);
            if (!st || st.success !== true) {
                console.error(`  ✗ FAIL: select_tab(tabId) 未 success: ${stText}`);
                failed = true;
            } else {
                const s2 = await getSessions(client);
                const t2 = s2.find(x => x.sessionId === stTarget.sessionId);
                const f2 = s2.filter(x => x.isFocusedPane === true);
                const okSt = t2 && t2.isFocusedPane === true && f2.length === 1;
                console.log(`  → 切换后 isFocusedPane ${f2.length} 个（目标 ${stTarget.title}）${okSt ? '✓' : '✗'}`);
                if (!okSt) { console.error('  ✗ FAIL: select_tab(tabId) 后聚焦未唯一迁移'); failed = true; }
            }

            // 恢复：切回测试前的聚焦会话
            if (before && before.sessionId !== stTarget.sessionId) {
                await client.callTool({ name: 'select_tab', arguments: { sessionId: before.sessionId } });
                console.log(`[恢复] 切回 ${before.title}`);
            } else if (!before) {
                console.log('[恢复] 无原聚焦会话，跳过恢复');
            }
        }

        // ---------- 上游 v1.7.1 新增能力的检查 ----------
        console.log('\n--- v1.7.1 新增能力 ---');

        // H1) submit_keyboard_interactive_response：无 active prompt 时必须走拒绝分支
        //     （不需要连 MFA 服务器即可验证）
        const kipTarget = sessions.find(s => s.keyboardInteractivePending !== true) || sessions[0];
        if (kipTarget) {
            const kipText = extractText(await client.callTool({
                name: 'submit_keyboard_interactive_response',
                arguments: { sessionId: kipTarget.sessionId, response: '000000' }
            }));
            let kip = null;
            try { kip = JSON.parse(kipText); } catch { /* 非 JSON */ }
            const okKip = kip && kip.success === false && kip.keyboardInteractivePending === false
                && /No active keyboard-interactive prompt/.test(kip.error || '');
            console.log(`[H1] submit_keyboard_interactive_response 无 prompt → ${okKip ? '✓ 拒绝分支正确' : '✗'} ${kipText.slice(0, 110)}`);
            if (!okKip) { console.error('  ✗ FAIL: 无 active prompt 时应返回 success=false + keyboardInteractivePending=false'); failed = true; }
        } else {
            console.warn('[H1] 无可用会话，跳过');
        }

        // H2) /health 必须带 instanceId（v1.7.1 新增，用于陈旧实例识别与端口移交）
        const health = await httpGet('/health');
        let healthJson = null;
        try { healthJson = JSON.parse(health.body); } catch { /* 非 JSON */ }
        const okHealth = health.status === 200 && healthJson
            && typeof healthJson.instanceId === 'string' && healthJson.instanceId.length > 0;
        console.log(`[H2] GET /health → status=${health.status}, instanceId=${healthJson ? healthJson.instanceId : '-'} ${okHealth ? '✓' : '✗'}`);
        if (!okHealth) { console.error(`  ✗ FAIL: /health 未返回 instanceId（body=${String(health.body).slice(0, 120)}）`); failed = true; }

        // H3) /api/tool/:name 直连端点默认关闭（directToolApi.enabled 默认 false）
        const direct = await httpPost('/api/tool/exec_command', { command: 'hostname' });
        const okDirect = direct.status === 404;
        console.log(`[H3] POST /api/tool/exec_command → status=${direct.status} ${okDirect ? '✓ 默认关闭' : '✗ 期望 404'}`);
        if (!okDirect) { console.error(`  ✗ FAIL: 直连工具 API 应默认关闭（404），实际 ${direct.status}: ${String(direct.body).slice(0, 120)}`); failed = true; }

        // H4) 目标主机连通性：HOST 必达（默认 127.0.0.1）；localhost 仅记录
        const loop4 = await probeHost(HOST);
        const loopName = await probeHost('localhost');
        console.log(`[H4] 连通性 → ${HOST}: ${loop4.ok ? '✓ 可达' : '✗ ' + loop4.error} | localhost: ${loopName.ok ? '可达' : '不可达(' + loopName.error + ')'}`);
        if (!loop4.ok) { console.error(`  ✗ FAIL: ${HOST} 不可达`); failed = true; }
        if (HOST === '127.0.0.1' && !loopName.ok) {
            console.log('  ℹ localhost 不可达属预期（服务只绑 127.0.0.1），本脚本已固定使用 127.0.0.1');
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
