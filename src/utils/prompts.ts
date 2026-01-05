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
 * Builds the system/user prompt instructing GPT to produce structured test proposals.
 *
 * @param {any} relevantParts - Extracted manifest details that provide context about the extension.
 * @returns {string} Fully formatted prompt ready for OpenAI consumption.
 */
export function getTestProposalPrompt(relevantParts: any): string {
	return `
  You are an expert test proposal generator for VS Code extensions.

  ## Objective
  Analyze the provided VS Code extension context (package.json) and generate a comprehensive list of **UI test proposals** that would ensure strong coverage.
 
  ## Input
  Extension context (package.json):
  ${JSON.stringify(relevantParts, null, 2)}

  ## Output Requirements
  Return **only valid JSON** and nothing else.
  - The root must be a JSON array.
  - Each element is an object with the following exact keys:
    - "category": string - logical test area (e.g. "views", "commands", "panels", "dialogs")
    - "test-name": string - concise, descriptive identifier in camelCase
    - "description": string - clear explanation of the test's goal
    - "cover": array<string> - names of features, commands, or code areas covered

  ## Additional Guidance
  - “category” refers to the UI area or functional group, **not** to testing level (unit/integration/UI).
  - Include as many distinct, meaningful test ideas as possible.
  - Ensure each idea is realistic and relevant to VS Code UI interactions.

  ## Example Format
  [
    {
      "category": "views",
      "test-name": "calculateSumHandlesNegative",
      "description": "Verifies that calculateSum correctly adds two numbers when one or both are negative.",
      "cover": ["calculateSum", "errorHandling"]
    },
    {
      "category": "commands",
      "test-name": "userLoginFlow",
      "description": "Checks the full login flow including authentication service and session store.",
      "cover": ["AuthService.login", "SessionStore.createSession"]
    }
  ]

  ## Expected Output
  Strictly output valid JSON matching the above schema.
  `;
}

/**
 * Generates the instruction text for producing a runnable ExTester file from a proposal.
 *
 * @param {any} testProposal - Proposal selected for implementation.
 * @param {any} relevantParts - Manifest context that helps shape the test.
 * @returns {string} Prompt instructing the model to emit a full TypeScript test file.
 */
export function getTestFileContentPrompt(testProposal: any, relevantParts: any): string {
	return `
  You are a TypeScript test file generator specialized in the ExTester framework for VS Code extensions.

  ## Objective
  Generate a **complete runnable test file** implementing the following proposal.

  ## Input
  Test proposal:
  - Name: ${testProposal['test-name']}
  - Category: ${testProposal.category}
  - Description: ${testProposal.description}
  - Coverage Areas: ${testProposal.cover.join(', ')}

  Extension context:
  ${JSON.stringify(relevantParts, null, 2)}

  ## Output Requirements
  Output **only** the full TypeScript test file content (no explanations, no markdown).

  The test file must:
  - Use \`vscode-extension-tester\` imports (VSBrowser, WebDriver, Workbench, etc.)
  - Follow ExTester async/await style
  - Contain realistic UI interactions and assertions relevant to the described coverage
  - Include setup (\`before\`) and teardown (\`after\`) sections as needed
  - Contain one \`it()\` block implementing the described scenario
  - Use \`chai.expect\` for assertions
  - Be runnable and syntactically correct

  ## Template
  import { VSBrowser, WebDriver, EditorView, ActivityBar, Workbench, SideBarView } from 'vscode-extension-tester';
  import { expect } from 'chai';

  describe('${testProposal.category} - ${testProposal['test-name']}', () => {
      let driver: WebDriver;
      let workbench: Workbench;

      before(async function() {
          this.timeout(30000);
          driver = VSBrowser.instance.driver;
          workbench = new Workbench();
      });

      it('${testProposal.description}', async function() {
          this.timeout(20000);
          // Implement based on coverage areas: ${testProposal.cover.join(', ')}
      });

      after(async () => {
          // Cleanup if required
      });
  });
  `;
}

/**
 * Creates a prompt that requests a fixed test file for failures caused by compilation or logic errors.
 *
 * @param {{ failingOutput: string; filePath?: string; currentContent?: string; relevantParts: any }} args - Diagnostic artifact bundle passed to the AI.
 * @returns {string} Instruction asking the model to rewrite the broken test file.
 */
export function getFixFailingTestPrompt(args: { failingOutput: string; filePath?: string; currentContent?: string; relevantParts: any }): string {
	return `
  You are a TypeScript test fixer for the ExTester framework used in VS Code UI testing.

  ## Objective
  Analyze the provided failure and produce a **corrected, runnable** test file.

  ## Input
  Failure output:
  ${args.failingOutput}

  ${args.filePath ? `Failing file path: ${args.filePath}` : ''}

  ${args.currentContent ? `Current test file content:\n\n${args.currentContent}` : ''}

  Extension context:
  ${JSON.stringify(args.relevantParts, null, 2)}

  ## Task
  - Diagnose the likely failure cause based on the output and current content.
  - Rewrite the full TypeScript file with a corrected and stable version of the test.
  - Maintain all valid imports for \`vscode-extension-tester\` and common assertion libraries.
  - Ensure the new version is logically consistent, executable, and matches ExTester best practices.

  ## Output
  Return **only** the full corrected TypeScript test file content, with no markdown, comments, or explanations.
`;
}

/**
 * Builds a runtime-focused fixing prompt that emphasizes stability and explicit waits.
 *
 * @param {{ failingOutput: string; filePath?: string; currentContent?: string; relevantParts: any }} args - Diagnostic context for the failure.
 * @returns {string} Instruction for rewriting a flaky but compilable test file.
 */
export function getFixRuntimeFailurePrompt(args: { failingOutput: string; filePath?: string; currentContent?: string; relevantParts: any }): string {
	return `
  You are a TypeScript test fixer for the ExTester framework used in VS Code UI testing.

  ## Objective
  The test compiles and runs but fails at runtime (timeouts, missing elements, flakiness, navigation issues, WebDriver errors).
  Produce a corrected, stable, and runnable test file that addresses runtime causes.

  ## Input
  Failure output:
  ${args.failingOutput}

  ${args.filePath ? `Failing file path: ${args.filePath}` : ''}

  ${args.currentContent ? `Current test file content:\n\n${args.currentContent}` : ''}

  Extension context:
  ${JSON.stringify(args.relevantParts, null, 2)}

  ## Requirements
  - Ensure Workbench is ready before interactions (e.g., await new Workbench().getTitle() or similar readiness).
  - Open the correct view/panel before selecting elements (e.g., use ActivityBar, SideBarView, ViewControl).
  - Use stable locators. Avoid brittle text; prefer consistent labels/ids and robust queries.
  - Add explicit waits with sensible timeouts for elements and state transitions.
  - Introduce small retries around flaky steps (e.g., re-find and re-click).
  - Trigger required activation events/commands before assertions.
  - Keep imports limited to \`vscode-extension-tester\` and \`chai.expect\`.
  - Keep the overall scenario/intent intact.

  ## Output
  Return only the full corrected TypeScript test file content, no markdown, no extra text.
`;
}
