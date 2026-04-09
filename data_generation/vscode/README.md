# Cursor Pixel Coordinates

A VS Code extension that collects exact pixel coordinates of the cursor position as it moves through every character in a file. Designed to generate training data for GUI grounding research — mapping code positions (line, column) to screen pixel locations in the Monaco editor.

## Prerequisites

- VS Code / VS Code Insiders **1.85.0** or later
- Node.js and npm

## Installation

1. Clone this repository and navigate to the extension directory:

   ```bash
   cd vscode-cursor-coords
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Compile the TypeScript source:

   ```bash
   npm run compile
   ```

4. Install the extension into VS Code:

   ```bash
   # For VS Code Insiders
   code-insiders --install-extension .

   # For VS Code stable
   code --install-extension .
   ```

   Alternatively, press **F5** in this workspace to launch the Extension Development Host.

## Usage

### 1. Inject the DOM Payload

The extension needs a small script injected into VS Code's renderer process to read cursor pixel positions from the DOM.

1. Open the Command Palette (**Ctrl+Shift+P**).
2. Run **`Cursor Coords: Inject DOM Payload`**.
3. Reload VS Code when prompted.

> **Note:** This modifies VS Code's internal `workbench.html` file. A backup is created automatically (`workbench.html.cursorcoords.bak`). VS Code may show a "corrupt installation" warning — this is expected and can be dismissed.

### 2. Start Collection

1. Open the file you want to collect coordinates for.
2. Open the Command Palette (**Ctrl+Shift+P**).
3. Run **`Cursor Coords: Start Collection`**.
4. The extension will:
   - Start a local WebSocket server on `ws://127.0.0.1:54321`
   - Wait for the DOM payload to connect
   - Move the cursor through every character in the file
   - Record the pixel position of each character
   - Capture a screenshot of the editor
   - Save results to a JSONL file in `cursor-coords-data/`

A progress bar is shown during collection. Do not interact with the editor while collection is running.

### 3. Stop Collection

To cancel a running collection, open the Command Palette and run **`Cursor Coords: Stop Collection`**.

### 4. Remove the DOM Payload

When you no longer need the extension:

1. Open the Command Palette (**Ctrl+Shift+P**).
2. Run **`Cursor Coords: Remove DOM Payload`**.
3. Reload VS Code.

This restores `workbench.html` from the backup.

## Commands

| Command | Description |
|---|---|
| `Cursor Coords: Inject DOM Payload` | Inject the tracking script into VS Code's renderer |
| `Cursor Coords: Remove DOM Payload` | Remove the injected script and restore the original |
| `Cursor Coords: Start Collection` | Begin collecting pixel coordinates for the active file |
| `Cursor Coords: Stop Collection` | Cancel a running collection |

## Output Format

Results are saved as JSONL (JSON Lines) files in the `cursor-coords-data/` directory, named `{fileName}_{timestamp}.jsonl`.

### Metadata (first line)

```json
{
  "type": "metadata",
  "file": "c:\\path\\to\\file.ts",
  "fileContent": "import * as vscode from 'vscode'; ...",
  "totalCharacters": 1246,
  "collectedAt": "2026-03-04T10:56:08.953Z",
  "editorFontFamily": "Consolas, 'Courier New', monospace",
  "editorFontSize": 14,
  "editorLineHeight": 0,
  "delayMs": 80,
  "window": {
    "screenX": -467,
    "screenY": -1440,
    "outerWidth": 2561,
    "outerHeight": 1392,
    "innerWidth": 2560,
    "innerHeight": 1392,
    "devicePixelRatio": 1.5
  },
  "screenshotPath": "c:\\...\\cursor-coords-data\\file_..._screenshot.png"
}
```

### Records (subsequent lines, one per character)

```json
{
  "type": "record",
  "file": "c:\\path\\to\\file.ts",
  "char": "i",
  "line": 0,
  "col": 0,
  "pixelX": -762,
  "pixelY": -1440,
  "windowRelativeX": 545,
  "windowRelativeY": 92,
  "pixelW": 2,
  "pixelH": 19,
  "devicePixelRatio": 1.5
}
```

| Field | Description |
|---|---|
| `char` | Character at the cursor position (`\n` for end of line) |
| `line`, `col` | Zero-based line and column in the source file |
| `pixelX`, `pixelY` | Screen-absolute cursor position (CSS pixels) |
| `windowRelativeX`, `windowRelativeY` | Position relative to the VS Code window |
| `pixelW`, `pixelH` | Cursor element width and height |
| `devicePixelRatio` | Display scaling factor |

## Architecture

```
┌─────────────────────┐       WebSocket        ┌──────────────────────┐
│   Extension Host    │◄──────────────────────►│   Renderer Process   │
│                     │    ws://127.0.0.1:54321 │                      │
│  extension.ts       │                         │  dom-payload.js      │
│  collector.ts       │                         │  (injected into      │
│  bridge-server.ts   │                         │   workbench.html)    │
│  injector.ts        │                         │                      │
└─────────────────────┘                         └──────────────────────┘
```

- **extension.ts** — Entry point; registers commands, manages collection lifecycle.
- **bridge-server.ts** — WebSocket server bridging the extension host and renderer.
- **collector.ts** — Iterates through every character, queries pixel positions, saves JSONL output and screenshots.
- **injector.ts** — Injects/removes `dom-payload.js` into VS Code's `workbench.html`, modifying CSP headers.
- **dom-payload.js** — Runs in the renderer; locates the Monaco cursor element via DOM queries and reports its `getBoundingClientRect()` coordinates over WebSocket.

## Development

```bash
# Watch mode (recompiles on changes)
npm run watch

# Launch Extension Development Host
# Press F5 in VS Code with this folder open
```
