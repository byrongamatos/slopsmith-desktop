// Debug logging — opt-in diagnostic capture for bug reports.
//
// Enabled by the SLOPSMITH_DEBUG env var or a --verbose / --debug CLI flag.
// When on, console.* output is routed to stderr and the native addon
// freopen's stderr to <logs>/slopsmith-debug.log (see audio-bridge.ts), so a
// single file captures the Electron main process, the native [AudioEngine]
// diagnostics, and (forwarded as [python] lines) the Python subprocess.

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';

let debugEnabled: boolean | null = null;
let logFilePath: string | null = null;

export function isDebugEnabled(): boolean {
    if (debugEnabled !== null) return debugEnabled;
    const env = (process.env.SLOPSMITH_DEBUG || '').trim().toLowerCase();
    const envOn = env !== '' && env !== '0' && env !== 'false';
    const argOn = process.argv.includes('--verbose') || process.argv.includes('--debug');
    debugEnabled = envOn || argOn;
    return debugEnabled;
}

// <logs>/slopsmith-debug.log — Windows: %APPDATA%\<app>\logs, macOS:
// ~/Library/Logs/<app>, Linux: ~/.config/<app>/logs.
export function getDebugLogPath(): string {
    if (logFilePath) return logFilePath;
    logFilePath = path.join(app.getPath('logs'), 'slopsmith-debug.log');
    return logFilePath;
}

// Truncate the log with a fresh header and route console.log/info/debug to
// stderr (console.warn/error already write there). Once the native addon
// freopen's stderr to this file, everything funnels into it through one fd.
// Returns the log path when debug mode is on, otherwise null.
//
// The handful of lines logged before the addon loads land on the real fd 2
// (a terminal in dev, nowhere on a packaged Windows build) — the audio
// diagnostics this exists to capture all happen after the addon is up.
export function initDebugLogging(): string | null {
    if (!isDebugEnabled()) return null;

    const file = getDebugLogPath();
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `=== Slopsmith debug log — ${new Date().toISOString()} ===\n`);
    } catch {
        // Can't open the log file — stay console-only rather than crash.
        return null;
    }

    const toStderr = (...args: unknown[]) => {
        process.stderr.write(util.format(...args) + '\n');
    };
    console.log = toStderr;
    console.info = toStderr;
    console.debug = toStderr;

    return file;
}
