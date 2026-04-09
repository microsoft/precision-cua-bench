# vscode-cursor-coords: Deep Research Report

## Purpose

This is a VS Code extension designed to collect **exact pixel coordinates** of the text cursor as it moves through every character in a file. The primary goal is to generate ground-truth training data for **GUI grounding research** — specifically, to build a mapping from (file, line, column) positions to actual screen pixel locations within the Monaco editor.

This extension was built by the xscience-cua team as part of the GTA1 grounding fine-tuning pipeline.

---

## High-Level Architecture

```
┌─────────────────────┐       WebSocket        ┌──────────────────────┐
│   Extension Host    │◄──────────────────────►│   Renderer Process   │
│   (Node.js)         │    ws://127.0.0.1:54321 │   (Chromium/browser) │
│                     │                         │                      │
│  extension.ts       │                         │  dom-payload.js      │
│  collector.ts       │                         │  (injected into      │
│  bridge-server.ts   │                         │   workbench.html)    │
│  injector.ts        │                         │                      │
└─────────────────────┘                         └──────────────────────┘
```

The fundamental challenge this extension solves: the VS Code Extension Host API gives you cursor position in (line, col) coordinates, but **not pixel coordinates**. Pixel coordinates are only available in the renderer process (where the DOM lives). These two processes are sandboxed from each other, so the extension uses a local WebSocket server as a bridge.

---

## Component Breakdown

### 1. `extension.ts` — Entry Point & Lifecycle Manager

Registers 4 commands:

| Command ID | Title | Action |
|---|---|---|
| `cursorCoords.start` | Start Collection | Starts WS server, runs collection loop |
| `cursorCoords.stop` | Stop Collection | Halts collection, tears down WS server |
| `cursorCoords.inject` | Inject DOM Payload | Patches `workbench.html` with the payload script |
| `cursorCoords.uninject` | Remove DOM Payload | Restores original `workbench.html` |

Key state variables:
- `isCollecting: boolean` — guards against double-start
- `bridge: BridgeServer | null` — the active WS server instance
- `BRIDGE_PORT = 54321` — hardcoded port

On `deactivate`, any running bridge is stopped cleanly.

---

### 2. `bridge-server.ts` — WebSocket Bridge

A thin `EventEmitter`-based class wrapping the `ws` library.

**Server behavior:**
- Listens on `127.0.0.1:54321` (localhost only — no external exposure)
- Accepts only one client at a time; closes the previous client if a new one connects
- Emits `clientConnected` / `clientDisconnected` events

**Request-response protocol (single pending request at a time):**

The server operates as a strict request-response system. Only one request can be in flight at a time (`pending: PendingRequest | null`). A new request supersedes any pending one.

Two request types:

1. **`getCursorPosition`** → expects back `cursorPosition` message with:
   - `x`, `y` — screen-absolute CSS pixel coordinates
   - `windowRelativeX`, `windowRelativeY` — position relative to the VS Code window
   - `width`, `height` — cursor element bounding box size
   - `devicePixelRatio` — display scaling (multiply CSS pixels by this for physical pixels)

2. **`getWindowInfo`** → expects back `windowInfo` message with:
   - `screenX`, `screenY` — window position on screen
   - `outerWidth`, `outerHeight` — window outer dimensions
   - `innerWidth`, `innerHeight` — window inner/viewport dimensions
   - `devicePixelRatio`

Each request has a **3-second timeout** by default. Timed-out requests reject their promise.

**Interfaces exported:**
```typescript
interface CursorRect {
    x: number;               // Screen-absolute X (CSS px)
    y: number;               // Screen-absolute Y (CSS px)
    windowRelativeX: number; // Window-relative X (CSS px)
    windowRelativeY: number; // Window-relative Y (CSS px)
    width: number;
    height: number;
    devicePixelRatio: number;
}

interface WindowInfo {
    screenX: number;
    screenY: number;
    outerWidth: number;
    outerHeight: number;
    innerWidth: number;
    innerHeight: number;
    devicePixelRatio: number;
}
```

