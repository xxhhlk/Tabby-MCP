/**
 * MCP Tool definition interface
 */
export interface McpTool {
    name: string;
    description: string;
    schema: Record<string, any>;
    handler: (params: any, context: any) => Promise<any>;
}

/**
 * Tool category interface for grouping related tools
 */
export interface ToolCategory {
    name: string;
    mcpTools: McpTool[];
}

/**
 * Terminal session information
 */
export interface TerminalSession {
    id: number;
    title: string;
    type: string;
    isActive: boolean;
}

/**
 * Command execution result
 */
export interface CommandResult {
    success: boolean;
    output: string;
    exitCode?: number;
    error?: string;
    outputId?: string;
    totalLines?: number;
}

/**
 * Active command tracking
 */
export interface ActiveCommand {
    tabId: number;
    command: string;
    timestamp: number;
    startMarker: string;
    endMarker: string;
    abort: () => void;
}

/**
 * Command Security Configuration
 */
export interface CommandSecurityConfig {
    autoAllowReadCommands: boolean;      // Auto-allow read/query commands
    allowSudo: boolean;                   // Allow sudo commands to auto-execute
    allowPipes: boolean;                  // Allow pipe operations to auto-execute
    allowRedirects: boolean;              // Allow redirect operations to auto-execute
    allowCommandChains: boolean;          // Allow command chains (&& ||) to auto-execute
}

/**
 * MCP Configuration
 */
export interface McpConfig {
    port: number;
    host: string;
    enableLogging: boolean;
    startOnBoot: boolean;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    pairProgrammingMode: {
        enabled: boolean;
        showConfirmationDialog: boolean;
        autoFocusTerminal: boolean;
        autoAllowReadCommands?: boolean;      // Auto-allow read/query commands
        commandSecurity?: CommandSecurityConfig;  // Advanced security options
    };
    useStreamCapture?: boolean; // New experimental mode to fix output truncation
}

/**
 * Command history entry
 */
export interface CommandHistoryEntry {
    id: string;
    tabId: number;
    command: string;
    timestamp: number;
    status: 'running' | 'completed' | 'aborted' | 'error';
    output?: string;
    exitCode?: number;
}

/**
 * Log entry
 */
export interface LogEntry {
    timestamp: Date;
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    context?: any;
}

/**
 * Enhanced terminal session with stable ID and metadata
 */
export interface EnhancedTerminalSession {
    sessionId: string;       // Stable unique ID (UUID)
    tabIndex: number;        // Array index (may change if tabs are reordered)
    title: string;
    type: string;
    isActive: boolean;
    hasActiveCommand: boolean;
    profile?: {
        id: string;
        name: string;
        type: string;
    };
    pid?: number;            // Process ID if available
    cwd?: string;            // Current working directory if available
}

/**
 * Session locator for flexible session targeting
 * Priority: sessionId > tabId > tabIndex > title > profileName
 */
export interface SessionLocator {
    sessionId?: string;      // Stable session ID (recommended)
    tabId?: string;          // Stable tab ID (interchangeable with sessionId for terminal tabs)
    tabIndex?: number;       // Tab index (legacy, may change)
    title?: string;          // Match by title (partial, case-insensitive)
    profileName?: string;    // Match by profile name (partial, case-insensitive)
}

/**
 * SFTP file/directory information
 */
export interface SFTPFileInfo {
    name: string;
    path: string;
    isDirectory: boolean;
    size: number;
    modifiedTime: string;
    permissions: string;
}

/**
 * SFTP operation result
 */
export interface SFTPResult {
    success: boolean;
    message?: string;
    error?: string;
    files?: SFTPFileInfo[];
    localPath?: string;
    remotePath?: string;
}
