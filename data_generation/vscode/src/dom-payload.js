// dom-payload.js
// This script runs inside VS Code's renderer process (browser context).
// It connects to the BridgeServer WebSocket and responds to cursor position requests
// by reading the actual pixel coordinates of the Monaco editor cursor from the DOM.

(function () {
    'use strict';

    const WS_URL = 'ws://127.0.0.1:54321';
    const RECONNECT_INTERVAL_MS = 2000;

    let ws = null;
    let reconnectTimer = null;

    function log(...args) {
        console.log('[CursorCoords DOM Payload]', ...args);
    }

    function warn(...args) {
        console.warn('[CursorCoords DOM Payload]', ...args);
    }

    /**
     * Find the primary cursor element in the Monaco editor DOM.
     * Monaco renders the cursor as a div. The class names can vary between
     * VS Code versions, so we try several selectors.
     */
    function findCursorElement() {
        // Modern VS Code (1.80+): .cursor-primary inside .cursors-layer
        const selectors = [
            '.monaco-editor .cursors-layer .cursor',
            '.monaco-editor .cursor.cursor-primary',
            '.monaco-editor .cursor',
        ];

        for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el) {
                return el;
            }
        }
        return null;
    }

    /**
     * Read the pixel bounding rect of the cursor element.
     * Uses requestAnimationFrame to ensure we measure after the renderer has
     * painted the cursor in its new position.
     */
    function measureCursorPosition() {
        return new Promise((resolve) => {
            requestAnimationFrame(() => {
                const cursor = findCursorElement();
                if (!cursor) {
                    warn('Could not find cursor element in DOM');
                    resolve({ x: -1, y: -1, width: 0, height: 0 });
                    return;
                }

                const rect = cursor.getBoundingClientRect();
                const dpr = window.devicePixelRatio || 1;
                resolve({
                    // Screen-absolute coordinates (CSS pixels)
                    x: rect.x + window.screenX,
                    y: rect.y + window.screenY,
                    // Also provide window-relative for reference
                    windowRelativeX: rect.x,
                    windowRelativeY: rect.y,
                    width: rect.width,
                    height: rect.height,
                    devicePixelRatio: dpr,
                });
            });
        });
    }

    /**
     * Handle an incoming message from the BridgeServer.
     */
    async function handleMessage(event) {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch (e) {
            warn('Failed to parse message:', event.data);
            return;
        }

        if (msg.type === 'getCursorPosition') {
            const pos = await measureCursorPosition();
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'cursorPosition',
                    x: pos.x,
                    y: pos.y,
                    windowRelativeX: pos.windowRelativeX,
                    windowRelativeY: pos.windowRelativeY,
                    width: pos.width,
                    height: pos.height,
                    devicePixelRatio: pos.devicePixelRatio,
                }));
            }
        } else if (msg.type === 'getWindowInfo') {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'windowInfo',
                    screenX: window.screenX,
                    screenY: window.screenY,
                    outerWidth: window.outerWidth,
                    outerHeight: window.outerHeight,
                    innerWidth: window.innerWidth,
                    innerHeight: window.innerHeight,
                    devicePixelRatio: window.devicePixelRatio || 1,
                }));
            }
        }
    }

    /**
     * Connect to the BridgeServer. Automatically reconnects on disconnect.
     */
    function connect() {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        try {
            ws = new WebSocket(WS_URL);
        } catch (e) {
            warn('Failed to create WebSocket:', e);
            scheduleReconnect();
            return;
        }

        ws.onopen = () => {
            log('Connected to BridgeServer at', WS_URL);
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
        };

        ws.onmessage = handleMessage;

        ws.onclose = () => {
            log('Disconnected from BridgeServer');
            ws = null;
            scheduleReconnect();
        };

        ws.onerror = (err) => {
            // onclose will fire after this, triggering reconnect
            warn('WebSocket error:', err);
        };
    }

    function scheduleReconnect() {
        if (reconnectTimer) {
            return;
        }
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            log('Attempting to reconnect...');
            connect();
        }, RECONNECT_INTERVAL_MS);
    }

    // --- Bootstrap ---
    // Wait a moment for VS Code to finish initializing before connecting
    log('Loaded. Will connect to BridgeServer in 1s...');
    setTimeout(connect, 1000);
})();
