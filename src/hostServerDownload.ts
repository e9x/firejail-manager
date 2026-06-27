import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Log from './common/logger';
import { untildify } from './common/files';
import { JailConfiguration } from './jail/jailConfig';

/**
 * Map the running host's `uname -m` architecture to the server arch token used
 * in the download URL. Mirrors the `case $ARCH in` block in the jailed install
 * script so the host-side download lands the exact tarball the jail expects.
 */
function resolveServerArch(): string | undefined {
    switch (os.arch()) {
        case 'x64':
            return 'x64';
        case 'arm':
            return 'armhf';
        case 'arm64':
            return 'arm64';
        case 'ppc64':
            return 'ppc64le';
        case 'riscv64':
            return 'riscv64';
        case 'loong64':
            return 'loong64';
        case 's390x':
            return 's390x';
        default:
            return undefined;
    }
}

/**
 * Detect the host OS release id (e.g. `alpine`), used as the `${os}` token in
 * the download URL template. Mirrors the `/etc/os-release` lookup in the jailed
 * script; defaults to `linux` when not Alpine.
 */
function resolveOsPlatform(): string {
    for (const file of ['/etc/os-release', '/usr/lib/os-release']) {
        try {
            const content = fs.readFileSync(file, 'utf8');
            const match = content.match(/^ID=("?)([^"\n]*)\1/m);
            if (match && match[2] === 'alpine') {
                return 'alpine';
            }
        } catch {
            // Ignore missing os-release files.
        }
    }
    return 'linux';
}

/**
 * Substitute the `${...}` tokens in a server download URL template. Mirrors the
 * sed pipeline in the jailed install script.
 */
function buildDownloadUrl(template: string, tokens: { quality: string; version: string; commit: string; os: string; arch: string; release: string }): string {
    return template
        .replace(/\$\{quality\}/g, tokens.quality)
        .replace(/\$\{version\}/g, tokens.version)
        .replace(/\$\{commit\}/g, tokens.commit)
        .replace(/\$\{os\}/g, tokens.os)
        .replace(/\$\{arch\}/g, tokens.arch)
        .replace(/\$\{release\}/g, tokens.release);
}

/**
 * Resolve the host-side server data directory for a jail. With
 * `firejail --private=DIR`, DIR becomes the jail's `$HOME`, so the jail path
 * `$HOME/<serverDataFolderName>` (or a custom install path) maps to a concrete
 * host path under the jail's private dir.
 */
export function resolveHostServerDataDir(jail: JailConfiguration, serverDataFolderName: string, customInstallPath: string | undefined): string {
    const home = untildify(jail.privateDir);
    if (customInstallPath) {
        const expanded = customInstallPath.replace(/^~(?=\/|$)/, home);
        // Absolute custom paths inside the jail resolve, under --private, to the
        // same absolute path on the host only if they live under HOME. A custom
        // path like `~/.vscode-server` expands to `<home>/.vscode-server`.
        return path.isAbsolute(expanded) ? expanded : path.join(home, expanded);
    }
    return path.join(home, serverDataFolderName);
}

export type HostDownloadParams = {
    jail: JailConfiguration;
    serverDownloadUrlTemplate: string;
    version: string;
    commit: string;
    quality: string;
    release: string;
    serverApplicationName: string;
    serverDataFolderName: string;
    customInstallPath: string | undefined;
};

/**
 * Download and extract the VS Code server tarball on the host (which has
 * networking) into the jail's data directory. This runs BEFORE the jailed
 * install script, so that script finds `$SERVER_SCRIPT` already present and
 * skips its own download/extract path entirely — letting the jail itself run
 * with `--net=none`.
 *
 * No-op (resolves) if the server binary is already present. Throws on download
 * or extraction failure so the caller can surface a clear error.
 */
export async function downloadServerOnHost(params: HostDownloadParams, logger: Log): Promise<void> {
    const arch = resolveServerArch();
    if (!arch) {
        throw new Error(`Architecture not supported for host-side download: ${os.arch()}`);
    }

    const serverDataDir = resolveHostServerDataDir(params.jail, params.serverDataFolderName, params.customInstallPath);
    const serverDir = path.join(serverDataDir, 'bin', params.commit);
    const serverScript = path.join(serverDir, 'bin', params.serverApplicationName);

    if (fs.existsSync(serverScript)) {
        logger.trace(`[host-download] server already present at ${serverScript}, skipping`);
        return;
    }

    const downloadUrl = buildDownloadUrl(params.serverDownloadUrlTemplate, {
        quality: params.quality,
        version: params.version,
        commit: params.commit,
        os: resolveOsPlatform(),
        arch,
        release: params.release,
    });

    logger.info(`[host-download] downloading server on host from ${downloadUrl}`);
    await fs.promises.mkdir(serverDir, { recursive: true });

    const tarballPath = path.join(serverDir, 'vscode-server.tar.gz');
    try {
        await downloadFile(downloadUrl, tarballPath, logger);
        logger.trace('[host-download] extracting server tarball...');
        await extractTarball(tarballPath, serverDir);
        if (!fs.existsSync(serverScript)) {
            throw new Error('server contents are corrupted (server script missing after extraction)');
        }
        logger.info(`[host-download] server installed on host at ${serverScript}`);
    } catch (err) {
        // Leave a clean slate so the jailed script (or a retry) isn't fooled by
        // a half-extracted tree.
        await fs.promises.rm(serverDir, { recursive: true, force: true }).catch(() => undefined);
        throw err instanceof Error ? err : new Error(String(err));
    } finally {
        await fs.promises.rm(tarballPath, { force: true }).catch(() => undefined);
    }
}

async function downloadFile(url: string, dest: string, logger: Log): Promise<void> {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
        throw new Error(`Error downloading server from ${url}: HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(dest, buffer);
    logger.trace(`[host-download] wrote ${buffer.length} bytes to ${dest}`);
}

function extractTarball(tarball: string, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = cp.spawn('tar', ['-xf', tarball, '--strip-components', '1', '-C', destDir]);
        let stderr = '';
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Error while extracting server contents (tar exit ${code}): ${stderr.trim()}`));
            }
        });
    });
}
