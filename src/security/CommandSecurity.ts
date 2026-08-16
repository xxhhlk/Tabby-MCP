/**
 * Command Security Configuration
 * Defines safe commands, dangerous commands, and dangerous operators
 * Reference: Chaterm security implementation
 */

/**
 * Safe commands whitelist - automatically allowed without confirmation
 * These are read-only/query commands that don't modify the system
 */
export const SAFE_COMMANDS = new Set([
    // File/Directory viewing
    'ls', 'dir', 'll', 'la', 'l', 'lh', 'ltr',
    'cat', 'head', 'tail', 'less', 'more', 'bat', 'zcat',
    'file', 'stat', 'du', 'df', 'tree', 'find', 'locate',
    
    // Text viewing/search
    'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack',
    'sed', 'awk', 'wc', 'sort', 'uniq', 'cut', 'tr',
    'strings',
    
    // System information
    'pwd', 'whoami', 'who', 'w', 'id', 'groups',
    'uname', 'hostname', 'uptime', 'date', 'cal', 'time',
    'env', 'printenv', 'echo', 'printf', 'type',
    
    // Process/Resource viewing
    'ps', 'top', 'htop', 'btop', 'glances', 'atop',
    'free', 'vmstat', 'iostat', 'mpstat', 'lscpu',
    
    // Network (view only)
    'ping', 'traceroute', 'tracepath', 'mtr', 'nmap',
    'netstat', 'ss', 'ip', 'ifconfig', 'iwconfig',
    'curl', 'wget', 'httpie', 'http',
    'dig', 'nslookup', 'host', 'whois', 'nc', 'telnet',
    
    // Version/Help
    'version', 'help', 'man', 'info', 'tldr', 'whatis', 'apropos',
    
    // Git (needs subcommand check)
    'git',
    
    // JSON/YAML processing
    'jq', 'yq', 'xq', 'tomlq', 'jc',
    
    // Checksum/Encoding
    'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'b3sum',
    'base64', 'base32', 'xxd', 'od', 'hexdump',
    
    // Compare/Diff
    'diff', 'sdiff', 'vimdiff', 'colordiff', 'cmp',
    
    // Other safe commands
    'history', 'alias', 'which', 'whereis',
    'exa', 'fd', 'fzf', 'sk', 'fzy', 'peco',
    'lsd', 'broot', 'nnn', 'ranger',
    'cd', 'pushd', 'popd', 'dirs',
    
    // Kubernetes view commands (read-only)
    'kubectl',  // Needs subcommand check
    'helm',     // Needs subcommand check
    
    // Docker view commands
    'docker',   // Needs subcommand check
    
    // Very safe execution commands (no side effects)
    'sleep', 'true', 'false', 'yes', 'no', 'exit',
    'test', '[', '[[', 'expr', 'let',
    'seq', 'yes', 'printf', 'tee',  // tee is safe for viewing
    'watch', 'time',
    'xargs', 'parallel',  // depends on what's passed, but command itself is safe
    'logger', 'notify-send',
]);

/**
 * Dangerous commands blacklist - always require confirmation
 * These commands can modify or destroy the system
 */
export const DANGEROUS_COMMANDS = new Set([
    // File deletion
    'rm', 'rmdir', 'shred', 'wipe',
    
    // Disk operations
    'dd', 'mkfs', 'fdisk', 'parted', 'gparted', 'format',
    
    // Permission changes
    'chmod', 'chown', 'chgrp',
    
    // User management
    'useradd', 'userdel', 'usermod', 'passwd',
    'groupadd', 'groupdel', 'groupmod',
    
    // System control
    'shutdown', 'reboot', 'poweroff', 'halt', 'init',
    'systemctl', 'service', 'journalctl',
    
    // Process control
    'kill', 'pkill', 'killall', 'xkill',
    
    // Network firewall
    'iptables', 'ip6tables', 'ufw', 'firewall-cmd', 'nft',
    
    // Package managers
    'apt', 'apt-get', 'aptitude', 'dpkg',
    'yum', 'dnf', 'rpm', 'zypper',
    'pacman', 'yay', 'paru',
    'npm', 'yarn', 'pnpm', 'bower',
    'pip', 'pip3', 'conda', 'poetry',
    'cargo', 'gem', 'composer',
    'brew', 'choco', 'scoop',
    
    // Container/Orchestration (modify operations)
    'docker-compose',
    
    // Remote execution
    'ssh', 'scp', 'rsync', 'sftp',
    
    // Other dangerous commands
    'crontab', 'at', 'batch',
    'openssl', 'gpg',
    'mysql', 'psql', 'mongo', 'redis-cli',
    
    // File operations
    'mv', 'cp', 'mkdir', 'touch', 'ln',
    'tar', 'zip', 'unzip', 'gzip', 'gunzip',
    
    // Text editors (can modify files)
    'vi', 'vim', 'nvim', 'nano', 'emacs', 'ed',
    
    // Sudo/doas (privilege escalation)
    'sudo', 'doas', 'su',
]);

