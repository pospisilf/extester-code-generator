import * as vscode from 'vscode';
import OpenAI from 'openai';
import { Logger } from '../logger/logger';

let OpenAIClass: typeof OpenAI = OpenAI;

/**
 * Internal helper that allows tests to replace the OpenAI constructor.
 *
 * @param {typeof OpenAI | undefined} replacement - Alternate constructor used for dependency injection.
 */
export function __setOpenAIClassForTests(replacement?: typeof OpenAI) {
	OpenAIClass = replacement ?? OpenAI;
}

/**
 * Retrieves the OpenAI API key from VS Code workspace settings.
 *
 * @returns {string | undefined} The API key string if configured; otherwise undefined.
 */
export function getApiKey(): string | undefined {
	return vscode.workspace.getConfiguration('extester-test-generator').get<string>('apiKey');
}

/**
 * Sends a natural language prompt to OpenAI's gpt-5 chat model and returns the response text.
 *
 * @param {Logger} logger - Logger used for recording token usage and failures.
 * @param {string} prompt - Fully constructed instruction set sent to OpenAI.
 * @returns {Promise<string>} Message text returned by the model, an empty string when no API key is configured, or a user-friendly error message if the call fails.
 */
export async function askChatGPT(logger: Logger, prompt: string): Promise<string> {
	const log = logger.withScope('OpenAI/askChatGPT');
	// Check if API key is configured in settings
	const apiKey = getApiKey();
	if (!apiKey) {
		vscode.window.showErrorMessage('OpenAI API key missing. Set extester-test-generator.apiKey in settings and try again.');
		return '';
	}

	// Initialize OpenAI client with the API key
	const openai = new OpenAIClass({ apiKey });

	try {
		// Send request to OpenAI API using the gpt-5 chat-completions model
		const completion = await openai.chat.completions.create({
			model: 'gpt-5',
			// reasoning_effort: "medium",
			messages: [{ role: 'user', content: prompt }],
			// max_tokens: 4096, // Limit response length to 150 tokens
			// max_completion_tokens: 4096,
		});

		// Log token usage information
		log.info(
			`Input tokens: ${completion.usage?.prompt_tokens}, output tokens: ${completion.usage?.completion_tokens}, total: ${completion.usage?.total_tokens}`,
		);

		return completion.choices[0].message.content || '';
	} catch (error) {
		// Log the error and show user-friendly error message
		log.error(`OpenAI API Error: ${error}`);
		if (error instanceof Error) {
			vscode.window.showErrorMessage(`Error calling OpenAI API: ${error.message}`);
		} else {
			vscode.window.showErrorMessage('Error calling OpenAI API: Unknown error');
		}
		return 'An error occurred while fetching the response.';
	}
}

/**
 * Sends a coding-focused prompt to OpenAI's gpt-5-codex responses model for code generation.
 *
 * @param {Logger} logger - Logger used for tracing latency, usage, and failures.
 * @param {string} prompt - Instruction text describing the desired code output.
 * @returns {Promise<string>} Full model response text, or an error description when unavailable.
 */
export async function askCodex(logger: Logger, prompt: string): Promise<string> {
	const log = logger.withScope('OpenAI/askCodex');
	// Check if API key is configured in settings
	const apiKey = getApiKey();
	if (!apiKey) {
		vscode.window.showErrorMessage('OpenAI API key missing. Set extester-test-generator.apiKey in settings and try again.');
		return '';
	}

	// Initialize OpenAI client with the API key
	const openai = new OpenAIClass({ apiKey });

	try {
		const startTime = Date.now();
		// Send request to OpenAI API using the gpt-5-codex responses endpoint
		const completion = await openai.responses.create({
			model: 'gpt-5-codex',
			input: prompt,
			reasoning: { effort: 'medium' },
		});

		// Log processing duration
		const durationMs = Date.now() - startTime;
		log.info(`OpenAI processing time: ${durationMs}ms`);

		// Log token usage information
		log.info(
			`Input tokens: ${completion.usage?.input_tokens}, output tokens: ${completion.usage?.output_tokens}, total: ${completion.usage?.total_tokens}`,
		);

		return completion.output_text || '';
	} catch (error) {
		// Log the error and show user-friendly error message
		log.error(`OpenAI API Error: ${error}`);
		if (error instanceof Error) {
			vscode.window.showErrorMessage(`Error calling OpenAI API: ${error.message}`);
		} else {
			vscode.window.showErrorMessage('Error calling OpenAI API: Unknown error');
		}
		return 'An error occurred while fetching the response.';
	}
}
