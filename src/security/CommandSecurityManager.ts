/**
 * Command Security Manager - Makes security decisions for commands
 * Reference: Chaterm CommandSecurityManager implementation
 */

import { CommandParser, ParsedCommand } from './CommandParser';
import {
    SAFE_COMMANDS,
    DANGEROUS_COMMANDS,
    SAFE_GIT_SUBCOMMANDS,
    DANGEROUS_GIT_SUBCOMMANDS,
    SAFE_KUBECTL_SUBCOMMANDS,
    DANGEROUS_KUBECTL_SUBCOMMANDS,
    SAFE_DOCKER_SUBCOMMANDS,
    DANGEROUS_DOCKER_SUBCOMMANDS,
    SAFE_COMMAND_ARGS,
    COMMANDS_WITH_SAFE_ARGS,
    CommandSecurityConfig,
} from './CommandSecurity';

/**
 * Security decision result
 */
export type SecurityDecision =
    | { action: 'allow'; reason: string }
    | { action: 'confirm'; reason: string }
    | { action: 'deny'; reason: string };

/**
 * Command Security Manager
 * Evaluates commands and determines if they should be allowed, confirmed, or denied
 */
export class CommandSecurityManager {
    private parser: CommandParser;

    constructor(private config: CommandSecurityConfig) {
        this.parser = new CommandParser();
    }

    /**
     * Update security configuration
     */
    updateConfig(config: CommandSecurityConfig): void {
        this.config = config;
    }

    /**
     * Evaluate a command and return security decision
     */
    evaluate(command: string): SecurityDecision {
        // If auto-allow is disabled, all commands need confirmation
        if (!this.config.autoAllowReadCommands) {
            return { action: 'confirm', reason: 'Auto-allow is disabled' };
        }

        const parsed = this.parser.parse(command);

        // 1. Check if main command is in dangerous list
        if (DANGEROUS_COMMANDS.has(parsed.mainCommand)) {
            // Special handling for commands with subcommands
            if (parsed.mainCommand === 'git') {
                return this.evaluateGitCommand(parsed);
            }
            if (parsed.mainCommand === 'kubectl') {
                return this.evaluateKubectlCommand(parsed);
            }
            if (parsed.mainCommand === 'docker') {
                return this.evaluateDockerCommand(parsed);
            }
            
            // Check if this dangerous command has safe arguments
            if (COMMANDS_WITH_SAFE_ARGS.has(parsed.mainCommand)) {
                const safeArgsResult = this.evaluateSafeArgs(parsed);
                if (safeArgsResult.action === 'allow') {
                    return safeArgsResult;
                }
                // If not all args are safe, fall through to confirm
            }
            
            return { action: 'confirm', reason: `Dangerous command: ${parsed.mainCommand}` };
        }

        // 2. Check sudo usage
        if (parsed.hasSudo && !this.config.allowSudo) {
            return { action: 'confirm', reason: 'sudo command requires confirmation' };
        }

        // 3. Check pipe operations
        if (parsed.hasPipes && !this.config.allowPipes) {
            return { action: 'confirm', reason: 'Pipe operation requires confirmation' };
        }

        // 4. Check redirect operations
        if (parsed.hasRedirects && !this.config.allowRedirects) {
            return { action: 'confirm', reason: 'Redirect operation requires confirmation' };
        }

        // 5. Check command chains
        if (parsed.hasCommandChains && !this.config.allowCommandChains) {
            return { action: 'confirm', reason: 'Command chain requires confirmation' };
        }

        // 6. Check all sub-commands in pipes
        if (parsed.hasPipes) {
            for (const subCmd of parsed.subCommands) {
                if (DANGEROUS_COMMANDS.has(subCmd)) {
                    return { action: 'confirm', reason: `Pipe contains dangerous command: ${subCmd}` };
                }
            }
        }

        // 7. Check if command is in safe list
        if (SAFE_COMMANDS.has(parsed.mainCommand)) {
            // Special handling for commands with subcommands
            if (parsed.mainCommand === 'git') {
                return this.evaluateGitCommand(parsed);
            }
            if (parsed.mainCommand === 'kubectl') {
                return this.evaluateKubectlCommand(parsed);
            }
            if (parsed.mainCommand === 'docker') {
                return this.evaluateDockerCommand(parsed);
            }
            return { action: 'allow', reason: 'Safe command' };
        }

        // 8. Unknown command - needs confirmation
        return { action: 'confirm', reason: 'Unknown command requires confirmation' };
    }

