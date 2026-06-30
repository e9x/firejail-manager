import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { exists as fileExists, untildify } from '../common/files';

export type JailConfiguration = {
    name: string;
    privateDir: string;
    privateTmp: boolean;
    noprofile: boolean;
    tab: boolean;
    // Networking
    net?: string;
    netns?: string;
    dns?: string;
    ip?: string;
    hostname?: string;
    // Devices / IPC
    nodbus?: boolean;
    no3d?: boolean;
    nosound?: boolean;
    novideo?: boolean;
    nodvd?: boolean;
    notv?: boolean;
    nou2f?: boolean;
    noinput?: boolean;
    privateDev?: boolean;
    // Security
    nonewprivs: boolean;
    noroot: boolean;
    seccomp?: boolean;
    capsDropAll?: boolean;
    apparmor?: boolean;
    // Filesystem
    privateCache?: boolean;
    disableMnt?: boolean;
    writableVar?: boolean;
    writableVarLog?: boolean;
    writableRunUser?: boolean;
    keepDevShm?: boolean;
    machineId?: boolean;
    // Resource limits
    timeout?: string;
    nice?: string;
    // Escape hatch for anything not modelled above.
    extraArgs: string[];
};

/**
 * Maps boolean JailConfiguration fields to the firejail flag they emit.
 * Single source of truth for arg-building and normalization.
 */
const BOOLEAN_FLAGS: { [K in keyof JailConfiguration]?: string } = {
    nodbus: '--nodbus',
    no3d: '--no3d',
    nosound: '--nosound',
    novideo: '--novideo',
    nodvd: '--nodvd',
    notv: '--notv',
    nou2f: '--nou2f',
    noinput: '--noinput',
    privateDev: '--private-dev',
    seccomp: '--seccomp',
    apparmor: '--apparmor',
    privateCache: '--private-cache',
    disableMnt: '--disable-mnt',
    writableVar: '--writable-var',
    writableVarLog: '--writable-var-log',
    writableRunUser: '--writable-run-user',
    keepDevShm: '--keep-dev-shm',
    machineId: '--machine-id',
};

/**
 * Maps string-valued JailConfiguration fields to the firejail flag they emit
 * as `--flag=value`. Single source of truth for arg-building.
 */
const VALUE_FLAGS: { [K in keyof JailConfiguration]?: string } = {
    net: '--net',
    netns: '--netns',
    dns: '--dns',
    ip: '--ip',
    hostname: '--hostname',
    timeout: '--timeout',
    nice: '--nice',
};

let configPathOverride: string | undefined;

const defaultJailsConfigPath = path.resolve(os.homedir(), '.config/jailmanager/jails.json');

/**
 * Resolve the path to the jails.json store. Mirrors getweConfigPath():
 * honour the `firejail.configFile` setting, else fall back to a default
 * under the user's config dir. extension.ts may set a context-derived
 * override (globalStorageUri) via setJailsConfigPath().
 */
export function getJailsConfigPath(): string {
    const configured = vscode.workspace.getConfiguration('firejail').get<string>('configFile');
    if (configured) {
        return untildify(configured);
    }
    return configPathOverride ?? defaultJailsConfigPath;
}

export function setJailsConfigPath(p: string) {
    configPathOverride = p;
}

/**
 * The default new-jail config: equivalent to
 *   firejail --private=DIR --private-tmp --noprofile
 */
export function defaultJail(name: string, privateDir: string): JailConfiguration {
    return {
        name,
        privateDir,
        privateTmp: true,
        noprofile: true,
        tab: true,
        nonewprivs: true,
        noroot: true,
        extraArgs: [],
    };
}

/**
 * Single source of truth for the firejail command line. Assembles the argv
 * passed to the `firejail` binary (excluding the binary itself and the
 * command to run inside the jail).
 */
