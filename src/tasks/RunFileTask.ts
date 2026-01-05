/**
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License", destination); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import { Logger, ScopedLogger } from '../logger/logger';
import { ShellExecution, TaskScope, workspace } from 'vscode';
import { TestRunner } from './TestRunnerTask';
import { TestRunResult } from '../utils/testRunner';
import { parseTestOutputForFailures, ParsedFailure, classifyFailure } from '../utils/testFailureParser';
import { askChatGPT } from '../utils/openAiUtils';
import { getFixFailingTestPrompt, getFixRuntimeFailurePrompt } from '../utils/prompts';

/**
 * Task for running a single test file within the workspace.
 *
 * This task executes a specified test file by converting its TypeScript path to the
 * corresponding JavaScript file in the output folder. It retrieves necessary configurations
 * and constructs the appropriate command for execution using `extest`.
 */
export class RunFileTask extends TestRunner {
	private command: string;
	private args: string[];
	private cwd: string;
	private finalPath: string;
	private readonly scopeLabel = 'RunFileTask';

	/**
	 * Creates an instance of the `RunFileTask`.
	 *
	 * This constructor retrieves configurations, transforms the file path to match the
	 * compiled output location, and sets up the shell execution command.
	 *
	 * @param {string} file - The absolute path of the test file to be executed.
	 * @param {Logger} logger - The logger instance for logging messages.
	 */
	constructor(file: string, logger: Logger) {
		const scopeLog = logger.withScope('RunFileTask');
		const configuration = workspace.getConfiguration('extesterRunner');
		const workspaceFolder = workspace.workspaceFolders?.[0]?.uri.fsPath;

		if (!workspaceFolder) {
			scopeLog.error('No workspace folder found.');
			vscode.window.showErrorMessage('No workspace folder is open. Please open a folder before running tests.');
			throw new Error('No workspace folder found.');
		}

		// Get configuration values.
		const outputFolder = configuration.get<string>('outputFolder') ?? 'out';
		const rootFolder = configuration.get<string>('rootFolder');
		const tempDirSettings = configuration.get<string>('tempFolder');
		scopeLog.info(`Configuration -> outputFolder=${outputFolder}, rootFolder=${rootFolder}, tempDir=${tempDirSettings}`);

		// Convert file path to relative path.
		const filePath = path.resolve(file);
		const relativePath = path.relative(workspaceFolder, filePath);

		// Split paths into segments.
		const outputSegments = outputFolder.split(/[/\\]/).filter(Boolean);
		const rootSegments = rootFolder ? rootFolder.split(/[/\\]/).filter(Boolean) : [];
		const relativeSegments = relativePath.split(/[/\\]/).filter(Boolean);
		scopeLog.debug(
			`Path segments - Output: ${JSON.stringify(outputSegments)}, Root: ${JSON.stringify(rootSegments)}, Relative: ${JSON.stringify(relativeSegments)}`,
		);

		// Find matching segments between root and relative paths.
		const matchingSegmentsCount =
			rootSegments.length > 0 ? rootSegments.reduce((count, segment, i) => (relativeSegments[i] === segment ? count + 1 : count), 0) : 0;

		// Build final path for test execution.
		const finalPath = path.join(
			workspaceFolder,
			outputFolder,
			...relativeSegments.slice(matchingSegmentsCount).map((segment) => (segment.endsWith('.ts') ? segment.replace(/\.ts$/, '.js') : segment)),
		);
		scopeLog.debug(`Computed compiled test path: ${finalPath}`);

		// Prepare command arguments.
		const storageArgs = tempDirSettings && tempDirSettings.trim().length > 0 ? ['--storage', `'${tempDirSettings}'`] : [];
		const visualStudioCodeVersion = configuration.get<string>('visualStudioCode.Version');
		const versionArgs = visualStudioCodeVersion ? ['--code_version', visualStudioCodeVersion] : [];
		const visualStudioCodeType = configuration.get<string>('visualStudioCode.Type');
		const typeArgs = visualStudioCodeType ? ['--type', visualStudioCodeType] : [];
		const additionalArgs = configuration.get<string[]>('additionalArgs', []) ?? [];
		const processedArgs = additionalArgs.flatMap((arg) => arg.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []);

		// Create and execute shell command.
		const command = 'npx';
		const args = ['extest', 'setup-and-run', `'${finalPath}'`, ...storageArgs, ...versionArgs, ...typeArgs, ...processedArgs];
		const shellExecution = new ShellExecution(command, args);

		const commandString = `npx extest setup-and-run '${finalPath}' ${storageArgs.join(' ')} ${versionArgs.join(' ')} ${typeArgs.join(' ')} ${additionalArgs.join(' ')}`;
		scopeLog.info(`Configured command: ${commandString}`);

		super(TaskScope.Workspace, 'Run Test File', shellExecution, logger);

		// Store command details for direct execution after super() call
		this.command = command;
		this.args = args;
		this.cwd = workspaceFolder;
		this.finalPath = finalPath;
	}

