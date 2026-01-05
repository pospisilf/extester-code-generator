import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../logger/logger';
import { TestProposal } from '../types/testTypes';
import { getTestFileContentPrompt } from './prompts';

/**
 * Metadata describing a generated test file.
 *
 * @interface TestFile
 * @property {string} name - Basename including extension.
 * @property {string} content - Text written to disk.
 * @property {string} path - Absolute path to the file on disk.
 */
export interface TestFile {
	name: string;
	content: string;
	path: string;
}

/**
 * Ensures the base `src/ui-test` directory exists under the current workspace.
 *
 * @param {string} basePath - Workspace root where the folder should live.
 * @returns {Promise<string>} Absolute path to the ensured directory.
 */
export async function createTestDirectory(basePath: string): Promise<string> {
	const testDir = path.join(basePath, 'src', 'ui-test');
	if (!fs.existsSync(testDir)) {
		await fs.promises.mkdir(testDir, { recursive: true });
	}
	return testDir;
}

/**
 * Creates a subdirectory for a proposal category when it does not already exist.
 *
 * @param {string} testDir - Root UI test directory.
 * @param {string} category - Proposal category used as the folder name.
 * @returns {Promise<string>} Absolute path to the ensured category directory.
 */
export async function createCategoryDirectory(testDir: string, category: string): Promise<string> {
	const categoryDir = path.join(testDir, category);
	if (!fs.existsSync(categoryDir)) {
		await fs.promises.mkdir(categoryDir, { recursive: true });
	}
	return categoryDir;
}

/**
 * Writes a test file within the provided directory and returns its metadata.
 *
 * @param {string} testDir - Directory where the file will be created.
 * @param {string} fileName - Target filename, typically ending in `.test.ts`.
 * @param {string} content - TypeScript file contents to persist.
 * @returns {Promise<TestFile>} Metadata about the newly created file.
 */
export async function createTestFile(testDir: string, fileName: string, content: string): Promise<TestFile> {
	const filePath = path.join(testDir, fileName);
	await fs.promises.writeFile(filePath, content, 'utf8');
	return {
		name: fileName,
		content,
		path: filePath,
	};
}

/**
 * Convenience helper that ensures the primary UI test directory exists.
 *
 * @param {string} workspacePath - Workspace root path.
 * @returns {Promise<string>} Absolute path to the UI test directory.
 */
export async function ensureTestDirectoryExists(workspacePath: string): Promise<string> {
	const testDir = await createTestDirectory(workspacePath);
	return testDir;
}

/**
 * Creates a placeholder test file that developers can later fill in manually.
 *
 * @param {string} categoryDir - Directory representing the test category.
 * @param {string} testName - Logical name of the test proposal.
 * @returns {Promise<TestFile>} Metadata about the placeholder file.
 */
export async function createEmptyTestFile(categoryDir: string, testName: string): Promise<TestFile> {
	const fileName = `${testName}.test.ts`;
	const content = `import * as assert from 'assert';
import * as vscode from 'vscode';

describe('${testName}', () => {
    it('should pass', async () => {
        // TODO: Implement test
    });
});`;

	return createTestFile(categoryDir, fileName, content);
}

/**
 * Generates a full ExTester file using an AI model and writes it to disk.
 *
 * @param {string} categoryDir - Folder where the file should be created.
 * @param {TestProposal} testProposal - Proposal describing the scenario to implement.
 * @param {any} relevantParts - Manifest metadata to include in the prompt.
 * @param {Logger} logger - Logger instance for tracing the generation lifecycle.
 * @param {(logger: Logger, prompt: string) => Promise<string>} model - Function that fulfills the prompt using OpenAI.
 * @returns {Promise<TestFile>} Metadata for the generated test file.
 */
export async function generateAndWriteTestContent(
	categoryDir: string,
	testProposal: TestProposal,
	relevantParts: any,
	logger: Logger,
	model: (logger: Logger, prompt: string) => Promise<string>,
): Promise<TestFile> {
	const log = logger.withScope('TestFileUtils/generateAndWriteTestContent');
	const fileName = `${testProposal['test-name']}.test.ts`;

	log.info(`Generating content for ${fileName}`);

	// Generate content using AI
	const prompt = getTestFileContentPrompt(testProposal, relevantParts);
	const generatedContent = await model(logger, prompt);

	// Clean the response if needed (remove markdown formatting)
	let cleanedContent = generatedContent.trim();
	cleanedContent = cleanedContent.replace(/```typescript\n?/g, '').replace(/```\n?/g, '');

	if (cleanedContent.startsWith('\n')) {
		cleanedContent = cleanedContent.substring(1);
	}

	log.info(`Generated content for ${fileName} (${cleanedContent.length} characters)`);

	return createTestFile(categoryDir, fileName, cleanedContent);
}
