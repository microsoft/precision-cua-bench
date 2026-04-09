import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const INJECTION_MARKER = '<!-- CURSOR_COORDS_DOM_PAYLOAD -->';
const BACKUP_SUFFIX = '.cursorcoords.bak';

/**
 * Locate VS Code's workbench.html by walking up from vscode.env.appRoot.
 * appRoot typically points to: <install>/resources/app
 * workbench.html lives at:    <install>/<hash>/resources/app/out/vs/code/electron-browser/workbench/workbench.html
 */
function findWorkbenchHtml(): string {
    const appRoot = vscode.env.appRoot; // e.g. C:\Users\...\Microsoft VS Code Insiders\f5927e727c\resources\app
    const candidate = path.join(
        appRoot, 'out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html'
    );

    if (fs.existsSync(candidate)) {
        return candidate;
    }

    throw new Error(
        `Could not find workbench.html. Expected at: ${candidate}\n` +
        `appRoot = ${appRoot}`
    );
}

/**
 * Get the absolute path to the dom-payload.js file bundled with the extension.
 */
function getPayloadPath(context: vscode.ExtensionContext): string {
    return path.join(context.extensionPath, 'src', 'dom-payload.js');
}

/**
 * Inject the DOM payload script tag into workbench.html.
 * Creates a backup of the original file first.
 */
export async function injectPayload(context: vscode.ExtensionContext): Promise<void> {
    const workbenchPath = findWorkbenchHtml();
    const payloadPath = getPayloadPath(context);

    if (!fs.existsSync(payloadPath)) {
        throw new Error(`DOM payload not found at: ${payloadPath}`);
    }

    let html = fs.readFileSync(workbenchPath, 'utf-8');

    // Already injected? Ask to re-inject
    if (html.includes(INJECTION_MARKER)) {
        const action = await vscode.window.showInformationMessage(
            'Cursor Coords: DOM payload is already injected. Re-inject with updated code?',
            'Re-inject',
            'Cancel'
        );
        if (action !== 'Re-inject') {
            return;
        }
        // Strip old injection before re-injecting
        // Restore from backup if available, otherwise strip manually
        const backupPath = workbenchPath + BACKUP_SUFFIX;
        if (fs.existsSync(backupPath)) {
            html = fs.readFileSync(backupPath, 'utf-8');
        } else {
            // Remove everything between marker and closing script tag
            const markerIdx = html.indexOf(INJECTION_MARKER);
            const beforeMarker = html.substring(0, markerIdx).replace(/\n$/, '');
            const afterScript = html.substring(markerIdx);
            const closingTag = '</script>';
            const afterIdx = afterScript.indexOf(closingTag);
            const rest = afterScript.substring(afterIdx + closingTag.length);
            html = beforeMarker + rest;
        }
    }

    // Create backup
    const backupPath = workbenchPath + BACKUP_SUFFIX;
    if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(workbenchPath, backupPath);
        console.log(`cursorCoords: Backup created at ${backupPath}`);
    }

    // Read the payload script content to inline it
    const payloadCode = fs.readFileSync(payloadPath, 'utf-8');

    // Modify CSP to allow inline scripts and remove trusted-types restriction
    // Add 'unsafe-inline' to script-src
    html = html.replace(
        /(script-src\s*\n\s*'self')/,
        "$1\n\t\t\t\t\t\t\t'unsafe-inline'"
    );

    // Remove require-trusted-types-for and trusted-types directives
    // (they block dynamically created scripts)
    html = html.replace(/\s*require-trusted-types-for\s*\n\s*'script'\s*;/g, '');
    html = html.replace(/\s*trusted-types\s*\n(?:\s*\w+\n)*\s*;/g, '');

    // Build the inline script tag
    const scriptTag = `\n${INJECTION_MARKER}\n<script>\n${payloadCode}\n</script>\n`;

    // Insert before </html> or append at end
    if (html.includes('</html>')) {
        html = html.replace('</html>', `${scriptTag}</html>`);
    } else {
        html += scriptTag;
    }

    fs.writeFileSync(workbenchPath, html, 'utf-8');
    console.log(`cursorCoords: Injected DOM payload into ${workbenchPath}`);

    const action = await vscode.window.showInformationMessage(
        'Cursor Coords: DOM payload injected successfully. VS Code must be reloaded for it to take effect.\n' +
        '(You will see a "corrupt installation" warning — this is expected.)',
        'Reload Now',
        'Later'
    );

    if (action === 'Reload Now') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}

/**
 * Remove the injected DOM payload from workbench.html.
 * Restores from backup if available, otherwise strips the injected lines.
 */
export async function uninjectPayload(): Promise<void> {
    const workbenchPath = findWorkbenchHtml();
    const backupPath = workbenchPath + BACKUP_SUFFIX;

    if (fs.existsSync(backupPath)) {
        // Restore from backup
        fs.copyFileSync(backupPath, workbenchPath);
        fs.unlinkSync(backupPath);
        console.log(`cursorCoords: Restored workbench.html from backup`);
    } else {
        // No backup — try to strip the injected lines manually
        let html = fs.readFileSync(workbenchPath, 'utf-8');
        if (!html.includes(INJECTION_MARKER)) {
            vscode.window.showInformationMessage('Cursor Coords: No injection found to remove.');
            return;
        }

        // Remove the marker line and the script tag line after it
        const lines = html.split('\n');
        const filtered = lines.filter((line, i, arr) => {
            if (line.includes(INJECTION_MARKER)) {
                return false;
            }
            // Also remove the script tag on the next line
            if (i > 0 && arr[i - 1].includes(INJECTION_MARKER)) {
                return false;
            }
            return true;
        });
        html = filtered.join('\n');
        fs.writeFileSync(workbenchPath, html, 'utf-8');
        console.log(`cursorCoords: Stripped injected lines from workbench.html`);
    }

    const action = await vscode.window.showInformationMessage(
        'Cursor Coords: DOM payload removed. Reload VS Code to complete the cleanup.',
        'Reload Now',
        'Later'
    );

    if (action === 'Reload Now') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}
