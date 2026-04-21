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
import { getTestProposalPrompt, getTestFileContentPrompt, getFixFailingTestPrompt, getFixRuntimeFailurePrompt } from '../utils/prompts';

suite('prompts', () => {
	suite('getTestProposalPrompt', () => {
		test('returns a non-empty string', () => {
			const result = getTestProposalPrompt({ extensionId: 'test.ext' });
			assert.ok(result.length > 0);
		});

		test('includes the JSON of relevantParts in the output', () => {
			const parts = { extensionId: 'foo.bar', commands: [{ command: 'foo.bar.cmd' }] };
			const result = getTestProposalPrompt(parts);
			assert.ok(result.includes('"extensionId"'));
			assert.ok(result.includes('foo.bar'));
		});

		test('includes schema field names in the output', () => {
			const result = getTestProposalPrompt({});
			assert.ok(result.includes('"category"'));
			assert.ok(result.includes('"test-name"'));
			assert.ok(result.includes('"description"'));
			assert.ok(result.includes('"cover"'));
		});
	});

	suite('getTestFileContentPrompt', () => {
		const baseProposal = {
			'test-name': 'mySpecialTest',
			category: 'notifications',
			description: 'verifies the sidebar opens correctly',
			cover: ['featureAlpha', 'featureBeta'],
		};

		test('includes test-name in the output', () => {
			const result = getTestFileContentPrompt(baseProposal, {});
			assert.ok(result.includes('mySpecialTest'));
		});

		test('includes category in the output', () => {
			const result = getTestFileContentPrompt(baseProposal, {});
			assert.ok(result.includes('notifications'));
		});

		test('includes description in the output', () => {
			const result = getTestFileContentPrompt(baseProposal, {});
			assert.ok(result.includes('verifies the sidebar opens correctly'));
		});

		test('includes each cover item in the output', () => {
			const result = getTestFileContentPrompt(baseProposal, {});
			assert.ok(result.includes('featureAlpha'));
			assert.ok(result.includes('featureBeta'));
		});

		test('includes relevantParts JSON in the output', () => {
			const result = getTestFileContentPrompt(baseProposal, { extensionId: 'my.ext' });
			assert.ok(result.includes('my.ext'));
		});
	});

	suite('getFixFailingTestPrompt', () => {
		test('includes failingOutput in the output', () => {
			const result = getFixFailingTestPrompt({ failingOutput: 'error TS2552: cannot find name', relevantParts: {} });
			assert.ok(result.includes('error TS2552: cannot find name'));
		});

		test('includes filePath when provided', () => {
			const result = getFixFailingTestPrompt({ failingOutput: 'err', filePath: 'src/test.ts', relevantParts: {} });
			assert.ok(result.includes('src/test.ts'));
		});

		test('omits Failing file path label when filePath is undefined', () => {
			const result = getFixFailingTestPrompt({ failingOutput: 'err', relevantParts: {} });
			assert.ok(!result.includes('Failing file path:'));
		});

		test('includes currentContent when provided', () => {
			const result = getFixFailingTestPrompt({ failingOutput: 'err', currentContent: 'const x = 1;', relevantParts: {} });
			assert.ok(result.includes('const x = 1;'));
		});

		test('omits Current test file content label when currentContent is undefined', () => {
			const result = getFixFailingTestPrompt({ failingOutput: 'err', relevantParts: {} });
			assert.ok(!result.includes('Current test file content:'));
		});

		test('includes relevantParts JSON in the output', () => {
			const result = getFixFailingTestPrompt({ failingOutput: 'err', relevantParts: { extensionId: 'my.ext' } });
			assert.ok(result.includes('my.ext'));
		});
	});

	suite('getFixRuntimeFailurePrompt', () => {
		test('includes failingOutput in the output', () => {
			const result = getFixRuntimeFailurePrompt({ failingOutput: 'Timeout of 20000ms exceeded', relevantParts: {} });
			assert.ok(result.includes('Timeout of 20000ms exceeded'));
		});

		test('includes filePath when provided', () => {
			const result = getFixRuntimeFailurePrompt({ failingOutput: 'err', filePath: 'src/runtime.test.ts', relevantParts: {} });
			assert.ok(result.includes('src/runtime.test.ts'));
		});

		test('includes currentContent when provided', () => {
			const result = getFixRuntimeFailurePrompt({
				failingOutput: 'err',
				currentContent: 'await driver.findElement()',
				relevantParts: {},
			});
			assert.ok(result.includes('await driver.findElement()'));
		});

		test('includes relevantParts JSON in the output', () => {
			const result = getFixRuntimeFailurePrompt({ failingOutput: 'err', relevantParts: { extensionId: 'rt.ext' } });
			assert.ok(result.includes('rt.ext'));
		});

		test('omits Failing file path label when filePath is undefined', () => {
			const result = getFixRuntimeFailurePrompt({ failingOutput: 'err', relevantParts: {} });
			assert.ok(!result.includes('Failing file path:'));
		});

		test('omits Current test file content label when currentContent is undefined', () => {
			const result = getFixRuntimeFailurePrompt({ failingOutput: 'err', relevantParts: {} });
			assert.ok(!result.includes('Current test file content:'));
		});
	});
});