---

### 3. `collector.ts` — Data Collection Loop

This is the core orchestration module.

**`runCollection(bridge, isCollecting, delayMs=80)`:**

1. Waits up to 15 seconds for the DOM payload client to connect (via `waitForClient`)
2. Reads editor configuration (fontFamily, fontSize, lineHeight) for metadata
3. Requests `WindowInfo` from the DOM payload
4. Counts total characters across all lines (newlines count as one cursor stop each)
5. Moves the cursor to the start of the document (`cursorTop` command)
6. Takes an initial **screenshot** via PowerShell (see below)
7. Enters a `withProgress` notification loop:
   - Reads current cursor position via `editor.selection.active`
   - Detects EOF: if cursor is stuck at same (line, col) for 3+ iterations, stops
   - Reads the character at the current position (`\n` for EOL)
   - Waits `delayMs` ms (default 80ms) for the renderer to paint the cursor
   - Requests pixel position from the bridge (3s timeout)
   - Records all data into a `CollectionRecord`
   - Advances with `cursorRight` command
8. Returns a `CollectionResult` with all records + metadata

**Stuck-cursor detection:** Uses `stuckCount` — if `pos.line === prevLine && pos.character === prevCol` for more than 2 iterations, the loop breaks (EOF reached).

**Error resilience:** If a pixel position request fails, the loop logs a warning and continues to the next character rather than aborting.

**`saveResults(result)`:**

Saves output to a hardcoded path:
```
c:\Users\gamit\Documents\code\devdiv\xscience-cua\vscode-cursor-coords\cursor-coords-data\
```
> Note: This path is hardcoded to the original developer's machine. This will need to be updated for other environments.

Output filename format: `{baseName}_{ISO-timestamp}.jsonl`

**Screenshot capture (`captureScreenshot`):**

Uses an inline PowerShell script executed via `child_process.exec`:
- Identifies the correct monitor using VS Code window center coordinates (`window.screenX + outerWidth/2`, `window.screenY + outerHeight/2`)
- Uses `System.Windows.Forms.Screen.FromPoint()` to find the containing monitor
- Captures the full monitor bounds with `Graphics.CopyFromScreen`
- Saves as PNG alongside the JSONL output

This is Windows-specific (`powershell`) and will not work on macOS/Linux.

**Data types:**

```typescript
interface CollectionRecord {
    file: string;
    line: number;             // 0-based line
    col: number;              // 0-based column
    char: string;             // character at position ('\n' for EOL)
    pixelX: number;           // screen-absolute X (CSS px)
    pixelY: number;           // screen-absolute Y (CSS px)
    windowRelativeX: number;
    windowRelativeY: number;
    pixelW: number;           // cursor element width
    pixelH: number;           // cursor element height
    devicePixelRatio: number;
}

interface CollectionMetadata {
    file: string;
    fileContent: string;      // full source text of the file
    totalCharacters: number;
    collectedAt: string;      // ISO timestamp
    editorFontFamily: string;
    editorFontSize: number;
    editorLineHeight: number;
    delayMs: number;
    window: WindowInfo;
    screenshotPath: string | null;
}
```

---

### 4. `injector.ts` — Workbench HTML Patcher

This module modifies VS Code's internal `workbench.html` to inject the DOM payload script. This is the most invasive part of the extension and is what triggers VS Code's "corrupt installation" warning.

**`findWorkbenchHtml()`:**

Locates `workbench.html` at:
```
{vscode.env.appRoot}/out/vs/code/electron-browser/workbench/workbench.html
```

**`injectPayload(context)`:**

1. Reads `workbench.html`
2. If already injected (checks for `<!-- CURSOR_COORDS_DOM_PAYLOAD -->` marker):
   - Asks user to confirm re-injection
   - Restores from backup or strips old injection manually
