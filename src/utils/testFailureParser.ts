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

/**
 * Represents a single failure parsed from raw test output.
 *
 * @interface ParsedFailure
 * @property {string} title - Human-readable failure title (e.g., test name).
 * @property {string} [file] - Optional file path extracted from stack traces or error headers.
 * @property {string} errorMessage - Normalized error message describing the failure.
 * @property {string} [stack] - Optional captured stack trace string.
 */
export interface ParsedFailure {
	title: string;
	file?: string;
	errorMessage: string;
	stack?: string;
}

/**
 * Wraps all failures identified within a single parse run.
 *
 * @interface ParseResult
 * @property {ParsedFailure[]} failures - Collection of failures discovered in the output.
 */
export interface ParseResult {
	failures: ParsedFailure[];
}

/**
 * Removes ANSI color codes (Mocha/ExTester often prints colored output).
 *
 * @param {string} input - Original terminal text that may contain escape sequences.
 * @returns {string} Cleaned string without formatting characters.
 */
// Remove ANSI color codes (Mocha/ExTester often prints colored output)
function stripAnsi(input: string): string {
	const ansiRegex = /\x1B\[[0-?]*[ -/]*[@-~]/g;
	return input.replace(ansiRegex, '');
}

/**
 * Lightweight parser for Mocha/ExTester, TypeScript compiler, and WebDriver errors.
 *
 * @param {string} output - Combined stdout and stderr emitted by the runner.
 * @returns {ParseResult} Structured failures detected within the output text.
 */
// Very lightweight parser for Mocha/ExTester + TSC + WebDriver errors
export function parseTestOutputForFailures(output: string): ParseResult {
	const clean = stripAnsi(output);
	const lines = clean.split(/\r?\n/);
	const failures: ParsedFailure[] = [];

	let current: ParsedFailure | undefined;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}

		// 1) TypeScript compiler errors (tsc)
		// file.ts(22,27): error TS2552: ...
		const tscMatch = trimmed.match(/^([^()]+\.(?:ts|tsx|js|jsx))\((\d+),(\d+)\):\s+error\s+TS\d+:\s+(.*)$/);
		if (tscMatch) {
			const [, file, lineNo, colNo, message] = tscMatch;
			failures.push({
				title: `${file}:${lineNo}:${colNo}`,
				file,
				errorMessage: message.trim(),
			});
			current = undefined;
			continue;
		}

		// 2) Mocha failure header:
		// 1) Suite should do X
		// 1) "before all" hook in "{root}"
		// 2) "after all" hook in "{root}":
		const failIndex = trimmed.match(/^\d+\)\s+(.*?)(?::\s*)?$/);
		if (failIndex) {
			if (current) {
				failures.push(current);
			}
			current = { title: failIndex[1], errorMessage: '' };
			continue;
		}

		// 3) Error messages:
		// - Error: message
		// - AssertionError: ...
		// - TypeError:, ReferenceError:, RangeError:, TimeoutError:
		// - SessionNotCreatedError: ... (WebDriver)
		// - Any XxxError: message
		// - Timeout of 20000ms exceeded
		// - Unhandled ...
		const errorMatch =
			trimmed.match(/^(?:Error|AssertionError|TypeError|ReferenceError|RangeError|TimeoutError|SessionNotCreatedError):\s*(.*)$/) ||
			trimmed.match(/^[A-Za-z][A-Za-z0-9]*Error:\s*(.*)$/) ||
			trimmed.match(/^Timeout of \d+ms exceeded.*$/) ||
			trimmed.match(/^Unhandled.*$/);
		if (errorMatch) {
			if (!current) {
				current = { title: 'Unknown test', errorMessage: '' };
			}
			current.errorMessage = (errorMatch[1] ?? errorMatch[0]).trim();
			continue;
		}

		// 4) File path hints in stack frames:
		// at Context.<anonymous> (path/to/test.ts:12:3)
		const fileParenMatch = trimmed.match(/\(([^()]+\.(?:ts|tsx|js|jsx)):\d+:\d+\)/);
		if (fileParenMatch) {
			if (!current) {
				current = { title: 'Unknown test', errorMessage: '' };
			}
			current.file = fileParenMatch[1];
			// don't continue; we also want to capture the stack line below
		} else {
			// at path/to/test.ts:12:3
			const fileBareMatch = trimmed.match(/\b([^()\s]+\.(?:ts|tsx|js|jsx)):(\d+):(\d+)\b/);
			if (fileBareMatch) {
				if (!current) {
					current = { title: 'Unknown test', errorMessage: '' };
				}
				current.file = fileBareMatch[1];
			}
		}

		// 5) Accumulate stack lines (most start with "at ")
		if (trimmed.startsWith('at ')) {
			if (!current) {
				current = { title: 'Unknown test', errorMessage: '' };
			}
			current.stack = (current.stack || '') + line + '\n';
			continue;
		}
	}

	if (current) {
		failures.push(current);
	}

	// Fallback if nothing matched but we see error-like lines
	if (failures.length === 0) {
		const lastErrorLine =
			lines
				.map((l) => stripAnsi(l).trim())
				.filter((l) => l.match(/(error TS\d+|[A-Za-z][A-Za-z0-9]*Error:|Timeout|Unhandled)/))
				.pop() || '';
		if (lastErrorLine) {
			failures.push({
				title: 'Unknown failing test',
				errorMessage: lastErrorLine,
			});
		}
	}

	return { failures };
}

