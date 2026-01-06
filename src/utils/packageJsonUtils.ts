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
 * Loads the first package.json in the workspace and returns its JSON string representation.
 *
 * @param {Logger} logger - Logger used to report lookup failures.
 * @returns {Promise<string>} Serialized package.json contents.
 * @throws {Error} When no package.json can be located within the workspace scope.
 */
// find package.json in workspace
export async function readPackageJsoAsString(logger: Logger): Promise<string> {
	const log = logger.withScope('PackageJsonUtils/readPackageJson');
	const packageJsonUri = await findPackageJson(logger);
	if (packageJsonUri) {
		const content = await vscode.workspace.fs.readFile(packageJsonUri);
		const packageJson = JSON.parse(content.toString());
		return JSON.stringify(packageJson);
	}
	log.error('No package.json found in workspace');
	throw new Error('No package.json found in workspace');
}

/**
 * Finds the first package.json file located in the current workspace.
 *
 * @param {Logger} logger - Logger used to capture discovery or filesystem errors.
 * @returns {Promise<vscode.Uri | undefined>} The URI of the package.json file if found; otherwise undefined.
 */
export async function findPackageJson(logger: Logger): Promise<vscode.Uri | undefined> {
	const log = logger.withScope('PackageJsonUtils/findPackageJson');
	try {
		const packageJsonFiles = await vscode.workspace.findFiles('**/package.json');
		if (packageJsonFiles.length > 0) {
			// Return the first package.json found (usually the root one)
			return packageJsonFiles[0];
		}
		return undefined;
	} catch (error) {
		log.error(`Error finding package.json: ${error}`);
		return undefined;
	}
}

/**
 * Extracts AI-relevant metadata from the package.json manifest.
 *
 * @param {string} packageJson - Raw package.json string that will be parsed.
 * @param {Logger} logger - Logger used to trace the derived metadata.
 * @returns {Promise<any>} Object containing extension identifiers, commands, menus, and configuration snippets.
 */
export async function getRelevantParts(packageJson: string, logger: Logger): Promise<any> {
	const log = logger.withScope('PackageJsonUtils/getRelevantParts');
	let manifestData: any;

	// Analyze package.json content
	if (packageJson) {
		const parsedJson = JSON.parse(packageJson);

		// Get Extension ID
		const extensionId = `${parsedJson.publisher}.${parsedJson.name}`;

		// Get Activation Events
		const activationEvents = parsedJson.activationEvents || [];

		// Get Commands
		const commands = parsedJson.contributes?.commands || [];

		// Get Menus & Context Menus
		const menus = parsedJson.contributes?.menus || {};
		const submenus = parsedJson.contributes?.submenus || {};

		// Get Welcome View
		const viewsWelcome = parsedJson.contributes?.viewsWelcome || [];

		// Get Configuration Settings
		const configProperties = parsedJson.contributes?.configuration?.properties || {};

		// Create an array of manifest data for analysis
		manifestData = {
			extensionId: extensionId,
			activationEvents: activationEvents,
			commands: commands,
			menus: menus,
			submenus: submenus,
			viewsWelcome: viewsWelcome,
			configProperties: configProperties,
		};

		log.info(`Manifest data prepared for analysis: ${JSON.stringify(manifestData, null, 2)}`);
	}

	// Export manifest data for external use
	return manifestData;
}
