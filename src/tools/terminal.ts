import { Injectable, Inject, forwardRef } from '@angular/core';
import { AppService, BaseTabComponent, ConfigService, SplitTabComponent } from 'tabby-core';
import { BaseTerminalTabComponent, XTermFrontend } from 'tabby-terminal';
import { SerializeAddon } from '@xterm/addon-serialize';
import stripAnsi from 'strip-ansi';
import { BehaviorSubject, Subscription, ReplaySubject } from 'rxjs';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { BaseToolCategory } from './base-tool-category';
import { McpLoggerService } from '../services/mcpLogger.service';
import { DialogService } from '../services/dialog.service';
import { McpTool, ActiveCommand, CommandResult, EnhancedTerminalSession, SessionLocator, CommandSecurityConfig } from '../types/types';
import { CommandSecurityManager } from '../security';
import { TabManagementToolCategory } from './tabManagement';

/**
 * Shared zod refine: at least one session/tab targeting parameter is REQUIRED.
 * Prevents silent execution on the wrong session when the LLM omits the locator
 * (which used to fall back to the first/focused session - a common source of
 * "command ran on the wrong machine" reports).
 */
const requireLocator = (p: any) => !!(p?.sessionId || p?.tabId || p?.tabIndex !== undefined || p?.title || p?.profileName);
const LOCATOR_REQUIRED_MSG = 'At least one target is required: sessionId, tabId, tabIndex, title or profileName. Run get_session_list first to obtain a sessionId, then pass it explicitly.';

/**
 * Leading blanks prepended to every command and readiness probe we type.
 *
 * While a remote shell is starting up - on first connect AND after a reconnect -
 * it drops the FIRST byte of each write it receives. Measured on a real host:
 * `echo MCPR""EADY...` was echoed in full by the pty, but bash reported
 * `-bash: cho: command not found`, i.e. it only ever received `cho`. Four probe
 * attempts in a row lost exactly that one byte, and the next one was clean.
 *
 * Leading whitespace is ignored by every shell we support (bash / zsh / fish /
 * sh / PowerShell), so a swallowed byte only eats a blank and the command still
 * runs - which also means probe success now implies the real command survives.
 * Bonus: bash's HISTCONTROL=ignorespace keeps these out of the shell history.
 */
const COMMAND_PREFIX = '    ';

/**
 * Terminal session with stable ID for tracking
 * Enhanced to support split pane identification
 */
export interface TerminalSessionWithTab {
    sessionId: string;        // Stable UUID (unique per pane)
    tabIndex: number;         // Global index across all panes
    tabParent: BaseTabComponent;  // The actual tab (may be SplitTabComponent)
    tab: BaseTerminalTabComponent;  // The terminal component

    // Split pane information
    isSplit: boolean;         // Is this pane inside a SplitTabComponent?
    splitTabIndex?: number;   // Index of the parent SplitTabComponent in app.tabs
    paneIndex?: number;       // Index within the SplitTabComponent (0, 1, 2, ...)
    totalPanes?: number;      // Total panes in the split
    isFocusedPane?: boolean;  // Is this the focused pane in the split?
}

/**
 * Terminal Tools Category - Commands for terminal control
 * Enhanced with stable session IDs and flexible session targeting
 */
@Injectable({ providedIn: 'root' })
export class TerminalToolCategory extends BaseToolCategory {
    name = 'terminal';

    // Session registry for stable IDs (UUID per tab)
    private tabToSessionId = new WeakMap<BaseTerminalTabComponent, string>();
    // Reverse lookup: sessionId -> tab (for tabId/sessionId interchangeability)
    private sessionIdToTab = new Map<string, BaseTerminalTabComponent>();

    // Active commands tracked by sessionId
    private _activeCommands = new Map<string, ActiveCommand>();
    private _activeCommandsSubject = new BehaviorSubject<Map<string, ActiveCommand>>(new Map());

    // Shell type cache per session (avoids repeated detection)
    private shellTypeCache = new Map<string, 'bash' | 'zsh' | 'fish' | 'sh' | 'powershell'>();

    // Session objects whose shell last confirmed (via the idempotent echo probe)
    // that it consumes input, mapped to the timestamp of that confirmation.
    // Keyed by the session *object* on purpose: a reconnect produces a new one,
    // so readiness is re-established automatically.
    //
    // The timestamp is what makes a stale session detectable. A session can be
    // open and answer SSH keepalives while its remote shell has stopped
    // consuming input (suspended host, wedged pty) - nothing about the session
    // object changes when that happens, so a confirmation cannot be permanent.
    private shellReadyAt = new WeakMap<object, number>();

    // Command security manager (lazy initialized)
    private securityManager?: CommandSecurityManager;

    public readonly activeCommands$ = this._activeCommandsSubject.asObservable();

    constructor(
        private app: AppService,
        logger: McpLoggerService,
        private config: ConfigService,
        private dialogService: DialogService,
        @Inject(forwardRef(() => TabManagementToolCategory)) private tabManagement: TabManagementToolCategory
    ) {
        super(logger);
        this.initializeTools();
    }

    /**
     * Get or initialize security manager
     */
    private getSecurityManager(): CommandSecurityManager {
        if (!this.securityManager) {
            this.securityManager = new CommandSecurityManager(this.getSecurityConfig());
        }
        return this.securityManager;
    }

    /**
     * Get security configuration from config store
     */
    private getSecurityConfig(): CommandSecurityConfig {
        // Safe access to config with defaults
        const store = this.config?.store;
        const mcp = store?.mcp;
        const pairConfig = mcp?.pairProgrammingMode;
        return {
            autoAllowReadCommands: pairConfig?.autoAllowReadCommands ?? true,
            allowSudo: pairConfig?.commandSecurity?.allowSudo ?? false,
            allowPipes: pairConfig?.commandSecurity?.allowPipes ?? true,
            allowRedirects: pairConfig?.commandSecurity?.allowRedirects ?? false,
            allowCommandChains: pairConfig?.commandSecurity?.allowCommandChains ?? false,
        };
    }

    /**
     * Initialize all terminal tools
     */
    private initializeTools(): void {
        this.registerTool(this.createGetSessionListTool());
        this.registerTool(this.createExecCommandTool());
        this.registerTool(this.createSendInputTool());
        this.registerTool(this.createSubmitKeyboardInteractiveResponseTool());
        this.registerTool(this.createGetTerminalBufferTool());
        this.registerTool(this.createAbortCommandTool());
        this.registerTool(this.createGetCommandStatusTool());
        this.registerTool(this.createFocusPaneTool());
        this.registerTool(this.createGetSessionEnvironmentTool());

        this.logger.info('Terminal tools initialized');
    }

    /**
     * Get or create a stable session ID for a tab
     * Made public for cross-category access (e.g., from TabManagementToolCategory)
     */
    public getOrCreateSessionId(tab: BaseTerminalTabComponent): string {
        let sessionId = this.tabToSessionId.get(tab);
        if (!sessionId) {
            sessionId = randomUUID();
            this.tabToSessionId.set(tab, sessionId);
        }
        // Keep reverse map in sync (re-register on every call to survive tab re-creation)
        this.sessionIdToTab.set(sessionId, tab);
        return sessionId;
    }

    /**
     * Detect shell type from terminal session info
     * Used to generate shell-compatible command wrappers
     * 
     * Detection priority:
     * 1. Cached result (if previously detected)
     * 2. Terminal buffer analysis (most accurate for active sessions)
     * 3. Profile type/name hints
     * 4. Terminal title hints
     * 5. Default to 'sh' (POSIX fallback)
     */
    private detectShellType(session: TerminalSessionWithTab): 'bash' | 'zsh' | 'fish' | 'sh' | 'powershell' {
        // Step 1: Check cache first
        const cached = this.shellTypeCache.get(session.sessionId);
        if (cached) {
            this.logger.debug(`Shell type from cache: ${cached} for session ${session.sessionId}`);
            return cached;
        }

        const tabAny = session.tab as any;

        // Step 2: Analyze terminal buffer for shell-specific patterns
        // This is the most reliable method for connected sessions
        try {
            const buffer = this.getTerminalBufferText(session);
            if (buffer && buffer.length > 0) {
                // PowerShell-specific patterns (Windows ConPTY / pwsh)
                // - Banner: "Windows PowerShell" or "PowerShell 7.x"
                // - Default prompt: "PS C:\Users\im>"
                // - pwsh binary name in output
                // NOTE: must be checked BEFORE bash patterns to avoid false matches
                const powershellBufferPatterns = [
                    /Windows PowerShell/i,
                    /PowerShell \d/i,
                    /PS [A-Za-z]:\\/,
                    /pwsh/i,
                ];
                for (const pattern of powershellBufferPatterns) {
                    if (pattern.test(buffer)) {
                        this.logger.info(`Detected PowerShell from buffer pattern: ${pattern}`);
                        this.shellTypeCache.set(session.sessionId, 'powershell');
                        return 'powershell';
                    }
                }

                // Fish-specific patterns
                // - Welcome message: "Welcome to fish"
                // - Error message when using $?: "fish: $? is not the exit status"
                // - Fish version info: "fish, version X.Y.Z"
                // - Fish default prompts: ❯, ⏎, or specific fish greeting
                const fishBufferPatterns = [
                    /Welcome to fish/i,
                    /fish:.*\$\? is not the exit status/i,
                    /fish,?\s*version/i,
                    /In fish, please use \$status/i,
                    /❯\s*$/m,  // Fish default prompt character
                ];

                for (const pattern of fishBufferPatterns) {
                    if (pattern.test(buffer)) {
                        this.logger.info(`Detected fish shell from buffer pattern: ${pattern}`);
                        this.shellTypeCache.set(session.sessionId, 'fish');
                        return 'fish';
                    }
                }

                // Bash-specific patterns
                const bashBufferPatterns = [
                    /bash.*version/i,
                    /GNU bash/i,
                ];
                for (const pattern of bashBufferPatterns) {
                    if (pattern.test(buffer)) {
                        this.logger.info(`Detected bash shell from buffer pattern`);
                        this.shellTypeCache.set(session.sessionId, 'bash');
                        return 'bash';
                    }
                }

                // Zsh-specific patterns
                const zshBufferPatterns = [
                    /zsh.*version/i,
                    /oh-my-zsh/i,
                ];
                for (const pattern of zshBufferPatterns) {
                    if (pattern.test(buffer)) {
                        this.logger.info(`Detected zsh shell from buffer pattern`);
                        this.shellTypeCache.set(session.sessionId, 'zsh');
                        return 'zsh';
                    }
                }
            }
        } catch (e) {
            this.logger.debug(`Buffer analysis failed, falling back to profile/title hints`);
        }

        // Step 3: Check profile info (fallback)
        const profileName = tabAny.profile?.name || '';
        const profileType = tabAny.profile?.type || '';
        const profileOptions = tabAny.profile?.options || {};
        const shellPath = profileOptions.shell || profileOptions.command || '';
        const allProfileText = `${profileName} ${profileType} ${shellPath}`.toLowerCase();

        const fishPatterns = [/\bfish\b/i, /fish$/i];
        const zshPatterns = [/\bzsh\b/i, /zsh$/i];
        const bashPatterns = [/\bbash\b/i, /bash$/i];
        const powershellPatterns = [/\bpowershell\b/i, /\bpwsh\b/i];

        if (powershellPatterns.some(p => p.test(allProfileText))) {
            this.logger.debug(`Detected PowerShell shell from profile: ${profileName}`);
            this.shellTypeCache.set(session.sessionId, 'powershell');
            return 'powershell';
        }
        if (fishPatterns.some(p => p.test(allProfileText))) {
            this.logger.debug(`Detected fish shell from profile: ${profileName}`);
            this.shellTypeCache.set(session.sessionId, 'fish');
            return 'fish';
        }
        if (zshPatterns.some(p => p.test(allProfileText))) {
            this.logger.debug(`Detected zsh shell from profile: ${profileName}`);
            this.shellTypeCache.set(session.sessionId, 'zsh');
            return 'zsh';
        }
        if (bashPatterns.some(p => p.test(allProfileText))) {
            this.logger.debug(`Detected bash shell from profile: ${profileName}`);
            this.shellTypeCache.set(session.sessionId, 'bash');
            return 'bash';
        }

        // Step 4: Check terminal title (last resort)
        const title = session.tab.title || '';
        if (powershellPatterns.some(p => p.test(title))) {
            this.logger.debug(`Detected PowerShell shell from title: ${title}`);
            this.shellTypeCache.set(session.sessionId, 'powershell');
            return 'powershell';
        }
        if (fishPatterns.some(p => p.test(title))) {
            this.logger.debug(`Detected fish shell from title: ${title}`);
            this.shellTypeCache.set(session.sessionId, 'fish');
            return 'fish';
        }
        if (zshPatterns.some(p => p.test(title))) {
            this.logger.debug(`Detected zsh shell from title: ${title}`);
            this.shellTypeCache.set(session.sessionId, 'zsh');
            return 'zsh';
        }
        if (bashPatterns.some(p => p.test(title))) {
            this.logger.debug(`Detected bash shell from title: ${title}`);
            this.shellTypeCache.set(session.sessionId, 'bash');
            return 'bash';
        }

        // Step 5: Default to 'sh' (POSIX compatible - safest fallback)
        this.logger.debug(`Shell type unknown, defaulting to sh (POSIX) for session ${session.sessionId}`);
        // Don't cache unknown - allow re-detection on next command
        return 'sh';
    }



