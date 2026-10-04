#!/usr/bin/env node

/**
 * Static smoke checks for the Tabby MCP plugin.
 *
 * Ported from upstream v1.7.1 with two deliberate adaptations for this fork:
 *  1. send_input approval goes through the local CommandSecurityManager instead
 *     of upstream's pairProgrammingMode-only gate, so the assertion checks for
 *     the CSM wiring rather than for JSON.stringify(processedInput).
 *  2. Dependencies are managed with pnpm (pnpm-lock.yaml), not npm
 *     (package-lock.json), so the lockfile assertion reads the pnpm lockfile.
 *  3. The Host and Origin header guards (upstream's DNS-rebinding protection)
 *     were deliberately removed, so the assertions below assert their absence
 *     instead of their presence. The loopback bind is the remaining control.
 *  4. PowerShell support (CR to submit, the Invoke-Expression wrapper, the PS
 *     branch of detectShellType) is fork-only - upstream has none of it - so a
 *     dedicated check guards it against being dropped by a merge or by running
 *     a registry build.
 *
 * Everything else matches upstream, including the tool-count assertion, which
 * doubles as a sentinel for accidentally unregistered tools.
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function testToolCount() {
    const files = [
        'src/tools/terminal.ts',
        'src/tools/tabManagement.ts',
        'src/tools/sftp.ts'
    ];
    const counts = files.map(file => (read(file).match(/this\.registerTool\(/g) || []).length);
    assert.deepEqual(counts, [9, 15, 12], 'Unexpected tool count per category');
    assert.equal(counts.reduce((sum, count) => sum + count, 0), 36, 'Expected 36 registered MCP tools');
}

function testNoBlockingBrowserDialogs() {
    const sourceFiles = [
        'src/components/mcpSettingsTab.component.ts',
        'src/services/dialog.service.ts',
        'src/tools/terminal.ts',
        'src/tools/sftp.ts'
    ];
    for (const file of sourceFiles) {
        const executableLines = read(file)
            .split('\n')
            .filter(line => {
                const trimmed = line.trimStart();
                return !trimmed.startsWith('//') && !trimmed.startsWith('*');
            })
            .join('\n');
        assert.equal(/\bconfirm\s*\(/.test(executableLines), false, `${file} must not use native confirm()`);
        assert.equal(/\balert\s*\(/.test(executableLines), false, `${file} must not use native alert()`);
    }
}

function testLegacySseParsedBody() {
    const source = read('src/services/mcpService.ts');
    assert.match(
        source,
        /handlePostMessage\(req,\s*res,\s*req\.body\)/,
        'Legacy SSE must pass the body already parsed by express.json()'
    );
    assert.match(source, /listen\(serverPort,\s*'127\.0\.0\.1'/, 'Server must bind to loopback only');
    assert.equal(source.includes('checkOrigin'), false, 'Origin header validation must stay removed (fork)');
    assert.equal(source.includes('isValidOrigin'), false, 'Origin validation helper must stay removed (fork)');
}

function testTransportAndLifecycleGuards() {
    const source = read('src/services/mcpService.ts');
    assert.match(
        source,
        /req\.method === 'GET' \|\| req\.method === 'DELETE'[\s\S]*transport\.handleRequest\(req, res\)/,
        'Streamable HTTP GET and DELETE must be delegated to the SDK transport'
    );
    assert.equal(source.includes('checkHost'), false, 'Host header validation must stay removed (fork)');
    assert.equal(source.includes('Invalid host'), false, 'Host rejection response must stay removed (fork)');
    assert.match(source, /private startPromise\?: Promise<void>/, 'Concurrent starts must share one pending promise');
    assert.match(source, /private lifecycleGeneration = 0/, 'Stop must be able to cancel an in-flight start');
}

function testApprovalAndCancellationGuards() {
    const dialog = read('src/services/dialog.service.ts');
    assert.equal(dialog.includes('preview.slice(0, 2000)'), false, 'Approval previews must not hide payload suffixes');
    assert.match(dialog, /requestOsAttention\(\)/, 'Approval dialogs must request OS attention when shown in the background');
    assert.match(dialog, /flashFrame/, 'Windows/Linux attention must use Tabby flashFrame');
    assert.match(dialog, /bounce\('critical'\)/, 'macOS attention must bounce the Dock until focused');
    assert.match(dialog, /bringToFront\(\)/, 'Windows/Linux must bring the window forward for pending approval');
    assert.match(dialog, /Platform\.macOS/, 'macOS must not steal focus when requesting Dock attention');

    const terminal = read('src/tools/terminal.ts');
    const sendInput = terminal.slice(
        terminal.indexOf("name: 'send_input'"),
        terminal.indexOf("name: 'submit_keyboard_interactive_response'")
    );
    assert.equal(sendInput.includes('confirmFileOperations'), false, 'send_input approval must not depend on the SFTP confirmation option');
    // Fork-specific: the CommandSecurityManager is the single decision maker for
    // raw terminal input; upstream instead previewed JSON.stringify(processedInput).
    assert.match(sendInput, /securityManager\.evaluate\(commandText\)/, 'send_input must be judged by the CommandSecurityManager');
    assert.match(sendInput, /showCommandConfirmation\(/, 'send_input must ask for confirmation when the CSM says so');
    assert.match(sendInput, /extractSubmittedCommandLine\(/, 'send_input must judge only the submitted command line');
    const keyboardInteractive = terminal.slice(
        terminal.indexOf("name: 'submit_keyboard_interactive_response'"),
        terminal.indexOf('private parseEnvironmentFromBuffer')
    );
    assert.match(
        keyboardInteractive,
        /showOperationConfirmation\([\s\S]*'submit_keyboard_interactive_response'/,
        'keyboard-interactive authentication must require Pair Programming confirmation'
    );
    assert.match(
        keyboardInteractive,
        /`\$\{providedResponses\.length\} keyboard-interactive response\(s\)`/,
        'keyboard-interactive confirmation must show only the response count'
    );
    assert.equal(
        keyboardInteractive.includes('submit:'),
        false,
        'keyboard-interactive responses must not remain staged without submission'
    );
    assert.equal(/else; printf 'shell'; end; end/.test(terminal), false, 'fish probe must close its if chain exactly once');

    const sftp = read('src/tools/sftp.ts');
    assert.match(sftp, /cancelRequested: boolean/, 'Transfers must retain cancellation requested during setup');
    assert.equal(sftp.includes('sftpSession.end()'), false, 'Cancelling one transfer must not close the shared SFTP session');
}

function testTranslations() {
    const en = JSON.parse(read('src/i18n/en-US.json'));
    const zh = JSON.parse(read('src/i18n/zh-CN.json'));
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'English and Chinese translation keys must match');

    const translatedSources = [
        read('src/components/mcpSettingsTab.component.ts'),
        read('src/services/dialog.service.ts')
    ].join('\n');
    const usedKeys = new Set(Array.from(translatedSources.matchAll(/\bt\('([^']+)'/g), match => match[1]));
    for (const key of usedKeys) {
        assert.ok(en[key], `Missing English translation: ${key}`);
        assert.ok(zh[key], `Missing Chinese translation: ${key}`);
    }

    const i18nService = read('src/services/i18n.service.ts');
    assert.match(
        i18nService,
        /config\.store\?\.language/,
        'i18n initialization must tolerate ConfigService.store not being ready yet'
    );
}

function testPinnedSdkAndLockfile() {
    const packageJson = JSON.parse(read('package.json'));
    assert.equal(packageJson.devDependencies['@modelcontextprotocol/sdk'], '1.25.2', 'MCP SDK must be pinned');

    // This fork uses pnpm, so the lockfile is pnpm-lock.yaml (no package-lock.json).
    const lockfile = read('pnpm-lock.yaml');
    assert.match(
        lockfile,
        /'@modelcontextprotocol\/sdk':\n\s+specifier: 1\.25\.2\b/,
        'Lockfile specifier must match the pinned MCP SDK version'
    );
    assert.match(
        lockfile,
        /'@modelcontextprotocol\/sdk@1\.25\.2[(']/,
        'Lockfile must resolve the pinned MCP SDK version'
    );

    assert.ok(packageJson.files.includes('scripts/stdio-bridge.js'), 'The published package must include the STDIO bridge');
}

function testBridgeSyntax() {
    new vm.Script(read('scripts/stdio-bridge.js'), { filename: 'scripts/stdio-bridge.js' });
}

/**
 * The whole PowerShell support is fork-only (upstream 1.6.2 and 1.7.1 have no
 * PS branch at all), and it silently disappears whenever the plugin is
 * reinstalled from the npm registry - which is exactly how the "PowerShell
 * commands never run" bug came back once already. These assertions are the
 * reverse of that: they fail loudly if a merge or a re-port drops any of it.
 */
