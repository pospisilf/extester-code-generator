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

import * as vscode from 'vscode';
import { Logger } from '../logger/logger';

/**
 * Provides the tree data for the Generator panel inside VS Code.
 *
 * @implements {vscode.TreeDataProvider<vscode.TreeItem>}
 */
export class GeneratorViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private logger: Logger;

	/**
	 * Creates a new instance of `GeneratorViewProvider`.
	 *
	 * @param {Logger} logger - Logger instance for debugging and error tracking.
	 */
	constructor(logger: Logger) {
		this.logger = logger;
		this.logger.withScope('GeneratorViewProvider').debug('Generator view created.');
	}

	/**
	 * Event emitter that notifies VS Code when the tree view data has changed.
	 * This is used to refresh the view when updates occur.
	 */
	private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | void> = new vscode.EventEmitter();
	readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | void> = this._onDidChangeTreeData.event;

	/**
	 * Mirrors the element provided by VS Code back to the tree view.
	 *
	 * @param {vscode.TreeItem} element - Tree item requested by the view.
	 * @returns {vscode.TreeItem} The element, unchanged.
	 */
	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	/**
	 * Provides the root nodes for the command-centric tree view.
	 *
	 * @returns {Thenable<vscode.TreeItem[]>} Promise resolving to available command entries.
	 */
	getChildren(): Thenable<vscode.TreeItem[]> {
		// Step 1: Generate test proposals and individual test files/cases
		// Create a tree item for generating test proposals
		const testProposalItem = new vscode.TreeItem('Generate Test Proposals', vscode.TreeItemCollapsibleState.None);
		testProposalItem.command = {
			command: 'extester-test-generator.generateTestProposals',
			title: 'Generate Test Proposals',
		};
		testProposalItem.iconPath = new vscode.ThemeIcon('beaker');

		// Step 2: Fix compilation issues
		// Create a tree item for fixing compilation issues
		const fixCompilationItem = new vscode.TreeItem('Fix Compilation Issues', vscode.TreeItemCollapsibleState.None);
		fixCompilationItem.command = {
			command: 'extester-test-generator.fixCompilationIssues',
			title: 'Fix Compilation Issues',
		};
		fixCompilationItem.iconPath = new vscode.ThemeIcon('tools');

		// // Create a tree item for running tests
		// const runTestsItem = new vscode.TreeItem(
		//   "Run Tests",
		//   vscode.TreeItemCollapsibleState.None
		// );
		// runTestsItem.command = {
		//   command: "extester-test-generator.runTests",
		//   title: "Run Tests",
		// };
		// runTestsItem.iconPath = new vscode.ThemeIcon("play");

		// Create a tree item for fixing runtime failures
		const fixRuntimeItem = new vscode.TreeItem('Fix Runtime Failures', vscode.TreeItemCollapsibleState.None);
		fixRuntimeItem.command = {
			command: 'extester-test-generator.fixRuntimeFailures',
			title: 'Fix Runtime Failures',
		};
		fixRuntimeItem.iconPath = new vscode.ThemeIcon('debug-console');

		// return Promise.resolve([testProposalItem, runTestsItem, fixCompilationItem, fixRuntimeItem]);
		return Promise.resolve([testProposalItem, fixCompilationItem, fixRuntimeItem]);
	}

	/**
	 * Refreshes the tree view by firing the change event.
	 * This should be called whenever the view needs to be updated.
	 */
	refresh(): void {
		this._onDidChangeTreeData.fire();
	}
}