export function buildFirejailArgs(jail: JailConfiguration): string[] {
    const args: string[] = [`--name=${jail.name}`, `--private=${untildify(jail.privateDir)}`];
    if (jail.privateTmp) {
        args.push('--private-tmp');
    }
    if (jail.noprofile) {
        args.push('--noprofile');
    }
    if (jail.tab) {
        args.push('--tab');
    }
    if (jail.nonewprivs) {
        args.push('--nonewprivs');
    }
    if (jail.noroot) {
        args.push('--noroot');
    }

    for (const key of Object.keys(BOOLEAN_FLAGS) as (keyof JailConfiguration)[]) {
        if (jail[key]) {
            args.push(BOOLEAN_FLAGS[key]!);
        }
    }
    if (jail.capsDropAll) {
        args.push('--caps.drop=all');
    }
    for (const key of Object.keys(VALUE_FLAGS) as (keyof JailConfiguration)[]) {
        const value = jail[key];
        if (typeof value === 'string' && value !== '') {
            args.push(`${VALUE_FLAGS[key]}=${value}`);
        }
    }

    args.push(...jail.extraArgs);
    return args;
}

/**
 * Whether the jail shares the host network namespace. Firejail uses the host
 * network by default; it only gets its own namespace when an explicit
 * `--net=` or `--netns=` option is passed. When on the host network the server
 * is reachable directly at 127.0.0.1, so port forwarding is not needed.
 */
export function usesHostNetwork(jail: JailConfiguration): boolean {
    if ((typeof jail.net === 'string' && jail.net !== '') || (typeof jail.netns === 'string' && jail.netns !== '')) {
        return false;
    }
    return !jail.extraArgs.some(arg => arg === '--net' || arg.startsWith('--net=') || arg === '--netns' || arg.startsWith('--netns='));
}

function normalizeJail(raw: Partial<JailConfiguration> & { name: string; privateDir: string }): JailConfiguration {
    const result: JailConfiguration = {
        name: raw.name,
        privateDir: raw.privateDir,
        privateTmp: raw.privateTmp ?? true,
        noprofile: raw.noprofile ?? true,
        tab: raw.tab ?? true,
        nonewprivs: raw.nonewprivs ?? true,
        noroot: raw.noroot ?? true,
        extraArgs: Array.isArray(raw.extraArgs) ? raw.extraArgs : [],
    };

    for (const key of Object.keys(BOOLEAN_FLAGS) as (keyof JailConfiguration)[]) {
        if (raw[key] === true) {
            (result[key] as boolean) = true;
        }
    }
    if (raw.capsDropAll === true) {
        result.capsDropAll = true;
    }
    for (const key of Object.keys(VALUE_FLAGS) as (keyof JailConfiguration)[]) {
        const value = raw[key];
        if (typeof value === 'string' && value !== '') {
            (result[key] as string) = value;
        }
    }

    return result;
}

export default class JailStore {

    static async loadFromFS(): Promise<JailStore> {
        const configPath = getJailsConfigPath();
        let jails: JailConfiguration[] = [];
        if (await fileExists(configPath)) {
            try {
                const content = await fs.promises.readFile(configPath, 'utf8');
                const parsed = JSON.parse(content);
                if (Array.isArray(parsed)) {
                    jails = parsed
                        .filter((j): j is JailConfiguration => !!j && typeof j.name === 'string' && typeof j.privateDir === 'string')
                        .map(normalizeJail);
                }
            } catch {
                // Malformed config — treat as empty rather than throwing on every load.
                jails = [];
            }
        }
        return new JailStore(jails);
    }

    constructor(private jails: JailConfiguration[]) {
    }

    getAllJails(): JailConfiguration[] {
        return this.jails.slice();
    }

    getJail(name: string): JailConfiguration | undefined {
        return this.jails.find(j => j.name === name);
    }

    async addJail(jail: JailConfiguration): Promise<void> {
        if (this.jails.some(j => j.name === jail.name)) {
            throw new Error(`A jail named "${jail.name}" already exists`);
        }
        this.jails.push(normalizeJail(jail));
        await this.save();
    }

    async updateJail(name: string, jail: JailConfiguration): Promise<void> {
        const idx = this.jails.findIndex(j => j.name === name);
        if (idx < 0) {
            throw new Error(`No jail named "${name}"`);
        }
        this.jails[idx] = normalizeJail(jail);
        await this.save();
    }

    async removeJail(name: string): Promise<void> {
        this.jails = this.jails.filter(j => j.name !== name);
        await this.save();
    }

    private async save(): Promise<void> {
        const configPath = getJailsConfigPath();
        await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
        await fs.promises.writeFile(configPath, JSON.stringify(this.jails, null, 2), 'utf8');
    }
}