3. Creates a backup: `workbench.html.cursorcoords.bak`
4. **Modifies the Content Security Policy (CSP):**
   - Adds `'unsafe-inline'` to `script-src` directive (regex: `/(script-src\s*\n\s*'self')/`)
   - Removes `require-trusted-types-for 'script'` directive
   - Removes `trusted-types` directive
5. Inlines the full content of `dom-payload.js` as a `<script>` tag before `</html>`
6. Writes the modified HTML back to disk
7. Prompts user to reload VS Code

**`uninjectPayload()`:**

- If backup exists: restores from `workbench.html.cursorcoords.bak` and deletes backup
- If no backup: manually filters out lines containing the marker and the adjacent script tag
- Prompts user to reload

**Injection marker:** `<!-- CURSOR_COORDS_DOM_PAYLOAD -->`

**Idempotency note:** Re-injection is supported — the user is prompted, the old injection is removed, then the new one is applied. Backup is not overwritten if it already exists.

---

### 5. `dom-payload.js` — Renderer-Side Script

This plain JavaScript file runs inside VS Code's Chromium renderer process (the browser context). It has access to the full DOM and browser APIs.

**Bootstrapping:**
- Wrapped in an IIFE to avoid polluting global scope
- Waits 1 second after load before attempting to connect (to let VS Code initialize)
- Auto-reconnects every 2 seconds on disconnect

**`findCursorElement()`:**

Tries three CSS selectors in order (handles different VS Code versions):
1. `.monaco-editor .cursors-layer .cursor`
2. `.monaco-editor .cursor.cursor-primary`
3. `.monaco-editor .cursor`

Returns the first matching DOM element.

**`measureCursorPosition()`:**

Uses `requestAnimationFrame` to ensure measurement happens after the browser has painted:
```javascript
requestAnimationFrame(() => {
    const rect = cursor.getBoundingClientRect();
    // rect gives viewport-relative coordinates
    // window.screenX/Y converts to screen-absolute
    resolve({
        x: rect.x + window.screenX,
        y: rect.y + window.screenY,
        windowRelativeX: rect.x,
        windowRelativeY: rect.y,
        width: rect.width,
        height: rect.height,
        devicePixelRatio: window.devicePixelRatio || 1,
    });
});
```

**Coordinate system note:**
- `getBoundingClientRect()` gives coordinates relative to the viewport (CSS pixels)
- Adding `window.screenX` / `window.screenY` converts to screen-absolute coordinates
- These are **CSS pixels**, not physical pixels. Multiply by `devicePixelRatio` for physical pixels.

**Message handling:**
- `getCursorPosition` → calls `measureCursorPosition()`, sends back `cursorPosition`
- `getWindowInfo` → reads `window.screenX/Y`, `outerWidth/Height`, `innerWidth/Height`, `devicePixelRatio`, sends back `windowInfo`

---

## Output Format (JSONL)

Each collection produces one `.jsonl` file. The first line is a metadata record; subsequent lines are per-character records.

**Metadata line:**
```json
{
  "type": "metadata",
  "file": "c:\\path\\to\\file.ts",
  "fileContent": "import * as vscode ...",
  "totalCharacters": 1246,
  "collectedAt": "2026-03-04T10:56:08.953Z",
  "editorFontFamily": "Consolas, 'Courier New', monospace",
  "editorFontSize": 14,
  "editorLineHeight": 0,
  "delayMs": 80,
  "window": { "screenX": -467, "screenY": -1440, "outerWidth": 2561, ... },
  "screenshotPath": "c:\\...\\cursor-coords-data\\file_..._screenshot.png"
}
```

**Per-character record:**
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

The screenshot (PNG) is a full-monitor capture taken at the **start** of collection (before the cursor begins moving). It represents the initial state of the screen before any character traversal.

---

## Timing & Performance Characteristics

- **Default delay between characters:** 80ms (`delayMs` parameter)
- **Cursor position request timeout:** 3000ms
- **Client connection wait timeout:** 15000ms
- **DOM payload reconnect interval:** 2000ms
- **Delay before first connect attempt:** 1000ms (renderer initialization wait)
- **Cursor settle delay before first measurement:** 100ms after `cursorTop`

