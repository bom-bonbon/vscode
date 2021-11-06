/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as playwright from 'playwright';
import * as kill from 'tree-kill';
import { ChildProcess, spawn } from 'child_process';
import { join } from 'path';
import { mkdir } from 'fs';
import { promisify } from 'util';
import { IDriver } from './driver';
import { URI } from 'vscode-uri';

const root = join(__dirname, '..', '..', '..');

const vscodeToPlaywrightKey: { [key: string]: string } = {
	cmd: 'Meta',
	ctrl: 'Control',
	shift: 'Shift',
	enter: 'Enter',
	escape: 'Escape',
	right: 'ArrowRight',
	up: 'ArrowUp',
	down: 'ArrowDown',
	left: 'ArrowLeft',
	home: 'Home',
	esc: 'Escape'
};

let traceCounter = 1;

function buildDriver(context: playwright.BrowserContext, page: playwright.Page, logsPath: string): IDriver {
	const driver: IDriver = {
		_serviceBrand: undefined,
		waitForReady: () => page.evaluate('window.driver.waitForReady()'),
		reloadWindow: () => page.evaluate('window.driver.reloadWindow()'),
		exitApplication: async () => {
			try {
				await context.tracing.stop({ path: join(logsPath, `playwright-trace-${traceCounter++}.zip`) });
			} catch (error) {
				console.warn(`Failed to stop playwright tracing.`); // do not fail the build when this fails
			}
			await page.evaluate('window.driver.exitApplication()');
			await disconnect();
		},
		dispatchKeybinding: async (keybinding) => {
			const chords = keybinding.split(' ');
			for (let i = 0; i < chords.length; i++) {
				const chord = chords[i];
				if (i > 0) {
					await timeout(100);
				}
				const keys = chord.split('+');
				const keysDown: string[] = [];
				for (let i = 0; i < keys.length; i++) {
					if (keys[i] in vscodeToPlaywrightKey) {
						keys[i] = vscodeToPlaywrightKey[keys[i]];
					}
					await page.keyboard.down(keys[i]);
					keysDown.push(keys[i]);
				}
				while (keysDown.length > 0) {
					await page.keyboard.up(keysDown.pop()!);
				}
			}

			await timeout(100);
		},
		click: async (selector, xoffset, yoffset) => {
			const { x, y } = await driver.getElementXY(selector, xoffset, yoffset);
			await page.mouse.click(x + (xoffset ? xoffset : 0), y + (yoffset ? yoffset : 0));
		},
		doubleClick: async (selector) => {
			const { x, y } = await driver.getElementXY(selector);
			await page.mouse.dblclick(x, y);
		},
		setValue: async (selector, text) => await page.evaluate(`window.driver.setValue('${selector}', '${text}')`),
		getTitle: () => page.evaluate('window.driver.getTitle()'),
		isActiveElement: (selector) => page.evaluate(`window.driver.isActiveElement('${selector}')`),
		getElements: (selector, recursive) => page.evaluate(`window.driver.getElements('${selector}', ${recursive})`),
		getElementXY: (selector, xoffset?, yoffset?) => page.evaluate(`window.driver.getElementXY('${selector}', ${xoffset}, ${yoffset})`),
		typeInEditor: (selector, text) => page.evaluate(`window.driver.typeInEditor('${selector}', '${text}')`),
		getTerminalBuffer: (selector) => page.evaluate(`window.driver.getTerminalBuffer('${selector}')`),
		writeInTerminal: (selector, text) => page.evaluate(`window.driver.writeInTerminal('${selector}', '${text}')`),
		getLocaleInfo: () => page.evaluate('window.driver.getLocaleInfo()'),
		getLocalizedStrings: () => page.evaluate('window.driver.getLocalizedStrings()')
	};
	return driver;
}

function timeout(ms: number): Promise<void> {
	return new Promise<void>(r => setTimeout(r, ms));
}

let port = 9000;
let server: ChildProcess | undefined;
let endpoint: string | undefined;
let workspacePath: string | undefined;

export async function connectServer(userDataDir: string, _workspacePath: string, codeServerPath = process.env.VSCODE_REMOTE_SERVER_PATH, extPath: string, verbose: boolean): Promise<void> {
	workspacePath = _workspacePath;

	const logsPath = join(root, '.build', 'logs', 'smoke-tests-browser');

	const agentFolder = userDataDir;
	await promisify(mkdir)(agentFolder);
	const env = {
		VSCODE_AGENT_FOLDER: agentFolder,
		VSCODE_REMOTE_SERVER_PATH: codeServerPath,
		...process.env
	};

	const args = ['--disable-telemetry', '--port', `${port++}`, '--browser', 'none', '--enable-driver', '--extensions-dir', extPath];

	let serverLocation: string | undefined;
	if (codeServerPath) {
		serverLocation = join(codeServerPath, `server.${process.platform === 'win32' ? 'cmd' : 'sh'}`);
		args.push(`--logsPath=${logsPath}`);

		if (verbose) {
			console.log(`Starting built server from '${serverLocation}'`);
			console.log(`Storing log files into '${logsPath}'`);
		}
	} else {
		serverLocation = join(root, `resources/server/web.${process.platform === 'win32' ? 'bat' : 'sh'}`);
		args.push('--logsPath', logsPath);

		if (verbose) {
			console.log(`Starting server out of sources from '${serverLocation}'`);
			console.log(`Storing log files into '${logsPath}'`);
		}
	}

	server = spawn(
		serverLocation,
		args,
		{ env }
	);

	if (verbose) {
		server.stderr?.on('data', error => console.log(`Server stderr: ${error}`));
		server.stdout?.on('data', data => console.log(`Server stdout: ${data}`));
	}

	endpoint = await waitForEndpoint();
}

