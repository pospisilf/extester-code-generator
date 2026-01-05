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
 * Describes a single proposed test scenario produced by the generator.
 *
 * @interface TestProposal
 * @property {string} category - Functional grouping the proposal belongs to.
 * @property {string} test-name - Human readable identifier for the proposal.
 * @property {string} description - Narrative explanation of what the test covers.
 * @property {string[]} cover - Code areas, features, or tags the test is expected to exercise.
 */
export interface TestProposal {
	category: string;
	'test-name': string;
	description: string;
	cover: string[];
}

/**
 * Captures all details required to execute a generated test case.
 *
 * @interface TestCase
 * @property {string} name - Identifier that the executor uses for the test.
 * @property {string} description - Summary of the behaviour validated by the test.
 * @property {string} expectedResult - Outcome that determines if the test passes.
 * @property {string} [setup] - Optional preparation steps before the test runs.
 * @property {string} [teardown] - Optional cleanup steps after the test finishes.
 */
export interface TestCase {
	name: string;
	description: string;
	expectedResult: string;
	setup?: string;
	teardown?: string;
}

/**
 * Aggregates generated proposals and any optional metadata about the run.
 *
 * @interface TestGenerationResult
 * @property {TestProposal[]} proposals - Collection of proposed tests.
 * @property {string} [summary] - Optional textual summary of the generation.
 * @property {string} [timestamp] - Optional ISO timestamp describing when generation occurred.
 */
export interface TestGenerationResult {
	proposals: TestProposal[];
	summary?: string;
	timestamp?: string;
}

/**
 * Wraps raw proposals with default metadata such as the generation timestamp.
 *
 * @param {TestProposal[]} rawProposals - Proposals returned by the generator.
 * @returns {TestGenerationResult} An object containing proposals and metadata.
 */
export function convertToTestGenerationResult(rawProposals: TestProposal[]): TestGenerationResult {
	return {
		proposals: rawProposals,
		timestamp: new Date().toISOString(),
	};
}
