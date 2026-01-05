import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { Logger } from '../logger/logger';
import { glob } from 'glob';

/**
 * Captures the outcome of invoking a test runner command.
 *
 * @interface TestRunResult
 * @property {boolean} success - Indicates whether the command exited with code 0.
 * @property {number | null} exitCode - Raw exit code returned by the process.
 * @property {string} stdout - Standard output emitted during execution.
 * @property {string} stderr - Standard error emitted during execution.
 * @property {string} command - Command string that was executed.
 * @property {string} cwd - Working directory used for the process.
 */
export interface TestRunResult {
	success: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	command: string;
	cwd: string;
}

/**
 * Determines the most appropriate npm script to use when running UI tests.
 *
 * @param {any} packageJson - Parsed workspace package.json contents.
 * @returns {string | undefined} Name of the npm script to run, or undefined when none exist.
 */
function detectTestScript(packageJson: any): string | undefined {
	const scripts = packageJson?.scripts || {};
	if (typeof scripts['ui-test'] === 'string') {
		return 'ui-test';
	}
	if (typeof scripts['test'] === 'string') {
		return 'test';
	}
	return undefined;
}

/**
 * Resolves the absolute filesystem path of the first workspace folder.
 *
 * @param {Logger} logger - Logger instance for reporting missing workspace scenarios.
 * @returns {Promise<string | undefined>} Workspace root path when available, otherwise undefined.
 */
export async function getWorkspaceRoot(logger: Logger): Promise<string | undefined> {
	const log = logger.withScope('TestRunnerUtils/getWorkspaceRoot');
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		log.error('No workspace folder is open.');
		return undefined;
	}
	return folders[0].uri.fsPath;
}

/**
 * Runs the default UI test npm script for the workspace, capturing stdout/stderr.
 *
 * @param {Logger} logger - Logger used to stream process output and errors.
 * @returns {Promise<TestRunResult>} Structured result describing the command outcome.
 */
export async function runUiTests(logger: Logger): Promise<TestRunResult> {
	const log = logger.withScope('TestRunnerUtils/runUiTests');
	const root = await getWorkspaceRoot(logger);
	if (!root) {
		return {
			success: false,
			exitCode: null,
			stdout: '',
			stderr: 'No workspace folder is open.',
			command: '',
			cwd: '',
		};
	}

	// Read package.json from workspace root
	let pkg: any;
	try {
		const pkgUri = vscode.Uri.file(path.join(root, 'package.json'));
		const buf = await vscode.workspace.fs.readFile(pkgUri);
		pkg = JSON.parse(Buffer.from(buf).toString('utf8'));
	} catch (err) {
		log.error(`Failed to read package.json in workspace: ${err}`);
		return {
			success: false,
			exitCode: null,
			stdout: '',
			stderr: 'Failed to read package.json in workspace.',
			command: '',
			cwd: root,
		};
	}

	const script = detectTestScript(pkg);
	if (!script) {
		const msg = "No 'ui-test' or 'test' npm script found in workspace package.json.";
		log.error(msg);
		return {
			success: false,
			exitCode: null,
			stdout: '',
			stderr: msg,
			command: '',
			cwd: root,
		};
	}

	const command = process.platform === 'win32' ? `npm run ${script} --silent` : `npm run ${script} --silent`;
	log.info(`Running tests with: ${command} (cwd: ${root})`);

	return await new Promise<TestRunResult>((resolve) => {
		const child = cp.spawn(command, {
			cwd: root,
			shell: true,
			env: { ...process.env, CI: '1' },
		});

		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d) => {
			const text = d.toString();
			stdout += text;
			log.info(text);
		});
		child.stderr.on('data', (d) => {
			const text = d.toString();
			stderr += text;
			log.error(text);
		});
		child.on('error', (err) => {
			log.error(`Test process failed to start: ${err}`);
			resolve({ success: false, exitCode: null, stdout, stderr: String(err), command, cwd: root });
		});
		child.on('close', (code) => {
			const success = code === 0;
			resolve({ success, exitCode: code, stdout, stderr, command, cwd: root });
		});
	});
}

