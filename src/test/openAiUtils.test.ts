import * as assert from 'assert';
import * as vscode from 'vscode';
import { askChatGPT, askCodex, __setOpenAIClassForTests } from '../utils/openAiUtils';
import { Logger } from '../logger/logger';

suite('openAiUtils', () => {
	const originalGetConfiguration = vscode.workspace.getConfiguration;
	const originalShowErrorMessage = vscode.window.showErrorMessage;

	teardown(() => {
		(vscode.workspace as any).getConfiguration = originalGetConfiguration;
		(vscode.window as any).showErrorMessage = originalShowErrorMessage;
		__setOpenAIClassForTests();
	});

	function stubConfiguration(apiKey: string | undefined) {
		(vscode.workspace as any).getConfiguration = () =>
			({
				get: () => apiKey,
			}) as any;
	}

	function stubShowErrorMessage(): string[] {
		const messages: string[] = [];
		(vscode.window as any).showErrorMessage = (message: string) => {
			messages.push(message);
			return Promise.resolve(undefined);
		};
		return messages;
	}

	function createTestLogger() {
		const lines: string[] = [];
		const outputChannel: vscode.OutputChannel = {
			name: 'test',
			append: () => undefined,
			appendLine: (value: string) => {
				lines.push(value);
			},
			replace: () => undefined,
			clear: () => undefined,
			show: () => undefined,
			hide: () => undefined,
			dispose: () => undefined,
		};

		return {
			logger: new Logger(outputChannel),
			lines,
		};
	}

	test('askChatGPT returns empty string and shows error when API key is missing', async () => {
		stubConfiguration(undefined);
		const messages = stubShowErrorMessage();
		let constructed = false;

		class TestOpenAI {
			constructor() {
				constructed = true;
			}
		}

		__setOpenAIClassForTests(TestOpenAI as any);
		const { logger } = createTestLogger();

		const result = await askChatGPT(logger, 'prompt');

		assert.strictEqual(result, '');
		assert.strictEqual(messages.length, 1);
		assert.ok(messages[0].includes('API key missing'));
		assert.strictEqual(constructed, false);
	});

	test('askChatGPT uses gpt-5 model and logs token usage on success', async () => {
		stubConfiguration('test-key');
		const messages = stubShowErrorMessage();
		const { logger, lines } = createTestLogger();

		const chatResponse = {
			choices: [{ message: { content: 'hello world' } }],
			usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
		};

		let recordedArgs: any;
		let receivedKey: string | undefined;

		class TestOpenAI {
			public chat = {
				completions: {
					create: async (args: any) => {
						recordedArgs = args;
						return chatResponse;
					},
				},
			};

			public responses = {
				create: async () => {
					throw new Error('responses call not expected');
				},
			};

			constructor(config: { apiKey: string }) {
				receivedKey = config.apiKey;
			}
		}

		__setOpenAIClassForTests(TestOpenAI as any);

		const result = await askChatGPT(logger, 'Hello AI');

		assert.strictEqual(result, 'hello world');
		assert.strictEqual(messages.length, 0);
		assert.strictEqual(receivedKey, 'test-key');
		assert.strictEqual(recordedArgs.model, 'gpt-5');
		assert.deepStrictEqual(recordedArgs.messages, [{ role: 'user', content: 'Hello AI' }]);
		assert.ok(lines.some((line) => line.includes('Input tokens: 10')));
	});

	test('askChatGPT surfaces friendly error message when OpenAI call fails', async () => {
		stubConfiguration('test-key');
		const messages = stubShowErrorMessage();
		const { logger, lines } = createTestLogger();

		class TestOpenAI {
			public chat = {
				completions: {
					create: async () => {
						throw new Error('boom');
					},
				},
			};

			public responses = {
				create: async () => {
					throw new Error('responses call not expected');
				},
			};

			constructor() {}
		}

		__setOpenAIClassForTests(TestOpenAI as any);

		const result = await askChatGPT(logger, 'Hello AI');

		assert.strictEqual(result, 'An error occurred while fetching the response.');
		assert.strictEqual(messages.length, 1);
		assert.ok(messages[0].includes('boom'));
		assert.ok(lines.some((line) => line.includes('OpenAI API Error')));
	});

	test('askCodex returns empty string when API key is missing', async () => {
		stubConfiguration(undefined);
		const messages = stubShowErrorMessage();
		let constructed = false;

		class TestOpenAI {
			constructor() {
				constructed = true;
			}
		}

		__setOpenAIClassForTests(TestOpenAI as any);
		const { logger } = createTestLogger();

		const result = await askCodex(logger, 'prompt');

		assert.strictEqual(result, '');
		assert.strictEqual(messages.length, 1);
		assert.ok(messages[0].includes('API key missing'));
		assert.strictEqual(constructed, false);
	});

	test('askCodex sends reasoning metadata and returns generated output', async () => {
		stubConfiguration('codex-key');
		const messages = stubShowErrorMessage();
		const { logger, lines } = createTestLogger();

		const responsesResult = {
			output_text: 'generated code',
			usage: { input_tokens: 5, output_tokens: 8, total_tokens: 13 },
		};

		let recordedArgs: any;
		let receivedKey: string | undefined;

		class TestOpenAI {
			public chat = {
				completions: {
					create: async () => {
						throw new Error('chat call not expected');
					},
				},
			};

			public responses = {
				create: async (args: any) => {
					recordedArgs = args;
					return responsesResult;
				},
			};

			constructor(config: { apiKey: string }) {
				receivedKey = config.apiKey;
			}
		}

		__setOpenAIClassForTests(TestOpenAI as any);

		const result = await askCodex(logger, 'build code');

		assert.strictEqual(result, 'generated code');
		assert.strictEqual(messages.length, 0);
		assert.strictEqual(receivedKey, 'codex-key');
		assert.strictEqual(recordedArgs.model, 'gpt-5-codex');
		assert.strictEqual(recordedArgs.input, 'build code');
		assert.deepStrictEqual(recordedArgs.reasoning, { effort: 'medium' });
		assert.ok(lines.some((line) => line.includes('OpenAI processing time')));
		assert.ok(lines.some((line) => line.includes('Input tokens: 5')));
	});

	test('askCodex surfaces friendly error message when responses call fails', async () => {
		stubConfiguration('codex-key');
		const messages = stubShowErrorMessage();
		const { logger, lines } = createTestLogger();

		class TestOpenAI {
			public chat = {
				completions: {
					create: async () => {
						throw new Error('chat call not expected');
					},
				},
			};

			public responses = {
				create: async () => {
					throw new Error('codex boom');
				},
			};

			constructor() {}
		}

		__setOpenAIClassForTests(TestOpenAI as any);

		const result = await askCodex(logger, 'build code');

		assert.strictEqual(result, 'An error occurred while fetching the response.');
		assert.strictEqual(messages.length, 1);
		assert.ok(messages[0].includes('codex boom'));
		assert.ok(lines.some((line) => line.includes('OpenAI API Error')));
	});
});