    /**
     * Line terminator used to "press Enter" when submitting a line to a terminal.
     *
     * Windows ConPTY maps CR (0x0D) to the Enter key; LF (0x0A) is inserted as a
     * plain newline by PSReadLine instead of submitting the line, so commands
     * would stall in the continuation buffer. Unix shells submit on LF (and
     * remote sessions may run with `stty -icrnl`, where CR is NOT mapped to NL),
     * so *nix keeps LF to avoid regressions. WSL tabs on a Windows host are safe
     * with CR: ConPTY delivers CR and the WSL line discipline (ICRNL) converts
     * it back to NL.
     */
    private getEnterKey(): string {
        return process.platform === 'win32' ? '\r' : '\n';
    }

    /**
     * Generate shell-compatible wrapped command for output capture
     * 
     * CRITICAL: Commands are wrapped in `eval` to ensure that syntax errors
     * in the user command do NOT prevent the end marker from being printed.
     * Without eval, a syntax error causes the shell to reject the entire line,
     * including our end marker, causing the MCP server to hang until timeout.
     * 
     * Different shells use different syntax:
     * - bash/zsh/sh: eval '...' with single-quote escaping, $? for exit code
     * - fish: eval "..." with backslash escaping, $status for exit code
     * - powershell: Invoke-Expression (PS 5.1 compatible, no && / eval),
     *   exit code from $LASTEXITCODE (native exes) falling back to a $?
     *   snapshot taken inside the evaluated payload (cmdlets)
     */
    private getWrappedCommand(
        command: string,
        startMarker: string,
        endMarker: string,
        shellType: 'bash' | 'zsh' | 'fish' | 'sh' | 'powershell'
    ): string {
        switch (shellType) {
            case 'powershell': {
                // PowerShell (compatible with 5.1: no `&&`, no `eval`).
                // Reset $LASTEXITCODE so stale values from previous native
                // commands don't shadow $? of cmdlet-only failures.
                //
                // $? MUST be captured *inside* the evaluated payload, as the
                // statement right after the user's command. Invoke-Expression is
                // itself a cmdlet, so once it returns, $? describes ITS success.
                // Measured on PS 5.1 (5.1.19041.7725):
                //   Invoke-Expression 'Get-Item C:\nope'            ; $? -> True
                //   Invoke-Expression 'Get-Item C:\nope; $x = $?'   ; $x -> False
                // A snapshot taken outside therefore never sees the inner
                // failure, and every non-terminating cmdlet error came back as
                // exit code 0 - success:true with the error text in the output.
                //
                // A trailing `#comment` in the user's command swallows the
                // appended statement (measured), leaving $mcp_ok unset. It is
                // pre-seeded to $null so that case is detectable, and the
                // wrapper then falls back to the $Error count delta - a
                // non-terminating error always appends to $Error. Trade-off:
                // an error the caller silenced on purpose (-ErrorAction
                // SilentlyContinue) still appends to $Error, so a *silenced*
                // failure followed by a trailing comment reports 1. For an
                // agent-facing tool a loud false failure beats a silent false
                // success. A trailing `;` is harmless: PS 5.1 accepts `;;`.
                const psEscaped = command.replace(/'/g, "''");
                return `Write-Output "${startMarker}"; $mcp_ec = 0; $mcp_ok = $null; $mcp_e0 = $Error.Count; try { $global:LASTEXITCODE = 0; Invoke-Expression '${psEscaped}; $mcp_ok = $?'; if ($LASTEXITCODE -ne 0) { $mcp_ec = $LASTEXITCODE } elseif ($null -eq $mcp_ok) { if ($Error.Count -gt $mcp_e0) { $mcp_ec = 1 } } elseif (-not $mcp_ok) { $mcp_ec = 1 } } catch { $mcp_ec = 1 }; Write-Output "${endMarker} $mcp_ec"`;
            }

            case 'fish':
                // Fish shell: use $status instead of $?, eval with double quotes
                // Fish escaping: \ escapes " and \ inside double quotes
                const fishEscaped = command
                    .replace(/\\/g, '\\\\')  // Escape backslashes first
                    .replace(/"/g, '\\"');   // Escape double quotes
                return `echo "${startMarker}"; eval "${fishEscaped}"; set -l __mcp_exit $status; echo "${endMarker} $__mcp_exit"`;

            case 'bash':
            case 'zsh':
            case 'sh':
            default:
                // Bash/Zsh/POSIX: wrap in eval to catch syntax errors
                // Use single quotes to prevent premature variable expansion
                // Escape strategy: ' -> '\'' (close quote, escaped quote, open quote)
                const escaped = command.replace(/'/g, "'\\''");
                return `echo "${startMarker}" && eval '${escaped}' ; echo "${endMarker} $?"`;
        }
    }

    /**
     * Find session by flexible locator
     * Priority: sessionId > tabId > tabIndex > title > profileName
     * If no locator is provided, returns the currently active/focused session
     */
    public findSessionByLocator(locator: SessionLocator): TerminalSessionWithTab | null {
        this.logger.debug(`findSessionByLocator called with: ${JSON.stringify(locator)}`);
        const sessions = this.findTerminalSessions();

        // If no locator parameters provided, return the currently active session
        if (!locator.sessionId && !locator.tabId && locator.tabIndex === undefined && !locator.title && !locator.profileName) {
            // Prefer the globally focused tab (select_tab sets this). This must be checked
            // BEFORE isFocusedPane: in a multi-split layout getFocusedTab() is per-split,
            // so multiple panes can claim isFocusedPane=true and the first array hit may
            // not be the tab the user actually focused.
            const activeTab = this.app.activeTab;
            if (activeTab) {
                const activeSession = sessions.find(s => s.tab === activeTab || s.tabParent === activeTab);
                if (activeSession) {
                    this.logger.debug(`findSessionByLocator: no locator provided, using globally active tab ${activeTab.title}`);
                    return activeSession;
                }
            }
            // Fallback: focused pane within the active split
            const focusedSession = sessions.find(s => s.isFocusedPane === true);
            if (focusedSession)
                return focusedSession;
            // Otherwise return the first session (most recently used)
            this.logger.warn('findSessionByLocator: no locator provided, falling back to first/focused session');
            return sessions[0] || null;
        }

        // Priority 1: sessionId (stable, recommended)
        if (locator.sessionId) {
            const found = sessions.find(s => s.sessionId === locator.sessionId);
            if (found) return found;
            this.logger.debug(`findSessionByLocator: no session matched sessionId=${locator.sessionId}`);
        }

        // Priority 1.5: tabId (stable, interchangeable with sessionId for terminal tabs)
        if (locator.tabId) {
            const tab = this.tabManagement.findTabByTabId(locator.tabId);
            if (tab) {
                const found = sessions.find(s => s.tab === tab || s.tabParent === tab);
                if (found) return found;
            }
            this.logger.debug(`findSessionByLocator: no session matched tabId=${locator.tabId}`);
        }

        // Priority 2: tabIndex (legacy, may change)
        if (locator.tabIndex !== undefined) {
            const found = sessions.find(s => s.tabIndex === locator.tabIndex);
            if (found)
                return found;
        }

        // Priority 3: title (partial, case-insensitive)
        if (locator.title) {
            const titleLower = locator.title.toLowerCase();
            const found = sessions.find(s => s.tab.title?.toLowerCase().includes(titleLower));
            if (found)
                return found;
        }

        // Priority 4: profileName (partial, case-insensitive)
        if (locator.profileName) {
            const nameLower = locator.profileName.toLowerCase();
            const found = sessions.find(s => {
                const profile = (s.tab as any).profile;
                return profile?.name?.toLowerCase().includes(nameLower);
            });
            if (found)
                return found;
        }

        return null;
    }

    private getKeyboardInteractivePrompt(session: TerminalSessionWithTab): any | null {
        return (session.tab as any).activeKIPrompt ?? null;
    }

    private describeKeyboardInteractivePrompt(prompt: any): any | undefined {
        if (!prompt) {
            return undefined;
        }

        return {
            name: prompt.name ?? '',
            instruction: prompt.instruction ?? '',
            prompts: Array.isArray(prompt.prompts)
                ? prompt.prompts.map((entry: any, index: number) => {
                    // Current Tabby uses strings; older releases exposed prompt objects.
                    const text = typeof entry === 'string'
                        ? entry
                        : String(entry?.prompt ?? '');
                    return {
                        index,
                        prompt: text,
                        echo: typeof entry === 'object' && entry !== null
                            ? entry.echo !== false
                            : true,
                        isPassword: /password/i.test(text)
                    };
                })
                : [],
            responseCount: Array.isArray(prompt.responses) ? prompt.responses.length : 0
        };
    }

    /**
     * Tool: Get list of terminal sessions with enhanced metadata
     * Now includes detailed split pane information
     */
    private createGetSessionListTool(): McpTool {
        return {
            name: 'get_session_list',
            description: `Get list of all terminal sessions with stable IDs and metadata.
Use sessionId (stable UUID) or tabId (stable tab ID, interchangeable) for reliable session targeting.

For split panes:
- isSplit: true if this session is inside a split tab
- splitTabIndex: Index of parent tab (use for grouping panes)
- paneIndex: Position within the split (0, 1, 2, ...)
- totalPanes: Number of panes in the split
- isFocusedPane: Whether this is the currently focused pane

Session state:
- sessionLive: the session is connected and can accept input (false for a restored tab that was never focused)
- awaitingReconnect: sitting on "press any key to reconnect" after the connection dropped
- disconnectedByUser: the user pressed Disconnect in Tabby
exec_command and send_input recover all three states automatically, so these fields are informational.`,
            schema: z.object({}),
            handler: async () => {
                const sessions = this.findTerminalSessions();
                const result = sessions.map(s => {
                    const tabAny = s.tab as any;
                    const keyboardInteractivePrompt = this.getKeyboardInteractivePrompt(s);
                    const reconnectState = this.getReconnectState(s);
                    return {
                        sessionId: s.sessionId,
                        // tabId must match list_tabs: bind to the TOP-LEVEL tab (s.tabParent),
                        // not the pane (s.tab). Otherwise list_tabs and get_session_list return
                        // different IDs for the same window (split panes), and select_tab(tabId)
                        // fails with "No matching tab found".
                        tabId: this.tabManagement.getOrCreateTabId(s.tabParent),
                        // Diagnostic: changes when Tabby reloads the plugin (all IDs are
                        // regenerated then). Compare across calls to detect stale IDs.
                        serverInstanceId: this.tabManagement.instanceId,
                        tabIndex: s.tabIndex,
                        title: s.tab.title || `Terminal ${s.tabIndex}`,
                        type: s.tab.constructor.name,
                        isActive: this.app.activeTab === s.tabParent,
                        // false => restored/cold tab: Tabby has not created the session yet
                        // (it does so lazily on focus), so input cannot be delivered.
                        sessionLive: this.isSessionWritable(s),
                        // true => the tab is sitting on "press any key to reconnect"
                        // (MCP can revive this automatically; see ensureSessionLive).
                        awaitingReconnect: reconnectState.awaitingReconnect,
                        // true => user pressed Disconnect deliberately (recovered like any other drop; reported for visibility).
                        disconnectedByUser: reconnectState.blockedByUser,
                        hasActiveCommand: this._activeCommands.has(s.sessionId),
                        // SSH auth state: true while Tabby's keyboard-interactive
                        // (MFA/TOTP) panel is waiting for input.
                        sshConnected: tabAny.sshSession?.open === true,
                        keyboardInteractivePending: Boolean(keyboardInteractivePrompt),
                        keyboardInteractivePrompt: this.describeKeyboardInteractivePrompt(keyboardInteractivePrompt),
                        profile: tabAny.profile ? {
                            id: tabAny.profile.id,
                            name: tabAny.profile.name,
                            type: tabAny.profile.type
                        } : undefined,
                        pid: tabAny.session?.pty?.pid,
                        cwd: tabAny.session?.cwd,
                        // Split pane information
                        isSplit: s.isSplit,
                        splitTabIndex: s.splitTabIndex,
                        paneIndex: s.paneIndex,
                        totalPanes: s.totalPanes,
                        isFocusedPane: s.isFocusedPane
                    };
                });

                this.logger.info(`Found ${result.length} terminal sessions`);
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }
        };
    }

    /**
     * Tool: Execute command in terminal
     * Enhanced with flexible session targeting
     */
    private createExecCommandTool(): McpTool {
        return {
            name: 'exec_command',
            description: `Execute a command in a terminal session.
Session targeting (priority order): sessionId > tabId > tabIndex > title > profileName
- sessionId: Stable UUID (recommended, use get_session_list to get IDs)
- tabId: Stable tab ID (from list_tabs or get_session_list, interchangeable with sessionId for terminal tabs)
- tabIndex: Array index (legacy, may change if tabs are reordered)
- title: Match by terminal title (partial, case-insensitive)
- profileName: Match by profile name (partial, case-insensitive)

For interactive/paging commands (less, vim, top), set waitForOutput=false.
For long-running commands, increase timeout or use waitForOutput=false and poll with get_terminal_buffer.

Connection recovery: if the tab's session is not ready - restored but never focused, dropped, or its last connect attempt failed - the tab is activated and reconnected automatically before the command is sent, waiting up to the configured activation timeout. A hand-disconnected tab is reconnected too. Check the response for activatedTab / autoReconnectAttempted / reconnectedAfterManualDisconnect to see what happened.`,
            schema: z.object({
                command: z.string().describe('Command to execute'),
                sessionId: z.string().optional().describe('Stable session ID (recommended, from get_session_list)'),
                tabId: z.string().optional().describe('Stable tab ID (from list_tabs or get_session_list, interchangeable with sessionId)'),
                tabIndex: z.number().optional().describe('Tab index (legacy, may change if tabs reorder)'),
                title: z.string().optional().describe('Match session by title (partial, case-insensitive)'),
                profileName: z.string().optional().describe('Match session by profile name (partial, case-insensitive)'),
                waitForOutput: z.boolean().optional().describe('Wait for command completion (default: true). Set false for interactive commands.'),
                timeout: z.number().optional().describe('Timeout in ms (default: 30000, max: 300000)')
            }).strict(),
            handler: async (params: {
                command: string;
                sessionId?: string;
                tabId?: string;
                tabIndex?: number;
                title?: string;
                profileName?: string;
                waitForOutput?: boolean;
                timeout?: number;
            }) => {
                const { command, sessionId, tabId, tabIndex, title, profileName, waitForOutput = true, timeout: rawTimeout = 30000 } = params;
                const timeout = Math.min(rawTimeout, 300000); // Max 5 minutes

                // Find session using locator
                const session = this.findSessionByLocator({ sessionId, tabId, tabIndex, title, profileName });

                if (!session) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                error: 'No matching terminal session found',
                                hint: 'Use get_session_list to see available sessions with their sessionIds. Note: sessionIds/tabIds may be stale after Tabby restart - re-run get_session_list to refresh.'
                            })
                        }]
                    };
                }

