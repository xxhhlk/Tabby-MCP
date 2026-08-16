/**
 * Command Parser - Parses shell commands and extracts structure
 * Reference: Chaterm CommandParser implementation
 */

/**
 * Parsed command structure
 */
export interface ParsedCommand {
    /** Original command string */
    original: string;
    /** Main command (first word after sudo/doas) */
    mainCommand: string;
    /** Command arguments */
    arguments: string[];
    /** Whether sudo or doas is used */
    hasSudo: boolean;
    /** Whether pipe operator is present */
    hasPipes: boolean;
    /** Whether redirect operators are present */
    hasRedirects: boolean;
    /** Whether command chains (&& ||) are present */
    hasCommandChains: boolean;
    /** Commands in the pipe chain */
    subCommands: string[];
    /** Operators found in the command */
    operators: string[];
}

/**
 * Command Parser class
 * Parses shell commands to extract structure and detect dangerous operators
 */
export class CommandParser {
    /**
     * Parse a command string into structured format
     */
    parse(command: string): ParsedCommand {
        const result: ParsedCommand = {
            original: command,
            mainCommand: '',
            arguments: [],
            hasSudo: false,
            hasPipes: false,
            hasRedirects: false,
            hasCommandChains: false,
            subCommands: [],
            operators: [],
        };

        // Detect dangerous operators
        result.hasPipes = this.hasOperator(command, '|');
        result.hasRedirects = this.hasRedirectOperator(command);
        result.hasCommandChains = this.hasCommandChainOperator(command);

        // Collect operators
        if (result.hasPipes) result.operators.push('|');
        if (command.includes('>>')) result.operators.push('>>');
        else if (command.includes('>')) result.operators.push('>');
        if (command.includes('<')) result.operators.push('<');
        if (command.includes('&&')) result.operators.push('&&');
        if (command.includes('||')) result.operators.push('||');

        // Extract main command and arguments
        const tokens = this.tokenize(command);
        let commandTokens = [...tokens];

        // Check for sudo/doas
        if (commandTokens[0] === 'sudo' || commandTokens[0] === 'doas') {
            result.hasSudo = true;
            commandTokens = commandTokens.slice(1);
        }

        result.mainCommand = commandTokens[0] || '';
        result.arguments = commandTokens.slice(1);

        // Extract sub-commands from pipes
        if (result.hasPipes) {
            result.subCommands = this.extractPipeSubCommands(command);
        }

        return result;
    }

    /**
     * Tokenize command string, handling quotes
     */
    private tokenize(command: string): string[] {
        const tokens: string[] = [];
        let current = '';
        let inSingleQuote = false;
        let inDoubleQuote = false;
        let escaped = false;

        for (let i = 0; i < command.length; i++) {
            const char = command[i];

            if (escaped) {
                current += char;
                escaped = false;
                continue;
            }

            if (char === '\\') {
                escaped = true;
                continue;
            }

            if (char === "'" && !inDoubleQuote) {
                inSingleQuote = !inSingleQuote;
                continue;
            }

            if (char === '"' && !inSingleQuote) {
                inDoubleQuote = !inDoubleQuote;
                continue;
            }

            if (char === ' ' && !inSingleQuote && !inDoubleQuote) {
                if (current) {
                    tokens.push(current);
                    current = '';
                }
                continue;
            }

            current += char;
        }

        if (current) {
            tokens.push(current);
        }

        return tokens;
    }

    /**
     * Check if command contains a specific operator
     */
    private hasOperator(command: string, operator: string): boolean {
        // Simple check - may need refinement for edge cases
        // Avoid false positives for operators inside quotes
        const simplified = this.removeQuotedContent(command);
        return simplified.includes(operator);
    }

    /**
     * Check for redirect operators
     */
    private hasRedirectOperator(command: string): boolean {
        const simplified = this.removeQuotedContent(command);
        return /[<>]/.test(simplified);
    }

    /**
     * Check for command chain operators
     */
    private hasCommandChainOperator(command: string): boolean {
        const simplified = this.removeQuotedContent(command);
        return /&&|\|\|/.test(simplified);
    }

    /**
     * Remove quoted content for operator detection
     */
    private removeQuotedContent(command: string): string {
        let result = '';
        let inSingleQuote = false;
        let inDoubleQuote = false;
        let escaped = false;

        for (let i = 0; i < command.length; i++) {
            const char = command[i];

            if (escaped) {
                escaped = false;
                continue;
            }

            if (char === '\\') {
                escaped = true;
                continue;
            }

            if (char === "'" && !inDoubleQuote) {
                inSingleQuote = !inSingleQuote;
                continue;
            }

            if (char === '"' && !inSingleQuote) {
                inDoubleQuote = !inDoubleQuote;
                continue;
            }

            if (!inSingleQuote && !inDoubleQuote) {
                result += char;
            }
        }

        return result;
    }

    /**
     * Extract sub-commands from pipe chain
     */
    private extractPipeSubCommands(command: string): string[] {
        const simplified = this.removeQuotedContent(command);
        const parts: string[] = [];
        let current = '';
        let inSingleQuote = false;
        let inDoubleQuote = false;
        let escaped = false;

        for (let i = 0; i < command.length; i++) {
            const char = command[i];

            if (escaped) {
                current += char;
                escaped = false;
                continue;
            }

            if (char === '\\') {
                current += char;
                escaped = true;
                continue;
            }

            if (char === "'" && !inDoubleQuote) {
                inSingleQuote = !inSingleQuote;
                current += char;
                continue;
            }

            if (char === '"' && !inSingleQuote) {
                inDoubleQuote = !inDoubleQuote;
                current += char;
                continue;
            }

            if (char === '|' && !inSingleQuote && !inDoubleQuote) {
                if (current.trim()) {
                    parts.push(this.extractFirstCommand(current.trim()));
                }
                current = '';
                continue;
            }

            current += char;
        }

        if (current.trim()) {
            parts.push(this.extractFirstCommand(current.trim()));
        }

        return parts;
    }

    /**
     * Extract the first command from a command string
     */
    private extractFirstCommand(cmd: string): string {
        const tokens = this.tokenize(cmd);
        if (tokens.length === 0) return '';
        
        // Skip sudo/doas
        if (tokens[0] === 'sudo' || tokens[0] === 'doas') {
            return tokens[1] || '';
        }
        
        return tokens[0];
    }
}
