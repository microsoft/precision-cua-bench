// Copyright (c) Microsoft. All rights reserved.

import * as vscode from 'vscode';
import { BridgeServer } from './bridge-server';
import { injectPayload, uninjectPayload } from './injector';
import { runCollection, saveResults } from './collector';

const BRIDGE_PORT = 54321;
let isCollecting = false;
let bridge: BridgeServer | null = null;

export function activate(context: vscode.ExtensionContext) {
    console.log('cursorCoords: Extension activated');

    const startCmd = vscode.commands.registerCommand('cursorCoords.start', async () => {
        if (isCollecting) {
            vscode.window.showWarningMessage('Cursor coordinate collection is already running.');
            return;
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor. Open a file first.');
            return;
        }

        // Start WebSocket server
        bridge = new BridgeServer(BRIDGE_PORT);
        try {
            await bridge.start();
        } catch (err: any) {
            vscode.window.showErrorMessage(
                `Cursor Coords: Failed to start WebSocket server on port ${BRIDGE_PORT}: ${err.message}`
            );
            bridge = null;
            return;
        }

        isCollecting = true;
        vscode.window.showInformationMessage(
            `Cursor Coords: Server running on ws://127.0.0.1:${BRIDGE_PORT}. ` +
            `Starting collection on ${editor.document.fileName}`
        );

        // Wait for DOM payload to connect
        if (!bridge.isClientConnected) {
            vscode.window.showInformationMessage(
                'Cursor Coords: Waiting for DOM payload to connect… ' +
                'Make sure you have run "Cursor Coords: Inject DOM Payload" and reloaded VS Code.'
            );
        }

        // Run collection loop
        try {
            const result = await runCollection(bridge, () => isCollecting);

            if (result && result.records.length > 0) {
                // Save results
                const outputPath = saveResults(result);
                vscode.window.showInformationMessage(
                    `Cursor Coords: Done! Collected ${result.records.length} positions. Saved to ${outputPath}`
                );
            } else {
                vscode.window.showWarningMessage('Cursor Coords: Collection finished but no data was recorded.');
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Cursor Coords: Collection failed: ${err.message}`);
        } finally {
            isCollecting = false;
            if (bridge) {
                await bridge.stop();
                bridge = null;
            }
        }
    });

    const stopCmd = vscode.commands.registerCommand('cursorCoords.stop', async () => {
        if (!isCollecting) {
            vscode.window.showWarningMessage('No collection is running.');
            return;
        }

        isCollecting = false;

        // Shut down WebSocket server
        if (bridge) {
            await bridge.stop();
            bridge = null;
        }

        vscode.window.showInformationMessage('Cursor Coords: Collection stopped.');
    });

    const injectCmd = vscode.commands.registerCommand('cursorCoords.inject', async () => {
        try {
            await injectPayload(context);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Cursor Coords: Injection failed: ${err.message}`);
        }
    });

    const uninjectCmd = vscode.commands.registerCommand('cursorCoords.uninject', async () => {
        try {
            await uninjectPayload();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Cursor Coords: Uninjection failed: ${err.message}`);
        }
    });

    context.subscriptions.push(startCmd, stopCmd, injectCmd, uninjectCmd);
}

export async function deactivate() {
    isCollecting = false;
    if (bridge) {
        await bridge.stop();
        bridge = null;
    }
    console.log('cursorCoords: Extension deactivated');
}