/**
 * Describes the classification assigned to a failure for prompt selection.
 *
 * @interface FailureClassification
 * @property {boolean} isRuntimeFailure - Indicates the failure likely occurred at runtime.
 * @property {boolean} isCompilationFailure - Indicates the failure likely occurred during compilation.
 * @property {'runtime' | 'compilation' | 'unknown'} failureType - Enum summarizing the failure category.
 */
export interface FailureClassification {
	isRuntimeFailure: boolean;
	isCompilationFailure: boolean;
	failureType: 'runtime' | 'compilation' | 'unknown';
}

/**
 * Determines whether a parsed failure originated from runtime behaviour or compilation issues.
 *
 * @param {ParsedFailure} failure - Failure entry from the parser.
 * @returns {FailureClassification} Flags that describe the detected failure type.
 */
export function classifyFailure(failure: ParsedFailure): FailureClassification {
	const errorMsg = failure.errorMessage.toLowerCase();
	const title = failure.title.toLowerCase();

	// Runtime failure patterns
	const runtimePatterns = [
		'timeout',
		'nosuchelement',
		'staleelementreference',
		'elementnotinteractable',
		'webdriver',
		'sessionnotcreatederror',
		'unhandledpromiserejection',
		'element.*not.*interactable',
		'cannot find element',
		'element not found',
		'waiting for element',
		'element is not attached',
		'element is not clickable',
		'element is not visible',
		'element is not enabled',
	];

	// Compilation failure patterns
	const compilationPatterns = [
		'error ts',
		'typescript error',
		'syntax error',
		'cannot find name',
		'property does not exist',
		'type error',
		'module not found',
		'import error',
	];

	const isRuntime = runtimePatterns.some((pattern) => errorMsg.includes(pattern) || title.includes(pattern));

	const isCompilation = compilationPatterns.some((pattern) => errorMsg.includes(pattern) || title.includes(pattern));

	let failureType: 'runtime' | 'compilation' | 'unknown' = 'unknown';
	if (isRuntime) {
		failureType = 'runtime';
	} else if (isCompilation) {
		failureType = 'compilation';
	}

	return {
		isRuntimeFailure: isRuntime,
		isCompilationFailure: isCompilation,
		failureType,
	};
}

/**
 * Collects the unique file paths referenced across a set of failures.
 *
 * @param {ParsedFailure[]} failures - Parsed failures that may reference files.
 * @returns {string[]} Array of de-duplicated file system paths to investigate.
 */
export function extractTestFilesFromFailures(failures: ParsedFailure[]): string[] {
	const testFiles = new Set<string>();

	failures.forEach((failure) => {
		if (failure.file) {
			testFiles.add(failure.file);
		}
	});

	return Array.from(testFiles);
}
