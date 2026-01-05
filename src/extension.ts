import * as vscode from 'vscode';
import { createLogger, Logger } from './logger/logger';
import { askChatGPT, askCodex } from './utils/openAiUtils';
import { GeneratorViewProvider } from './providers/generatorViewProvider';
import { readPackageJsoAsString } from './utils/packageJsonUtils';
import { getRelevantParts } from './utils/packageJsonUtils';
import { getTestProposalPrompt, getFixFailingTestPrompt, getFixRuntimeFailurePrompt } from './utils/prompts';
import { discoverAllTestFiles, runSingleTestFile, runUiTests } from './utils/testRunner';
import { RunFileTask } from './tasks/RunFileTask';
import { parseTestOutputForFailures, classifyFailure, ParsedFailure, extractTestFilesFromFailures } from './utils/testFailureParser';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { ensureTestDirectoryExists, createCategoryDirectory, createEmptyTestFile, generateAndWriteTestContent } from './utils/testFileUtils';
import { TestProposal, convertToTestGenerationResult } from './types/testTypes';
import { TestRunResult } from './utils/testRunner';
let logger: Logger;

/**
 * Runs a single test file using `RunFileTask` while capturing stdout/stderr for later parsing.
 *
 * @param {Logger} logger - Logger used for progress and error reporting.
 * @param {string} testFilePath - Absolute path to the compiled test file that should be executed.
 * @returns {Promise<TestRunResult>} Structured run result, even when an exception occurs.
 */
async function runSingleTestFileWithTask(logger: Logger, testFilePath: string): Promise<TestRunResult> {
	const log = logger.withScope('Extension/RunSingleTestFile');
	log.info(`Starting targeted run for ${testFilePath}`);
	try {
		const runFileTask = new RunFileTask(testFilePath, logger);
		const result = await runFileTask.executeWithOutputCapture();
		log.info(`Completed targeted run for ${testFilePath} (success=${result.success})`);
		return result;
	} catch (error) {
		log.error(`Failed to run test file ${testFilePath}: ${error}`);
		return {
			success: false,
			exitCode: 1,
			stdout: '',
			stderr: error instanceof Error ? error.message : String(error),
			command: 'npx extest setup-and-run',
			cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
		};
	}
}

/**
 * Removes markdown fences and incidental whitespace from an AI response prior to JSON parsing.
 *
 * @param {string} response - Raw response text received from ChatGPT.
 * @returns {string} Cleaned string that should represent valid JSON.
 */
function cleanChatGPTResponse(response: string): string {
	// Remove markdown code block formatting
	let cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '');

	// Remove any leading/trailing whitespace
	cleaned = cleaned.trim();

	// If the response starts with a newline, remove it
	if (cleaned.startsWith('\n')) {
		cleaned = cleaned.substring(1);
	}

	return cleaned;
}

type ProgressReporter = (targetPercent: number, message: string) => void;

function createProgressReporter(progress: vscode.Progress<{ message?: string; increment?: number }>): ProgressReporter {
	let currentPercent = 0;
	return (targetPercent: number, message: string) => {
		const boundedTarget = Math.min(100, Math.max(0, targetPercent));
		if (boundedTarget > currentPercent) {
			const increment = boundedTarget - currentPercent;
			currentPercent = boundedTarget;
			progress.report({
				increment,
				message: `${message} (${currentPercent.toFixed(0)}%)`,
			});
		} else {
			progress.report({
				increment: 0,
				message: `${message} (${currentPercent.toFixed(0)}%)`,
			});
		}
	};
}

/**
 * Applies AI-generated fixes to a single parsed failure by producing a corrected test file.
 *
 * @param {Logger} logger - Logger used for status reporting and diagnostics.
 * @param {ParsedFailure} failure - Failure description emitted by `parseTestOutputForFailures`.
 * @param {string} combined - Concatenated stdout and stderr from the failing run.
 * @param {any} relevantParts - Workspace manifest context used when crafting prompts.
 * @param {vscode.Progress<{ message?: string; increment?: number }>} progress - Progress reporter for UI feedback.
 * @returns {Promise<boolean>} True when a fix was produced and written, otherwise false.
 */
