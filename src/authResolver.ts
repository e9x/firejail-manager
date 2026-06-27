import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import { isNullable } from '@zokugun/is-it-type';
import Log from './common/logger';
import JailStore, { buildFirejailArgs, usesHostNetwork } from './jail/jailConfig';
import JailConnection from './jail/jailConnection';
import { installCodeServer, ServerInstallError } from './serverSetup';
import { getVSCodeServerConfig, ServerVersion } from './serverConfig';
import { resolveHostServerDataDir } from './hostServerDownload';

export const REMOTE_FIREJAIL_AUTHORITY = 'firejail';

export function getRemoteAuthority(jailName: string) {
    return `${REMOTE_FIREJAIL_AUTHORITY}+${jailName}`;
}

export class FirejailResolver implements vscode.RemoteAuthorityResolver, vscode.Disposable {

    private labelFormatterDisposable: vscode.Disposable | undefined;
    tunnelFactory?: vscode.RemoteAuthorityResolver['tunnelFactory'];

    // Whether the jail resolved in this window shares the host network
    // namespace. A resolver instance lives in a single window's UI extension
    // host and only ever resolves that window's authority, so a single flag is
    // sufficient. Consulted by showCandidatePort to suppress auto-forwarding.
    private hostNetwork = false;

    constructor(
        readonly context: vscode.ExtensionContext,
        readonly logger: Log
    ) {
    }