/**
 * Safe git subcommands - automatically allowed
 */
export const SAFE_GIT_SUBCOMMANDS = new Set([
    'status', 'log', 'diff', 'show', 'blame', 'annotate',
    'branch', 'tag', 'remote', 'stash',
    'ls-files', 'ls-tree', 'ls-remote',
    'reflog', 'rev-list', 'rev-parse',
    'describe', 'shortlog', 'name-rev',
    'config', 'var',
]);

/**
 * Dangerous git subcommands - require confirmation
 */
export const DANGEROUS_GIT_SUBCOMMANDS = new Set([
    'add', 'commit', 'push', 'pull', 'fetch',
    'merge', 'rebase', 'reset', 'checkout',
    'cherry-pick', 'revert', 'clean',
    'stash',  // stash push/pop
    'branch', // branch -d
    'tag',    // tag -d
    'remote', // remote add/rm
    'init', 'clone',
]);

/**
 * Safe kubectl subcommands - automatically allowed
 */
export const SAFE_KUBECTL_SUBCOMMANDS = new Set([
    'get', 'describe', 'logs', 'explain',
    'top', 'api-resources', 'api-versions',
    'cluster-info', 'version', 'config', 'options',
]);

/**
 * Dangerous kubectl subcommands - require confirmation
 */
export const DANGEROUS_KUBECTL_SUBCOMMANDS = new Set([
    'create', 'apply', 'delete', 'patch', 'replace',
    'edit', 'scale', 'rollout', 'exec', 'port-forward',
    'cp', 'run', 'expose', 'set',
]);

/**
 * Safe docker subcommands - automatically allowed
 */
export const SAFE_DOCKER_SUBCOMMANDS = new Set([
    'ps', 'images', 'logs', 'inspect', 'stats',
    'top', 'port', 'history', 'diff',
    'version', 'info', 'events',
]);

/**
 * Dangerous docker subcommands - require confirmation
 */
export const DANGEROUS_DOCKER_SUBCOMMANDS = new Set([
    'run', 'exec', 'build', 'push', 'pull',
    'rm', 'rmi', 'stop', 'kill', 'restart',
    'create', 'update', 'rename', 'pause', 'unpause',
    'commit', 'save', 'load', 'import', 'export',
    'network', 'volume', 'system',
]);

/**
 * Dangerous operators that may need special handling
 */
export const DANGEROUS_OPERATORS = {
    PIPE: '|',
    REDIRECT_OUT: '>',
    REDIRECT_APPEND: '>>',
    REDIRECT_IN: '<',
    AND: '&&',
    OR: '||',
    BACKGROUND: '&',
} as const;

/**
 * Safe arguments/flags for dangerous commands
 * These are read-only operations that don't modify the system
 * Key: command name, Value: Set of safe arguments/flags
 */
