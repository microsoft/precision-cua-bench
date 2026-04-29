// Copyright (c) Microsoft. All rights reserved.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BridgeServer, CursorRect, WindowInfo } from './bridge-server';

export interface CollectionRecord {
    file: string;
    line: number;
    col: number;
    char: string;
    pixelX: number;
    pixelY: number;
    windowRelativeX: number;
    windowRelativeY: number;
    pixelW: number;
    pixelH: number;
    devicePixelRatio: number;
}

export interface CollectionMetadata {
    file: string;
    fileContent: string;
    totalCharacters: number;
    collectedAt: string;
    editorFontFamily: string;
    editorFontSize: number;
    editorLineHeight: number;
    delayMs: number;
    window: WindowInfo;
    screenshotPath: string | null;
}

export interface CollectionResult {
    metadata: CollectionMetadata;
    records: CollectionRecord[];
}

/**
 * Wait for the DOM payload client to connect, with a timeout.
 */
function waitForClient(bridge: BridgeServer, timeoutMs: number = 15000): Promise<void> {
    return new Promise((resolve, reject) => {
        if (bridge.isClientConnected) {
            resolve();
            return;
        }

        const timer = setTimeout(() => {
            bridge.removeListener('clientConnected', onConnect);
            reject(new Error(
                'DOM payload did not connect within timeout. ' +
                'Make sure you have run "Cursor Coords: Inject DOM Payload" and reloaded VS Code.'
            ));
        }, timeoutMs);

        function onConnect() {
            clearTimeout(timer);
            resolve();
        }

        bridge.once('clientConnected', onConnect);
    });
}

/**
 * Small async delay.
 */
function delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

const OUTPUT_DIR = path.join('c:', 'Users', 'gamit', 'Documents', 'code', 'devdiv', 'xscience-cua', 'vscode-cursor-coords', 'cursor-coords-data');

/**
 * Capture a screenshot of the monitor where VS Code is currently displayed.
 * Uses window position info from the DOM payload to identify the correct screen.
 * Returns the path to the saved PNG file.
 */
function captureScreenshot(sourceFileName: string, windowInfo?: WindowInfo): Promise<string> {
    return new Promise((resolve, reject) => {
        const { exec } = require('child_process');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const baseName = path.basename(sourceFileName, path.extname(sourceFileName));

        if (!fs.existsSync(OUTPUT_DIR)) {
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }

        const outputPath = path.join(OUTPUT_DIR, `${baseName}_${timestamp}_screenshot.png`);
        const escapedPath = outputPath.replace(/\\/g, '\\\\');

        // Use window center point to find the correct monitor
        const winCenterX = (windowInfo?.screenX ?? 0) + Math.round((windowInfo?.outerWidth ?? 1920) / 2);
        const winCenterY = (windowInfo?.screenY ?? 0) + Math.round((windowInfo?.outerHeight ?? 1080) / 2);

        // PowerShell: find the screen that contains the VS Code window center, then capture it
        const psScript = `
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
$point = New-Object System.Drawing.Point(${winCenterX}, ${winCenterY});
$screen = [System.Windows.Forms.Screen]::FromPoint($point);
$bounds = $screen.Bounds;
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height);
$gfx = [System.Drawing.Graphics]::FromImage($bmp);
$gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size);
$bmp.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png);
$gfx.Dispose();
$bmp.Dispose();
`.trim().replace(/\n/g, ' ');

        exec(`powershell -NoProfile -Command "${psScript}"`, (err: any, _stdout: string, stderr: string) => {
            if (err) {
                reject(new Error(`Screenshot failed: ${stderr || err.message}`));
            } else {
                resolve(outputPath);
            }
        });
    });
}

/**
 * Run the collection loop: move cursor through every character in the active
 * document, querying the DOM payload for the pixel position at each step.
 */