/**
 * Executes the configured test script while targeting a specific test file path.
 *
 * @param {Logger} logger - Logger receiving real-time command output.
 * @param {string} testFilePath - Path to the individual file that the test runner should focus on.
 * @returns {Promise<TestRunResult>} Structured result describing the command outcome.
 */
export async function runSingleTestFile(logger: Logger, testFilePath: string): Promise<TestRunResult> {
	const log = logger.withScope('TestRunnerUtils/runSingleTestFile');
	const root = await getWorkspaceRoot(logger);
	if (!root) {
		return {
			success: false,
			exitCode: null,
			stdout: '',
			stderr: 'No workspace folder is open.',
			command: '',
			cwd: '',
		};
	}

	// Read package.json to get test script
	let pkg: any;
	try {
		const pkgUri = vscode.Uri.file(path.join(root, 'package.json'));
		const buf = await vscode.workspace.fs.readFile(pkgUri);
		pkg = JSON.parse(Buffer.from(buf).toString('utf8'));
	} catch (err) {
		log.error(`Failed to read package.json: ${err}`);
		return {
			success: false,
			exitCode: null,
			stdout: '',
			stderr: 'Failed to read package.json.',
			command: '',
			cwd: root,
		};
	}

	const script = detectTestScript(pkg);
	if (!script) {
		return {
			success: false,
			exitCode: null,
			stdout: '',
			stderr: 'No test script found.',
			command: '',
			cwd: root,
		};
	}

	// Run specific test file (most test runners support this)
	const command = `npm run ${script} --silent -- ${testFilePath}`;
	log.info(`Running single test: ${command} (cwd: ${root})`);

	return await new Promise<TestRunResult>((resolve) => {
		const child = cp.spawn(command, {
			cwd: root,
			shell: true,
			env: { ...process.env, CI: '1' },
		});

		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d) => {
			const text = d.toString();
			stdout += text;
			log.info(text);
		});
		child.stderr.on('data', (d) => {
			const text = d.toString();
			stderr += text;
			log.error(text);
		});
		child.on('error', (err) => {
			log.error(`Test process failed to start: ${err}`);
			resolve({ success: false, exitCode: null, stdout, stderr: String(err), command, cwd: root });
		});
		child.on('close', (code) => {
			const success = code === 0;
			resolve({ success, exitCode: code, stdout, stderr, command, cwd: root });
		});
	});
}

/**
 * Discovers all candidate test files in the workspace using predefined glob patterns.
 *
 * @param {Logger} logger - Logger used to report search progress and errors.
 * @returns {Promise<string[]>} Sorted list of absolute file paths for discovered tests.
 */
export async function discoverAllTestFiles(logger: Logger): Promise<string[]> {
	const log = logger.withScope('TestRunnerUtils/discoverAllTestFiles');
	const root = await getWorkspaceRoot(logger);
	if (!root) {
		log.error('No workspace folder is open.');
		return [];
	}

	// Common test file patterns
	const testPatterns = [
		// "**/*.test.ts",
		// "**/*.test.js",
		// "**/*.spec.ts",
		// "**/*.spec.js",
		// "**/test/**/*.ts",
		// "**/test/**/*.js",
		// "**/tests/**/*.ts",
		// "**/tests/**/*.js",
		'**/ui-test/**/*.ts',
		// "**/ui-test/**/*.js"
	];

	const allTestFiles: string[] = [];

	for (const pattern of testPatterns) {
		try {
			const files = await glob(pattern, {
				cwd: root,
				absolute: true,
			});
			allTestFiles.push(...files);
		} catch (err) {
			log.warning(`Failed to search for pattern ${pattern}: ${err}`);
		}
	}

	// Remove duplicates and sort
	const uniqueFiles = [...new Set(allTestFiles)].sort();
	log.info(`Discovered ${uniqueFiles.length} test files: ${uniqueFiles.join(', ')}`);

	return uniqueFiles;
}