	private getLog(scope?: string): ScopedLogger {
		const base = this.logger.withScope(this.scopeLabel);
		return scope ? base.withScope(scope) : base;
	}

	/**
	 * Executes the test file using VS Code terminal with output capture.
	 * This method creates a terminal, runs the command with tee to both show output
	 * in the terminal AND capture it to a file for parsing.
	 *
	 * @returns {Promise<TestRunResult>} The test execution result with captured output.
	 */
	public async executeWithOutputCapture(): Promise<TestRunResult> {
		const log = this.getLog('executeWithOutputCapture');
		log.info(`Starting VS Code terminal execution for ${this.label}`);
		log.debug(`Command: ${this.command} ${this.args.join(' ')}`);
		log.debug(`CWD: ${this.cwd}`);

		// Create a unique result file for this test execution
		const resultFile = path.join(this.cwd, `.test-results-${Date.now()}.txt`);
		log.info(`Capturing terminal output to ${resultFile}`);

		// Base delay before we start looking for the result file.
		// Some ExTester runs need time to spin up VS Code / download artifacts.
		const initialDelayMs = 30000;
		// Additional time window during which we actively poll for the file to appear.
		const maxAdditionalWaitMs = 60000;
		const pollIntervalMs = 1000;

		return new Promise((resolve) => {
			// Create a terminal for this execution
			const terminal = vscode.window.createTerminal({
				name: `Test Execution - ${this.label}`,
				cwd: this.cwd,
				hideFromUser: false, // Show the terminal to user
			});

			// Build the full command with tee (shows in terminal AND saves to file)
			const fullCommand = `${this.command} ${this.args.join(' ')} 2>&1 | tee "${resultFile}"`;
			log.info(`Executing command via terminal: ${fullCommand}`);

			// Execute the command in the terminal
			terminal.sendText(fullCommand);

			// Wait for completion with a timeout and dynamic polling for the result file
			setTimeout(async () => {
				try {
					// Read the result file
					let stdout = '';
					let stderr = '';

					try {
						// Dynamically wait for the result file to appear. In some environments the
						// test process can run longer than the base delay, so we poll for a while
						// instead of assuming the file already exists.
						if (!fs.existsSync(resultFile)) {
							const waitStart = Date.now();
							while (!fs.existsSync(resultFile) && Date.now() - waitStart < maxAdditionalWaitMs) {
								log.debug(`Result file not found yet, waiting... (${resultFile})`);
								await new Promise((resolveDelay) => setTimeout(resolveDelay, pollIntervalMs));
							}
						}

						if (fs.existsSync(resultFile)) {
							const resultContent = fs.readFileSync(resultFile, 'utf8');
							stdout = resultContent;
							log.debug(`Captured output: ${resultContent}`);
							log.info(`Result file saved at: ${resultFile}`);

							// Keep the result file for analysis - don't delete it
							// fs.unlinkSync(resultFile); // Commented out to keep the file
						} else {
							log.warning(`Result file not found after waiting ${initialDelayMs + maxAdditionalWaitMs}ms: ${resultFile}`);
						}
					} catch (fileError) {
						log.error(`Failed to read result file: ${fileError}`);
						stderr = `Failed to read result file: ${fileError}`;
					}

					// Parse test results from the captured output
					const combinedOutput = `${stdout}\n${stderr}`;
					const hasTestFailures = this.parseTestResults(combinedOutput);

					// Test is successful only if no test failures were detected
					const success = !hasTestFailures;

					log.info('Terminal execution completed');
					log.info(`Test failures detected: ${hasTestFailures}`);
					log.debug(`STDOUT: ${stdout}`);
					log.debug(`STDERR: ${stderr}`);

					// Send warning to terminal if failures are found
					if (hasTestFailures) {
						const warningMessage = `
						echo ""
						echo "🚨 ================================================ 🚨"
						echo "🚨           TEST FAILURES DETECTED!              🚨"
						echo "🚨 ================================================ 🚨"
						echo ""
						echo "❌ The test execution found failures that need attention."
						echo "🔍 Check the output above for details about what went wrong."
						echo "🔧 The system will attempt to automatically fix these issues."
						echo ""
						echo "📁 Full test output saved to: ${resultFile}"
						echo ""
						echo "🚨 ================================================ 🚨"
						echo ""
						`;
						terminal.sendText(warningMessage);

						// Attempt to fix test failures using AI
						try {
							const progressMessage = `
							echo ""
							echo "🤖 ================================================ 🤖"
							echo "🤖           AI FIXING IN PROGRESS...              🤖"
							echo "🤖 ================================================ 🤖"
							echo ""
							echo "🔍 Analyzing test failures..."
							echo "🧠 Generating AI-powered fixes..."
							echo "⏳ This may take a moment..."
							echo ""
							echo "🤖 ================================================ 🤖"
							echo ""
							`;
							terminal.sendText(progressMessage);

							await this.attemptAIFix(combinedOutput, resultFile);
							log.info('AI remediation completed successfully');

							const successMessage = `
							echo ""
							echo "✅ ================================================ ✅"
							echo "✅           AI FIXING COMPLETED!                  ✅"
							echo "✅ ================================================ ✅"
							echo ""
							echo "🎉 AI has fixed the test failures in the original files."
							echo "🔄 Your test files have been updated with AI-generated fixes."
							echo "🧪 You may want to re-run the tests to verify the fixes work."
							echo ""
							echo "✅ ================================================ ✅"
							echo ""
							`;
							terminal.sendText(successMessage);
						} catch (error) {
							log.error(`AI fix attempt failed: ${error}`);
							const errorMessage = `
							echo ""
							echo "❌ ================================================ ❌"
							echo "❌           AI FIXING FAILED!                     ❌"
							echo "❌ ================================================ ❌"
							echo ""
							echo "❌ AI fix attempt failed: ${error}"
							echo "🔧 Manual intervention may be required."
							echo "📋 Check the logs for more details."
							echo ""
							echo "❌ ================================================ ❌"
							echo ""
							`;
							terminal.sendText(errorMessage);
						}
					} else {
						const successMessage = `
						echo ""
						echo "✅ ================================================ ✅"
						echo "✅              ALL TESTS PASSED!                  ✅"
						echo "✅ ================================================ ✅"
						echo ""
						echo "🎉 Great! No test failures were detected."
						echo "✨ The test execution completed successfully."
						echo ""
						echo "📁 Full test output saved to: ${resultFile}"
						echo ""
						echo "✅ ================================================ ✅"
						echo ""
						`;
						terminal.sendText(successMessage);
					}

					// Wait a moment for the warning/success message to be displayed
					setTimeout(() => {
						// Dispose the terminal
						terminal.dispose();
					}, 2000);

					resolve({
						success,
						exitCode: success ? 0 : 1,
						stdout,
						stderr,
						command: `${this.command} ${this.args.join(' ')}`,
						cwd: this.cwd,
					});
				} catch (error) {
					log.error(`Failed to process terminal results: ${error}`);
					terminal.dispose();

					// Keep result file for analysis - no cleanup needed

					resolve({
						success: false,
						exitCode: 1,
						stdout: '',
						stderr: error instanceof Error ? error.message : String(error),
						command: `${this.command} ${this.args.join(' ')}`,
						cwd: this.cwd,
					});
				}
			}, 30000); // 30 second timeout
		});
	}

