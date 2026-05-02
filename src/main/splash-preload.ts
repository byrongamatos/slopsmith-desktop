// Minimal preload for the splash window.
// Exposes only the startup-status IPC bridge — no node APIs in the renderer.

const { contextBridge, ipcRenderer } = require('electron');
import type { StartupStatus } from './python';
import { IPC_STARTUP_STATUS, IPC_STARTUP_REQUEST_STATUS } from './ipc-channels';

contextBridge.exposeInMainWorld('splashBridge', {
    onStatus: (callback: (status: StartupStatus) => void): (() => void) => {
        const listener = (_event: unknown, status: StartupStatus) => callback(status);
        ipcRenderer.on(IPC_STARTUP_STATUS, listener);
        ipcRenderer.send(IPC_STARTUP_REQUEST_STATUS);
        return () => ipcRenderer.removeListener(IPC_STARTUP_STATUS, listener);
    },
});

export {};