                // Warn the caller when NO locator was provided: the command silently runs on
                // the first/focused session, which is almost never what the caller intended.
                const noLocatorWarning = !(sessionId || tabId || tabIndex !== undefined || title || profileName)
                    ? `No locator provided - command executed on session ${session.sessionId} (${session.tab.title}). Always pass sessionId/tabId for reliable targeting.`
                    : undefined;

                // Check pair programming mode
                if (this.config.store.mcp?.pairProgrammingMode?.enabled) {
                    if (this.config.store.mcp?.pairProgrammingMode?.showConfirmationDialog) {
                        // Get security manager and update config
                        const securityManager = this.getSecurityManager();
                        securityManager.updateConfig(this.getSecurityConfig());

                        // Evaluate command security
                        const decision = securityManager.evaluate(command);

                        if (decision.action === 'allow') {
                            // Auto-allow safe commands
                            this.logger.info(`Auto-allowed command: ${command} (${decision.reason})`);
                        } else if (decision.action === 'confirm') {
                            // Show confirmation dialog for commands that need it
                            const confirmed = await this.dialogService.showCommandConfirmation(command, session.tabIndex);
                            if (!confirmed) {
                                return {
                                    content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Command rejected by user' }) }]
                                };
                            }
                        } else {
                            // Deny dangerous commands
                            this.logger.warn(`Command denied: ${command} (${decision.reason})`);
                            return {
                                content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Command denied: ${decision.reason}` }) }]
                            };
                        }
                    }
                }

                try {
                    // Focus terminal ONLY if background execution is disabled AND the
                    // user has not turned off auto-focus (Issue #7: stealing focus
                    // interrupts the user's typing/IME in another tab).
                    // Background mode allows AI to work on tabs without disturbing the
                    // user's current focus.
                    // NOTE: a cold/restored tab is still activated unconditionally by
                    // ensureSessionLive() below - Tabby only creates the session once
                    // the tab gets focus, so without that the command could never run.
                    const backgroundMode = this.config.store.mcp?.backgroundExecution?.enabled ?? false;
                    const autoFocus = this.config.store.mcp?.pairProgrammingMode?.autoFocusTerminal !== false;
                    let activated = false;
                    if (!backgroundMode && autoFocus) {
                        this.activateTab(session);
                        activated = true;
                    }

                    // A restored ("cold") tab has NO session yet: Tabby creates it
                    // lazily in onFrontendReady() -> initializeSession(), which only
                    // runs once the tab gets focus. sendInput() before that is a silent
                    // no-op (`this.session?.write()` / SSHShellSession.write() with a
                    // null shell), which showed up as "Tabby reconnected, but the
                    // command never ran". Wait for a writable session before sending.
                    const live = await this.ensureSessionLive(session, activated);
                    if (!live.ok) {
                        return {
                            content: [{
                                type: 'text', text: JSON.stringify({
                                    success: false,
                                    sessionId: session.sessionId,
                                    error: live.error,
                                    waitedMs: live.waitedMs,
                                    ...(live.reconnected ? { autoReconnectAttempted: true } : {}),
                                    ...(live.manualDisconnect ? { reconnectedAfterManualDisconnect: true } : {}),
                                    ...(live.hint ? { hint: live.hint } : {}),
                                    ...(noLocatorWarning ? { warning: noLocatorWarning } : {})
                                })
                            }]
                        };
                    }
                    const activationInfo = live.activated
                        ? {
                            activatedTab: true,
                            activationWaitMs: live.waitedMs,
                            ...(live.reconnected ? { autoReconnectAttempted: true } : {}),
                            ...(live.manualDisconnect ? { reconnectedAfterManualDisconnect: true } : {}),
                            ...(live.shellReadyWaitMs !== undefined
                                ? { shellReadyWaitMs: live.shellReadyWaitMs, probeAttempts: live.probeAttempts }
                                : {}),
                            ...(live.shellReady === false
                                ? { shellReadyWarning: 'Shell readiness probe timed out; the command was sent anyway. Do NOT re-run it just because of this - check the output first.' }
                                : {})
                        }
                        : {};

                    // For non-waiting mode, just send the command
                    if (!waitForOutput) {
                        session.tab.sendInput(COMMAND_PREFIX + command + this.getEnterKey());
                        this.logger.info(`Sent command (async): ${command} in session ${session.sessionId}`);
                        return {
                            content: [{
                                type: 'text', text: JSON.stringify({
                                    success: true,
                                    sessionId: session.sessionId,
                                    message: 'Command sent (not waiting for output)',
                                    hint: 'Use get_terminal_buffer with same sessionId to check output',
                                    ...activationInfo,
                                    ...(noLocatorWarning ? { warning: noLocatorWarning } : {})
                                })
                            }]
                        };
                    }

                    // Generate unique markers
                    const timestamp = Date.now();
                    const startMarker = `__MCP_START_${timestamp}__`;
                    const endMarker = `__MCP_END_${timestamp}__`;

                    // Track active command
                    let aborted = false;
                    const activeCommand: ActiveCommand = {
                        tabId: session.tabIndex,
                        command,
                        timestamp,
                        startMarker,
                        endMarker,
                        abort: () => { aborted = true; }
                    };
                    this._activeCommands.set(session.sessionId, activeCommand);
                    this._activeCommandsSubject.next(new Map(this._activeCommands));

                    // Setup Stream Capture if enabled
                    const useStreamCapture = this.config.store.mcp?.useStreamCapture ?? false;
                    let outputStream$: ReplaySubject<string> | undefined;
                    let rawSubscription: Subscription | undefined;

                    if (useStreamCapture) {
                        const sessionAny = session.tab.session as any;
                        if (sessionAny?.output$) {
                            outputStream$ = new ReplaySubject<string>();
                            rawSubscription = sessionAny.output$.subscribe(outputStream$);
                            this.logger.debug(`[Exec] Stream capture enabled for session ${session.sessionId}`);
                        } else {
                            this.logger.warn(`[Exec] Stream capture requested but output$ unavailable. Fallback to buffer.`);
                        }
                    }

                    // Send command with markers - use shell-aware wrapper.
                    // COMMAND_PREFIX mirrors the probe's prefix: a shell that just
                    // came up swallows the first byte of a write, so the probe can
                    // only prove the command will run if both carry the same prefix.
                    const detectedShell = this.detectShellType(session);
                    const wrappedCommand = this.getWrappedCommand(command, startMarker, endMarker, detectedShell);
                    session.tab.sendInput(COMMAND_PREFIX + wrappedCommand + this.getEnterKey());

                    this.logger.info(`Executing command: ${command} in session ${session.sessionId} (shell: ${detectedShell}, stream: ${!!outputStream$})`);

                    // Wait for output
                    let result: CommandResult;
                    if (outputStream$) {
                        result = await this.waitForCommandOutputViaStream(outputStream$, startMarker, endMarker, timeout, () => aborted, session);
                    } else {
                        result = await this.waitForCommandOutputViaBuffer(session, startMarker, endMarker, timeout, () => aborted);
                    }

                    // Clean up stream resources
                    if (rawSubscription) {
                        rawSubscription.unsubscribe();
                    }

                    // Clean up active command
                    this._activeCommands.delete(session.sessionId);
                    this._activeCommandsSubject.next(new Map(this._activeCommands));

                    // Add sessionId to result for reference
                    const resultWithSession = { ...result, sessionId: session.sessionId, ...activationInfo, ...(noLocatorWarning ? { warning: noLocatorWarning } : {}) };
                    return { content: [{ type: 'text', text: JSON.stringify(resultWithSession) }] };
                } catch (error: any) {
                    this._activeCommands.delete(session.sessionId);
                    this._activeCommandsSubject.next(new Map(this._activeCommands));

                    this.logger.error('Command execution error:', error);
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }]
                    };
                }
            }
        };
    }

    /**
     * Check if a session is valid (tab exists and is connected)
     * Returns true if valid, throws error if invalid
     */
    private ensureSessionValid(session: TerminalSessionWithTab): void {
        const tabAny = session.tab as any;
        const sessionObj = tabAny.session;

        // Debug log to analyze tab state
        // NOTE: tab.destroyed is a Subject<void>, NOT a boolean! Only check session.open
        this.logger.debug(`[ensureSessionValid] Checking session ${session.sessionId}: hasSession=${!!sessionObj}, sessionOpen=${sessionObj?.open}`);

        if (!sessionObj) {
            // Cold/restored tab: Tabby has not created the session yet (it does so
            // on first focus). ensureSessionLive() handles activation + waiting.
            this.logger.warn(`[ensureSessionValid] Session ${session.sessionId} has no session object (restored tab never focused)`);
        }

        if (sessionObj && sessionObj.open === false) {
            this.logger.warn(`[ensureSessionValid] Session ${session.sessionId} disconnected: session.open=false`);

            // Remove from active commands but DO NOT throw error yet to avoid false positives
            // until we confirm this logic covers all valid states (e.g. some session types might not have 'open' prop)
            if (this._activeCommands.has(session.sessionId)) {
                // Only strict abort if we are 100% sure. For now, let's just log.
                // const activeCmd = this._activeCommands.get(session.sessionId);
                // activeCmd?.abort();
                // this._activeCommands.delete(session.sessionId);
                // this._activeCommandsSubject.next(new Map(this._activeCommands));
            }

            // PER USER REQUEST: Do not block execution if logic is uncertain. 
            // Just warn for now.
            // throw new Error(`Session ${session.sessionId} is disconnected or tab is closed`);
        }
    }

    /**
     * Can this tab's session accept input right now?
     *
     * `false` covers two cases that both silently swallow input:
     * 1. `session === null` - restored tab whose frontend has never been attached
     *    (Tabby creates the session in onFrontendReady(), i.e. only on focus).
     * 2. `session.open === false` - session exists but is not connected yet
     *    (SSH: setSession() runs before the awaited session.start()).
     *
     * `sendInput()` is `this.session?.write(data)` and SSHShellSession.write() is
     * `if (this.shell) ...`, so both cases drop the data without any error.
     */
    private isSessionWritable(session: TerminalSessionWithTab): boolean {
        const sessionObj = (session.tab as any).session;
        if (!sessionObj) {
            return false;
        }
        // `open` is set to false in the BaseSession constructor and flipped to true
        // in start(); treat an unknown value as writable to avoid false negatives
        // for session types that do not expose it.
        return sessionObj.open !== false;
    }

    /**
     * Focus a tab (and its pane, when inside a split).
     */
    private activateTab(session: TerminalSessionWithTab): void {
        if (this.app.activeTab !== session.tabParent) {
            this.app.selectTab(session.tabParent);
        }
        if (session.isSplit && session.tabParent instanceof SplitTabComponent) {
            (session.tabParent as SplitTabComponent).focus(session.tab);
        }
    }

    /**
     * Inspect Tabby's post-disconnect state.
     *
     * `ConnectableTerminalTabComponent` (the base of SSH/telnet tabs) reacts to a
     * lost session in two ways:
     *  - `reconnectOffered === true`: it printed "Press any key to reconnect" and
     *    subscribed to `input$.pipe(first())` - i.e. it is blocked until a real
     *    keyboard event arrives to call `reconnect()`. Focusing the tab does NOT
     *    satisfy that subscription, so without help an MCP command just waits out
     *    its whole timeout.
     *  - `isDisconnectedByHand === true`: the user pressed Disconnect - that is a
     *    deliberate choice, so fail fast instead of reconnecting behind their back.
     *
     * Not to be confused with the cold-tab state (session === null because the
     * tab was restored and never focused): there `reconnectOffered` is still false.
     */
    private getReconnectState(session: TerminalSessionWithTab): {
        awaitingReconnect: boolean;
        blockedByUser: boolean;
        canReconnect: boolean;
    } {
        const tabAny = session.tab as any;
        return {
            awaitingReconnect: tabAny?.reconnectOffered === true,
            blockedByUser: tabAny?.isDisconnectedByHand === true,
            canReconnect: typeof tabAny?.reconnect === 'function',
        };
    }

    private isAutoReconnectEnabled(): boolean {
        try {
            return this.config.store.mcp?.timing?.autoReconnect !== false;
        } catch {
            return true;
        }
    }

    /**
     * Call the tab's own reconnect() - byte-for-byte what "press any key" does,
     * minus the keyboard. Fire-and-forget: a failed attempt leaves the tab with
     * `session.open === false`, which the caller's poll loop reports as a timeout.
     */
    private requestReconnect(session: TerminalSessionWithTab): void {
        const tabAny = session.tab as any;
        try {
            const result = tabAny.reconnect();
            if (result && typeof result.then === 'function') {
                result.then(undefined, (e: any) => {
                    this.logger.error(`[ensureSessionLive] Programmatic reconnect failed: ${e?.message ?? e}`);
                });
            }
        } catch (e: any) {
            this.logger.error(`[ensureSessionLive] Programmatic reconnect threw: ${e?.message ?? e}`);
        }
    }

    /**
     * Track when MCP last kicked off a programmatic connect for a tab.
     *
     * SSH's initializeSession() has no re-entrancy guard, so firing reconnect()
     * while the previous attempt is still running would open a second SSH
     * connection (the first one is never destroyed - `reconnect()` can only
     * destroy an existing `session`, which is still null during the connect).
     * The attempt settles within the profile's readyTimeout (ssh2 default 20s)
     * plus handshake overhead, so stay quiet a little longer than that.
     */
    private connectAttempts = new WeakMap<object, number>();

    private mayRetryConnect(tab: any): boolean {
        try {
            const last = this.connectAttempts.get(tab);
            if (last === undefined) {
                return true;
            }
            const readyTimeout = Number(tab?.profile?.options?.readyTimeout) || 20000;
            return Date.now() - last >= readyTimeout + 2000;
        } catch {
            return true;
        }
    }

    private markConnectAttempt(tab: any): void {
        try {
            this.connectAttempts.set(tab, Date.now());
        } catch {
            // best effort only
        }
    }

    /**
     * Should the readiness probe run again for this session object?
     *
     * A confirmation is only good for so long. Nothing in the session object
     * changes when a remote shell stops consuming input, so the only way to
     * notice is to ask again - and asking on every command would add two lines
     * of noise to each one. Re-probing an idle session strikes the balance.
     */
    private needsProbe(sessionObj: object): boolean {
        const last = this.shellReadyAt.get(sessionObj);
        if (last === undefined) {
            return true;
        }
        const interval = this.config.store.mcp?.timing?.shellReprobeInterval ?? 60000;
        return Date.now() - last >= interval;
    }

    /**
     * Is the session sitting at a shell prompt, with the prompt as the last
     * thing on screen?
     *
     * Only used to decide whether a *repeat* probe is safe. A confirmed session
     * whose last line is prompt-shaped can be re-probed harmlessly; one showing
     * a program's output cannot - typing there would feed the probe into that
     * program's stdin. In the latter case the session simply keeps its previous
     * confirmation and behaves exactly as it did before re-probing existed.
     */
    private isAtShellPrompt(session: TerminalSessionWithTab): boolean {
        try {
            const lines = this.getTerminalBufferText(session).split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
                const clean = stripAnsi(lines[i]).replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '').trim();
                if (!clean) {
                    continue;
                }
                return /[$#%❯➜>]\s*$/.test(clean);
            }
        } catch {
            // An unreadable buffer must not turn into a reconnect.
        }
        return false;
    }

    /**
     * Guarantee the target session can receive input, activating the tab first
     * when it is still cold (restored but never focused), and driving Tabby's
     * "press any key to reconnect" prompt when the session was lost.
     *
     * NOTE: activation is mandatory in the cold case and therefore overrides
     * background execution mode - the frontend is attached only on focus, so
     * without it the session would never be created and the command could never
     * run at all.
     */
    private async ensureSessionLive(
        session: TerminalSessionWithTab,
        alreadyActivated: boolean
    ): Promise<{ ok: boolean; activated: boolean; reconnected?: boolean; manualDisconnect?: boolean; waitedMs: number; shellReady?: boolean; shellReadyWaitMs?: number; probeAttempts?: number; error?: string; hint?: string }> {
        const sessionObj = (session.tab as any).session;
        const timing = this.config.store.mcp?.timing || {};
        const pollInterval = timing.sessionPollInterval ?? 200;
        const timeout = timing.sessionActivationTimeout ?? 30000;
        const started = Date.now();
        const reconnectState = this.getReconnectState(session);
        const tabAny = session.tab as any;

        // Snapshot BEFORE activation. A cold (restored, never focused) tab has no
        // frontend yet, and focusing it is what creates one: attach ->
        // onFrontendReady -> initializeSession. A tab that is ALREADY attached
        // never runs that path again, so if its connection attempt failed there
        // is nothing left to retry it (see the third branch below).
        const attachedBeforeActivation = Boolean(tabAny?.frontend);

        // A tab the user disconnected by hand ends up in exactly the same
        // internal state as one whose connection dropped: session === null plus
        // "press any key to reconnect". Reviving both the same way is simpler and
        // never leaves an agent stuck on a tab it can see; a deliberate
        // disconnect is rare and a command aimed at that tab is the stronger
        // signal. The flag is kept only so the response can say what happened.
        const manualDisconnect = reconnectState.blockedByUser;

        let reconnected = false;

        if (this.isSessionWritable(session)) {
            // Writable != ready. A session object that appeared *between* two MCP
            // calls - e.g. select_tab on a cold tab, then exec_command - is already
            // `open` while the remote shell is still running its profile, and bash
            // discards type-ahead written in that window. The old code returned
            // here immediately, so that command vanished and only surfaced as
            // "Command timeout" with empty output.
            //
            // The same probe also catches the opposite case: a session confirmed
            // earlier that has gone stale since - still open, still answering SSH
            // keepalives, but no longer feeding input to its shell. A cold session
            // is probed once; a confirmed one is re-probed once it has been idle
            // past mcp.timing.shellReprobeInterval. isProbeSafe() keeps both probes
            // off an interactive program, isAtShellPrompt() keeps the repeat probe
            // off a busy one.
            const probeTarget: object | null = sessionObj ?? null;
            const confirmed = probeTarget !== null && this.shellReadyAt.has(probeTarget);
            const shouldProbe = probeTarget !== null
                && this.isProbeSafe(session)
                && (!confirmed || (this.needsProbe(probeTarget) && this.isAtShellPrompt(session)));

            if (probeTarget && shouldProbe) {
                // A confirmed shell answers within ~100-300ms, so it gets a short
                // window; only a cold one needs the full cold-start budget.
                const shell = await this.waitForShellReady(
                    session,
                    confirmed ? Math.min(timing.shellReadyTimeout ?? 10000, 3000) : undefined
                );
                if (shell.ready) {
                    this.shellReadyAt.set(probeTarget, Date.now());
                    return {
                        ok: true,
                        activated: alreadyActivated,
                        waitedMs: 0,
                        shellReady: true,
                        shellReadyWaitMs: shell.waitedMs,
                        probeAttempts: shell.attempts
                    };
                }

                // Confirmed before, silent now, and the probe was not even echoed:
                // the bytes never reached the remote tty. Nothing on this side can
                // revive that session short of rebuilding it. A probe that WAS
                // echoed means the tty is alive and something else owns the input
                // line, which is a normal state - send the command as before.
                if (confirmed && !shell.echoed && reconnectState.canReconnect && this.isAutoReconnectEnabled() && this.mayRetryConnect(tabAny)) {
                    this.logger.warn(
                        `[ensureSessionLive] Session ${session.sessionId} is open but stopped consuming input ` +
                        `(probe not even echoed) - rebuilding the session`
                    );
                    this.markConnectAttempt(tabAny);
                    this.requestReconnect(session);
                    reconnected = true;
                } else {
                    return {
                        ok: true,
                        activated: alreadyActivated,
                        waitedMs: 0,
                        shellReady: false,
                        shellReadyWaitMs: shell.waitedMs,
                        probeAttempts: shell.attempts
                    };
                }
            } else {
                return { ok: true, activated: alreadyActivated, waitedMs: 0 };
            }
        }

        if (!reconnected) {
            // The tab is sitting on "press any key to reconnect" - nothing else will
            // ever revive it, so trigger the reconnect instead of waiting it out.
            if ((reconnectState.awaitingReconnect || manualDisconnect) && reconnectState.canReconnect && this.isAutoReconnectEnabled()) {
                this.logger.warn(
                    `[ensureSessionLive] Session ${session.sessionId} is awaiting "press any key to reconnect"` +
                    `${manualDisconnect ? ' (disconnected by hand in Tabby)' : ''} - triggering tab.reconnect()`
                );
                this.markConnectAttempt(tabAny);
                this.requestReconnect(session);
                reconnected = true;
            } else if (attachedBeforeActivation && reconnectState.canReconnect && this.isAutoReconnectEnabled() && this.mayRetryConnect(tabAny)) {
                // Third state: the tab was connected, the link dropped, and Tabby's
                // own reconnect attempt died at the socket level ("os error 10060" /
                // "10061"). SSH's initializeSession() throws before ever calling
                // setSession(), so onSessionDestroyed() never fires and Tabby offers
                // NOTHING: no "press any key to reconnect" prompt, reconnectOffered
                // stays false. Without this branch the tab stays dead until a human
                // picks Reconnect from the tab menu - every MCP call just waits out
                // its timeout and reports the misleading "restored on startup" cause.
                //
                // Gated on the pre-activation frontend snapshot: a cold tab must not
                // be reconnected here, because its in-flight initializeSession() has
                // no re-entrancy guard and we would open a second SSH connection.
                this.logger.warn(
                    `[ensureSessionLive] Session ${session.sessionId} has no session and no reconnect prompt ` +
                    `(the last connect attempt failed) - triggering tab.reconnect()`
                );
                this.markConnectAttempt(tabAny);
                this.requestReconnect(session);
                reconnected = true;
            }
        }

        this.logger.warn(
            `[ensureSessionLive] Session ${session.sessionId} has no writable session ` +
            `(awaitingReconnect=${reconnectState.awaitingReconnect}, reconnected=${reconnected}) - ` +
            `waiting up to ${timeout}ms for it to connect`
        );
        this.activateTab(session);

        while (Date.now() - started < timeout) {
            if (this.isSessionWritable(session)) {
                const waitedMs = Date.now() - started;
                this.logger.info(`[ensureSessionLive] Session ${session.sessionId} became writable after ${waitedMs}ms`);

                // Writable != ready: the remote shell is still initialising and
                // swallows type-ahead written during that window (see below).
                const shell = await this.waitForShellReady(session);
                if (shell.ready) {
                    // Remember this session object (and when) so later calls can
                    // skip the probe until it has been idle long enough to matter.
                    const liveObj = (session.tab as any).session;
                    if (liveObj) {
                        this.shellReadyAt.set(liveObj, Date.now());
                    }
                }
                return {
                    ok: true,
                    activated: true,
                    reconnected,
                    manualDisconnect: manualDisconnect && reconnected,
                    waitedMs,
                    shellReady: shell.ready,
                    shellReadyWaitMs: shell.waitedMs,
                    probeAttempts: shell.attempts
                };
            }
            // Re-assert activation: the tab could have been switched away while waiting.
            this.activateTab(session);
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        const waitedMs = Date.now() - started;
        const kipPending = this.getKeyboardInteractivePrompt(session) !== null;
        this.logger.error(`[ensureSessionLive] Session ${session.sessionId} never became writable (${waitedMs}ms)`);

        const diagnosis = kipPending
            ? 'SSH is waiting for keyboard-interactive input (MFA/TOTP) in Tabby.'
            : reconnectState.awaitingReconnect || manualDisconnect || reconnected
                ? 'The reconnect did not complete - the host may be unreachable or authentication failed.'
                : 'The tab was restored on startup but its session never connected (no session object / session.open=false).';

        return {
            ok: false,
            activated: true,
            reconnected,
            manualDisconnect: manualDisconnect && reconnected,
            waitedMs,
            error: `Session not writable after ${waitedMs}ms: ${diagnosis}`,
            hint: kipPending
                ? 'Complete the keyboard-interactive prompt in Tabby, then retry.'
                : 'Check the tab in Tabby (red SSH error line? "Press any key to reconnect"?), then retry.'
        };
    }

    /**
     * Cheap, passive check: is it safe to type an `echo` probe into this session?
     *
     * The readiness probe writes text to the terminal, so it must stay away from
     * sessions that are already running an interactive program:
     *
     *   - a full-screen app (vim / less / top / man / htop) owns the alternate
     *     screen buffer - typing there edits the file or scrolls the pager;
     *   - a REPL (python / node / mysql / ...) would execute the probe text as
     *     code.
     *
     * Everything else is safe: a shell prompt, and equally a tab whose shell has
     * not printed a prompt yet - the latter being exactly the case the probe
     * exists for.
     *
     * Both checks are read-only. A session that fails the check is simply left
     * unconfirmed, so the probe is retried on the next command - once the user
     * quits vim, the next call probes normally.
     */
    private isProbeSafe(session: TerminalSessionWithTab): boolean {
        try {
            const frontend = session.tab.frontend as XTermFrontend;
            const xtermInstance = (frontend as any)?.xterm;
            if (xtermInstance?.buffer?.active?.type === 'alternate') {
                this.logger.debug(`[isProbeSafe] alternate screen buffer active - skipping probe for ${session.sessionId}`);
                return false;
            }
        } catch (e: any) {
            // An unreadable buffer must not block the probe - that would bring
            // back the silent command drop this whole path exists to prevent.
            this.logger.debug(`[isProbeSafe] buffer check failed for ${session.sessionId}: ${e?.message ?? e}`);
        }

        const parsed = this.parseEnvironmentFromBuffer(session, this.getTerminalBufferText(session), true);
        const repls = ['python', 'ruby', 'mysql', 'postgres', 'sqlite', 'mongodb', 'redis', 'node'];
        if (repls.includes(parsed.environment)) {
            this.logger.debug(`[isProbeSafe] ${parsed.environment} REPL detected - skipping probe for ${session.sessionId}`);
            return false;
        }

        return true;
    }

    /**
     * Wait until the shell on the other end really consumes input.
     *
     * `session.open === true` only means the SSH channel is up. The remote shell
     * is still initialising (profile/banner scripts) and bash discards pending
     * type-ahead while it takes over the terminal - so a command written in that
     * window disappears with NO echo and NO error. That is why the first command
     * on a cold tab timed out (`Command timeout`, empty output) while an
     * immediate retry on the same session worked.
     *
     * Verify readiness with an idempotent `echo` probe and retry until its
     * *output* shows up. The token is typed as `TOK""EN` so the echoed command
     * line itself can never match the searched string `TOKEN` - only a shell that
     * actually executed it prints the joined form (both bash and PowerShell strip
     * the empty quotes). Retrying is safe: `echo` has no side effects.
     *
     * Callers must gate this with isProbeSafe(): the probe is safe on a shell
     * that is still starting up, but must never be typed into a full-screen app
     * or a REPL. ensureSessionLive() is the only caller and does exactly that.
     *
     * The result also reports whether the probe line was *echoed*. That
     * separates the two ways a probe can go unanswered: an echo without the
     * joined token means the bytes did reach the tty and something else (a
     * running program) owns the input line, while no echo at all means the
     * session is wedged and nothing is reaching the remote tty anymore.
     */
    private async waitForShellReady(
        session: TerminalSessionWithTab,
        budgetOverride?: number
    ): Promise<{ ready: boolean; waitedMs: number; attempts: number; echoed: boolean }> {
        const timing = this.config.store.mcp?.timing || {};
        const pollInterval = timing.sessionPollInterval ?? 200;
        const budget = budgetOverride ?? timing.shellReadyTimeout ?? 10000;
        // A ready shell answers a probe within ~100-300ms, so a short window is
        // enough: if nothing comes back the shell is still initialising and we
        // should re-probe soon instead of burning the whole budget on one wait.
        // Slow hosts were measured needing >6s before a probe executed cleanly.
        const perAttempt = Math.min(2000, Math.max(800, budget));
        const started = Date.now();
        let attempts = 0;
        let echoed = false;

        while (Date.now() - started < budget) {
            attempts++;
            const token = `MCPREADY${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
            const typed = `${token.slice(0, 4)}""${token.slice(4)}`;

            if (attempts > 1) {
                // A previous probe may be sitting unsubmitted on the input line.
                session.tab.sendInput('\x03');
            }
            // COMMAND_PREFIX absorbs the first-byte loss of a starting shell.
            session.tab.sendInput(`${COMMAND_PREFIX}echo ${typed}${this.getEnterKey()}`);

            const attemptDeadline = Math.min(started + budget, Date.now() + perAttempt);
            while (Date.now() < attemptDeadline) {
                const bufferText = this.getTerminalBufferText(session);
                if (bufferText.includes(token)) {
                    const waitedMs = Date.now() - started;
                    this.logger.info(`[waitForShellReady] Shell consumed input after ${waitedMs}ms (${attempts} probe attempt(s))`);
                    return { ready: true, waitedMs, attempts, echoed: true };
                }
                if (bufferText.includes(typed)) {
                    echoed = true;
                }
                await new Promise(resolve => setTimeout(resolve, pollInterval));
            }
        }

        const waitedMs = Date.now() - started;
        this.logger.warn(
            `[waitForShellReady] Shell did not confirm readiness within ${waitedMs}ms (${attempts} probe attempt(s), echoed=${echoed}) - ` +
            `sending the command anyway (raise mcp.timing.shellReadyTimeout for very slow hosts)`
        );
        return { ready: false, waitedMs, attempts, echoed };
    }

    /**
     * Tool: Send raw input to terminal (for interactive commands)
     */
    private createSendInputTool(): McpTool {
        return {
            name: 'send_input',
            description: `Send raw input to a terminal. Use this for interactive commands like vim, less, top, etc.
Session targeting: sessionId > tabId > tabIndex > title > profileName
Special keys: \\x03 (Ctrl+C), \\x04 (Ctrl+D), \\x1b (Escape), \\r (Enter)

Connection recovery: if the tab's session is not ready - restored but never focused, dropped, or its last connect attempt failed - the tab is activated and reconnected automatically before the input is sent, waiting up to the configured activation timeout. A hand-disconnected tab is reconnected too. Check the response for activatedTab / autoReconnectAttempted / reconnectedAfterManualDisconnect to see what happened.`,
            schema: z.object({
                input: z.string().describe('Input to send (can include special characters like \\n, \\x03 for Ctrl+C)'),
                sessionId: z.string().optional().describe('Stable session ID (recommended)'),
                tabId: z.string().optional().describe('Stable tab ID (interchangeable with sessionId)'),
                tabIndex: z.number().optional().describe('Tab index (legacy)'),
                title: z.string().optional().describe('Match by title'),
                profileName: z.string().optional().describe('Match by profile name')
            }).strict(),
            handler: async (params: { input: string; sessionId?: string; tabId?: string; tabIndex?: number; title?: string; profileName?: string }) => {
                const { input, sessionId, tabId, tabIndex, title, profileName } = params;

                const session = this.findSessionByLocator({ sessionId, tabId, tabIndex, title, profileName });

                if (!session) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                error: 'No matching terminal session found',
                                hint: 'Use get_session_list to see available sessions'
                            })
                        }]
                    };
                }

