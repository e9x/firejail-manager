import * as crypto from 'crypto';
import Log from './common/logger';
import { getVSCodeServerConfig, ServerVersion, ServerValidation } from './serverConfig';
import JailConnection from './jail/jailConnection';
import { fetchRelease, IRelease } from './fetchRelease';
import { JailConfiguration } from './jail/jailConfig';
import { downloadServerOnHost } from './hostServerDownload';

function matchHostnamePattern(hostname: string, pattern: string): number {
    if (hostname === pattern) {
        return 1000;
    }
    if (pattern === '*') {
        return 1;
    }
    const regexPattern = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
    const regex = new RegExp(`^${regexPattern}$`);
    if (regex.test(hostname)) {
        const nonWildcardChars = pattern.replace(/\*/g, '').length;
        return 10 + nonWildcardChars;
    }
    return -1;
}

export function findServerInstallPath(hostname: string, pathMap: Record<string, string>): string | undefined {
    let bestMatch: { pattern: string; path: string; score: number } | undefined;
    for (const [pattern, path] of Object.entries(pathMap)) {
        const score = matchHostnamePattern(hostname, pattern);
        if (score > 0) {
            if (!bestMatch || score > bestMatch.score) {
                bestMatch = { pattern, path, score };
            }
        }
    }
    return bestMatch?.path;
}

export type ServerInstallOptions = {
    id: string;
    quality: string;
    commit: string;
    version: string;
    release?: string;
    extensionIds: string[];
    envVariables: string[];
    useSocketPath: boolean;
    serverApplicationName: string;
    serverDataFolderName: string;
    serverDownloadUrlTemplate: string;
    customInstallPath?: string;
    serverValidation: ServerValidation;
};

export type ServerInstallResult = {
    exitCode: number;
    listeningOn: number | string;
    connectionToken: string;
    logFile: string;
    osReleaseId: string;
    arch: string;
    platform: string;
    tmpDir: string;
    [key: string]: unknown;
};

export class ServerInstallError extends Error {
    constructor(message: string) {
        super(message);
    }
}

const DEFAULT_DOWNLOAD_URL_TEMPLATE = 'https://update.code.visualstudio.com/commit:${commit}/server-linux-${arch}/${quality}';