export const SAFE_COMMAND_ARGS: Record<string, Set<string>> = {
    // iptables - list/view rules only
    'iptables': new Set([
        '-L', '--list',           // List rules
        '-S', '--list-rules',     // List rules in exact format
        '-n', '--numeric',        // Numeric output (combined with -L)
        '-v', '--verbose',        // Verbose (combined with -L)
        '-x', '--exact',          // Exact numbers (combined with -L)
        '--line-numbers',         // Show line numbers
        '-t', '--table',          // Specify table (with list operations)
    ]),
    'ip6tables': new Set([
        '-L', '--list', '-S', '--list-rules',
        '-n', '--numeric', '-v', '--verbose',
        '-x', '--exact', '--line-numbers', '-t', '--table',
    ]),
    
    // systemctl - status/view only
    'systemctl': new Set([
        'status',                 // Show service status
        'list-units',             // List units
        'list-unit-files',        // List unit files
        'list-sockets',           // List sockets
        'list-timers',            // List timers
        'list-jobs',              // List jobs
        'list-dependencies',      // List dependencies
        'show',                   // Show properties
        'show-environment',       // Show environment
        'cat',                    // Cat unit file
        'is-active',              // Check if active
        'is-enabled',             // Check if enabled
        'is-failed',              // Check if failed
        'help',                   // Show help
        '--version',              // Version
        '--no-pager',             // No pager flag
        '--all', '-a',            // Show all (with list commands)
        '--type', '-t',           // Filter by type
        '--state',                // Filter by state
        '--plain',                // Plain output
    ]),
    
    // journalctl - read-only log viewing
    'journalctl': new Set([
        // All journalctl operations are read-only
        '-u', '--unit',           // Filter by unit
        '-f', '--follow',         // Follow (read-only)
        '-n', '--lines',          // Number of lines
        '--since', '--until',     // Time range
        '-p', '--priority',       // Priority filter
        '-g', '--grep',           // Grep pattern
        '-b', '--boot',           // Boot filter
        '-k', '--dmesg',          // Kernel messages
        '--no-pager',             // No pager
        '-o', '--output',         // Output format
        '--utc',                  // UTC time
        '--no-hostname',          // No hostname
        '-r', '--reverse',        // Reverse order
        '--disk-usage',           // Disk usage
        '--list-boots',           // List boots
        '--verify',               // Verify journal
    ]),
    
    // ufw - status only
    'ufw': new Set([
        'status',                 // Show status
        'app list',               // List app profiles
        'help',                   // Help
        '--version',              // Version
    ]),
    
    // firewall-cmd - list/view only
    'firewall-cmd': new Set([
        '--list-all',             // List all
        '--list-all-zones',       // List all zones
        '--list-services',        // List services
        '--list-ports',           // List ports
        '--list-interfaces',      // List interfaces
        '--list-sources',         // List sources
        '--list-rich-rules',      // List rich rules
        '--list-forward-ports',   // List forward ports
        '--get-zones',            // Get zones
        '--get-services',         // Get services
        '--get-icmptypes',        // Get ICMP types
        '--get-default-zone',     // Get default zone
        '--get-active-zones',     // Get active zones
        '--state',                // State
        '--version',              // Version
        '--help',                 // Help
        '--permanent',            // Permanent flag (with list commands)
        '--zone',                 // Zone flag (with list commands)
    ]),
    
    // nft - list only
    'nft': new Set([
        'list',                   // List rules
        'list ruleset',           // List all rules
        'list tables',            // List tables
        'list chain',             // List chain
        '-a', '--handle',         // Show handles
        '-s', '--stateless',      // Stateless output
        '-n', '--numeric',        // Numeric output
        '-y', '--numeric-protocol', // Numeric protocol
        '-p', '--numeric-priority', // Numeric priority
    ]),
    
    // crontab - list only
    'crontab': new Set([
        '-l', '--list',           // List crontab
    ]),
    
    // passwd - status only
    'passwd': new Set([
        '-S', '--status',         // Show password status
        '-s',                     // Short status
    ]),
    
    // kill - signal listing only
    'kill': new Set([
        '-l', '-L', '--list',     // List signals
    ]),
    'pkill': new Set([
        '-l', '--list',           // List signals
    ]),
    
    // Package managers - search/info only
    'apt': new Set([
        'list',                   // List packages
        'search',                 // Search packages
        'show',                   // Show package info
        'info',                   // Package info
        'policy',                 // Show policy
        'depends',                // Show dependencies
        'rdepends',               // Show reverse dependencies
        'cache',                  // Cache operations (read-only)
        'madison',                // Show available versions
        '--version',              // Version
        '-h', '--help',           // Help
        '--installed',            // Filter installed
        '--upgradable',           // Filter upgradable
        '-a', '--all-versions',   // All versions
    ]),
    'apt-get': new Set([
        'source',                 // Download source (read-only)
        'download',               // Download only (read-only)
        'changelog',              // View changelog
        '-s', '--simulate',       // Simulate (dry-run)
        '--print-uris',           // Print URIs
        '--version',              // Version
        '-h', '--help',           // Help
    ]),
    'dpkg': new Set([
        '-l', '--list',           // List packages
        '-L', '--listfiles',      // List files in package
        '-s', '--status',         // Package status
        '-S', '--search',         // Search file in packages
        '-I', '--info',           // Package info
        '-c', '--contents',       // Contents of deb
        '--audit',                // Audit
        '--yet-to-unpack',        // Not unpacked
        '--verify',               // Verify
        '--version',              // Version
        '-h', '--help',           // Help
    ]),
    'yum': new Set([
        'list',                   // List packages
        'search',                 // Search packages
        'info',                   // Package info
        'provides', 'whatprovides', // What provides file
        'deplist',                // Dependencies
        'repolist',               // List repos
        '--version',              // Version
        '-h', '--help',           // Help
    ]),
    'dnf': new Set([
        'list', 'search', 'info', 'provides', 'deplist', 'repolist',
        '--version', '-h', '--help',
    ]),
    'rpm': new Set([
        '-q', '--query',          // Query package
        '-qa', '--all',           // Query all
        '-qi', '--info',          // Package info
        '-ql', '--list',          // List files
        '-qc', '--configfiles',   // Config files
        '-qd', '--docfiles',      // Doc files
        '-qf', '--file',          // File owner
        '-qR', '--requires',      // Requires
        '--provides',             // Provides
        '--scripts',              // Scripts
        '--changelog',            // Changelog
        '--version',              // Version
        '-h', '--help',           // Help
    ]),
    'pacman': new Set([
        '-Q', '--query',          // Query local
        '-Qi', '--info',          // Package info
        '-Ql', '--list',          // List files
        '-Qo', '--owns',          // File owner
        '-Qs', '--search',        // Search local
        '-Si', '--info',          // Sync info
        '-Ss', '--search',        // Sync search
        '-Sl', '--list',          // Sync list
        '-F', '--files',          // File database
        '-Fl', '--list',          // File list
        '-Fy', '--refresh',       // Refresh file db
        '--version',              // Version
        '-h', '--help',           // Help
    ]),
    'npm': new Set([
        'list', 'ls',             // List packages
        'search', 's',            // Search packages
        'view', 'v', 'info', 'show', // View package info
        'outdated',               // Check outdated
        'doctor',                 // Run diagnostics
        'audit',                  // Security audit
        '--version',              // Version
        '-h', '--help',           // Help
    ]),
    'yarn': new Set([
        'list',                   // List packages
        'info',                   // Package info
        'outdated',               // Check outdated
        'why',                    // Why installed
        '--version',              // Version
        '-h', '--help',           // Help
    ]),
    'pnpm': new Set([
        'list', 'ls',             // List packages
        'search',                 // Search packages
        'info',                   // Package info
        'outdated',               // Check outdated
        'why',                    // Why installed
        '--version',              // Version
        '-h', '--help',           // Help
    ]),
    'pip': new Set([
        'list',                   // List packages
        'show',                   // Show package info
        'search',                 // Search packages
        'freeze',                 // Freeze requirements
        '--version',              // Version
        '-h', '--help',           // Help
    ]),
    'pip3': new Set([
        'list', 'show', 'search', 'freeze', '--version', '-h', '--help',
    ]),
    'conda': new Set([
        'list',                   // List packages
        'search',                 // Search packages
        'info',                   // Conda info
        '--version',              // Version
        '-h', '--help',           // Help
    ]),
    'cargo': new Set([
        'search',                 // Search crates
        'tree',                   // Dependency tree
        'outdated',               // Check outdated
        '--version', '-V',        // Version
        '-h', '--help',           // Help
    ]),
    'gem': new Set([
        'list',                   // List gems
        'search',                 // Search gems
        'info',                   // Gem info
        'query',                  // Query gems
        '--version',              // Version
        '-h', '--help',           // Help
    ]),
    'brew': new Set([
        'list', 'ls',             // List packages
        'search',                 // Search packages
        'info', 'abv',            // Package info
        'desc',                   // Package description
        'cat',                    // Show formula
        'options',                // Show options
        'deps',                   // Dependencies
        'uses',                   // Uses
        'outdated',               // Check outdated
        'doctor',                 // Diagnostics
        '--version',              // Version
        '-h', '--help',           // Help
    ]),
    
    // MySQL/PostgreSQL - query only (no INSERT/UPDATE/DELETE/DROP etc.)
    'mysql': new Set([
        '-e', '--execute',        // Execute (depends on query)
        '-V', '--version',        // Version
        '-h', '--help',           // Help
        '--print-defaults',       // Print defaults
    ]),
    'psql': new Set([
        '-l', '--list',           // List databases
        '-c', '--command',        // Command (depends on query)
        '-V', '--version',        // Version
        '-h', '--help',           // Help
    ]),
    
    // Redis - info only
    'redis-cli': new Set([
        'INFO', 'info',           // Server info
        'DBSIZE', 'dbsize',       // Database size
        'CLIENT', 'client',       // Client list/info
        'CONFIG', 'config',       // Config get
        'SLOWLOG', 'slowlog',     // Slow log
        'MONITOR', 'monitor',     // Monitor (read-only)
        '--version',              // Version
        '--help',                 // Help
    ]),
    
    // openssl - info/query only
    'openssl': new Set([
        'version',                // Version
        'list',                   // List algorithms
        'ciphers',                // List ciphers
        'x509', '-text', '-noout', // View certificate
        'rsa', '-text', '-noout', // View RSA key
        'ec', '-text', '-noout',  // View EC key
        'pkcs7', '-text', '-noout', // View PKCS7
        'pkcs12', '-info', '-noout', // View PKCS12
        's_client',               // SSL client (read-only)
        's_server',               // SSL server test
        'speed',                  // Speed test
        'help',                   // Help
    ]),
    
    // gpg - list/info only
    'gpg': new Set([
        '--list-keys', '-k',      // List public keys
        '--list-secret-keys', '-K', // List secret keys
        '--list-sigs',            // List signatures
        '--check-sigs',           // Check signatures
        '--fingerprint',          // Show fingerprint
        '--list-packets',         // List packets
        '--verify',               // Verify signature
        '--version',              // Version
        '--help',                 // Help
        '--list-config',          // List config
    ]),
    
    // tar - list only
    'tar': new Set([
        '-t', '--list',           // List archive contents
        '-v', '--verbose',        // Verbose (with list)
        '-z', '-j', '-J',         // Compression flags (with list)
        '-f', '--file',           // Archive file (with list)
        '--version',              // Version
        '--help',                 // Help
    ]),
    
    // unzip - list only
    'unzip': new Set([
        '-l',                     // List contents
        '-v',                     // Verbose list
        '-Z',                     // Zipinfo mode
        '-h',                     // Help
    ]),
    
    // service - status only
    'service': new Set([
        'status',                 // Service status
        '--status-all',           // All services status
        '--version',              // Version
        '--help',                 // Help
    ]),
    
    // docker-compose - ps/logs only
    'docker-compose': new Set([
        'ps',                     // List containers
        'logs',                   // View logs
        'config',                 // Validate/view config
        'images',                 // List images
        'top',                    // Top processes
        'port',                   // Print port
        'version',                // Version
        '--help', '-h',           // Help
    ]),
};

/**
 * Commands that have safe args but need special handling
 * These commands are in DANGEROUS_COMMANDS but have some safe operations
 */
export const COMMANDS_WITH_SAFE_ARGS = new Set(Object.keys(SAFE_COMMAND_ARGS));

/**
 * Security configuration interface
 */
export interface CommandSecurityConfig {
    autoAllowReadCommands: boolean;
    allowSudo: boolean;
    allowPipes: boolean;
    allowRedirects: boolean;
    allowCommandChains: boolean;
}
