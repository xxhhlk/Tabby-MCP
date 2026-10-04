# Changelog

All notable changes to Tabby-MCP will be documented in this file.

## [Unreleased]

## [1.7.1-fork.4] - 2026-10-05

### 🐛 Fixed
- **命令以 `#` 注释结尾时失败仍报 `exitCode:0`**（fork.3 的残留缺口）：`$mcp_ok` 的追加语句 `; $mcp_ok = $?` 被行尾注释吞掉，`$mcp_ok` 停在预置的 `$true`，于是 `Get-Item C:\nope  # comment` 报 `success:true`。
  - 修法：把预置值改成 `$null` 并记录 `$mcp_e0 = $Error.Count` 基线；判定时 `$null -eq $mcp_ok` 说明快照被吞，此时按 `$Error.Count - $mcp_e0` 判失败（非终止错误必然进 `$Error`）。三级判定变为 `$LASTEXITCODE` → `$null` 哨兵/`$Error` 增量 → `$mcp_ok` → `catch`。
  - 实测（PS 5.1.19041.7725，手搓同构包装）：无注释报错 → 1、`Test-Path` → 0、`cmd /c exit 7` → 7、管道多行 → 0、**尾注释报错 → 1**。
  - **已知代价**：调用方显式静默的错误（`-ErrorAction SilentlyContinue`）同样会写入 `$Error`，若又恰逢行尾注释则误报 1。取舍理由：对 agent 工具而言「响亮的假失败」优于「静默的假成功」。
  - 另记：曾考虑用换行替代 `;` 追加快照，实测**不可行**——包装把命令塞进单引号串，控制台解析器按行切分，含字面换行的命令会报 `UnexpectedToken` 并超时。

### 🔧 Changed
- `scripts/smoke-test.js` 第 9 项 **PowerShell support** 同步：断言改为 `$mcp_ok = $null; $mcp_e0 = $Error.Count;` 预置 + `$null` 哨兵/`$Error` 增量回退分支。

## [1.7.1-fork.3] - 2026-10-05

### 🐛 Fixed
- **PowerShell 的 cmdlet 非终止错误被报成成功**：`Get-ChildItem C:\nope` 这类命令返回 `success:true / exitCode:0`（错误文本只在 output 里），代理会误判为执行成功。
  - **真因（PS 5.1.19041.7725 实测）**：`Invoke-Expression` 自己是个 cmdlet，它返回之后 `$?` 描述的是**它自己**的成功，与内部命令无关：
    - `Invoke-Expression 'Get-Item C:\nope'` → `$?` = **True**
    - `Invoke-Expression 'Get-Item C:\nope; $x = $?'` → `$x` = **False**
  - 故 `$?` 快照必须**放进被 eval 的 payload 内**（紧跟用户命令之后），在 `Invoke-Expression` 外面取永远取不到内层失败。修法：`Invoke-Expression '${cmd}; $mcp_ok = $?'`，并用 `$mcp_ok = $true` 预置——命令以 `#comment` 结尾时追加语句会被注释吞掉，此时退化为只看 `$LASTEXITCODE`，不会读到脏值。（命令以 `;` 结尾无碍：PS 5.1 接受 `;;`。）
  - 实测：cmdlet 报错 → 1，cmdlet 成功 → 0，原生退出码透传（`cmd /c exit 7` → 7）。
  - 注：fork.2 里试过「在 `Invoke-Expression` 之后快照 `$?`」，实测无效（上表第一行），已被 fork.3 取代。

### 🔧 Changed
- `scripts/smoke-test.js` 新增第 9 项检查 **PowerShell support**（8 → 9）：断言 PS 包装分支、`Invoke-Expression`、`$?` 快照必须在 payload 内（并反向断言「不得在 `Invoke-Expression` 之后快照」）、`$mcp_ok` 预置、`getEnterKey()` 的 CR/LF 分支、`COMMAND_PREFIX`、`detectShellType` 的 PS prompt 正则，以及环境探针对 PowerShell 的短路。这组能力**只有本 fork 有**（上游 v1.6.2 / v1.7.1 均无），且一旦从 npm 装回原版就会整组消失——2026-10-05 就是这样复发过一次，故用反向断言钉住。

### ⚠️ 部署注意
- 运行时插件若从 npm registry 重装，会被换成无 PS 支持的原版。`%APPDATA%\tabby\plugins\package.json` 的依赖请指向 fork tarball（`file:` 形式），见仓库外脚本 `tabby-mcp-fork/pin-fork-plugin.cjs`。
- 每次重建都请**递增版本号**：`/health` 直接报 `package.json` 的 version，这是判断线上跑的是哪次构建的唯一廉价手段。