export async function installCodeServer(
    conn: JailConnection,
    serverDownloadUrlTemplate: string | undefined,
    serverVersion: ServerVersion,
    extensionIds: string[],
    envVariables: string[],
    platform: string | undefined,
    useSocketPath: boolean,
    customInstallPath: string | undefined,
    logger: Log,
    jail?: JailConfiguration
): Promise<ServerInstallResult> {
    // Firejail is Linux-only; the platform arg is kept for signature compat.
    void platform;

    const scriptId = crypto.randomBytes(12).toString('hex');
    const vscodeServerConfig = await getVSCodeServerConfig();

    const serverDownloadUrlTemplateFinal = serverDownloadUrlTemplate || vscodeServerConfig.serverDownloadUrlTemplate || DEFAULT_DOWNLOAD_URL_TEMPLATE;
    const bestRelease: IRelease = await fetchRelease(serverDownloadUrlTemplateFinal, vscodeServerConfig.version, vscodeServerConfig.release, serverVersion, logger);

    const installOptions: ServerInstallOptions = {
        id: scriptId,
        version: bestRelease.version,
        commit: vscodeServerConfig.commit,
        quality: vscodeServerConfig.quality,
        release: bestRelease.build,
        extensionIds,
        envVariables,
        useSocketPath,
        serverApplicationName: vscodeServerConfig.serverApplicationName,
        serverDataFolderName: vscodeServerConfig.serverDataFolderName,
        serverDownloadUrlTemplate: serverDownloadUrlTemplateFinal,
        customInstallPath,
        serverValidation: vscodeServerConfig.serverValidation,
    };

    // Download the server on the host (which has networking) into the jail's
    // data dir BEFORE running the jailed script. The jailed script then finds
    // the server binary already present and skips its own download, so the jail
    // can run with networking disabled (e.g. --net=none).
    if (jail) {
        try {
            await downloadServerOnHost({
                jail,
                serverDownloadUrlTemplate: serverDownloadUrlTemplateFinal,
                version: bestRelease.version,
                commit: vscodeServerConfig.commit,
                quality: vscodeServerConfig.quality,
                release: bestRelease.build,
                serverApplicationName: vscodeServerConfig.serverApplicationName,
                serverDataFolderName: vscodeServerConfig.serverDataFolderName,
                customInstallPath,
            }, logger);
        } catch (err) {
            throw new ServerInstallError(`Host-side server download failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    const installServerScript = generateBashInstallScript(installOptions);
    logger.trace('Server install command:', installServerScript);

    // Resolve as soon as the result block is printed, NOT on process close.
    // The script backgrounds a long-lived server, and firejail keeps the
    // `bash -ls` process alive until every descendant in its PID namespace
    // exits. So the process never closes while the server runs, and a plain
    // exec() (which resolves on close) would hang forever even though all the
    // install output is already available. execPartial resolves once the
    // `${scriptId}: end` marker appears.
    const endMarker = `${scriptId}: end`;
    // Stream output live so a hang is visible at the phase it stalls on,
    // instead of only seeing buffered output after the process closes.
    const commandOutput = await conn.execPartial(
        installServerScript,
        (stdout) => stdout.includes(endMarker),
        (channel, chunk) => {
            const text = chunk.replace(/\r?\n$/, '');
            if (text) {
                logger.trace(`[install:${channel}] ${text}`);
            }
        }
    );

    if (commandOutput.stderr) {
        logger.trace('Server install command stderr:', commandOutput.stderr);
    }
    logger.trace('Server install command stdout:', commandOutput.stdout);

    const resultMap = parseServerInstallOutput(commandOutput.stdout, scriptId);
    if (!resultMap) {
        throw new ServerInstallError(`Failed parsing install script output`);
    }

    const exitCode = parseInt(resultMap.exitCode, 10);
    if (exitCode !== 0) {
        throw new ServerInstallError(`Couldn't install vscode server in jail, install script returned non-zero exit status`);
    }

    const listeningOn = resultMap.listeningOn.match(/^\d+$/)
        ? parseInt(resultMap.listeningOn, 10)
        : resultMap.listeningOn;

    const remoteEnvVars = Object.fromEntries(Object.entries(resultMap).filter(([key,]) => envVariables.includes(key)));

    return {
        exitCode,
        listeningOn,
        connectionToken: resultMap.connectionToken,
        logFile: resultMap.logFile,
        osReleaseId: resultMap.osReleaseId,
        arch: resultMap.arch,
        platform: resultMap.platform,
        tmpDir: resultMap.tmpDir,
        ...remoteEnvVars
    };
}

function parseServerInstallOutput(str: string, scriptId: string): { [k: string]: string } | undefined {
    const startResultStr = `${scriptId}: start`;
    const endResultStr = `${scriptId}: end`;
    const startResultIdx = str.indexOf(startResultStr);
    if (startResultIdx < 0) {
        return undefined;
    }
    const endResultIdx = str.indexOf(endResultStr, startResultIdx + startResultStr.length);
    if (endResultIdx < 0) {
        return undefined;
    }
    const installResult = str.substring(startResultIdx + startResultStr.length, endResultIdx);
    const resultMap: { [k: string]: string } = {};
    for (const line of installResult.split(/\r?\n/)) {
        const [key, value] = line.split('==');
        resultMap[key] = value;
    }
    return resultMap;
}

function generateBashInstallScript({ id, quality, version, commit, release, extensionIds, envVariables, useSocketPath, serverApplicationName, serverDataFolderName, serverDownloadUrlTemplate, customInstallPath, serverValidation }: ServerInstallOptions) {
    const extensions = extensionIds.map(id => '--install-extension ' + id).join(' ');
    const serverDataDir = customInstallPath
        ? customInstallPath.replace(/^~(?=\/|$)/, '$HOME')
        : `$HOME/${serverDataFolderName}`;
    return `
# Server installation script (jailed)

TMP_DIR="\${XDG_RUNTIME_DIR:-"/tmp"}"

DISTRO_VERSION="${version}"
DISTRO_COMMIT="${commit}"
DISTRO_QUALITY="${quality}"
DISTRO_VSCODIUM_RELEASE="${release ?? ''}"

SERVER_APP_NAME="${serverApplicationName}"
SERVER_INITIAL_EXTENSIONS="${extensions}"
SERVER_DATA_DIR="${serverDataDir}"
SERVER_LISTEN_FLAG="${useSocketPath ? `--socket-path="$SERVER_DATA_DIR/.$DISTRO_COMMIT.sock"` : '--port=0'}"
SERVER_DATA_DIR_FLAG="${customInstallPath ? '--server-data-dir="$SERVER_DATA_DIR"' : ''}"
SERVER_DIR="$SERVER_DATA_DIR/bin/$DISTRO_COMMIT"
SERVER_SCRIPT="$SERVER_DIR/bin/$SERVER_APP_NAME"
SERVER_LOGFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.log"
SERVER_PIDFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.pid"
SERVER_TOKENFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.token"
SERVER_ARCH=
SERVER_CONNECTION_TOKEN=
SERVER_DOWNLOAD_URL=
SERVER_VALIDATION_FLAG="${serverValidation === 'skip' ? '--disable-client-validation' : ''}"

LISTENING_ON=
OS_RELEASE_ID=
ARCH=
PLATFORM=linux

print_install_results_and_exit() {
    echo "${id}: start"
    echo "exitCode==$1=="
    echo "listeningOn==$LISTENING_ON=="
    echo "connectionToken==$SERVER_CONNECTION_TOKEN=="
    echo "logFile==$SERVER_LOGFILE=="
    echo "osReleaseId==$OS_RELEASE_ID=="
    echo "arch==$ARCH=="
    echo "platform==$PLATFORM=="
    echo "tmpDir==$TMP_DIR=="
    ${envVariables.map(envVar => `echo "${envVar}==$${envVar}=="`).join('\n')}
    echo "${id}: end"
    exit 0
}

LOCKFILE="$TMP_DIR/server_install.lock"
if command -v flock >/dev/null 2>&1; then
  exec {FD}<>"$LOCKFILE"
  flock -x -w 30 $FD || print_install_results_and_exit 1
  trap "flock -u $FD; trap - EXIT INT HUP; exit" EXIT INT HUP
fi

ARCH="$(uname -m)"
case $ARCH in
    x86_64 | amd64) SERVER_ARCH="x64" ;;
    armv7l | armv8l) SERVER_ARCH="armhf" ;;
    arm64 | aarch64) SERVER_ARCH="arm64" ;;
    ppc64le) SERVER_ARCH="ppc64le" ;;
    riscv64) SERVER_ARCH="riscv64" ;;
    loongarch64) SERVER_ARCH="loong64" ;;
    s390x) SERVER_ARCH="s390x" ;;
    *)
        echo "Error architecture not supported: $ARCH"
        print_install_results_and_exit 1
        ;;
esac

OS_RELEASE_ID="$(grep -i '^ID=' /etc/os-release 2>/dev/null | sed 's/^ID=//gi' | sed 's/"//g')"
if [[ -z $OS_RELEASE_ID ]]; then
    OS_RELEASE_ID="$(grep -i '^ID=' /usr/lib/os-release 2>/dev/null | sed 's/^ID=//gi' | sed 's/"//g')"
    if [[ -z $OS_RELEASE_ID ]]; then
        OS_RELEASE_ID="unknown"
    fi
fi

if [[ ! -d $SERVER_DIR ]]; then
    mkdir -p $SERVER_DIR
    if (( $? > 0 )); then
        echo "Error creating server install directory"
        print_install_results_and_exit 1
    fi
fi

if [[ $OS_RELEASE_ID = alpine ]]; then
    PLATFORM=$OS_RELEASE_ID
fi

SERVER_DOWNLOAD_URL="$(echo "${serverDownloadUrlTemplate.replace(/\$\{/g, '\\${')}" | sed "s/\\\${quality}/$DISTRO_QUALITY/g" | sed "s/\\\${version}/$DISTRO_VERSION/g" | sed "s/\\\${commit}/$DISTRO_COMMIT/g" | sed "s/\\\${os}/$PLATFORM/g" | sed "s/\\\${arch}/$SERVER_ARCH/g" | sed "s/\\\${release}/$DISTRO_VSCODIUM_RELEASE/g")"
echo "[phase] arch=$SERVER_ARCH os=$OS_RELEASE_ID download_url=$SERVER_DOWNLOAD_URL" 1>&2

if [[ ! -f $SERVER_SCRIPT ]]; then
    pushd $SERVER_DIR > /dev/null
    echo "[phase] downloading server tarball..." 1>&2
    if command -v wget >/dev/null 2>&1; then
        wget --tries=3 --timeout=10 --continue --no-verbose -O vscode-server.tar.gz $SERVER_DOWNLOAD_URL 1>&2
    elif command -v curl >/dev/null 2>&1; then
        curl --retry 3 --connect-timeout 10 --location --show-error --silent --output vscode-server.tar.gz $SERVER_DOWNLOAD_URL 1>&2
    else
        echo "Error no tool to download server binary"
        print_install_results_and_exit 1
    fi
    if (( $? > 0 )); then
        echo "Error downloading server from $SERVER_DOWNLOAD_URL"
        rm -rf vscode-server.tar.gz
        print_install_results_and_exit 1
    fi
    echo "[phase] extracting server tarball..." 1>&2
    tar -xf vscode-server.tar.gz --strip-components 1
    if (( $? > 0 )); then
        echo "Error while extracting server contents"
        rm -rf vscode-server.tar.gz
        print_install_results_and_exit 1
    fi
    if [[ ! -f $SERVER_SCRIPT ]]; then
        rm -rf $SERVER_DIR/*
        echo "Error server contents are corrupted"
        print_install_results_and_exit 1
    fi
    rm -f vscode-server.tar.gz
    popd > /dev/null
    echo "[phase] server installed at $SERVER_SCRIPT" 1>&2
else
    echo "[phase] server script already installed in $SERVER_SCRIPT" 1>&2
fi

if ${serverValidation === 'force' ? 'true' : 'false'}; then
    if command -v sed >/dev/null 2>&1; then
        sed -i -E 's/"commit": "[0-9a-f]+",/"commit": "'"$DISTRO_COMMIT"'",/' "$SERVER_DIR/product.json"
    fi
fi

# Detect a still-running server WITHOUT relying on the pidfile. Under firejail's
# PID namespace the backgrounded server gets a jail-local pid (e.g. 45) that is
# meaningless to the next jail invocation, so a pid-based check always misses and
# every attempt respawns + rewrites the token. Instead, treat a server as alive
# if the log reports a listening endpoint AND that endpoint is actually
# accepting connections.
#
# The server listens either on a TCP port (--port=0) or a unix socket
# (--socket-path=). The log line "Extension host agent listening on <X>" carries
# a numeric port in the first case and a socket path in the second, so both
# forms must be handled or socket-path servers are never detected as alive and
# every resolve respawns a duplicate that collides on the socket (EADDRINUSE).
SERVER_RUNNING=
if [[ -f $SERVER_LOGFILE ]]; then
    EXISTING_LISTEN="$(grep -E 'Extension host agent listening on .+' $SERVER_LOGFILE 2>/dev/null | sed 's/.*Extension host agent listening on //' | tail -1)"
    if [[ -n $EXISTING_LISTEN ]]; then
        if [[ $EXISTING_LISTEN =~ ^[0-9]+$ ]]; then
            # TCP port: probe it to confirm the server is still up.
            EXISTING_PORT="$EXISTING_LISTEN"
            if command -v curl >/dev/null 2>&1; then
                if curl --max-time 2 --silent --output /dev/null "http://127.0.0.1:$EXISTING_PORT/version"; then
                    SERVER_RUNNING=1
                fi
            elif (exec 3<>"/dev/tcp/127.0.0.1/$EXISTING_PORT") 2>/dev/null; then
                exec 3>&- 3<&-
                SERVER_RUNNING=1
            fi
        else
            # Unix socket: confirm the socket exists and is accepting connections.
            # A stale socket file can linger after a crash, so probe it rather
            # than trusting its mere presence.
            if command -v curl >/dev/null 2>&1; then
                if curl --max-time 2 --silent --output /dev/null --unix-socket "$EXISTING_LISTEN" "http://localhost/version"; then
                    SERVER_RUNNING=1
                fi
            elif command -v nc >/dev/null 2>&1; then
                if nc -z -U "$EXISTING_LISTEN" 2>/dev/null; then
                    SERVER_RUNNING=1
                fi
            elif [[ -S $EXISTING_LISTEN ]]; then
                SERVER_RUNNING=1
            fi
        fi
    fi
fi

if [[ -z $SERVER_RUNNING ]]; then
    echo "[phase] starting server process..." 1>&2
    # Fresh start: this is the only place that resets the shared log/token files.
    # The reuse branch below must NOT touch them, or it would clobber the
    # token/port a concurrent resolve attempt already handed to the client.
    if [[ -f $SERVER_LOGFILE ]]; then rm $SERVER_LOGFILE; fi
    if [[ -f $SERVER_TOKENFILE ]]; then rm $SERVER_TOKENFILE; fi
    touch $SERVER_TOKENFILE
    chmod 600 $SERVER_TOKENFILE
    SERVER_CONNECTION_TOKEN="${crypto.randomUUID()}"
    echo $SERVER_CONNECTION_TOKEN > $SERVER_TOKENFILE
    $SERVER_SCRIPT --start-server --host=127.0.0.1 $SERVER_LISTEN_FLAG $SERVER_DATA_DIR_FLAG $SERVER_VALIDATION_FLAG $SERVER_INITIAL_EXTENSIONS --connection-token-file $SERVER_TOKENFILE --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms &> $SERVER_LOGFILE &
    echo $! > $SERVER_PIDFILE
else
    # Reuse the live server. Do NOT rewrite the token file or the log; the
    # endpoint and token reported below must come from the instance that is
    # actually listening, so the client connects with credentials that match.
    echo "[phase] reusing running server on $EXISTING_LISTEN" 1>&2
fi

if [[ -f $SERVER_TOKENFILE ]]; then
    SERVER_CONNECTION_TOKEN="$(cat $SERVER_TOKENFILE)"
else
    echo "Error server token file not found $SERVER_TOKENFILE"
    print_install_results_and_exit 1
fi

if [[ -f $SERVER_LOGFILE ]]; then
    echo "[phase] waiting for server to listen..." 1>&2
    for i in {1..35}; do
        LISTENING_ON="$(cat $SERVER_LOGFILE | grep -E 'Extension host agent listening on .+' | sed 's/Extension host agent listening on //')"
        if [[ -n $LISTENING_ON ]]; then
            break
        fi
        sleep 0.5
    done
    if [[ -z $LISTENING_ON ]]; then
        echo "Error server did not start successfully"
        echo "[phase] server log contents follow:" 1>&2
        cat $SERVER_LOGFILE 1>&2
        print_install_results_and_exit 1
    fi
    echo "[phase] server listening on $LISTENING_ON" 1>&2
else
    echo "Error server log file not found $SERVER_LOGFILE"
    print_install_results_and_exit 1
fi

print_install_results_and_exit 0
`;
}