For a 1000-character file at 80ms/char: approximately **80 seconds** minimum for a full collection run.

---

## Technical Constraints & Limitations

1. **Windows-only screenshot:** Uses PowerShell + `System.Windows.Forms`. Will fail silently on macOS/Linux (screenshot path becomes `null` in metadata).

2. **Hardcoded output path:** `OUTPUT_DIR` in `collector.ts` is hardcoded to `c:\Users\gamit\...`. Must be changed for other machines.

3. **Single pending request:** `BridgeServer` can only handle one in-flight request at a time. A new request supersedes any pending one.

4. **Single WebSocket client:** Only one DOM payload client is accepted. If a second connects, the first is closed.

5. **CSP modification is fragile:** The regex-based CSP patching in `injector.ts` is tied to specific whitespace/newline formatting in VS Code's `workbench.html`. Different VS Code versions may have different formatting that breaks these regexes.

6. **Monaco cursor selectors may break:** `dom-payload.js` tries 3 selectors for the cursor element. If VS Code changes its DOM structure, all may fail, returning `{x: -1, y: -1}`.

7. **No multi-editor support:** `collector.ts` uses `vscode.window.activeTextEditor` only. Switching editors mid-collection would break the run.

8. **Cursor blink:** The `requestAnimationFrame` approach in `measureCursorPosition` mitigates cursor blink issues but doesn't fully eliminate the possibility of measuring a hidden cursor frame.

9. **Physical vs CSS pixels:** The output records CSS pixel coordinates. To get physical pixels for ML model training, multiply `pixelX`/`pixelY`/`windowRelativeX`/`windowRelativeY`/`pixelW`/`pixelH` by `devicePixelRatio`.

10. **workbench.html is version-specific:** VS Code updates overwrite `workbench.html`, removing the injection. The backup (`.cursorcoords.bak`) becomes stale after a VS Code update.

---

## Data Flow Summary

```
User runs "Start Collection"
    │
    ▼
extension.ts: creates BridgeServer, starts WS on :54321
    │
    ▼
collector.ts: waitForClient() — blocks until dom-payload.js connects
    │
    ▼
dom-payload.js: (already running in renderer after injection + reload)
    connects to ws://127.0.0.1:54321
    │
    ▼
collector.ts: requestWindowInfo() → bridge sends "getWindowInfo"
dom-payload.js: reads window.screenX/Y etc → responds "windowInfo"
    │
    ▼
collector.ts: captureScreenshot() — PowerShell captures monitor PNG
    │
    ▼
collector.ts: loop over every character
    │  ├─ editor.selection.active → get (line, col)
    │  ├─ delay(80ms)
    │  ├─ bridge.requestCursorPosition()
    │  │    → sends "getCursorPosition" over WS
    │  │    ← dom-payload.js: rAF → getBoundingClientRect() → "cursorPosition"
    │  ├─ push CollectionRecord
    │  └─ executeCommand('cursorRight')
    │
    ▼
collector.ts: saveResults() → JSONL file written to disk
    │
    ▼
extension.ts: bridge.stop(), isCollecting = false
```

---

## Use in the xscience-cua Pipeline

This extension is a **data collection tool** for the GTA1 (GUI Testing Agent) grounding fine-tuning work. The collected JSONL files provide:

- Ground-truth pixel locations for every character position in a source file
- Paired with a screenshot of the editor at the time of collection
- Font metrics and window geometry for reproducibility

This data can be used to train a model that, given a screenshot of VS Code and a target (file, line, col), can predict the correct pixel location to click — enabling precise cursor placement in automated GUI testing/CUA agents.

Related work in this repo:
- `ux-testing-agent/gta1_grounding_finetuning/` — fine-tuning scripts that consume this data
- The conversion scripts (merged PR 1846) process these JSONL + screenshot pairs into training examples
