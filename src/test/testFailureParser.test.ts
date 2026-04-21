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

import * as assert from 'assert';
import { parseTestOutputForFailures, classifyFailure, extractTestFilesFromFailures } from '../utils/testFailureParser';

suite('testFailureParser', () => {
	suite('parseTestOutputForFailures', () => {
		suite('ANSI stripping', () => {
			test('strips ANSI codes before matching a TSC error', () => {
				const output = '\x1B[31msrc/foo.ts(5,3): error TS2552: Cannot find name\x1B[0m';
				const { failures } = parseTestOutputForFailures(output);
				assert.strictEqual(failures.length, 1);
				assert.strictEqual(failures[0].file, 'src/foo.ts');
				assert.strictEqual(failures[0].errorMessage, 'Cannot find name');
			});

			test('strips ANSI codes before matching a Mocha failure header', () => {
				const output = '\x1B[31m1) Suite should open\x1B[0m\n    Error: boom';
				const { failures } = parseTestOutputForFailures(output);
				assert.strictEqual(failures.length, 1);
				assert.strictEqual(failures[0].title, 'Suite should open');
			});
		});

		suite('TSC errors', () => {
			test('parses a single TSC error into title, file, and errorMessage', () => {
				const output = 'src/foo.ts(22,27): error TS2552: Cannot find name "bar"';
				const { failures } = parseTestOutputForFailures(output);
				assert.strictEqual(failures.length, 1);
				assert.strictEqual(failures[0].title, 'src/foo.ts:22:27');
				assert.strictEqual(failures[0].file, 'src/foo.ts');
				assert.strictEqual(failures[0].errorMessage, 'Cannot find name "bar"');
			});

			test('parses two TSC errors into two separate failures', () => {
				const output = [
					'src/a.ts(1,1): error TS2345: Argument type mismatch',
					'src/b.ts(3,5): error TS2339: Property does not exist',
				].join('\n');
				const { failures } = parseTestOutputForFailures(output);
				assert.strictEqual(failures.length, 2);
				assert.strictEqual(failures[0].file, 'src/a.ts');
				assert.strictEqual(failures[1].file, 'src/b.ts');
			});

			test('matches .tsx file extension', () => {
				const output = 'src/a.tsx(1,1): error TS2345: mismatch';
				assert.strictEqual(parseTestOutputForFailures(output).failures.length, 1);
			});

			test('matches .js file extension', () => {
				const output = 'src/b.js(2,2): error TS2339: not found';
				assert.strictEqual(parseTestOutputForFailures(output).failures.length, 1);
			});
		});

		suite('Mocha failure headers', () => {
			test('captures a numbered failure header as an entry', () => {
				const output = '1) Suite should open the view';
				const { failures } = parseTestOutputForFailures(output);
				assert.strictEqual(failures.length, 1);
				assert.strictEqual(failures[0].title, 'Suite should open the view');
				assert.strictEqual(failures[0].errorMessage, '');
			});

			test('captures a before-all hook failure header', () => {
				const output = '1) "before all" hook in "{root}":';
				const { failures } = parseTestOutputForFailures(output);
				assert.strictEqual(failures.length, 1);
				assert.strictEqual(failures[0].title, '"before all" hook in "{root}"');
			});

			test('captures two numbered failures as two separate entries', () => {
				const output = '1) First test\n2) Second test';
				const { failures } = parseTestOutputForFailures(output);
				assert.strictEqual(failures.length, 2);
				assert.strictEqual(failures[0].title, 'First test');
				assert.strictEqual(failures[1].title, 'Second test');
			});
		});

		suite('error message lines', () => {
			test('sets errorMessage from Error: line under a Mocha header', () => {
				const output = '1) Suite test\n    Error: boom';
				const { failures } = parseTestOutputForFailures(output);
				assert.strictEqual(failures[0].errorMessage, 'boom');
			});

			test('captures AssertionError message', () => {
				const output = '1) Test\n    AssertionError: expected 1 to equal 2';
				const { failures } = parseTestOutputForFailures(output);
				assert.strictEqual(failures[0].errorMessage, 'expected 1 to equal 2');
			});

			test('captures TimeoutError message', () => {
				const output = '1) Test\n    TimeoutError: element not found';
				const { failures } = parseTestOutputForFailures(output);
				assert.strictEqual(failures[0].errorMessage, 'element not found');
			});

			test('captures SessionNotCreatedError message', () => {
				const output = '1) Test\n    SessionNotCreatedError: bad session config';
				const { failures } = parseTestOutputForFailures(output);
				assert.strictEqual(failures[0].errorMessage, 'bad session config');
			});

			test('captures a generic XxxError pattern', () => {
				const output = '1) Test\n    FooBarError: custom message';
				const { failures } = parseTestOutputForFailures(output);
				assert.strictEqual(failures[0].errorMessage, 'custom message');
			});

			test('captures Timeout of Nms exceeded as errorMessage', () => {
				const output = '1) Test\n    Timeout of 20000ms exceeded.';
				const { failures } = parseTestOutputForFailures(output);
				assert.ok(failures[0].errorMessage.includes('Timeout of 20000ms exceeded'));
			});

			test('captures Unhandled line as errorMessage', () => {
				const output = '1) Test\n    Unhandled rejection at: Promise { <rejected> }';
				const { failures } = parseTestOutputForFailures(output);
				assert.ok(failures[0].errorMessage.includes('Unhandled'));
			});

			test('creates Unknown test entry for standalone error line with no Mocha header', () => {
				const output = 'Error: standalone error with no header';
				const { failures } = parseTestOutputForFailures(output);
				assert.strictEqual(failures.length, 1);
				assert.strictEqual(failures[0].title, 'Unknown test');
				assert.strictEqual(failures[0].errorMessage, 'standalone error with no header');
			});
		});

		suite('stack frame file extraction', () => {
			test('extracts file from parenthesised stack frame format', () => {
				const output = [
					'1) Test',
					'    Error: boom',
					'    at Context.<anonymous> (src/foo.test.ts:12:3)',
				].join('\n');
				const { failures } = parseTestOutputForFailures(output);
				assert.strictEqual(failures[0].file, 'src/foo.test.ts');
			});

			test('extracts file from bare stack frame format', () => {
				const output = [
					'1) Test',
					'    Error: boom',
					'    at src/foo.test.ts:12:3',
				].join('\n');
				const { failures } = parseTestOutputForFailures(output);
				assert.strictEqual(failures[0].file, 'src/foo.test.ts');
			});

			test('accumulates multiple at lines into stack property', () => {
				const output = [
					'1) Test',
					'    Error: boom',
					'    at Context.<anonymous> (src/foo.test.ts:12:3)',
					'    at processImmediate (node:internal/timers:476:7)',
				].join('\n');
				const { failures } = parseTestOutputForFailures(output);
				assert.ok(failures[0].stack?.includes('at Context.<anonymous>'));
				assert.ok(failures[0].stack?.includes('at processImmediate'));
			});
		});

		suite('fallback behavior', () => {
			test('returns no failures for empty string', () => {
				const { failures } = parseTestOutputForFailures('');
				assert.strictEqual(failures.length, 0);
			});

			test('returns no failures for output with no recognizable patterns', () => {
				const { failures } = parseTestOutputForFailures('Some random log output\nNothing relevant here');
				assert.strictEqual(failures.length, 0);
			});

			test('creates fallback entry when output has error-like substring but no parseable structure', () => {
				const output = 'Process exited with TypeError: cannot read property x of undefined';
				const { failures } = parseTestOutputForFailures(output);
				assert.strictEqual(failures.length, 1);
				assert.strictEqual(failures[0].title, 'Unknown failing test');
				assert.ok(failures[0].errorMessage.includes('TypeError:'));
			});
		});

		suite('mixed / integration', () => {
			test('captures TSC error and Mocha failure independently in mixed output', () => {
				const output = [
					'src/foo.ts(1,1): error TS2552: Cannot find name',
					'1) Suite test fails',
					'    Error: assertion failed',
				].join('\n');
				const { failures } = parseTestOutputForFailures(output);
				assert.strictEqual(failures.length, 2);
				assert.strictEqual(failures[0].file, 'src/foo.ts');
				assert.strictEqual(failures[1].title, 'Suite test fails');
				assert.strictEqual(failures[1].errorMessage, 'assertion failed');
			});

			test('parses a realistic two-failure Mocha dump', () => {
				const output = [
					'  1) views > should open panel',
					'     Error: Element not found',
					'     at Context.<anonymous> (src/ui-test/views/panelTest.test.ts:20:5)',
					'',
					'  2) commands > run generate',
					'     TimeoutError: timed out waiting for element',
					'     at Context.<anonymous> (src/ui-test/commands/generateTest.test.ts:35:7)',
				].join('\n');
				const { failures } = parseTestOutputForFailures(output);
				assert.strictEqual(failures.length, 2);
				assert.strictEqual(failures[0].errorMessage, 'Element not found');
				assert.strictEqual(failures[0].file, 'src/ui-test/views/panelTest.test.ts');
				assert.strictEqual(failures[1].errorMessage, 'timed out waiting for element');
				assert.strictEqual(failures[1].file, 'src/ui-test/commands/generateTest.test.ts');
			});
		});
	});

	suite('classifyFailure', () => {
		suite('runtime patterns', () => {
			test('classifies timeout in errorMessage as runtime', () => {
				const result = classifyFailure({ title: 'test', errorMessage: 'timeout exceeded' });
				assert.strictEqual(result.isRuntimeFailure, true);
				assert.strictEqual(result.failureType, 'runtime');
				assert.strictEqual(result.isCompilationFailure, false);
			});

			test('classifies nosuchelement as runtime', () => {
				const result = classifyFailure({ title: 'test', errorMessage: 'NoSuchElement: not found' });
				assert.strictEqual(result.isRuntimeFailure, true);
				assert.strictEqual(result.failureType, 'runtime');
				assert.strictEqual(result.isCompilationFailure, false);
			});

			test('classifies staleelementreference as runtime', () => {
				const result = classifyFailure({ title: 'test', errorMessage: 'StaleElementReference: detached from DOM' });
				assert.strictEqual(result.isRuntimeFailure, true);
				assert.strictEqual(result.failureType, 'runtime');
				assert.strictEqual(result.isCompilationFailure, false);
			});

			test('classifies cannot find element as runtime', () => {
				const result = classifyFailure({ title: 'test', errorMessage: 'cannot find element in DOM' });
				assert.strictEqual(result.isRuntimeFailure, true);
				assert.strictEqual(result.failureType, 'runtime');
				assert.strictEqual(result.isCompilationFailure, false);
			});

			test('classifies runtime keyword in title only as runtime', () => {
				const result = classifyFailure({ title: 'timeout in generator test', errorMessage: '' });
				assert.strictEqual(result.isRuntimeFailure, true);
				assert.strictEqual(result.failureType, 'runtime');
				assert.strictEqual(result.isCompilationFailure, false);
			});
		});

		suite('compilation patterns', () => {
			test('classifies error ts in errorMessage as compilation', () => {
				const result = classifyFailure({ title: 'src/foo.ts:5:3', errorMessage: 'error TS2552: cannot find name' });
				assert.strictEqual(result.isCompilationFailure, true);
				assert.strictEqual(result.failureType, 'compilation');
				assert.strictEqual(result.isRuntimeFailure, false);
			});

			test('classifies cannot find name as compilation', () => {
				const result = classifyFailure({ title: 'test', errorMessage: 'cannot find name "foo"' });
				assert.strictEqual(result.isCompilationFailure, true);
				assert.strictEqual(result.failureType, 'compilation');
				assert.strictEqual(result.isRuntimeFailure, false);
			});

			test('classifies property does not exist as compilation', () => {
				const result = classifyFailure({ title: 'test', errorMessage: 'property does not exist on type Bar' });
				assert.strictEqual(result.isCompilationFailure, true);
				assert.strictEqual(result.failureType, 'compilation');
				assert.strictEqual(result.isRuntimeFailure, false);
			});

			test('classifies module not found as compilation', () => {
				const result = classifyFailure({ title: 'test', errorMessage: 'module not found: openai' });
				assert.strictEqual(result.isCompilationFailure, true);
				assert.strictEqual(result.failureType, 'compilation');
				assert.strictEqual(result.isRuntimeFailure, false);
			});
		});

		suite('edge cases', () => {
			test('returns unknown for empty errorMessage and title', () => {
				const result = classifyFailure({ title: '', errorMessage: '' });
				assert.strictEqual(result.isRuntimeFailure, false);
				assert.strictEqual(result.isCompilationFailure, false);
				assert.strictEqual(result.failureType, 'unknown');
			});

			test('runtime takes precedence when both patterns are present', () => {
				const result = classifyFailure({ title: 'test', errorMessage: 'timeout error ts2552 cannot find name' });
				assert.strictEqual(result.isRuntimeFailure, true);
				assert.strictEqual(result.isCompilationFailure, true);
				assert.strictEqual(result.failureType, 'runtime');
			});
		});
	});

	suite('extractTestFilesFromFailures', () => {
		test('returns empty array for empty input', () => {
			assert.deepStrictEqual(extractTestFilesFromFailures([]), []);
		});

		test('returns empty array when no failures have a file field', () => {
			const failures = [
				{ title: 'test', errorMessage: 'boom' },
				{ title: 'test2', errorMessage: 'crash' },
			];
			assert.deepStrictEqual(extractTestFilesFromFailures(failures), []);
		});

		test('returns the file path from a single failure', () => {
			const failures = [{ title: 'test', errorMessage: 'boom', file: 'src/foo.ts' }];
			assert.deepStrictEqual(extractTestFilesFromFailures(failures), ['src/foo.ts']);
		});

		test('returns all unique files from failures with distinct paths', () => {
			const failures = [
				{ title: 't1', errorMessage: '', file: 'src/a.ts' },
				{ title: 't2', errorMessage: '', file: 'src/b.ts' },
			];
			const result = extractTestFilesFromFailures(failures);
			assert.strictEqual(result.length, 2);
			assert.ok(result.includes('src/a.ts'));
			assert.ok(result.includes('src/b.ts'));
		});

		test('deduplicates failures pointing to the same file', () => {
			const failures = [
				{ title: 't1', errorMessage: '', file: 'src/foo.ts' },
				{ title: 't2', errorMessage: '', file: 'src/foo.ts' },
			];
			const result = extractTestFilesFromFailures(failures);
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0], 'src/foo.ts');
		});

		test('returns only files from failures that have a file property', () => {
			const failures = [
				{ title: 't1', errorMessage: '', file: 'src/foo.ts' },
				{ title: 't2', errorMessage: '' },
				{ title: 't3', errorMessage: '', file: 'src/bar.ts' },
			];
			const result = extractTestFilesFromFailures(failures);
			assert.strictEqual(result.length, 2);
			assert.ok(result.includes('src/foo.ts'));
			assert.ok(result.includes('src/bar.ts'));
		});
	});
});