	/**
	 * Parses test output to detect test failures.
	 * Looks for common patterns that indicate test failures in the output.
	 *
	 * @param {string} output - The combined stdout and stderr output from the test execution.
	 * @returns {boolean} True if test failures were detected, false otherwise.
	 */
	private parseTestResults(output: string): boolean {
		const log = this.getLog('parseTestResults');
		// Look for common test failure patterns
		const failurePatterns = [
			/\d+\s+failing/, // "1 failing"
			/\d+\s+passing.*\d+\s+failing/, // "0 passing (10s)\n1 failing"
			/AssertionError:/, // "AssertionError: ..."
			/Error:/, // "Error: ..."
			/FAILED/, // "FAILED"
			/FAIL/, // "FAIL"
			/Test failed/, // "Test failed"
			/Test failure/, // "Test failure"
			/Expected.*but got/, // "Expected 'x' but got 'y'"
			/Expected.*to include/, // "Expected 'x' to include 'y'"
			/Expected.*to be/, // "Expected 'x' to be 'y'"
		];

		for (const pattern of failurePatterns) {
			if (pattern.test(output)) {
				log.debug(`Detected failure pattern: ${pattern}`);
				return true;
			}
		}

		// Also check for success patterns to ensure we're not missing anything
		const successPatterns = [
			/\d+\s+passing.*\d+\s+failing/, // This should be treated as failure
			/All tests passed/, // "All tests passed"
			/✓.*tests? passed/, // "✓ 5 tests passed"
		];

		// If we see only success patterns and no failure patterns, it's a success
		const hasSuccessPattern = successPatterns.some((pattern) => pattern.test(output));
		const hasFailurePattern = failurePatterns.some((pattern) => pattern.test(output));

		if (hasSuccessPattern && !hasFailurePattern) {
			log.debug('Detected only success patterns');
			return false;
		}

		// Default to no failures if we can't determine
		log.debug('No clear test result patterns detected');
		return false;
	}