    resolve(authority: string, context: vscode.RemoteAuthorityResolverContext): Thenable<vscode.ResolverResult> {
        const [type, jailName] = authority.split('+');
        if (type !== REMOTE_FIREJAIL_AUTHORITY) {
            throw new Error(`Invalid authority type for Firejail resolver: ${type}`);
        }

        this.logger.info(`Resolving firejail authority '${authority}' (attempt #${context.resolveAttempt})`);

        const firejailConfig = vscode.workspace.getConfiguration('firejail');
        const serverDownloadUrlTemplate = firejailConfig.get<string>('serverDownloadUrlTemplate');
        const serverVersion = firejailConfig.get<ServerVersion>('serverVersion', 'match');
        const defaultExtensions = firejailConfig.get<string[]>('defaultExtensions', []);
        const useSocketPath = firejailConfig.get<boolean>('useSocketPath', true);

        return vscode.window.withProgress({
            title: `Setting up Firejail ${jailName}`,
            location: vscode.ProgressLocation.Notification,
            cancellable: false
        }, async () => {
            try {
                const jailStore = await JailStore.loadFromFS();
                const jail = jailStore.getJail(jailName);
                if (!jail) {
                    throw new ServerInstallError(`No jail named "${jailName}"`);
                }

                this.logger.trace(`Firejail args: ${buildFirejailArgs(jail).join(' ')}`);

                const conn = new JailConnection(jail);

                const installResult = await installCodeServer(
                    conn,
                    serverDownloadUrlTemplate,
                    serverVersion,
                    defaultExtensions,
                    [],
                    'linux',
                    useSocketPath,
                    undefined,
                    this.logger,
                    jail
                );

                // Enable the ports view only when the jail has its own network
                // namespace. On the host network the server is reachable directly
                // at 127.0.0.1, so port forwarding is unnecessary.
                this.hostNetwork = usesHostNetwork(jail);
                this.tunnelFactory = this.hostNetwork ? (tunnelOptions) => {
                    this.logger.trace(`Ignoring port forward request for host-network jail: ${tunnelOptions.remoteAddress.host}:${tunnelOptions.remoteAddress.port}`);
                    return undefined;
                } : undefined;
                vscode.commands.executeCommand('setContext', 'forwardedPortsViewEnabled', !this.hostNetwork);

                this.labelFormatterDisposable?.dispose();
                this.labelFormatterDisposable = vscode.workspace.registerResourceLabelFormatter({
                    scheme: 'vscode-remote',
                    authority: `${REMOTE_FIREJAIL_AUTHORITY}+*`,
                    formatting: {
                        label: '${path}',
                        separator: '/',
                        tildify: true,
                        workspaceSuffix: `Firejail: ${jailName}`
                    }
                });

                const listeningOn = installResult.listeningOn;

                if (useSocketPath) {
                    // The server listens on a Unix socket inside the jail. Under
                    // `firejail --private=DIR`, the jail's $HOME maps to DIR on the
                    // host, so the jail-internal socket path
                    // ($SERVER_DATA_DIR/.<commit>.sock) is reachable on the host by
                    // rebasing it onto the jail's private dir. We bridge that socket
                    // through a ManagedResolvedAuthority since ResolvedAuthority only
                    // supports host+port.
                    const vscodeServerConfig = await getVSCodeServerConfig();
                    const hostDataDir = resolveHostServerDataDir(jail, vscodeServerConfig.serverDataFolderName, undefined);
                    const socketName = path.basename(String(listeningOn));
                    const hostSocketPath = path.join(hostDataDir, socketName);
                    this.logger.info(`Connecting to jail server over Unix socket ${hostSocketPath}`);

                    return new vscode.ManagedResolvedAuthority(
                        () => connectToSocket(hostSocketPath, this.logger),
                        installResult.connectionToken
                    );
                }

                // The server listens on 127.0.0.1:<port> inside the jail; since the
                // jail shares the host network namespace by default, we connect to it
                // directly with no tunnel.
                const port = typeof listeningOn === 'number' ? listeningOn : parseInt(String(listeningOn), 10);
                if (isNullable(port) || Number.isNaN(port)) {
                    throw new ServerInstallError(`Server did not report a numeric listening port`);
                }

                return new vscode.ResolvedAuthority('127.0.0.1', port, installResult.connectionToken);
            } catch (e: unknown) {
                this.logger.error(`Error resolving authority`, e);

                if (context.resolveAttempt === 1) {
                    this.logger.show();

                    const closeRemote = 'Close Remote';
                    const retry = 'Retry';
                    const result = await vscode.window.showErrorMessage(`Could not establish connection to jail "${jailName}"`, { modal: true }, closeRemote, retry);
                    if (result === closeRemote) {
                        await vscode.commands.executeCommand('workbench.action.remote.close');
                    } else if (result === retry) {
                        await vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                }

                if (e instanceof ServerInstallError || !(e instanceof Error)) {
                    throw vscode.RemoteAuthorityResolverError.NotAvailable(e instanceof Error ? e.message : String(e));
                } else {
                    throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(e.message);
                }
            }
        });
    }

    dispose() {
        this.labelFormatterDisposable?.dispose();
    }
}

/**
 * Open a Unix domain socket and adapt it to VS Code's ManagedMessagePassing
 * interface, so a socket-listening jail server can be reached without a TCP
 * port. Resolves once the socket is connected; rejects if the connection fails
 * before it is established.
 */
function connectToSocket(socketPath: string, logger: Log): Promise<vscode.ManagedMessagePassing> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);

        const onDidReceiveMessage = new vscode.EventEmitter<Uint8Array>();
        const onDidClose = new vscode.EventEmitter<Error | undefined>();
        const onDidEnd = new vscode.EventEmitter<void>();

        let connected = false;
        let settled = false;

        socket.on('connect', () => {
            connected = true;
            settled = true;
            resolve({
                onDidReceiveMessage: onDidReceiveMessage.event,
                onDidClose: onDidClose.event,
                onDidEnd: onDidEnd.event,
                send: (data: Uint8Array) => {
                    socket.write(Buffer.from(data));
                },
                end: () => {
                    socket.end();
                },
            });
        });

        socket.on('data', (data: Buffer) => {
            onDidReceiveMessage.fire(new Uint8Array(data));
        });

        socket.on('error', (err: Error) => {
            if (!settled) {
                settled = true;
                logger.error(`Failed to connect to jail server socket ${socketPath}`, err);
                reject(err);
            } else {
                onDidClose.fire(err);
            }
        });

        socket.on('end', () => {
            onDidEnd.fire();
        });

        socket.on('close', () => {
            if (connected) {
                onDidClose.fire(undefined);
            }
        });
    });
}
