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