    /**
     * Evaluate git command based on subcommand
     */
    private evaluateGitCommand(parsed: ParsedCommand): SecurityDecision {
        const subCommand = parsed.arguments[0];

        if (!subCommand) {
            // git without subcommand
            return { action: 'allow', reason: 'Git command without subcommand' };
        }

        // Check if subcommand is dangerous
        if (DANGEROUS_GIT_SUBCOMMANDS.has(subCommand)) {
            return { action: 'confirm', reason: `Git ${subCommand} requires confirmation` };
        }

        // Check if subcommand is safe
        if (SAFE_GIT_SUBCOMMANDS.has(subCommand)) {
            return { action: 'allow', reason: `Git ${subCommand} is safe` };
        }

        // Unknown git subcommand - be conservative
        return { action: 'confirm', reason: `Unknown git subcommand: ${subCommand}` };
    }

    /**
     * Evaluate kubectl command based on subcommand
     */
    private evaluateKubectlCommand(parsed: ParsedCommand): SecurityDecision {
        const subCommand = parsed.arguments[0];

        if (!subCommand) {
            return { action: 'allow', reason: 'kubectl command without subcommand' };
        }

        if (DANGEROUS_KUBECTL_SUBCOMMANDS.has(subCommand)) {
            return { action: 'confirm', reason: `kubectl ${subCommand} requires confirmation` };
        }

        if (SAFE_KUBECTL_SUBCOMMANDS.has(subCommand)) {
            return { action: 'allow', reason: `kubectl ${subCommand} is safe` };
        }

        return { action: 'confirm', reason: `Unknown kubectl subcommand: ${subCommand}` };
    }

    /**
     * Evaluate docker command based on subcommand
     */
    private evaluateDockerCommand(parsed: ParsedCommand): SecurityDecision {
        const subCommand = parsed.arguments[0];

        if (!subCommand) {
            return { action: 'allow', reason: 'docker command without subcommand' };
        }

        if (DANGEROUS_DOCKER_SUBCOMMANDS.has(subCommand)) {
            return { action: 'confirm', reason: `docker ${subCommand} requires confirmation` };
        }

        if (SAFE_DOCKER_SUBCOMMANDS.has(subCommand)) {
            return { action: 'allow', reason: `docker ${subCommand} is safe` };
        }

        return { action: 'confirm', reason: `Unknown docker subcommand: ${subCommand}` };
    }

    /**
     * Evaluate dangerous command with safe arguments
     * Returns 'allow' if all arguments are in the safe list
     */
    private evaluateSafeArgs(parsed: ParsedCommand): SecurityDecision {
        const safeArgs = SAFE_COMMAND_ARGS[parsed.mainCommand];
        if (!safeArgs) {
            return { action: 'confirm', reason: `No safe args defined for ${parsed.mainCommand}` };
        }

        // Check if all arguments are in the safe list
        // Arguments can be flags (-L), options (--list), or subcommands (status)
        for (const arg of parsed.arguments) {
            // Skip option values (e.g., after -t or --table)
            if (arg.startsWith('-')) {
                // It's a flag or option
                if (!safeArgs.has(arg)) {
                    return { action: 'confirm', reason: `Unsafe argument: ${arg}` };
                }
            } else {
                // It could be a subcommand or option value
                // Check if it's a known safe arg
                if (!safeArgs.has(arg)) {
                    // Could be an option value, check previous arg
                    const prevArgIdx = parsed.arguments.indexOf(arg) - 1;
                    if (prevArgIdx >= 0) {
                        const prevArg = parsed.arguments[prevArgIdx];
                        // If previous arg is a safe option that takes a value, allow it
                        if (safeArgs.has(prevArg) && this.isOptionThatTakesValue(prevArg)) {
                            continue;
                        }
                    }
                    // Not a known safe arg or option value
                    return { action: 'confirm', reason: `Unsafe argument: ${arg}` };
                }
            }
        }

        return { action: 'allow', reason: `Safe arguments for ${parsed.mainCommand}` };
    }

    /**
     * Check if an option takes a value (e.g., -t, --table, -u, --unit)
     */
    private isOptionThatTakesValue(option: string): boolean {
        const optionsThatTakeValue = new Set([
            '-t', '--table',           // iptables
            '-u', '--unit',            // journalctl
            '-n', '--lines',           // journalctl
            '--since', '--until',      // journalctl
            '-p', '--priority',        // journalctl
            '-g', '--grep',            // journalctl
            '-b', '--boot',            // journalctl
            '-o', '--output',          // journalctl
            '--zone',                  // firewall-cmd
            '--type', '-t',            // systemctl
            '--state',                 // systemctl
            '-S', '--search',          // dpkg
            '-f', '--file',            // tar
            '-e', '--execute',         // mysql
            '-c', '--command',         // psql
        ]);
        return optionsThatTakeValue.has(option);
    }

    /**
     * Quick check if a command is safe (for logging/debugging)
     */
    isSafe(command: string): boolean {
        const decision = this.evaluate(command);
        return decision.action === 'allow';
    }

    /**
     * Get detailed analysis of a command (for debugging)
     */
    analyze(command: string): { parsed: ParsedCommand; decision: SecurityDecision } {
        const parsed = this.parser.parse(command);
        const decision = this.evaluate(command);
        return { parsed, decision };
    }
}
