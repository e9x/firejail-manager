import * as vscode from 'vscode';
import { isNullable } from '@zokugun/is-it-type';
import Log from './common/logger';
import JailStore, { buildFirejailArgs, usesHostNetwork } from './jail/jailConfig';
import JailConnection from './jail/jailConnection';
import { installCodeServer, ServerInstallError } from './serverSetup';
import { ServerVersion } from './serverConfig';

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
                    false,
                    undefined,
                    this.logger
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

                // The server listens on 127.0.0.1:<port> inside the jail; since the
                // jail shares the host network namespace by default, we connect to it
                // directly with no tunnel.
                const listeningOn = installResult.listeningOn;
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