	/**
	 * Attempts to fix test failures using AI analysis and code generation.
	 *
	 * @param {string} testOutput - The complete test output containing failures
	 * @param {string} resultFile - Path to the result file for additional context
	 * @returns {Promise<void>} Resolves when all failures have been processed.
	 */
	private async attemptAIFix(testOutput: string, resultFile: string): Promise<void> {
		const log = this.getLog('attemptAIFix');
		log.info('Starting AI-powered test failure analysis');

		// Parse test failures from the output
		const parseResult = parseTestOutputForFailures(testOutput);
		log.info(`Detected ${parseResult.failures.length} failures to analyze`);

		// Debug: Log the parsed failures to understand what's being detected
		parseResult.failures.forEach((failure, index) => {
			log.debug(`Failure ${index + 1} -> title="${failure.title}", file="${failure.file ?? 'unknown'}", error="${failure.errorMessage}"`);
		});

		// Debug: Log a sample of the test output to understand the format
		log.debug('Logging first 20 lines of test output for diagnostics');
		const outputLines = testOutput.split('\n').slice(0, 20); // First 20 lines
		outputLines.forEach((line, index) => {
			if (line.trim()) {
				log.debug(`Output line ${index + 1}: ${line}`);
			}
		});

		if (parseResult.failures.length === 0) {
			log.warning('No specific test failures could be parsed from output');
			return;
		}

		// Get workspace context for AI prompts
		const relevantParts = await this.getWorkspaceContext();

		// Process each failure
		for (const failure of parseResult.failures) {
			// If no file was detected, try to use the original test file path
			if (!failure.file) {
				// Extract the original test file path from the command or result file
				const originalTestFile = this.extractOriginalTestFilePath(resultFile);
				if (originalTestFile) {
					failure.file = originalTestFile;
					log.info(`Using original test file as fallback: ${originalTestFile}`);
				}
			}
			await this.fixIndividualFailure(failure, testOutput, relevantParts);
		}

		log.info('AI fix attempt completed');
	}

