import * as vscode from 'vscode';

/**
 * Minimal logger that writes structured levels to a VS Code output channel.
 */
export class Logger {
	private outputChannel: vscode.OutputChannel;

	/**
	 * Creates an instance of the Logger.
	 *
	 * @param {vscode.OutputChannel} outputChannel - The output channel where log messages will be written.
	 */
	constructor(outputChannel: vscode.OutputChannel) {
		this.outputChannel = outputChannel;
	}

	/**
	 * Logs an informational message.
	 *
	 * @param {string} message - The message to log.
	 */
	info(message: string) {
		this.outputChannel.appendLine(`[INFO] ${message}`);
	}

	/**
	 * Logs a debug message.
	 *
	 * @param {string} message - The debug message to log.
	 */
	debug(message: string) {
		this.outputChannel.appendLine(`[DEBUG] ${message}`);
	}

	/**
	 * Logs a warning message.
	 *
	 * @param {string} message - The warning message to log.
	 */
	warning(message: string) {
		this.outputChannel.appendLine(`[WARNING] ${message}`);
	}

	/**
	 * Logs an error message.
	 *
	 * @param {string} message - The error message to log.
	 */
	error(message: string) {
		this.outputChannel.appendLine(`[ERROR] ${message}`);
	}

	/**
	 * Creates a scoped logger that automatically prefixes messages with the provided scope.
	 *
	 * @param {string} scope - Scope label added in front of every message.
	 * @returns {ScopedLogger} Logger instance that prefixes each log entry.
	 */
	withScope(scope: string): ScopedLogger {
		return new ScopedLogger(this, scope);
	}
}

/**
 * Logger wrapper that prefixes every message with a contextual scope.
 */
export class ScopedLogger {
	private readonly base: Logger;
	private readonly scope: string;

	constructor(base: Logger, scope: string) {
		this.base = base;
		this.scope = scope;
	}

	private format(message: string): string {
		return `[${this.scope}] ${message}`;
	}

	info(message: string) {
		this.base.info(this.format(message));
	}

	debug(message: string) {
		this.base.debug(this.format(message));
	}

	warning(message: string) {
		this.base.warning(this.format(message));
	}

	error(message: string) {
		this.base.error(this.format(message));
	}

	/**
	 * Creates a child scope nested under the current scope.
	 *
	 * @param {string} scope - Additional scope descriptor appended after a slash.
	 * @returns {ScopedLogger} Nested scoped logger.
	 */
	withScope(scope: string): ScopedLogger {
		const nestedScope = `${this.scope}/${scope}`;
		return new ScopedLogger(this.base, nestedScope);
	}
}

/**
 * Creates a new instance of the Logger.
 *
 * This function initializes a `Logger` using a specified VS Code output channel.
 *
 * @param {vscode.OutputChannel} outputChannel - The output channel where log messages will be written.
 * @returns {Logger} - An instance of the Logger class.
 */
export function createLogger(outputChannel: vscode.OutputChannel): Logger {
	return new Logger(outputChannel);
}