### ⚠️ 行为变化
- **移除 Host 头校验**：不再因 `Host` 不是 `127.0.0.1` / `localhost`（或端口不匹配）而返回 `403 Invalid host`。这是上游 v1.7.1 引入的 DNS rebinding 防护。
- **移除 Origin 头校验**：`/mcp`、`/sse`、`/messages`、`/api/tool/:name` 不再因 `Origin` 不匹配而返回 `403 Invalid origin`。

移除后**没有任何请求会因 Host / Origin 头被拒**。剩余访问控制：

- 服务仍只绑 `127.0.0.1`（`listenOnce()`）——非本机流量无法建立 TCP 连接；
- `/internal/shutdown` 仍要求回环来源 + `x-tabby-mcp-control-token`；
- `/api/tool/:name` 直连 API 默认关闭（需 `directToolApi.enabled = true`）。

`scripts/smoke-test.js` 已同步改为断言这两个校验**不存在**，防止被无意加回。

> ⚠️ MCP 端点本身无鉴权。若日后把监听地址改到非回环接口，必须另行加上访问控制。

## [1.7.1-fork.1] - 2026-09-28

合并上游 `v1.6.2 → v1.7.1` 的全部功能改动，同时保留本地自研能力。差异说明见 README_CN「与上游的差异」。

### ✨ Added
- **`submit_keyboard_interactive_response` 工具**：应答 Tabby 的 SSH 键盘交互认证面板（MFA/TOTP、JumpServer 等）。`send_input` 只能写终端 PTY，够不到该面板。兼容新旧两种 prompt 结构。
- **`get_session_list` 新增字段**：`sshConnected`、`keyboardInteractivePending`、`keyboardInteractivePrompt`（仅非敏感元数据）。
- **`/health` 返回 `instanceId`**，用于识别陈旧实例。

### 🔒 Security
- **全局 Host 校验**：仅接受 `127.0.0.1` / `localhost` 且端口匹配的请求（DNS rebinding 防护）。
- **Origin 校验统一**：`/mcp`、`/sse`、`/messages`、`/api/tool/:name` 全部接入（此前只有 `/mcp`）。
- **`/api/tool/:name` 直连 API 默认关闭**（需 `directToolApi.enabled = true`）。
- **服务只绑 `127.0.0.1`**：MCP 无鉴权，不应在网络其他接口上可达。
- **SFTP 敏感操作确认**：10 个操作（list / read / write / mkdir / delete / rename / stat / upload / download / cancel）在结对编程模式下需确认；确认框展示完整 payload，不截断。
- **键盘交互应答确认只显示响应数量**，绝不回显 TOTP / 密码。
- `/internal/shutdown` 仅限回环 + 控制令牌。

### 🔧 Fixed
- **异常退出后重启**（上游 Issue #5）：`startServer` 改为 single-flight，`EADDRINUSE` 重试退避，检测到陈旧实例时经 `/internal/shutdown` 请求其释放端口；`stopServerInternal` 可取消在途启动。
- **焦点与输入法**（上游 Issue #7）：原生 `confirm()` / `alert()` 改为非阻塞 DOM 对话框，关闭后恢复原焦点，xterm 键盘输入与中文输入法立即可用；`exec_command` 尊重 `autoFocusTerminal` 开关。
- **背景审批提醒**（上游 Issue #10/#11）：窗口非前台时 Windows/Linux 闪烁任务栏并前置窗口，macOS 弹跳 Dock。
- **SFTP 取消语义**：取消改为标记 + 只取消传输流，不再 `sftpSession.end()` 断开共享 SSH 会话；`waitForTransferComplete` 在 `finally` 中清理轮询定时器。
- **SFTP 会话定位**：`findSSHSession` 新增 `profileName` 匹配。
- **旧版 SSE 传输**：`/messages` 把 `express.json()` 已解析的 body 传给 SDK，避免重复读取已耗尽的流导致空 body。
- **Streamable HTTP**：GET/DELETE 委托 SDK 处理；未知会话返回 404 `-32001`，未初始化请求返回 400 `-32000`；创建失败时清理 transport 与 server。
- **fish 环境探测**：改用 fish 原生语法（POSIX 的 `if [ -n ... ]; then` 在 fish 中是语法错误）。
- **设置页**：会话/传输监控弹窗全量 i18n；传输表格循环变量 `t` 遮蔽 `t()` 方法已修正；`closeSession` 不再把英文句子当 i18n 键。
- **stdio bridge**：连接地址改 `127.0.0.1`；`connectSSE` 单飞 + 5 秒超时；不再把 POST ACK 写入 stdout（会污染 JSON-RPC 流）；统一关闭路径。