export async function runCollection(
    bridge: BridgeServer,
    isCollecting: () => boolean,
    delayMs: number = 80
): Promise<CollectionResult | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        throw new Error('No active editor');
    }

    // Wait for DOM payload
    await waitForClient(bridge);

    const doc = editor.document;
    const totalLines = doc.lineCount;

    // Read editor config for metadata
    const editorConfig = vscode.workspace.getConfiguration('editor');
    const fontFamily = editorConfig.get<string>('fontFamily', 'unknown');
    const fontSize = editorConfig.get<number>('fontSize', 14);
    const lineHeight = editorConfig.get<number>('lineHeight', 0);

    // Get window dimensions from DOM payload
    let windowInfo: WindowInfo;
    try {
        windowInfo = await bridge.requestWindowInfo();
    } catch (err: any) {
        console.warn('cursorCoords: Could not get window info:', err.message);
        windowInfo = { screenX: 0, screenY: 0, outerWidth: 0, outerHeight: 0, innerWidth: 0, innerHeight: 0, devicePixelRatio: 1 };
    }

    // Calculate total characters for progress
    let totalChars = 0;
    for (let i = 0; i < totalLines; i++) {
        totalChars += doc.lineAt(i).text.length;
        if (i < totalLines - 1) {
            totalChars += 1; // newline counts as a cursor stop (end of line)
        }
    }

    const records: CollectionRecord[] = [];

    // Move cursor to start of document
    await vscode.commands.executeCommand('cursorTop');
    await delay(100); // let cursor settle

    // Take initial screenshot (use window info to capture the correct monitor)
    let screenshotPath: string | null = null;
    try {
        screenshotPath = await captureScreenshot(doc.fileName, windowInfo);
        console.log(`cursorCoords: Screenshot saved to ${screenshotPath}`);
    } catch (err: any) {
        console.warn('cursorCoords: Screenshot failed:', err.message);
    }

    const progress = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Cursor Coords: Collecting',
            cancellable: true,
        },
        async (report, token) => {
            let collected = 0;
            let prevLine = -1;
            let prevCol = -1;
            let stuckCount = 0;

            while (isCollecting() && !token.isCancellationRequested) {
                const pos = editor.selection.active;

                // Detect if cursor stopped advancing (EOF reached)
                if (pos.line === prevLine && pos.character === prevCol) {
                    stuckCount++;
                    if (stuckCount > 2) {
                        // Truly at end of file
                        break;
                    }
                } else {
                    stuckCount = 0;
                }
                prevLine = pos.line;
                prevCol = pos.character;

                // Get the character at this position
                const lineText = doc.lineAt(pos.line).text;
                const char = pos.character < lineText.length
                    ? lineText[pos.character]
                    : '\\n'; // cursor is past last char = at newline/EOL

                // Wait a frame for cursor to render
                await delay(delayMs);

                // Ask DOM payload for pixel position
                let rect: CursorRect;
                try {
                    rect = await bridge.requestCursorPosition(3000);
                } catch (err: any) {
                    console.warn(`cursorCoords: Failed to get position at ${pos.line}:${pos.character}: ${err.message}`);
                    // Try to continue
                    await vscode.commands.executeCommand('cursorRight');
                    continue;
                }

                records.push({
                    file: doc.fileName,
                    line: pos.line,
                    col: pos.character,
                    char,
                    pixelX: rect.x,
                    pixelY: rect.y,
                    windowRelativeX: rect.windowRelativeX,
                    windowRelativeY: rect.windowRelativeY,
                    pixelW: rect.width,
                    pixelH: rect.height,
                    devicePixelRatio: rect.devicePixelRatio,
                });

                collected++;
                const pct = Math.round((collected / totalChars) * 100);
                report.report({
                    message: `${collected}/${totalChars} chars (${pct}%) — L${pos.line + 1}:${pos.character + 1}`,
                    increment: (1 / totalChars) * 100,
                });

                // Move cursor one character forward
                await vscode.commands.executeCommand('cursorRight');
            }

            return records;
        }
    );

    if (records.length === 0) {
        return null;
    }

    const result: CollectionResult = {
        metadata: {
            file: doc.fileName,
            fileContent: doc.getText(),
            totalCharacters: records.length,
            collectedAt: new Date().toISOString(),
            editorFontFamily: fontFamily,
            editorFontSize: fontSize,
            editorLineHeight: lineHeight,
            delayMs,
            window: windowInfo,
            screenshotPath,
        },
        records,
    };

    return result;
}

/**
 * Save collection results to a JSONL file in the fixed output directory.
 */
export function saveResults(result: CollectionResult): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseName = path.basename(result.metadata.file, path.extname(result.metadata.file));

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const outputPath = path.join(OUTPUT_DIR, `${baseName}_${timestamp}.jsonl`);

    const lines: string[] = [];
    // First line is metadata
    lines.push(JSON.stringify({ type: 'metadata', ...result.metadata }));
    // Remaining lines are records
    for (const rec of result.records) {
        lines.push(JSON.stringify({ type: 'record', ...rec }));
    }

    fs.writeFileSync(outputPath, lines.join('\n') + '\n', 'utf-8');
    return outputPath;
}