function waitForEndpoint(): Promise<string> {
	return new Promise<string>(r => {
		server?.stdout?.on('data', (d: Buffer) => {
			const matches = d.toString('ascii').match(/Web UI available at (.+)/);
			if (matches !== null) {
				r(matches[1]);
			}
		});
	});
}

interface BrowserOptions {
	readonly browser?: 'chromium' | 'webkit' | 'firefox';
	readonly headless?: boolean;
}

let browser: playwright.Browser | undefined = undefined;

export interface IAsyncDisposable {
	dispose(): Promise<void>;
}

export async function connectBrowser(options: BrowserOptions = {}): Promise<{ client: IAsyncDisposable, driver: IDriver }> {
	browser = await playwright[options.browser ?? 'chromium'].launch({ headless: options.headless ?? false });
	const context = await browser.newContext();
	try {
		await context.tracing.start({ screenshots: true, snapshots: true });
	} catch (error) {
		console.warn(`Failed to start playwright tracing.`); // do not fail the build when this fails
	}

	const page = await context.newPage();
	await page.setViewportSize({ width: 1200, height: 800 });

	page.on('pageerror', error => console.error(`Playwright ERROR: page error: ${error}`));
	page.on('crash', () => console.error('Playwright ERROR: page crash'));
	page.on('response', response => {
		if (response.status() >= 400) {
			console.error(`Playwright ERROR: HTTP status ${response.status()} for ${response.url()}`);
		}
	});

	const payloadParam = `[["enableProposedApi",""],["skipWelcome","true"]]`;
	await page.goto(`${endpoint}&folder=vscode-remote://localhost:9888${URI.file(workspacePath!).path}&payload=${payloadParam}`);

	return {
		client: {
			dispose: () => disconnect()
		},
		driver: buildDriver(context, page, join(root, '.build', 'logs', 'smoke-tests-browser'))
	};
}

interface ElectronOptions {
	readonly executablePath: string;
	readonly args?: string[];
	readonly env?: NodeJS.ProcessEnv;
}

let electron: playwright.ElectronApplication | undefined = undefined;

export async function connectElectron(options: ElectronOptions): Promise<{ client: IAsyncDisposable, driver: IDriver }> {
	electron = await playwright._electron.launch({
		executablePath: options.executablePath,
		args: options.args,
		env: options.env as { [key: string]: string; } // Playwright typings fail
	});

	const window = await electron.firstWindow();
	const context = window.context();
	try {
		await context.tracing.start({ screenshots: true, snapshots: true });
	} catch (error) {
		console.warn(`Failed to start playwright tracing.`); // do not fail the build when this fails
	}

	window.on('requestfailed', request => console.error(`Playwright ERROR: HTTP status ${request}`));
	window.on('pageerror', error => console.error(`Playwright ERROR: window error: ${error}`));
	window.on('crash', () => console.error('Playwright ERROR: window crash'));
	window.on('response', response => {
		if (response.status() >= 400) {
			console.error(`Playwright ERROR: HTTP status ${response.status()} for ${response.url()}`);
		}
	});

	return {
		client: {
			dispose: () => disconnect()
		},
		driver: buildDriver(context, window, join(root, '.build', 'logs', 'smoke-tests'))
	};
}

export async function disconnect(): Promise<void> {
	let teardownPromises: Promise<void>[] = [];

	if (server) {
		teardownPromises.push((async () => {
			try {
				await new Promise<void>((resolve, reject) => kill(server!.pid, err => err ? reject(err) : resolve()));
			} catch {
				// noop
			}

			server = undefined;
		})());
	}

	if (browser) {
		teardownPromises.push((async () => {
			try {
				await browser.close();
			} catch (error) {
				// noop
			}

			browser = undefined;
		})());
	}

	if (electron) {
		teardownPromises.push((async () => {
			try {
				await electron.close();
			} catch (error) {
				// noop
			}

			electron = undefined;
		})());
	}

	try {
		await Promise.all(teardownPromises);
	} catch (error) {
		console.error(error);
	}
}