### 🧰 Engineering
- `@modelcontextprotocol/sdk` 由 `^1.8.0` 钉到 `1.25.2`（此前已漂移到 1.29.0）。
- 新增 `scripts/smoke-test.js`（8 项静态检查）与 `typecheck` / `test` / `check` 脚本。
- `scripts/mcp-test.cjs` 扩展：工具数量断言、`get_session_list` 字段完整性、无 prompt 时的键盘交互拒绝分支、`/health` 的 `instanceId`、直连 API 默认 404、回环连通性。
- 移除未使用的 `cors` / `@types/cors` 依赖。
- 全部文件行尾符统一为 LF（新增 `.gitattributes`）。

### ⚠️ 行为变化
- 无会话的 `GET` / `POST /mcp` 由本地此前的 `404 Session not found` 改为上游语义：未知会话 `404 / -32001`，缺少会话头 `400 / -32000`（符合 Streamable HTTP 规范）。

## [1.6.2] - 2026-06-06

### ✨ Added
- **`get_session_environment` tool**: Added robust environment detection tool to intelligently probe if a session is currently running a shell, python, mysql, sqlite, etc. 
  - Dual modes included: `heuristic` (passive ANSI-cleaned buffer scan) and `active` (low-risk active probing).
  - Defaults to **disabled** and is fully configurable via Tabby Settings. When disabled, the tool is strictly omitted from registration to prevent AI hallucination.
- **Environment Detection Config UI**: Full settings tab integration with i18n support (zh-CN, en-US) and risk warnings.

### 🔧 Fixed
- **NPM Publish Workflow**: Stabilized GitHub Action publish workflow using pure Node 24 and NPM token mode, bypassing persistent OIDC trusted publisher 404 blockages.
- **Config-Ready Lifecycle Crash**: Fixed a critical crash on boot (`TypeError: Cannot read properties of undefined (reading 'mcp')`) caused by eager configuration evaluation during early tool registration.

## [1.6.1] - 2026-06-06

### 🔧 Fixed
- **`quick_connect` false success / wrong protocol selection** (refs #3, #5, #6)
  - `quick_connect` now reuses the same tab/session/ready response chain as `open_profile`
  - Fixed top-level `tabId` / `tabIndex` reporting for tabs wrapped by `SplitTabComponent`
  - `protocol="auto"` now prefers SSH for `user@host` targets instead of depending on provider registration order
  - Added explicit protocol selection support for `ssh`, `telnet`, `socket`, and `serial`
  - Removed stale SSH-only validation that incorrectly rejected non-SSH URI forms
- **Plugin shutdown cleanup** (refs #5)
  - Added best-effort MCP server stop during plugin/window unload to reduce restart-time port conflicts

## [1.3.0] - 2026-02-04

### 🔧 Fixed
- **Session disconnect detection**: Fixed false positive disconnection errors caused by incorrect type checking
  - `tab.destroyed` is a `Subject<void>` (RxJS Observable), NOT a boolean
  - Now correctly detecting disconnection via `session.open === false` only
  - Affects `exec_command`, `send_input`, and stream capture modes

### 🗑️ Removed
- **SFTP Advanced Tuning**: Removed non-functional "Chunk Size" and "Concurrency" settings
  - These settings had no effect with Tabby's `russh`-based SFTP implementation
  - Cleaned up UI, type definitions, and translations (zh-CN, en-US)
- **fastPut/fastGet detection code**: Removed obsolete detection logic for non-existent methods
  - Tabby's SFTP uses `russh` which doesn't support these optimizations

### ✏️ Changed
- **SFTP size descriptions**: Corrected default values in translations
  - Changed from "default: 10 MB" to "default: 10 GB" to match actual configuration
- **SFTP cancellation**: Added `cancelCallback` binding for proper transfer cancellation

### 🌐 i18n
- Updated both `zh-CN.json` and `en-US.json` with correct SFTP descriptions
- Removed 6 obsolete translation entries for Advanced Tuning section

---

## [1.2.0] - 2026-01-22

### Added
- i18n support (Chinese and English)
- `open_profile` now returns `sessionId` directly
- Enhanced SSH connection readiness detection

### Fixed
- SFTP upload/download schema validation
- MCP tool parameter passing issues

---

## [1.1.5] - 2026-01-20

### Added
- Comprehensive logging for all MCP operations
- SFTP file transfer tools (upload, download, list, read, write, etc.)

### Fixed
- Command output truncation issues
- Session tracking improvements

---

## [1.1.0] - Initial SFTP Release

### Added
- SFTP tool category (13 tools)
- Stable session IDs (UUID-based)
- Stream capture mode for long outputs