	/**
	 * Fixes an individual test failure using AI analysis.
	 *
	 * @param {ParsedFailure} failure - The parsed failure information
	 * @param {string} fullOutput - The complete test output
	 * @param {any} relevantParts - Workspace context for AI prompts
	 * @returns {Promise<void>} Resolves after the failure has been processed.
	 */
	private async fixIndividualFailure(failure: ParsedFailure, fullOutput: string, relevantParts: any): Promise<void> {
		const log = this.getLog('fixIndividualFailure');
		log.info(`Analyzing failure "${failure.title}"`);

		// Load current content of failing file if available
		let currentContent: string | undefined;
		if (failure.file) {
			try {
				const folders = vscode.workspace.workspaceFolders;
				const base = folders && folders.length ? folders[0].uri.fsPath : undefined;
				const resolvedFile = path.isAbsolute(failure.file) ? failure.file : base ? path.join(base, failure.file) : failure.file;
				const content = await vscode.workspace.fs.readFile(vscode.Uri.file(resolvedFile));
				currentContent = Buffer.from(content).toString('utf8');
				log.debug(`Loaded current content for file: ${failure.file}`);
			} catch (e) {
				log.error(`Could not read failing file '${failure.file}': ${e}`);
			}
		}

		// Classify failure type to choose appropriate prompt
		const classification = classifyFailure(failure);
		log.info(`Failure classification: ${JSON.stringify(classification, null, 2)}`);

		const isClearlyNotRuntime = classification.isCompilationFailure && !classification.isRuntimeFailure;

		// Generate appropriate AI prompt based on failure type
		const prompt = (() => {
			if (!isClearlyNotRuntime) {
				log.info('Using runtime failure fixer prompt');
				return getFixRuntimeFailurePrompt({
					failingOutput: fullOutput,
					filePath: failure.file,
					currentContent,
					relevantParts,
				});
			} else {
				log.info('Using general failure fixer prompt');
				return getFixFailingTestPrompt({
					failingOutput: fullOutput,
					filePath: failure.file,
					currentContent,
					relevantParts,
				});
			}
		})();

		// Get AI fix
		log.info('Requesting AI fix from ChatGPT');
		const aiResponse = await askChatGPT(this.logger, prompt);
		let fixed = aiResponse
			.trim()
			.replace(/```[a-zA-Z]*\n?/g, '')
			.replace(/```\n?/g, '');

		// Determine target file path - prioritize the original failing file
		let targetFilePath: string | undefined = failure.file;
		const folders = vscode.workspace.workspaceFolders;
		const base = folders && folders.length ? folders[0].uri.fsPath : undefined;

		if (targetFilePath) {
			// Resolve to workspace if relative - keep the original file path
			targetFilePath = path.isAbsolute(targetFilePath) ? targetFilePath : base ? path.join(base, targetFilePath) : targetFilePath;
			log.info(`Will replace content in original file: ${targetFilePath}`);
		} else {
			// Only create a new file if we can't determine the original file
			if (folders && folders.length) {
				const guessDir = path.join(base!, 'src', 'ui-test');
				const defaultName = 'ai-fix.test.ts';
				targetFilePath = path.join(guessDir, defaultName);
				log.warning(`Original file path unknown, creating new file: ${targetFilePath}`);
			} else {
				log.error('Cannot determine target file path - no workspace folder');
				return;
			}
		}

		// Write the fixed content to file
		if (targetFilePath && fixed) {
			try {
				await vscode.workspace.fs.writeFile(vscode.Uri.file(targetFilePath), Buffer.from(fixed, 'utf8'));
				log.info(`Fixed test content written to: ${targetFilePath}`);
				log.info('Original test file updated with AI-generated fixes');
			} catch (error) {
				log.error(`Failed to write fixed test file: ${error}`);
				throw error;
			}
		} else {
			log.warning('No target file path or fixed content available');
		}
	}

	/**
	 * Extracts the original test file path from the command or result file.
	 *
	 * @param {string} resultFile - Path to the result file
	 * @returns {string | undefined} The original test file path if found
	 */
	private extractOriginalTestFilePath(resultFile: string): string | undefined {
		const log = this.getLog('extractOriginalTestFilePath');
		// The original test file path is stored in this.finalPath from the constructor
		// We can use that as the fallback
		if (this.finalPath) {
			log.info(`Using original test file path: ${this.finalPath}`);
			return this.finalPath;
		}

		// Alternative: try to extract from the command that was run
		const command = `${this.command} ${this.args.join(' ')}`;
		const fileMatch = command.match(/'([^']+\.(?:ts|tsx|js|jsx))'/);
		if (fileMatch) {
			log.info(`Extracted test file from command: ${fileMatch[1]}`);
			return fileMatch[1];
		}

		log.warning('Could not determine original test file path');
		return undefined;
	}

	/**
	 * Gets workspace context for AI prompts.
	 *
	 * @returns {Promise<any>} Workspace context information
	 */
	private async getWorkspaceContext(): Promise<any> {
		const log = this.getLog('workspaceContext');
		try {
			const folders = vscode.workspace.workspaceFolders;
			const base = folders && folders.length ? folders[0].uri.fsPath : undefined;

			if (!base) {
				return {};
			}

			// Try to read package.json for context
			const packageJsonPath = path.join(base, 'package.json');
			try {
				const content = await vscode.workspace.fs.readFile(vscode.Uri.file(packageJsonPath));
				const packageJson = JSON.parse(Buffer.from(content).toString('utf8'));
				return { packageJson, workspaceRoot: base };
			} catch (e) {
				log.warning(`Could not read package.json: ${e}`);
				return { workspaceRoot: base };
			}
		} catch (error) {
			log.error(`Failed to get workspace context: ${error}`);
			return {};
		}
	}
}