                try {
                    this.ensureSessionValid(session);
                } catch (error: any) {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }]
                    };
                }

                // Restored tabs have no live session until they are focused, and
                // sendInput() drops data silently in that state - activate and wait.
                const live = await this.ensureSessionLive(session, false);
                if (!live.ok) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                sessionId: session.sessionId,
                                error: live.error,
                                waitedMs: live.waitedMs,
                                ...(live.reconnected ? { autoReconnectAttempted: true } : {}),
                                ...(live.manualDisconnect ? { reconnectedAfterManualDisconnect: true } : {}),
                                hint: live.hint ?? 'Input was NOT sent. Inspect/reconnect the tab in Tabby, then retry.'
                            })
                        }]
                    };
                }

                // Process escape sequences
                const processedInput = input
                    .replace(/\\n/g, '\n')
                    .replace(/\\r/g, '\r')
                    .replace(/\\t/g, '\t')
                    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

                // Raw input can execute commands through Enter/newline, so it goes
                // through the same decision path as exec_command. The local
                // CommandSecurityManager stays the single decision maker; upstream's
                // separate pairProgrammingMode-only gate is deliberately NOT used, so
                // a single keystroke can never produce two stacked confirmations.
                // Note: the submitted text is never written to the log - it may be a
                // password typed into a sudo/passphrase prompt.
                const pairMode = this.config.store.mcp?.pairProgrammingMode;
                if (pairMode?.enabled && pairMode?.showConfirmationDialog) {
                    const commandText = this.extractSubmittedCommandLine(processedInput);
                    if (commandText) {
                        const securityManager = this.getSecurityManager();
                        securityManager.updateConfig(this.getSecurityConfig());
                        const decision = securityManager.evaluate(commandText);

                        if (decision.action === 'allow') {
                            this.logger.info(`Auto-allowed terminal input (${decision.reason})`);
                        } else if (decision.action === 'confirm') {
                            const confirmed = await this.dialogService.showCommandConfirmation(commandText, session.tabIndex);
                            if (!confirmed) {
                                return {
                                    content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Input rejected by user' }) }]
                                };
                            }
                        } else {
                            this.logger.warn(`Terminal input denied (${decision.reason})`);
                            return {
                                content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Input denied: ${decision.reason}` }) }]
                            };
                        }
                    }
                }

                try {
                    session.tab.sendInput(processedInput);
                    this.logger.info(`Sent input to session ${session.sessionId}`);

                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: true, sessionId: session.sessionId, message: 'Input sent' }) }]
                    };
                } catch (error: any) {
                    this.logger.error(`Error sending input to session ${session.sessionId}:`, error);
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                error: `Failed to send input: ${error.message}. Session might be disconnected.`,
                                sessionId: session.sessionId
                            })
                        }]
                    };
                }
            }
        };
    }

    /**
     * Tool: Submit response to Tabby's SSH keyboard-interactive auth panel
     */
    private createSubmitKeyboardInteractiveResponseTool(): McpTool {
        return {
            name: 'submit_keyboard_interactive_response',
            description: `Submit response(s) to an active SSH keyboard-interactive authentication prompt.
Use this for MFA/TOTP prompts shown by Tabby's SSH authentication panel, such as Jumpserver MFA.

This tool targets Tabby's activeKIPrompt object directly; it is different from send_input,
which writes to the terminal pty and cannot answer Tabby's auth form.

Session targeting (priority order): sessionId > tabId > tabIndex > title > profileName`,
            schema: z.object({
                response: z.string().optional().describe('Single response for prompts with one field, such as a 6-digit TOTP code'),
                responses: z.array(z.string()).optional().describe('Responses for multi-prompt keyboard-interactive auth, in prompt order'),
                sessionId: z.string().optional().describe('Stable session ID (recommended, from get_session_list)'),
                tabId: z.string().optional().describe('Stable tab ID (from list_tabs or get_session_list, interchangeable with sessionId)'),
                tabIndex: z.number().optional().describe('Tab index (legacy, may change if tabs reorder)'),
                title: z.string().optional().describe('Match session by title (partial, case-insensitive)'),
                profileName: z.string().optional().describe('Match session by profile name (partial, case-insensitive)')
            }).strict(),
            handler: async (params: {
                response?: string;
                responses?: string[];
                sessionId?: string;
                tabId?: string;
                tabIndex?: number;
                title?: string;
                profileName?: string;
            }) => {
                const { response, responses, sessionId, tabId, tabIndex, title, profileName } = params;
                const session = this.findSessionByLocator({ sessionId, tabId, tabIndex, title, profileName });

                if (!session) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                error: 'No matching terminal session found',
                                hint: 'Use get_session_list to see available sessions'
                            })
                        }]
                    };
                }

                const prompt = this.getKeyboardInteractivePrompt(session);
                if (!prompt) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                sessionId: session.sessionId,
                                keyboardInteractivePending: false,
                                error: 'No active keyboard-interactive prompt on this session'
                            })
                        }]
                    };
                }

                const providedResponses = responses ?? (response !== undefined ? [response] : undefined);
                if (!providedResponses || providedResponses.length === 0) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                sessionId: session.sessionId,
                                keyboardInteractivePending: true,
                                keyboardInteractivePrompt: this.describeKeyboardInteractivePrompt(prompt),
                                error: 'Provide response or responses'
                            })
                        }]
                    };
                }

                if (!Array.isArray(prompt.responses) || !Array.isArray(prompt.prompts)) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                sessionId: session.sessionId,
                                error: 'Active keyboard-interactive prompt has an unexpected shape',
                                keyboardInteractivePrompt: this.describeKeyboardInteractivePrompt(prompt)
                            })
                        }]
                    };
                }

                if (providedResponses.length !== prompt.prompts.length) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                sessionId: session.sessionId,
                                error: `Expected ${prompt.prompts.length} response(s), got ${providedResponses.length}`,
                                keyboardInteractivePrompt: this.describeKeyboardInteractivePrompt(prompt)
                            })
                        }]
                    };
                }

                if (typeof prompt.respond !== 'function') {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                sessionId: session.sessionId,
                                error: 'Keyboard-interactive prompt does not expose respond()'
                            })
                        }]
                    };
                }

                // Approval goes through the same dialog as every other MCP operation.
                // The preview carries ONLY the response count - TOTP codes and
                // passwords must never appear in a dialog or in the log.
                const pairMode = this.config.store.mcp?.pairProgrammingMode;
                if (pairMode?.enabled && pairMode?.showConfirmationDialog) {
                    const confirmed = await this.dialogService.showOperationConfirmation(
                        'submit_keyboard_interactive_response',
                        session.tab.title || `Terminal ${session.tabIndex}`,
                        `${providedResponses.length} keyboard-interactive response(s)`
                    );
                    if (!confirmed) {
                        return {
                            content: [{
                                type: 'text', text: JSON.stringify({
                                    success: false,
                                    sessionId: session.sessionId,
                                    error: 'Keyboard-interactive response rejected by user'
                                })
                            }]
                        };
                    }
                }

                const previousResponses = [...prompt.responses];
                try {
                    providedResponses.forEach((value, index) => {
                        prompt.responses[index] = value;
                    });

                    prompt.respond();
                    (session.tab as any).activeKIPrompt = null;
                    (session.tab as any).frontend?.focus?.();

                    this.logger.info(`Submitted keyboard-interactive response for session ${session.sessionId}`);
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: true,
                                sessionId: session.sessionId,
                                submitted: true,
                                responseCount: providedResponses.length,
                                message: 'Keyboard-interactive response submitted'
                            })
                        }]
                    };
                } catch (error: any) {
                    prompt.responses.splice(0, prompt.responses.length, ...previousResponses);
                    this.logger.error(`Error submitting keyboard-interactive response for session ${session.sessionId}:`, error);
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                sessionId: session.sessionId,
                                error: `Failed to submit keyboard-interactive response: ${error.message || error}`
                            })
                        }]
                    };
                }
            }
        };
    }

    /**
     * Extract the command line that a raw terminal input would actually submit.
     *
     * send_input writes raw bytes to the pty, so the security decision has to be
     * made on the text that precedes the first Enter/newline: everything after it
     * is a second command and would otherwise slip past the check.
     * Returns null when the input cannot start a command on its own (Ctrl+C,
     * Escape, arrow keys, Home/End, ...), so plain keystrokes are never gated.
     */
    private extractSubmittedCommandLine(input: string): string | null {
        const firstBreak = input.search(/[\r\n]/);
        const line = firstBreak === -1 ? input : input.slice(0, firstBreak);
        const cleaned = line
            .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')  // CSI sequences (arrows, Home/End, ...)
            .replace(/\t/g, ' ')                     // Tab is a word separator, not a submit
            .replace(/[\x00-\x1f\x7f]/g, '')         // any remaining control char (Ctrl+C, Ctrl+D, ...)
            .trim();
        return cleaned || null;
    }

    private parseEnvironmentFromBuffer(
        session: TerminalSessionWithTab,
        bufferContent: string,
        useEnhancedHeuristics: boolean
    ): { environment: string; isShell: boolean; promptRaw: string; promptClean: string } {
        const normalizedLines = bufferContent
            .split('\n')
            .map(line => {
                const raw = line.trimEnd();
                const clean = useEnhancedHeuristics
                    ? stripAnsi(raw).replace(/\[[0-9;?]*[a-zA-Z]/g, '').trim()
                    : raw.trim();
                return { raw, clean };
            })
            .filter(line => line.raw.length > 0 || line.clean.length > 0);

        const replMatchers: Array<{ environment: string; pattern: RegExp }> = [
            { environment: 'python', pattern: /^>>>$/ },
            { environment: 'ruby', pattern: /^(irb>|irb\(main\):.*)$/ },
            { environment: 'mysql', pattern: /^mysql>$/ },
            { environment: 'postgres', pattern: /^(postgres[=#>-]?|\w+=>|\w+=#)$/ },
            { environment: 'sqlite', pattern: /^sqlite>$/ },
            { environment: 'mongodb', pattern: /^(mongo>|mongosh>|Enterprise\s.+>)$/ },
            { environment: 'redis', pattern: /^127\.0\.0\.1:\d+>$/ },
            { environment: 'node', pattern: /^>$/ },
        ];

        let environment = 'unknown';
        let isShell = false;
        let promptRaw = '';
        let promptClean = '';
        const fallbackLine = normalizedLines.length > 0 ? normalizedLines[normalizedLines.length - 1] : { raw: '', clean: '' };

        for (let i = normalizedLines.length - 1; i >= 0; i--) {
            const candidate = normalizedLines[i];
            if (!candidate.clean) {
                continue;
            }

            const replMatch = replMatchers.find(m => m.pattern.test(candidate.clean));
            if (replMatch) {
                environment = replMatch.environment;
                promptRaw = candidate.raw;
                promptClean = candidate.clean;
                break;
            }

            if (/[$#%❯➜]\s*$/.test(candidate.clean)) {
                isShell = true;
                const detectedShell = this.detectShellType(session);
                environment = detectedShell === 'sh' ? 'shell' : detectedShell;
                promptRaw = candidate.raw;
                promptClean = candidate.clean;
                break;
            }
        }

        if (!promptRaw) {
            isShell = true;
            const detectedShell = this.detectShellType(session);
            environment = detectedShell === 'sh' ? 'shell' : detectedShell;
            promptRaw = fallbackLine.raw;
            promptClean = fallbackLine.clean;
        }

        return { environment, isShell, promptRaw, promptClean };
    }

    /**
     * Tool: Get the current environment context of a session
     */
    private createGetSessionEnvironmentTool(): McpTool {
        return {
            name: 'get_session_environment',
            description: `Get the environment context of a terminal session (e.g., bash, python, node, database REPL).
Use this before sending complex commands to ensure the session is in the expected state.
Session targeting: sessionId > tabId > tabIndex > title > profileName`,
            schema: z.object({
                sessionId: z.string().optional().describe('Stable session ID (recommended)'),
                tabId: z.string().optional().describe('Stable tab ID (interchangeable with sessionId)'),
                tabIndex: z.number().optional().describe('Tab index (legacy)'),
                title: z.string().optional().describe('Match by title'),
                profileName: z.string().optional().describe('Match by profile name')
            }).strict(),
            handler: async (params: { sessionId?: string; tabId?: string; tabIndex?: number; title?: string; profileName?: string }) => {
                const environmentDetectionConfig = this.config.store.mcp?.environmentDetection;
                if (environmentDetectionConfig?.enabled === false) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                enabled: false,
                                error: 'Environment detection is disabled in Settings → MCP',
                                hint: 'Enable Environment Detection in the MCP settings page before using get_session_environment.'
                            })
                        }]
                    };
                }

                const session = this.findSessionByLocator(params);

                if (!session) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                error: 'No matching terminal session found',
                                hint: 'Use get_session_list to see available sessions'
                            })
                        }]
                    };
                }

                try {
                    this.ensureSessionValid(session);
                } catch (error: any) {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }]
                    };
                }

                const useEnhancedHeuristics = environmentDetectionConfig?.useEnhancedHeuristics !== false;
                const detectionMode = environmentDetectionConfig?.mode ?? 'heuristic';
                const bufferContent = this.getTerminalBufferText(session);
                const parsed = this.parseEnvironmentFromBuffer(session, bufferContent, useEnhancedHeuristics);
                let environment = parsed.environment;
                let isShell = parsed.isShell;
                const promptRaw = parsed.promptRaw;
                const promptClean = parsed.promptClean;

                const tabAny = session.tab as any;
                const profile = tabAny.profile ? {
                    id: tabAny.profile.id,
                    name: tabAny.profile.name,
                    type: tabAny.profile.type
                } : undefined;

                if (detectionMode === 'active' && isShell) {
                    const activeEnvironment = await this.detectActiveShellEnvironment(session);
                    if (activeEnvironment) {
                        environment = activeEnvironment.environment;
                        isShell = activeEnvironment.isShell;
                    }
                }

                const shell = isShell ? (['bash', 'zsh', 'fish', 'sh', 'shell'].includes(environment) ? environment : this.detectShellType(session)) : undefined;

                return {
                    content: [{
                        type: 'text', text: JSON.stringify({
                            success: true,
                            sessionId: session.sessionId,
                            environment,
                            shell,
                            isShell,
                            lastPrompt: promptRaw,
                            normalizedPrompt: promptClean || undefined,
                            cwd: tabAny.session?.cwd,
                            pid: tabAny.session?.pty?.pid,
                            profile
                        }, null, 2)
                    }]
                };
            }
        };
    }

    private async detectActiveShellEnvironment(session: TerminalSessionWithTab): Promise<{ environment: string; isShell: boolean } | null> {
        const tabAny = session.tab as any;
        const sessionObj = tabAny.session;
        if (!sessionObj || sessionObj.open === false) {
            return null;
        }

        const shell = this.detectShellType(session);
        // The probe command is POSIX-only (printf / [ -n ... ]). On PowerShell it
        // would type garbage into the terminal and always fail, so short-circuit.
        if (shell === 'powershell') {
            return { environment: 'powershell', isShell: true };
        }
        // fish does not support POSIX `if [ -n ... ]; then` syntax, so use a fish-native probe
        const command = shell === 'fish'
            ? `printf '__MCP_ENV__:'; if test -n "$VIRTUAL_ENV"; printf 'python-venv'; else if test -n "$CONDA_DEFAULT_ENV"; printf 'python-conda'; else if test -n "$IN_NIX_SHELL"; printf 'nix-shell'; else; printf 'shell'; end; printf ':__MCP_ENV__'`
            : `printf '__MCP_ENV__:'; if [ -n "$VIRTUAL_ENV" ]; then printf 'python-venv'; elif [ -n "$CONDA_DEFAULT_ENV" ]; then printf 'python-conda'; elif [ -n "$IN_NIX_SHELL" ]; then printf 'nix-shell'; else printf 'shell'; fi; printf ':__MCP_ENV__'`;

        try {
            const startMarker = `__MCP_ENV_START_${Date.now()}__`;
            const endMarker = `__MCP_ENV_END_${Date.now()}__`;
            const wrappedCommand = COMMAND_PREFIX + this.getWrappedCommand(command, startMarker, endMarker, shell);
            session.tab.sendInput(wrappedCommand + '\n');
            const result = await this.waitForCommandOutputViaBuffer(session, startMarker, endMarker, 3000, () => false);
            const match = result.output.match(/__MCP_ENV__:(.+?):__MCP_ENV__/);
            if (!match) {
                return null;
            }
            const marker = match[1].trim();
            if (marker === 'python-venv' || marker === 'python-conda' || marker === 'nix-shell') {
                return { environment: marker, isShell: false };
            }
            return { environment: shell === 'sh' ? 'shell' : shell, isShell: true };
        } catch {
            return null;
        }
    }

    /**
     * Tool: Get terminal buffer content
     */
    private createGetTerminalBufferTool(): McpTool {
        return {
            name: 'get_terminal_buffer',
            description: `Get the content of a terminal buffer. Use this to check command output after using send_input or async exec_command.
Session targeting: sessionId > tabId > tabIndex > title > profileName`,
            schema: z.object({
                sessionId: z.string().optional().describe('Stable session ID (recommended)'),
                tabId: z.string().optional().describe('Stable tab ID (interchangeable with sessionId)'),
                tabIndex: z.number().optional().describe('Tab index (legacy)'),
                title: z.string().optional().describe('Match by title'),
                profileName: z.string().optional().describe('Match by profile name'),
                lastNLines: z.number().optional().describe('Get only the last N lines (default: all)'),
                startLine: z.number().optional().describe('Start line (0-indexed)'),
                endLine: z.number().optional().describe('End line (exclusive)')
            }).strict(),
            handler: async (params: {
                sessionId?: string;
                tabId?: string;
                tabIndex?: number;
                title?: string;
                profileName?: string;
                lastNLines?: number;
                startLine?: number;
                endLine?: number;
            }) => {
                const { sessionId, tabId, tabIndex, title, profileName, lastNLines, startLine, endLine } = params;

                const session = this.findSessionByLocator({ sessionId, tabId, tabIndex, title, profileName });

                if (!session) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                error: 'No matching terminal session found',
                                hint: 'Use get_session_list to see available sessions'
                            })
                        }]
                    };
                }

                try {
                    this.ensureSessionValid(session);
                } catch (error: any) {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }]
                    };
                }

                const bufferContent = this.getTerminalBufferText(session);
                const lines = bufferContent.split('\n');

                let selectedLines: string[];
                if (lastNLines !== undefined) {
                    selectedLines = lines.slice(-lastNLines);
                } else {
                    const start = startLine ?? 0;
                    const end = endLine ?? lines.length;
                    selectedLines = lines.slice(start, end);
                }

                return {
                    content: [{
                        type: 'text', text: JSON.stringify({
                            success: true,
                            sessionId: session.sessionId,
                            tabIndex: session.tabIndex,
                            totalLines: lines.length,
                            returnedLines: selectedLines.length,
                            content: selectedLines.join('\n')
                        })
                    }]
                };
            }
        };
    }

    /**
     * Tool: Abort running command
     */
    private createAbortCommandTool(): McpTool {
        return {
            name: 'abort_command',
            description: `Abort a running command by sending Ctrl+C.
Session targeting: sessionId > tabId > tabIndex > title > profileName`,
            schema: z.object({
                sessionId: z.string().optional().describe('Stable session ID (recommended)'),
                tabId: z.string().optional().describe('Stable tab ID (interchangeable with sessionId)'),
                tabIndex: z.number().optional().describe('Tab index (legacy)'),
                title: z.string().optional().describe('Match by title'),
                profileName: z.string().optional().describe('Match by profile name')
            }).strict(),
            handler: async (params: { sessionId?: string; tabId?: string; tabIndex?: number; title?: string; profileName?: string }) => {
                const { sessionId, tabId, tabIndex, title, profileName } = params;

                const session = this.findSessionByLocator({ sessionId, tabId, tabIndex, title, profileName });

                if (!session) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                error: 'No matching terminal session found'
                            })
                        }]
                    };
                }

                const activeCommand = this._activeCommands.get(session.sessionId);
                if (activeCommand) {
                    activeCommand.abort();
                    this._activeCommands.delete(session.sessionId);
                    this._activeCommandsSubject.next(new Map(this._activeCommands));
                }

                // Send Ctrl+C
                session.tab.sendInput('\x03');

                this.logger.info(`Aborted command in session ${session.sessionId}`);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, sessionId: session.sessionId, message: 'Ctrl+C sent' }) }] };
            }
        };
    }

    /**
     * Tool: Get status of active commands
     */
    private createGetCommandStatusTool(): McpTool {
        return {
            name: 'get_command_status',
            description: 'Get the status of active/running commands across all terminals',
            schema: z.object({}),
            handler: async () => {
                const activeCommands = Array.from(this._activeCommands.entries()).map(([sessionId, cmd]) => ({
                    sessionId,
                    tabIndex: cmd.tabId,
                    command: cmd.command,
                    startedAt: new Date(cmd.timestamp).toISOString(),
                    runningFor: `${Math.round((Date.now() - cmd.timestamp) / 1000)}s`
                }));

                return {
                    content: [{
                        type: 'text', text: JSON.stringify({
                            success: true,
                            activeCommands,
                            count: activeCommands.length
                        }, null, 2)
                    }]
                };
            }
        };
    }

    /**
     * Tool: Focus a specific pane in a split tab
     */
    private createFocusPaneTool(): McpTool {
        return {
            name: 'focus_pane',
            description: `Focus a specific pane in a split terminal tab.
Use sessionId to identify the exact pane to focus.
After focusing, commands sent to that split tab will go to the focused pane.`,
            schema: z.object({
                sessionId: z.string().describe('Session ID of the pane to focus (from get_session_list)')
            }).strict(),
            handler: async (params: { sessionId: string }) => {
                const { sessionId } = params;

                const session = this.findSessionByLocator({ sessionId });
                if (!session) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                error: 'No matching session found',
                                hint: 'sessionId may be stale after Tabby restart - run get_session_list to refresh'
                            })
                        }]
                    };
                }

                // Check if the session is in a split tab
                if (session.isSplit && session.tabParent instanceof SplitTabComponent) {
                    const splitTab = session.tabParent as SplitTabComponent;
                    splitTab.focus(session.tab);

                    this.logger.info(`Focused pane ${session.paneIndex} in split tab`);
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: true,
                                message: `Focused pane ${session.paneIndex} of ${session.totalPanes}`,
                                sessionId: session.sessionId,
                                paneIndex: session.paneIndex,
                                title: session.tab.title
                            })
                        }]
                    };
                } else {
                    // Not in a split, just select the tab
                    this.app.selectTab(session.tabParent);

                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: true,
                                message: 'Selected tab (not a split pane)',
                                sessionId: session.sessionId
                            })
                        }]
                    };
                }
            }
        };
    }

    /**
     * Find all terminal sessions with stable IDs
     * Enhanced to include split pane information
     */
    public findTerminalSessions(): TerminalSessionWithTab[] {
        const sessions: TerminalSessionWithTab[] = [];
        let globalIndex = 0;

        this.app.tabs.forEach((tab: BaseTabComponent, appTabIndex: number) => {
            if (tab instanceof BaseTerminalTabComponent) {
                // Single terminal tab (not in a split)
                const sessionId = this.getOrCreateSessionId(tab);
                sessions.push({
                    sessionId,
                    tabIndex: globalIndex++,
                    tabParent: tab,
                    tab: tab as BaseTerminalTabComponent,
                    isSplit: false
                });
            } else if (tab instanceof SplitTabComponent) {
                // Split tab containing multiple panes
                const splitTab = tab as SplitTabComponent;
                const childTabs = splitTab.getAllTabs().filter(
                    (childTab: BaseTabComponent) => childTab instanceof BaseTerminalTabComponent &&
                        (childTab as BaseTerminalTabComponent).frontend !== undefined
                );
                const focusedTab = splitTab.getFocusedTab();
                const totalPanes = childTabs.length;

                childTabs.forEach((childTab: BaseTabComponent, paneIdx: number) => {
                    const termTab = childTab as BaseTerminalTabComponent;
                    const sessionId = this.getOrCreateSessionId(termTab);
                    sessions.push({
                        sessionId,
                        tabIndex: globalIndex++,
                        tabParent: tab,
                        tab: termTab,
                        isSplit: true,
                        splitTabIndex: appTabIndex,
                        paneIndex: paneIdx,
                        totalPanes: totalPanes,
                        // isFocusedPane must be globally unique: getFocusedTab() returns the
                        // per-split focused pane even when this split window is NOT the active
                        // tab, so without the activeTab check multiple splits would each claim
                        // isFocusedPane=true and locator fallback would pick the first in array
                        // order (wrong tab in multi-split layouts).
                        isFocusedPane: (this.app.activeTab === splitTab) && (childTab === focusedTab)
                    });
                });
            }
        });

        return sessions;
    }

    /**
     * Get terminal buffer as text
     */
    private getTerminalBufferText(session: TerminalSessionWithTab): string {
        try {
            const frontend = session.tab.frontend as XTermFrontend;
            if (!frontend) {
                return '';
            }

            // Access xterm through type assertion since it may be private
            const xtermInstance = (frontend as any).xterm;
            if (!xtermInstance) {
                return '';
            }

            // Check if serialize addon is already registered
            let serializeAddon = (xtermInstance as any)._addonManager?._addons?.find(
                (addon: any) => addon.instance instanceof SerializeAddon
            )?.instance;

            if (!serializeAddon) {
                serializeAddon = new SerializeAddon();
                xtermInstance.loadAddon(serializeAddon);
            }

            return serializeAddon.serialize();
        } catch (err) {
            this.logger.error('Error getting terminal buffer:', err);
            return '';
        }
    }

    /**
     * Wait for command output between markers
     * Timing is configurable via Settings → MCP → Timing
     */
    private async waitForCommandOutputViaBuffer(
        session: TerminalSessionWithTab,
        startMarker: string,
        endMarker: string,
        timeout: number,
        isAborted: () => boolean
    ): Promise<CommandResult> {
        const startTime = Date.now();

        // Get timing config (with fallback defaults)
        const timing = this.config.store.mcp?.timing || {};
        const pollInterval = timing.pollInterval ?? 100;
        const initialDelay = timing.initialDelay ?? 0;

        // Optional initial delay (configurable, default 0)
        if (initialDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, initialDelay));
        }

        while (Date.now() - startTime < timeout) {
            if (isAborted()) {
                return { success: false, output: '', error: 'Command aborted' };
            }

            // Check if session is still valid - abort immediately if disconnected.
            // NOTE: tab.destroyed is a Subject<void>, NOT a boolean! Only check session.open.
            // `session === null` also means gone: Tabby's onSessionDestroyed() sets it to
            // null, and WITHOUT this check the loop would spin until the full timeout
            // (the old code only looked at `session.open === false`, which never matches
            // once the session object itself is null).
            const tabAny = session.tab as any;
            const sessionObj = tabAny.session;
            if (!sessionObj || sessionObj.open === false) {
                this.logger.warn(`[waitForCommandOutput] Session ${session.sessionId} lost during execution (session=${sessionObj ? 'open=false' : 'null'})`);
                return {
                    success: false,
                    output: '',
                    error: sessionObj
                        ? 'Session disconnected during execution'
                        : 'Session was lost during execution (connection dropped before the command finished)',
                    exitCode: -1
                };
            }

            const buffer = this.getTerminalBufferText(session);

            // Look for end marker with exit code pattern (complete marker)
            // End marker format: __MCP_END_<timestamp>__ <exit_code>
            const endPattern = new RegExp(`${endMarker}\\s+(-?\\d+)`, 'm');
            const endMatch = buffer.match(endPattern);

            if (endMatch) {
                // Found complete end marker with exit code
                const endIndex = buffer.indexOf(endMatch[0]);
                const startIndex = buffer.lastIndexOf(startMarker, endIndex);

                if (startIndex !== -1 && startIndex < endIndex) {
                    // Extract output between markers
                    let output = buffer.substring(startIndex + startMarker.length, endIndex).trim();

                    // Remove command echo (first line often contains the wrapped command)
                    // Look for the start marker echo line and skip it
                    const lines = output.split('\n');
                    if (lines.length > 0 && lines[0].includes(startMarker.slice(0, 10))) {
                        lines.shift();
                        output = lines.join('\n').trim();
                    }

                    const exitCode = parseInt(endMatch[1], 10);

                    return {
                        success: exitCode === 0,
                        output,
                        exitCode
                    };
                } else if (startIndex === -1) {
                    // Start marker not found, but End marker IS found.
                    // This likely means the output was too long and the start marker scrolled off the buffer.
                    // We should return what we have instead of hanging.
                    this.logger.warn(`[waitForCommandOutput] Start marker not found, but end marker found. Output likely truncated. Session: ${session.sessionId}`);

                    let output = buffer.substring(0, endIndex).trim();
                    const exitCode = parseInt(endMatch[1], 10);

                    // Add a warning note to the output so the user/LLM knows it's truncated
                    output = `[MCP Warning: Output truncated, start marker missing]\n${output}`;

                    return {
                        success: exitCode === 0,
                        output,
                        exitCode
                    };
                }
            }

            // Wait between checks (configurable via Settings → MCP → Timing)
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        // On timeout, return partial output if start marker found
        const buffer = this.getTerminalBufferText(session);
        const startIndex = buffer.lastIndexOf(startMarker);
        if (startIndex !== -1) {
            let partialOutput = buffer.substring(startIndex + startMarker.length).trim();

            // Clean up command echo
            const lines = partialOutput.split('\n');
            if (lines.length > 0 && lines[0].includes('&&')) {
                lines.shift();
                partialOutput = lines.join('\n').trim();
            }

            return {
                success: false,
                output: partialOutput,
                error: 'Command timeout (partial output captured)',
                exitCode: -1
            };
        }

        return { success: false, output: '', error: 'Command timeout' };
    }
    /**
     * Wait for command output using Stream Capture (Observable)
     * This bypasses the terminal buffer limit and works for huge outputs
     */
    private async waitForCommandOutputViaStream(
        outputStream$: ReplaySubject<string>,
        startMarker: string,
        endMarker: string,
        timeout: number,
        isAborted: () => boolean,
        session: TerminalSessionWithTab
    ): Promise<CommandResult> {
        let buffer = '';
        // eslint-disable-next-line prefer-const
        let subscription: Subscription;

        return new Promise<CommandResult>((resolve) => {
            let resolved = false; // Prevent double resolution

            const timeoutId = setTimeout(() => {
                if (resolved) return;
                resolved = true;
                cleanup();
                // Timeout logic
                const startIndex = buffer.lastIndexOf(startMarker);
                if (startIndex !== -1) {
                    let partialOutput = buffer.substring(startIndex + startMarker.length).trim();
                    // Clean echo
                    const lines = partialOutput.split('\n');
                    if (lines.length > 0 && lines[0].includes('&&')) {
                        lines.shift();
                        partialOutput = lines.join('\n').trim();
                    }
                    resolve({
                        success: false,
                        output: partialOutput,
                        error: 'Command timeout (partial output captured via stream)',
                        exitCode: -1
                    });
                } else {
                    resolve({ success: false, output: '', error: 'Command timeout' });
                }
            }, timeout);

            // Health check for session disconnect (check every 500ms)
            // NOTE: tab.destroyed is a Subject<void>, NOT a boolean! Only check session.open
            const healthCheckId = setInterval(() => {
                if (resolved) {
                    clearInterval(healthCheckId);
                    return;
                }
                const tabAny = session.tab as any;
                const sessionObj = tabAny.session;
                // `session === null` means Tabby already dropped it (onSessionDestroyed
                // sets it to null) - otherwise this health check would never fire and the
                // command would hang until the full timeout.
                if (!sessionObj || sessionObj.open === false) {
                    this.logger.warn(`[StreamCapture] Session ${session.sessionId} lost: session=${sessionObj ? 'open=false' : 'null'}`);
                    resolved = true;
                    cleanup();
                    resolve({
                        success: false,
                        output: '',
                        error: sessionObj
                            ? 'Session disconnected during execution'
                            : 'Session was lost during execution (connection dropped before the command finished)',
                        exitCode: -1
                    });
                }
            }, 500);

            const cleanup = () => {
                clearTimeout(timeoutId);
                clearInterval(healthCheckId);
                if (subscription) {
                    subscription.unsubscribe();
                }
            };

            subscription = outputStream$.subscribe({
                next: (data) => {
                    if (resolved) return;

                    if (isAborted()) {
                        resolved = true;
                        cleanup();
                        resolve({ success: false, output: '', error: 'Command aborted' });
                        return;
                    }

                    buffer += data;

                    // Look for end marker
                    const endPattern = new RegExp(`${endMarker}\\s+(\\d+)`, 'm');
                    const endMatch = buffer.match(endPattern);

                    if (endMatch) {
                        resolved = true;
                        cleanup();
                        const endIndex = buffer.indexOf(endMatch[0]);
                        const startIndex = buffer.lastIndexOf(startMarker, endIndex);

                        let output = '';
                        if (startIndex !== -1) {
                            output = buffer.substring(startIndex + startMarker.length, endIndex).trim();
                        } else {
                            // Should not happen with ReplaySubject, but safe fallback
                            this.logger.warn(`[StreamCapture] Start marker missing but end marker found. Output truncated?`);
                            output = buffer.substring(0, endIndex).trim();
                        }

                        // Remove command echo
                        const lines = output.split('\n');
                        if (lines.length > 0 && lines[0].includes(startMarker.slice(0, 10))) {
                            lines.shift();
                            output = lines.join('\n').trim();
                        } else if (lines.length > 0 && lines[0].includes('&&')) { // Fallback check
                            lines.shift();
                            output = lines.join('\n').trim();
                        }

                        const exitCode = parseInt(endMatch[1], 10);
                        resolve({
                            success: exitCode === 0,
                            output,
                            exitCode
                        });
                    }
                },
                error: (err) => {
                    if (resolved) return;
                    resolved = true;
                    cleanup();
                    resolve({ success: false, output: '', error: `Stream error: ${err.message}` });
                }
            });
        });
    }
}
