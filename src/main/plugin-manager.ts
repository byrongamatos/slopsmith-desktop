// Plugin Manager — handles installation, removal, and updates
// of Slopsmith plugins via git operations.

import { ipcMain } from 'electron';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getPluginsDir, restartPython } from './python';

function execAsync(cmd: string, cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(cmd, { cwd, timeout: 60000 }, (error, stdout, stderr) => {
            if (error) reject(new Error(stderr || error.message));
            else resolve(stdout.trim());
        });
    });
}

interface InstalledPlugin {
    name: string;
    path: string;
    hasGit: boolean;
    manifest: any | null;
    version: string;
}

async function listInstalledPlugins(): Promise<InstalledPlugin[]> {
    const pluginsDir = getPluginsDir();
    const plugins: InstalledPlugin[] = [];

    if (!fs.existsSync(pluginsDir)) return plugins;

    const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;

        const pluginPath = path.join(pluginsDir, entry.name);
        const manifestPath = path.join(pluginPath, 'plugin.json');
        const gitDir = path.join(pluginPath, '.git');

        let manifest = null;
        try {
            if (fs.existsSync(manifestPath)) {
                manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            }
        } catch { /* invalid manifest */ }

        let version = manifest?.version || 'unknown';

        // Try to get git version info
        if (fs.existsSync(gitDir)) {
            try {
                const hash = await execAsync('git rev-parse --short HEAD', pluginPath);
                version = `${version} (${hash})`;
            } catch { /* not a git repo */ }
        }

        plugins.push({
            name: entry.name,
            path: pluginPath,
            hasGit: fs.existsSync(gitDir),
            manifest,
            version,
        });
    }

    return plugins;
}

async function installPlugin(gitUrl: string, name?: string): Promise<{ success: boolean; message: string }> {
    const pluginsDir = getPluginsDir();

    // Derive directory name from URL if not provided
    if (!name) {
        // https://github.com/user/slopsmith-plugin-foo.git -> slopsmith-plugin-foo
        const urlParts = gitUrl.replace(/\.git$/, '').split('/');
        name = urlParts[urlParts.length - 1] || 'plugin';
    }

    const targetDir = path.join(pluginsDir, name);

    if (fs.existsSync(targetDir)) {
        return { success: false, message: `Plugin directory "${name}" already exists` };
    }

    try {
        await execAsync(`git clone ${gitUrl} ${JSON.stringify(targetDir)}`);

        // Verify it has a plugin.json
        const manifestPath = path.join(targetDir, 'plugin.json');
        if (!fs.existsSync(manifestPath)) {
            console.warn(`[plugins] Warning: ${name} has no plugin.json — may not be a valid Slopsmith plugin`);
        }

        return { success: true, message: `Installed "${name}" successfully. Restart to activate.` };
    } catch (e: any) {
        // Clean up failed clone
        try { fs.rmSync(targetDir, { recursive: true }); } catch { /* ignore */ }
        return { success: false, message: `Failed to clone: ${e.message}` };
    }
}

async function removePlugin(name: string): Promise<{ success: boolean; message: string }> {
    const pluginsDir = getPluginsDir();
    const targetDir = path.join(pluginsDir, name);

    if (!fs.existsSync(targetDir)) {
        return { success: false, message: `Plugin "${name}" not found` };
    }

    try {
        fs.rmSync(targetDir, { recursive: true });
        return { success: true, message: `Removed "${name}". Restart to take effect.` };
    } catch (e: any) {
        return { success: false, message: `Failed to remove: ${e.message}` };
    }
}

async function updatePlugin(name: string): Promise<{ success: boolean; message: string }> {
    const pluginsDir = getPluginsDir();
    const targetDir = path.join(pluginsDir, name);

    if (!fs.existsSync(targetDir)) {
        return { success: false, message: `Plugin "${name}" not found` };
    }

    if (!fs.existsSync(path.join(targetDir, '.git'))) {
        return { success: false, message: `Plugin "${name}" is not a git repository — cannot update` };
    }

    try {
        const output = await execAsync('git pull', targetDir);
        if (output.includes('Already up to date')) {
            return { success: true, message: `"${name}" is already up to date` };
        }
        return { success: true, message: `Updated "${name}". Restart to activate changes.` };
    } catch (e: any) {
        return { success: false, message: `Failed to update: ${e.message}` };
    }
}

export function initPluginManager(): void {
    ipcMain.handle('plugins:listInstalled', async () => {
        return await listInstalledPlugins();
    });

    ipcMain.handle('plugins:install', async (_event, gitUrl: string, name?: string) => {
        return await installPlugin(gitUrl, name);
    });

    ipcMain.handle('plugins:remove', async (_event, name: string) => {
        return await removePlugin(name);
    });

    ipcMain.handle('plugins:update', async (_event, name: string) => {
        return await updatePlugin(name);
    });

    ipcMain.handle('plugins:restart', () => {
        restartPython();
        return { success: true, message: 'Restarting server...' };
    });
}
