// Copyright (c) Microsoft. All rights reserved.

import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';

export interface CursorRect {
    /** Screen-absolute X (CSS pixels) */
    x: number;
    /** Screen-absolute Y (CSS pixels) */
    y: number;
    /** Window-relative X (CSS pixels) */
    windowRelativeX: number;
    /** Window-relative Y (CSS pixels) */
    windowRelativeY: number;
    width: number;
    height: number;
    /** window.devicePixelRatio — multiply CSS pixels by this to get physical pixels */
    devicePixelRatio: number;
}

export interface WindowInfo {
    screenX: number;
    screenY: number;
    outerWidth: number;
    outerHeight: number;
    innerWidth: number;
    innerHeight: number;
    devicePixelRatio: number;
}

interface PendingRequest {
    resolve: (data: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
    messageType: string;
}

/**
 * Manages a local WebSocket server that bridges the Extension Host
 * and the injected DOM payload running in VS Code's renderer process.
 */
export class BridgeServer extends EventEmitter {
    private wss: WebSocketServer | null = null;
    private client: WebSocket | null = null;
    private pending: PendingRequest | null = null;
    private _port: number;

    constructor(port: number = 54321) {
        super();
        this._port = port;
    }

    get port(): number {
        return this._port;
    }

    get isClientConnected(): boolean {
        return this.client !== null && this.client.readyState === WebSocket.OPEN;
    }

    /**
     * Start the WebSocket server and begin listening for the DOM payload client.
     */
    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.wss) {
                resolve();
                return;
            }

            this.wss = new WebSocketServer({ port: this._port, host: '127.0.0.1' });

            this.wss.on('listening', () => {
                console.log(`cursorCoords: WebSocket server listening on ws://127.0.0.1:${this._port}`);
                resolve();
            });

            this.wss.on('error', (err: Error) => {
                console.error('cursorCoords: WebSocket server error', err);
                reject(err);
            });

            this.wss.on('connection', (ws: WebSocket) => {
                console.log('cursorCoords: DOM payload connected');

                // Only keep one client at a time
                if (this.client) {
                    this.client.close();
                }
                this.client = ws;
                this.emit('clientConnected');

                ws.on('message', (data: Buffer | string) => {
                    try {
                        const msg = JSON.parse(data.toString());
                        this.handleMessage(msg);
                    } catch (e) {
                        console.error('cursorCoords: Failed to parse message from DOM payload', e);
                    }
                });

                ws.on('close', () => {
                    console.log('cursorCoords: DOM payload disconnected');
                    if (this.client === ws) {
                        this.client = null;
                        this.emit('clientDisconnected');
                    }
                });

                ws.on('error', (err: Error) => {
                    console.error('cursorCoords: Client WebSocket error', err);
                });
            });
        });
    }

    /**
     * Shut down the WebSocket server and reject any pending request.
     */
    stop(): Promise<void> {
        return new Promise((resolve) => {
            if (this.pending) {
                this.pending.reject(new Error('Server shutting down'));
                clearTimeout(this.pending.timer);
                this.pending = null;
            }

            if (this.client) {
                this.client.close();
                this.client = null;
            }

            if (this.wss) {
                this.wss.close(() => {
                    console.log('cursorCoords: WebSocket server stopped');
                    this.wss = null;
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    /**
     * Ask the DOM payload for the current cursor pixel position.
     * Returns a promise that resolves with the cursor bounding rect.
     */
    requestCursorPosition(timeoutMs: number = 3000): Promise<CursorRect> {
        return new Promise((resolve, reject) => {
            if (!this.isClientConnected) {
                reject(new Error('DOM payload is not connected'));
                return;
            }

            if (this.pending) {
                this.pending.reject(new Error('Superseded by new request'));
                clearTimeout(this.pending.timer);
            }

            const timer = setTimeout(() => {
                if (this.pending) {
                    this.pending.reject(new Error('Cursor position request timed out'));
                    this.pending = null;
                }
            }, timeoutMs);

            this.pending = { resolve, reject, timer, messageType: 'cursorPosition' };

            this.client!.send(JSON.stringify({ type: 'getCursorPosition' }));
        });
    }

    /**
     * Ask the DOM payload for window dimensions and position.
     */
    requestWindowInfo(timeoutMs: number = 3000): Promise<WindowInfo> {
        return new Promise((resolve, reject) => {
            if (!this.isClientConnected) {
                reject(new Error('DOM payload is not connected'));
                return;
            }

            if (this.pending) {
                this.pending.reject(new Error('Superseded by new request'));
                clearTimeout(this.pending.timer);
            }

            const timer = setTimeout(() => {
                if (this.pending) {
                    this.pending.reject(new Error('Window info request timed out'));
                    this.pending = null;
                }
            }, timeoutMs);

            this.pending = { resolve, reject, timer, messageType: 'windowInfo' };

            this.client!.send(JSON.stringify({ type: 'getWindowInfo' }));
        });
    }

    private handleMessage(msg: any) {
        if (!this.pending) {
            return;
        }

        if (msg.type === 'cursorPosition' && this.pending.messageType === 'cursorPosition') {
            clearTimeout(this.pending.timer);
            this.pending.resolve({
                x: msg.x ?? 0,
                y: msg.y ?? 0,
                windowRelativeX: msg.windowRelativeX ?? 0,
                windowRelativeY: msg.windowRelativeY ?? 0,
                width: msg.width ?? 0,
                height: msg.height ?? 0,
                devicePixelRatio: msg.devicePixelRatio ?? 1,
            });
            this.pending = null;
        } else if (msg.type === 'windowInfo' && this.pending.messageType === 'windowInfo') {
            clearTimeout(this.pending.timer);
            this.pending.resolve({
                screenX: msg.screenX ?? 0,
                screenY: msg.screenY ?? 0,
                outerWidth: msg.outerWidth ?? 0,
                outerHeight: msg.outerHeight ?? 0,
                innerWidth: msg.innerWidth ?? 0,
                innerHeight: msg.innerHeight ?? 0,
                devicePixelRatio: msg.devicePixelRatio ?? 1,
            });
            this.pending = null;
        }
    }
}