async function fixTestFailure(
	logger: Logger,
	failure: ParsedFailure,
	combined: string,
	relevantParts: any,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<boolean> {
	const log = logger.withScope('Extension/FixTestFailure');
	log.info(`Preparing fix for failure "${failure.title}" (file=${failure.file ?? 'unknown'})`);

	// Load current content of failing file
	let currentContent: string | undefined;
	if (failure.file) {
		try {
			const folders = vscode.workspace.workspaceFolders;
			const base = folders && folders.length ? folders[0].uri.fsPath : undefined;
			const resolvedFile = path.isAbsolute(failure.file) ? failure.file : base ? path.join(base, failure.file) : failure.file;
			const content = await vscode.workspace.fs.readFile(vscode.Uri.file(resolvedFile));
			currentContent = Buffer.from(content).toString('utf8');
			log.debug(`Loaded existing content for ${resolvedFile} (${currentContent.length} chars)`);
		} catch (e) {
			log.error(`Could not read failing file '${failure.file}': ${e}`);
		}
	}

	// Classify failure and choose appropriate prompt
	const classification = classifyFailure(failure);
	log.info(`Failure classification: ${JSON.stringify(classification, null, 2)}`);

	const isClearlyNotRuntime = classification.isCompilationFailure && !classification.isRuntimeFailure;

	const prompt = (() => {
		if (!isClearlyNotRuntime) {
			// TODO: je potreba splitnout runtime a synakticky chyby
			log.info('Selecting runtime failure fixer prompt');
			return getFixRuntimeFailurePrompt({
				failingOutput: combined,
				filePath: failure.file,
				currentContent,
				relevantParts,
			});
		} else {
			log.info('Selecting general failure fixer prompt');
			return getFixFailingTestPrompt({
				failingOutput: combined,
				filePath: failure.file,
				currentContent,
				relevantParts,
			});
		}
	})();

	// Get AI fix
	const aiResponse = await askChatGPT(logger, prompt);
	let fixed = aiResponse
		.trim()
		.replace(/```[a-zA-Z]*\n?/g, '')
		.replace(/```\n?/g, '');
	log.info(`Received AI fix response (${fixed.length} chars after cleanup)`);

	// Determine target file path
	let targetFilePath: string | undefined = failure.file;
	const folders = vscode.workspace.workspaceFolders;
	const base = folders && folders.length ? folders[0].uri.fsPath : undefined;

	if (!targetFilePath) {
		if (folders && folders.length) {
			const guessDir = path.join(base!, 'src', 'ui-test');
			const defaultName = (() => {
				const fromFailure = failure.file ? path.basename(failure.file) : 'ai-fix.test.ts';
				return fromFailure.endsWith('.ts') ? fromFailure : `${fromFailure}.ts`;
			})();
			log.info(`Prompting user for destination. Default directory: ${guessDir}`);
			const picked = await vscode.window.showInputBox({
				prompt: 'Path for fixed test file (relative to workspace). You can enter a directory; a filename will be added automatically.',
				value: path.relative(base!, guessDir),
			});

			let resolved = picked && picked.trim().length ? path.join(base!, picked.trim()) : path.join(guessDir, defaultName);

			try {
				const st = await fs.promises.stat(resolved);
				if (st.isDirectory()) {
					resolved = path.join(resolved, defaultName);
				}
			} catch {
				if (!path.extname(resolved)) {
					resolved = path.join(resolved, defaultName);
				}
			}
			targetFilePath = resolved;
			log.info(`User-selected destination resolved to ${targetFilePath}`);
		}
	} else {
		targetFilePath = path.isAbsolute(targetFilePath) ? targetFilePath : base ? path.join(base, targetFilePath) : targetFilePath;

		try {
			const st = await fs.promises.stat(targetFilePath);
			if (st.isDirectory()) {
				const defaultName = (() => {
					const fromFailure = failure.file ? path.basename(failure.file) : 'ai-fix.test.ts';
					return fromFailure.endsWith('.ts') ? fromFailure : `${fromFailure}.ts`;
				})();
				targetFilePath = path.join(targetFilePath, defaultName);
			}
		} catch {
			if (!path.extname(targetFilePath)) {
				const defaultName = (() => {
					const fromFailure = failure.file ? path.basename(failure.file) : 'ai-fix.test.ts';
					return fromFailure.endsWith('.ts') ? fromFailure : `${fromFailure}.ts`;
				})();
				targetFilePath = path.join(targetFilePath, defaultName);
			}
		}
	}

	if (!targetFilePath) {
		log.error('Unable to determine target file path for AI fix');
		vscode.window.showErrorMessage('Unable to determine a destination file for the AI fix. Provide a valid target path and try again.');
		return false;
	}

	try {
		log.info(`Writing AI fix to ${targetFilePath}`);
		await fs.promises.mkdir(path.dirname(targetFilePath), { recursive: true });
		await fs.promises.writeFile(targetFilePath, fixed, 'utf8');
		log.info(`Successfully wrote AI fix to ${targetFilePath}`);
		vscode.window.showInformationMessage(`AI-generated fix applied to ${path.basename(targetFilePath)}.`);
		return true;
	} catch (e) {
		log.error(`Failed to write fixed file '${targetFilePath}': ${e}`);
		vscode.window.showErrorMessage(`Failed to write the AI-generated fix to ${path.basename(targetFilePath)}. See the output channel for details.`);
		return false;
	}
}

/**
 * Entry point invoked by VS Code when the extension is activated.
 *
 * @param {vscode.ExtensionContext} context - Extension lifecycle context provided by VS Code.
 * @returns {Promise<void>} Resolves once commands and providers have been registered.
 */
export async function activate(context: vscode.ExtensionContext) {
	// Create output channel for logger
	const outputChannel = vscode.window.createOutputChannel('ExTester Test Generator');
	logger = createLogger(outputChannel);
	const extensionLog = logger.withScope('Extension');
	extensionLog.debug('Activating ExTester Test Generator extension');

	const provider = new GeneratorViewProvider(logger);
	vscode.window.registerTreeDataProvider('generator-view', provider);
	extensionLog.info('Generator view provider registered');

	// Step 1: Generate Test
	// Register command for generating test proposals
	context.subscriptions.push(
		vscode.commands.registerCommand('extester-test-generator.generateTestProposals', async () => {
			const commandLog = extensionLog.withScope('GenerateTestProposals');
			commandLog.info('Command invoked');

			vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Generating test files',
					cancellable: false,
				},
				async (progress) => {
					const updateProgress = createProgressReporter(progress);
					try {
						updateProgress(0, 'Analyzing extension manifest');
						commandLog.info('Loading workspace package.json for analysis');

						const packageJson = await readPackageJsoAsString(logger);
						commandLog.debug(`package.json: ${packageJson}`);

						const relevantParts = await getRelevantParts(packageJson, logger);
						commandLog.debug(`Relevant manifest parts: ${JSON.stringify(relevantParts, null, 2)}`);

						updateProgress(25, 'Requesting proposal batch from ChatGPT');
						commandLog.info('Requesting proposal list from ChatGPT');

						const prompt = getTestProposalPrompt(relevantParts);
						const response = await askChatGPT(logger, prompt);

						if (response) {
							commandLog.info('Received raw proposal response from ChatGPT');

							updateProgress(45, 'Parsing AI proposal response');
							commandLog.info('Parsing proposals and preparing file structure');

							// Parse the response and create test files
							try {
								const cleanedResponse = cleanChatGPTResponse(response);
								commandLog.debug(`Cleaned response: ${cleanedResponse}`);

								const rawProposals: TestProposal[] = JSON.parse(cleanedResponse);
								const testResult = convertToTestGenerationResult(rawProposals);
								commandLog.info(`Parsed ${testResult.proposals.length} proposals from AI response`);

								const workspaceFolders = vscode.workspace.workspaceFolders;

								if (workspaceFolders && workspaceFolders.length > 0) {
									const workspacePath = workspaceFolders[0].uri.fsPath;
									const testDir = await ensureTestDirectoryExists(workspacePath);
									commandLog.info(`Ensured UI test directory at ${testDir}`);

									updateProgress(55, 'Preparing UI test directory');

									const config = vscode.workspace.getConfiguration('extester-test-generator');
									const rawLimit = config.get<number | null>('maxGeneratedTests');
									const normalizedLimit =
										typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : undefined;
									const proposalsToProcess =
										normalizedLimit !== undefined
											? testResult.proposals.slice(0, Math.min(normalizedLimit, testResult.proposals.length))
											: testResult.proposals;
									const totalAvailableProposals = testResult.proposals.length;
									const totalProposals = proposalsToProcess.length;
									const limitedBySetting = normalizedLimit !== undefined && totalProposals < totalAvailableProposals;

									if (limitedBySetting) {
										commandLog.info(`Applying generation limit: processing ${totalProposals}/${totalAvailableProposals} proposals`);
									}

									let completedProposals = 0;
									let processedProposals = 0;
									const proposalPercentRangeStart = 55;
									const proposalPercentRangeEnd = 95;
									const perProposalShare = totalProposals > 0 ? (proposalPercentRangeEnd - proposalPercentRangeStart) / totalProposals : 0;

									// Create test files for each proposal with AI-generated content
									for (const proposal of proposalsToProcess) {
										const generationLog = commandLog.withScope(`Proposal:${proposal['test-name']}`);
										generationLog.info(`Generating test for category ${proposal.category}`);

										// Create category directory
										const categoryDir = await createCategoryDirectory(testDir, proposal.category);
										generationLog.debug(`Category directory ready at ${categoryDir}`);

										try {
											// Generate and write actual test content
											await generateAndWriteTestContent(
												categoryDir,
												proposal,
												relevantParts,
												logger,
												askCodex, // use codex here!
											);
											completedProposals++;
											generationLog.info(`Generated test file ${proposal['test-name']}.test.ts`);
										} catch (error) {
											generationLog.error(`Failed to generate content: ${error}`);
											// Fallback to empty test file
											await createEmptyTestFile(categoryDir, proposal['test-name']);
											generationLog.warning(`Created empty fallback test file ${proposal['test-name']}.test.ts`);
										}

										processedProposals++;
										const nextPercent = proposalPercentRangeStart + perProposalShare * processedProposals;
										updateProgress(nextPercent, `Writing ${proposal['test-name']}.test.ts`);
									}

									updateProgress(100, 'Test generation workflow complete');
									commandLog.info(`Finished generating tests (${completedProposals}/${totalProposals})`);

									const limitNote = limitedBySetting ? ` (limited to ${totalProposals} of ${totalAvailableProposals} proposals)` : '';
									vscode.window.showInformationMessage(
										`Generated ${completedProposals}/${totalProposals} UI test files in ${testDir}${limitNote}. Review the output panel for details.`,
									);
								} else {
									commandLog.warning('No workspace folder detected, skipping file generation');
									updateProgress(100, 'Generation cancelled – no workspace detected');
								}
							} catch (parseError) {
								commandLog.error(`Error parsing test generation results: ${parseError}`);
								commandLog.error(`Raw response: ${response}`);
								updateProgress(100, 'Generation aborted');
								vscode.window.showErrorMessage(
									'Unable to parse the AI response for test generation. Open the ExTester Test Generator output channel for the raw data.',
								);
							}
						} else {
							commandLog.warning('ChatGPT response was empty, skipping generation');
							updateProgress(100, 'Generation skipped – empty AI response');
						}
					} catch (error) {
						commandLog.error(`Error generating test proposals: ${error}`);
						updateProgress(100, 'Generation failed');
						vscode.window.showErrorMessage(
							'Failed to generate test proposals. See the ExTester Test Generator output channel for diagnostic details.',
						);
					}
				},
			);
		}),
	);

	// Step 2: Fix Compilation Issus (syntatics)
	// Command 2: Fix Compilation Issues
	context.subscriptions.push(
		vscode.commands.registerCommand('extester-test-generator.fixCompilationIssues', async () => {
			const commandLog = extensionLog.withScope('FixCompilationIssues');
			commandLog.info('Command invoked');

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Fixing compilation issues',
					cancellable: false,
				},
				async (progress) => {
					const updateProgress = createProgressReporter(progress);
					const workspaceFolders = vscode.workspace.workspaceFolders;
					const workspaceRoot = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : undefined;

					const discoveredTestFiles = workspaceRoot ? await discoverAllTestFiles(logger) : [];
					const normalizeToRelative = (filePath: string): string => {
						const normalized = path.normalize(filePath);
						if (!workspaceRoot) {
							return normalized;
						}
						const absolutePath = path.isAbsolute(normalized) ? normalized : path.join(workspaceRoot, normalized);
						return path.relative(workspaceRoot, absolutePath);
					};
					const knownTestFiles = workspaceRoot
						? discoveredTestFiles.map((file) => path.relative(workspaceRoot, file))
						: discoveredTestFiles.map((file) => path.normalize(file));

					const logCompilationSummary = (failingRelative: string[]) => {
						if (!knownTestFiles.length) {
							commandLog.info('No UI test files were discovered, skipping compilation summary.');
						} else {
							const failingSet = new Set(failingRelative);
							const compilableFiles = knownTestFiles.filter((file) => !failingSet.has(file));

							if (compilableFiles.length > 0) {
								commandLog.info('Following tests are compilable without error:');
								compilableFiles.forEach((file) => commandLog.info(` - ${file}`));
							} else {
								commandLog.info('No compilable tests detected before encountering compilation errors.');
							}
						}

						if (failingRelative.length > 0) {
							commandLog.warning('Was not able to automatically fix the following tests yet:');
							failingRelative.forEach((file) => commandLog.warning(` - ${file}`));
						} else {
							commandLog.info('No tests currently blocked by compilation errors.');
						}
					};

					updateProgress(0, 'Running UI tests for compilation issues');
					commandLog.info('Running UI tests to capture compilation failures');
					const runResult = await runUiTests(logger);

					if (!runResult.success) {
						if (!runResult.command) {
							commandLog.error(`UI test run could not be started: ${runResult.stderr || 'Unknown error starting test command'}`);
							updateProgress(100, 'Compilation check failed');
							vscode.window.showErrorMessage(
								runResult.stderr || 'Failed to start the UI test run. Ensure your workspace has a package.json with a ui-test or test script.',
							);
							return;
						}

						if (runResult.exitCode === null && /ENOENT/.test(runResult.stderr)) {
							commandLog.error(`UI test command not found: ${runResult.stderr}`);
							updateProgress(100, 'Compilation check failed');
							vscode.window.showErrorMessage('Failed to start the UI test command. Ensure Node.js and npm are installed and available on PATH.');
							return;
						}
					}

					if (runResult.success) {
						logCompilationSummary([]);
						commandLog.info('UI test run succeeded; no compilation fixes required');
						updateProgress(100, 'Compilation check complete');
						vscode.window.showInformationMessage('Compilation check complete. Tests are already passing.');
						return;
					}

					const combined = `${runResult.stdout}\n${runResult.stderr}`;
					const parsed = parseTestOutputForFailures(combined);
					commandLog.info(`Parsed ${parsed.failures.length} failures from test output`);
					commandLog.debug(JSON.stringify(parsed, null, 2));
					updateProgress(30, 'Analyzing compiler output');

					if (!parsed.failures.length) {
						commandLog.warning('Failed to parse failures even though tests failed');
						updateProgress(100, 'Compilation fix aborted');
						vscode.window.showErrorMessage(
							'Tests failed, but the output could not be parsed. Review the ExTester Test Generator output channel for details.',
						);
						return;
					}

					const failingFilesRaw = extractTestFilesFromFailures(parsed.failures);

					const uniqueFailingRelative = [
						...new Set(failingFilesRaw.filter((file): file is string => Boolean(file?.trim())).map((file) => normalizeToRelative(file))),
					];

					logCompilationSummary(uniqueFailingRelative);

					const first = parsed.failures[0];
					updateProgress(45, `Preparing fix for "${first.title}"`);
					commandLog.info(`Targeting first failure "${first.title}" for automated fix`);

					// Load relevantParts again for context
					let relevantParts: any = {};
					try {
						const pkg = await readPackageJsoAsString(logger);
						relevantParts = await getRelevantParts(pkg, logger);
					} catch (e) {
						commandLog.error(`Failed to collect context for fix prompt: ${e}`);
					}
					updateProgress(55, 'Collecting project context');

					let currentContent: string | undefined;
					if (first.file) {
						try {
							const folders = vscode.workspace.workspaceFolders;
							const base = folders && folders.length ? folders[0].uri.fsPath : undefined;
							const resolvedFile = path.isAbsolute(first.file) ? first.file : base ? path.join(base, first.file) : first.file;
							const content = await vscode.workspace.fs.readFile(vscode.Uri.file(resolvedFile));
							currentContent = Buffer.from(content).toString('utf8');
							commandLog.debug(`Loaded current content for ${resolvedFile}`);
						} catch (e) {
							commandLog.error(`Could not read failing file '${first.file}': ${e}`);
						}
					}

					const prompt = getFixFailingTestPrompt({
						failingOutput: combined,
						filePath: first.file,
						currentContent,
						relevantParts,
					});

					commandLog.info(`Requesting AI fix for ${first.file ?? 'unknown file'}`);
					updateProgress(65, 'Requesting AI-generated fix');
					const aiResponse = await askChatGPT(logger, prompt); //TODO: Nejde tady pouzit clean ai response funkce??

					let fixed = aiResponse
						.trim()
						.replace(/```[a-zA-Z]*\n?/g, '')
						.replace(/```\n?/g, '');
					commandLog.info(`Received AI fix response (${fixed.length} chars after cleanup)`);
					updateProgress(75, 'Applying AI-generated fix');

					// If we know the file, overwrite it; otherwise ask user for location
					let targetFilePath: string | undefined = first.file;
					const folders = vscode.workspace.workspaceFolders;
					const base = folders && folders.length ? folders[0].uri.fsPath : undefined;

					if (!targetFilePath) {
						if (folders && folders.length) {
							const guessDir = path.join(base!, 'src', 'ui-test');
							const defaultName = (() => {
								const fromFailure = first.file ? path.basename(first.file) : 'ai-fix.test.ts';
								return fromFailure.endsWith('.ts') ? fromFailure : `${fromFailure}.ts`;
							})();
							const picked = await vscode.window.showInputBox({
								prompt: 'Path for fixed test file (relative to workspace). You can enter a directory; a filename will be added automatically.',
								value: path.relative(base!, guessDir),
							});

							// If user pressed Enter with empty input, use guessDir + defaultName
							let resolved = picked && picked.trim().length ? path.join(base!, picked.trim()) : path.join(guessDir, defaultName);

							// If the resolved path is a directory (exists and isDir), append defaultName
							try {
								const st = await fs.promises.stat(resolved);
								if (st.isDirectory()) {
									resolved = path.join(resolved, defaultName);
								}
							} catch {
								// stat failed → path likely does not exist; if it looks like a directory (no extension), append defaultName
								if (!path.extname(resolved)) {
									resolved = path.join(resolved, defaultName);
								}
							}
							targetFilePath = resolved;
						}
					} else {
						// Resolve to workspace if relative
						targetFilePath = path.isAbsolute(targetFilePath) ? targetFilePath : base ? path.join(base, targetFilePath) : targetFilePath;

						// If target resolves to an existing directory, append a filename derived from the failure
						try {
							const st = await fs.promises.stat(targetFilePath);
							if (st.isDirectory()) {
								const defaultName = (() => {
									const fromFailure = first.file ? path.basename(first.file) : 'ai-fix.test.ts';
									return fromFailure.endsWith('.ts') ? fromFailure : `${fromFailure}.ts`;
								})();
								targetFilePath = path.join(targetFilePath, defaultName);
							}
						} catch {
							// ignore if it doesn't exist; if it's directory-like (no extension), append defaultName
							if (!path.extname(targetFilePath)) {
								const defaultName = (() => {
									const fromFailure = first.file ? path.basename(first.file) : 'ai-fix.test.ts';
									return fromFailure.endsWith('.ts') ? fromFailure : `${fromFailure}.ts`;
								})();
								targetFilePath = path.join(targetFilePath, defaultName);
							}
						}
					}

					if (!targetFilePath) {
						commandLog.error('Could not resolve a destination for the AI fix');
						updateProgress(100, 'Compilation fix aborted');
						vscode.window.showErrorMessage('Could not determine where to write the AI-generated fix. Check the output panel for hints.');
						return;
					}

					try {
						commandLog.info(`Writing AI fix to ${targetFilePath}`);
						await fs.promises.mkdir(path.dirname(targetFilePath), { recursive: true });
						await fs.promises.writeFile(targetFilePath, fixed, 'utf8');
						commandLog.info('AI fix successfully written');
						vscode.window.showInformationMessage(`AI-generated fix applied to ${path.basename(targetFilePath)}. Re-running tests for validation.`);
					} catch (e) {
						commandLog.error(`Failed to write fixed file '${targetFilePath}': ${e}`);
						updateProgress(100, 'Compilation fix aborted');
						vscode.window.showErrorMessage(`Failed to write the AI fix to ${path.basename(targetFilePath)}. See the output channel for details.`);
						return;
					}
					// Optionally, re-run tests
					updateProgress(90, 'Re-running tests to verify fix');
					commandLog.info('Re-running UI tests to verify compilation fix');
					const rerun = await runUiTests(logger);
					if (rerun.success) {
						commandLog.info('Compilation issues resolved after AI fix');
						updateProgress(100, 'Compilation fix workflow complete');
						vscode.window.showInformationMessage('Compilation issues resolved. Tests are now passing.');
					} else {
						commandLog.warning('Tests still failing after AI fix');
						updateProgress(100, 'Compilation fix workflow complete');
						vscode.window.showWarningMessage(
							'Tests are still failing after the AI fix. Review the output channel for specifics and rerun after manual adjustments.',
						);
					}
				},
			);
		}),
	);

	// Step 3: Fix Runtime Failures (Semantics)
	// Command 3: Fix Runtime Failures
	// context.subscriptions.push(
	//   vscode.commands.registerCommand(
	//     "extester-test-generator.fixRuntimeFailures",
	//     async () => {
	//       await vscode.window.withProgress(
	//         {
	//           location: vscode.ProgressLocation.Notification,
	//           title: "Fixing runtime failures...",
	//           cancellable: false,
	//         },
	//         async (progress) => {
	//           progress.report({ increment: 0, message: "Running tests to detect runtime failures" });
	//           const runResult = await runUiTests(logger);

	//           if (runResult.success) {
	//             vscode.window.showInformationMessage("All tests passed - no runtime failures found!");
	//             return;
	//           }

	//           const combined = `${runResult.stdout}\n${runResult.stderr}`;
	//           const parsed = parseTestOutputForFailures(combined);

	//           if (!parsed.failures.length) {
	//             vscode.window.showErrorMessage("Tests failed, but no failures could be parsed. See output log.");
	//             return;
	//           }

	//           // Filter for runtime failures only
	//           const runtimeFailures = parsed.failures.filter(f =>
	//             classifyFailure(f).isRuntimeFailure
	//           );

	//           if (runtimeFailures.length === 0) {
	//             vscode.window.showInformationMessage("No runtime failures found. Try 'Fix Compilation Issues' instead.");
	//             return;
	//           }

	//           // Load relevantParts for context
	//           let relevantParts: any = {};
	//           try {
	//             const pkg = await readPackageJsoAsString(logger);
	//             relevantParts = await getRelevantParts(pkg, logger);
	//           } catch (e) {
	//             logger.error(`Failed to collect context for fix prompt: ${e}`);
	//           }

	//           // Fix the first runtime failure
	//           const first = runtimeFailures[0];
	//           progress.report({ increment: 40, message: `Fixing runtime failure: ${first.title}` });

	//           const fixed = await fixTestFailure(logger, first, combined, relevantParts, progress);
	//           if (!fixed) {
	//             return;
	//           }

	//           // Re-run tests
	//           progress.report({ increment: 90, message: "Re-running tests" });
	//           const rerun = await runUiTests(logger);
	//           if (rerun.success) {
	//             vscode.window.showInformationMessage("Runtime failures fixed! All tests now pass.");
	//           } else {
	//             vscode.window.showWarningMessage("Tests still failing after fix. Check logs for details.");
	//           }
	//         }
	//       );
	//     }
	//   )
	// );

	// In extension.ts - updated fixRuntimeFailures command
	context.subscriptions.push(
		vscode.commands.registerCommand('extester-test-generator.fixRuntimeFailures', async () => {
			const commandLog = extensionLog.withScope('FixRuntimeFailures');
			commandLog.info('Command invoked');

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Fixing runtime failures',
					cancellable: false,
				},
				async (progress) => {
					const updateProgress = createProgressReporter(progress);
					updateProgress(0, 'Discovering UI test files');
					commandLog.info('Discovering UI test files in workspace');
					const allTestFiles = await discoverAllTestFiles(logger);
					const workspaceFolders = vscode.workspace.workspaceFolders;
					const workspaceRoot = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : undefined;
					const normalizeToRelative = (filePath: string): string => {
						const normalized = path.normalize(filePath);
						if (!workspaceRoot) {
							return normalized;
						}
						const absolutePath = path.isAbsolute(normalized) ? normalized : path.join(workspaceRoot, normalized);
						return path.relative(workspaceRoot, absolutePath);
					};
					const passingTests = new Set<string>();
					const unresolvedRuntimeFailures = new Set<string>();
					const logRuntimeSummary = () => {
						if (!allTestFiles.length) {
							commandLog.info('No runtime tests discovered, skipping runtime summary.');
							return;
						}

						if (passingTests.size > 0) {
							commandLog.info('These tests ran without runtime errors:');
							Array.from(passingTests)
								.sort()
								.forEach((file) => commandLog.info(` - ${file}`));
						} else {
							commandLog.info('No tests confirmed to be passing yet.');
						}

						if (unresolvedRuntimeFailures.size > 0) {
							commandLog.warning('These tests still have unresolved runtime failures:');
							Array.from(unresolvedRuntimeFailures)
								.sort()
								.forEach((file) => commandLog.warning(` - ${file}`));
						} else {
							commandLog.info('No tests remain with runtime failures.');
						}
					};

					commandLog.info(`Discovered ${allTestFiles.length} test files`);

					if (allTestFiles.length === 0) {
						commandLog.warning('No test files discovered; aborting runtime fix workflow');
						updateProgress(100, 'Runtime fix cancelled – no test files discovered');
						vscode.window.showInformationMessage('No UI test files were found in this workspace. Generate tests first, then rerun runtime fixes.');
						return;
					}

					// Load relevantParts for context
					let relevantParts: any = {};
					try {
						const pkg = await readPackageJsoAsString(logger);
						relevantParts = await getRelevantParts(pkg, logger);
					} catch (e) {
						commandLog.error(`Failed to collect context for fix prompt: ${e}`);
					}
					updateProgress(15, 'Loading extension context');

					// Process each test file individually
					let fixedCount = 0;
					let totalFailures = 0;
					const processingStart = 20;
					const processingEnd = 95;
					const perFileShare = allTestFiles.length ? (processingEnd - processingStart) / allTestFiles.length : 0;
					let processedFiles = 0;

					for (let i = 0; i < allTestFiles.length; i++) {
						const testFile = allTestFiles[i];
						const fileLog = commandLog.withScope(path.relative(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', testFile) || testFile);
						const relativeTestPath = normalizeToRelative(testFile);

						updateProgress(processingStart + perFileShare * processedFiles, `Processing ${path.basename(testFile)}`);

						// Run this specific test file
						fileLog.info('Starting targeted runtime test execution');
						const singleTestResult = await runSingleTestFileWithTask(logger, testFile);
						fileLog.info(`Completed run (success=${singleTestResult.success})`);

						// Parse failures for this specific test using file-based capture
						const singleTestOutput = `${singleTestResult.stdout}\n${singleTestResult.stderr}`;
						const singleTestParsed = parseTestOutputForFailures(singleTestOutput);
						const singleTestRuntimeFailures = singleTestParsed.failures.filter((f) => {
							const classification = classifyFailure(f);
							const isClearlyNotRuntime = classification.isCompilationFailure && !classification.isRuntimeFailure;
							return !isClearlyNotRuntime;
						});

						if (singleTestResult.success) {
							fileLog.info('Test file passed; no fixes required');
							passingTests.add(relativeTestPath);
							processedFiles++;
							updateProgress(processingStart + perFileShare * processedFiles, `Processed ${processedFiles}/${allTestFiles.length} test files`);
							continue;
						}

						if (singleTestRuntimeFailures.length === 0) {
							fileLog.info('No runtime failures detected in parsed output; skipping');
							processedFiles++;
							updateProgress(processingStart + perFileShare * processedFiles, `Processed ${processedFiles}/${allTestFiles.length} test files`);
							continue;
						}

						totalFailures += singleTestRuntimeFailures.length;
						fileLog.info(`Detected ${singleTestRuntimeFailures.length} runtime failures`);

						// Fix each runtime failure in this test file
						let fileResolved = false;
						for (const failure of singleTestRuntimeFailures) {
							fileLog.info(`Attempting fix for failure "${failure.title}"`);

							const fixed = await fixTestFailure(logger, failure, singleTestOutput, relevantParts, progress);
							if (fixed) {
								fixedCount++;
								fileLog.info(`Applied AI fix for "${failure.title}", re-running file to verify`);

								// Re-run this specific test to verify the fix
								updateProgress(processingStart + perFileShare * processedFiles, `Verifying fix for ${path.basename(testFile)}`);

								const verifyResult = await runSingleTestFileWithTask(logger, testFile);
								if (verifyResult.success) {
									fileLog.info('Verification run succeeded; moving to next file');
									passingTests.add(relativeTestPath);
									unresolvedRuntimeFailures.delete(relativeTestPath);
									fileResolved = true;
									break; // Move to next test file
								} else {
									fileLog.warning('Verification run still failing; continuing with next failure in file');
								}
							}
						}

						if (!fileResolved) {
							unresolvedRuntimeFailures.add(relativeTestPath);
						}

						processedFiles++;
						updateProgress(processingStart + perFileShare * processedFiles, `Processed ${processedFiles}/${allTestFiles.length} test files`);
					}

					logRuntimeSummary();
					commandLog.info(`Runtime fix workflow finished (fixed=${fixedCount}, failuresFound=${totalFailures})`);
					if (fixedCount === 0) {
						commandLog.warning('No runtime failures were fixed during this run');
					}
					updateProgress(100, 'Runtime fix workflow complete');
				},
			);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('extester-test-generator.runAndFixTests', async () => {
			const commandLog = extensionLog.withScope('RunAndFixTests');
			commandLog.info('Command invoked');

			try {
				commandLog.info('Starting compilation fix phase');
				await vscode.commands.executeCommand('extester-test-generator.fixCompilationIssues');
			} catch (error) {
				commandLog.error(`Error during FixCompilationIssues phase: ${error}`);
				return;
			}

			try {
				commandLog.info('Starting runtime fix phase');
				await vscode.commands.executeCommand('extester-test-generator.fixRuntimeFailures');
			} catch (error) {
				commandLog.error(`Error during FixRuntimeFailures phase: ${error}`);
			}
		}),
	);
}

/**
 * No-op placeholder invoked when the extension is deactivated.
 */
export function deactivate() {}