function testPowerShellSupport() {
    const terminal = read('src/tools/terminal.ts');
    const wrapper = terminal.slice(
        terminal.indexOf('private getWrappedCommand('),
        terminal.indexOf('private findSessionByLocator(')
    );

    assert.match(wrapper, /case 'powershell':/, 'The shell-aware wrapper must keep a PowerShell branch');
    assert.match(
        wrapper,
        /Invoke-Expression/,
        'PowerShell commands must be wrapped in Invoke-Expression (no && / eval on PS 5.1)'
    );
    assert.match(
        wrapper,
        /Invoke-Expression '\$\{psEscaped\}; \$mcp_ok = \$\?';/,
        'The PS wrapper must capture $? INSIDE the payload: Invoke-Expression masks it once it returns'
    );
    assert.equal(
        /Invoke-Expression '\$\{psEscaped\}'; \$mcp_ok = \$\?;/.test(wrapper),
        false,
        'The PS wrapper must not snapshot $? after Invoke-Expression returns (it is always True there)'
    );
    assert.match(
        wrapper,
        /\$mcp_ok = \$true;/,
        'The PS wrapper must pre-seed $mcp_ok so a trailing #comment in the command cannot leave it unset'
    );
    assert.equal(
        /elseif \(-not \$\?\)/.test(wrapper),
        false,
        'The PS wrapper must not read $? after a condition has been evaluated'
    );
    assert.match(
        terminal,
        /if \(shell === 'powershell'\) \{\s*\n\s*return \{ environment: 'powershell', isShell: true \};/,
        'The active environment probe must short-circuit on PowerShell instead of typing a POSIX probe'
    );
    assert.match(
        terminal,
        /return process\.platform === 'win32' \? '\\r' : '\\n'/,
        'Enter must be CR on Windows (ConPTY) and LF elsewhere'
    );
    assert.match(
        terminal,
        /const COMMAND_PREFIX = ' {4}';/,
        'Commands and readiness probes must share the 4-space first-byte guard'
    );
    assert.match(
        terminal,
        /\/PS \[A-Za-z\]:\\\\\//,
        'detectShellType must keep its PowerShell prompt pattern'
    );
}

const tests = [
    ['tool count', testToolCount],
    ['non-blocking dialogs', testNoBlockingBrowserDialogs],
    ['legacy SSE parsed body', testLegacySseParsedBody],
    ['transport and lifecycle guards', testTransportAndLifecycleGuards],
    ['approval and cancellation guards', testApprovalAndCancellationGuards],
    ['translation parity', testTranslations],
    ['pinned MCP SDK', testPinnedSdkAndLockfile],
    ['stdio bridge syntax', testBridgeSyntax],
    ['PowerShell support', testPowerShellSupport]
];

// Run every check before reporting, so one failure does not hide the rest
// (upstream stops at the first failure, which makes a broken gate harder to read).
const failures = [];
for (const [name, test] of tests) {
    try {
        test();
        process.stdout.write(`✓ ${name}\n`);
    } catch (error) {
        failures.push({ name, error });
        process.stdout.write(`✗ ${name}\n`);
    }
}

if (failures.length > 0) {
    process.stdout.write(`\n${failures.length} of ${tests.length} smoke checks failed:\n`);
    for (const { name, error } of failures) {
        process.stdout.write(`\n✗ ${name}\n  ${error.message}\n`);
    }
    process.exitCode = 1;
} else {
    process.stdout.write(`All ${tests.length} smoke checks passed.\n`);
}
