import * as vscode from 'vscode';
import { getJailsConfigPath } from './jailConfig';

type FirejailFlag = {
    flag: string;
    detail: string;
    /** Whether the flag takes a `=value` argument. */
    takesValue?: boolean;
};

type JailProperty = {
    /** The JSON property name. */
    name: string;
    /** The JSON value kind, used to build the inserted snippet. */
    type: 'string' | 'boolean' | 'array';
    /** Human-readable description shown in the completion item. */
    detail: string;
};

/**
 * All jail settings, mirroring `JailConfiguration` and `jails.schema.json`.
 * Used to offer property-name autocomplete at object-key positions.
 */
const JAIL_PROPERTIES: JailProperty[] = [
    { name: 'name', type: 'string', detail: 'Unique jail name. Cannot contain whitespace or path separators.' },
    { name: 'privateDir', type: 'string', detail: 'Private home directory for the jail (firejail --private=DIR). Supports ~ expansion.' },
    { name: 'privateTmp', type: 'boolean', detail: 'Mount a private, empty /tmp inside the jail (firejail --private-tmp).' },
    { name: 'noprofile', type: 'boolean', detail: 'Do not load any firejail security profile (firejail --noprofile).' },
    { name: 'net', type: 'string', detail: 'Enable a new network namespace on the given interface (firejail --net=INTERFACE).' },
    { name: 'netns', type: 'string', detail: 'Run in a named network namespace (firejail --netns=NAME).' },
    { name: 'dns', type: 'string', detail: 'Set a DNS server for the jail (firejail --dns=ADDRESS).' },
    { name: 'ip', type: 'string', detail: 'Assign an IP address in the new network namespace (firejail --ip=ADDRESS).' },
    { name: 'hostname', type: 'string', detail: 'Set the jail hostname (firejail --hostname=NAME).' },
    { name: 'nodbus', type: 'boolean', detail: 'Disable D-Bus access (firejail --nodbus).' },
    { name: 'no3d', type: 'boolean', detail: 'Disable 3D hardware acceleration (firejail --no3d).' },
    { name: 'nosound', type: 'boolean', detail: 'Disable sound system (firejail --nosound).' },
    { name: 'novideo', type: 'boolean', detail: 'Disable video devices (firejail --novideo).' },
    { name: 'nodvd', type: 'boolean', detail: 'Disable DVD and CD devices (firejail --nodvd).' },
    { name: 'notv', type: 'boolean', detail: 'Disable DVB TV devices (firejail --notv).' },
    { name: 'nou2f', type: 'boolean', detail: 'Disable U2F devices (firejail --nou2f).' },
    { name: 'noinput', type: 'boolean', detail: 'Disable input devices (firejail --noinput).' },
    { name: 'privateDev', type: 'boolean', detail: 'Mount a minimal /dev (firejail --private-dev).' },
    { name: 'nonewprivs', type: 'boolean', detail: 'Prevent the process from gaining new privileges (firejail --nonewprivs).' },
    { name: 'noroot', type: 'boolean', detail: 'Install a user namespace with a single user (firejail --noroot).' },
    { name: 'seccomp', type: 'boolean', detail: 'Enable seccomp filtering (firejail --seccomp).' },
    { name: 'capsDropAll', type: 'boolean', detail: 'Drop all Linux capabilities (firejail --caps.drop=all).' },
    { name: 'apparmor', type: 'boolean', detail: 'Enable the firejail-default AppArmor profile (firejail --apparmor).' },
    { name: 'privateCache', type: 'boolean', detail: 'Mount an empty temporary ~/.cache (firejail --private-cache).' },
    { name: 'disableMnt', type: 'boolean', detail: 'Disable access to /mnt, /media, /run/mount, and /run/media (firejail --disable-mnt).' },
    { name: 'writableVar', type: 'boolean', detail: 'Mount /var read-write (firejail --writable-var).' },
    { name: 'writableVarLog', type: 'boolean', detail: 'Use the real /var/log directory rather than a tmpfs (firejail --writable-var-log).' },
    { name: 'writableRunUser', type: 'boolean', detail: 'Disable the default blacklisting of /run/user/$UID/systemd and /run/user/$UID/bus (firejail --writable-run-user).' },
    { name: 'keepDevShm', type: 'boolean', detail: 'Preserve /dev/shm when using --private-dev (firejail --keep-dev-shm).' },
    { name: 'machineId', type: 'boolean', detail: 'Spoof the /etc/machine-id value (firejail --machine-id).' },
    { name: 'timeout', type: 'string', detail: 'Kill the jail after the given time, hh:mm:ss (firejail --timeout=hh:mm:ss).' },
    { name: 'nice', type: 'string', detail: 'Set the nice value for the jailed process (firejail --nice=VALUE).' },
    { name: 'extraArgs', type: 'array', detail: 'Additional raw arguments passed to the firejail binary.' },
];

/**
 * A curated subset of firejail options that are useful inside a jail's
 * `extraArgs`. This is not exhaustive; it covers the most common networking,
 * filesystem, and security flags. See `man firejail` for the full list.
 */
const FIREJAIL_FLAGS: FirejailFlag[] = [
    { flag: '--caps.keep', detail: 'Keep only the given Linux capabilities.', takesValue: true },
    { flag: '--whitelist', detail: 'Whitelist a directory or file.', takesValue: true },
    { flag: '--blacklist', detail: 'Blacklist a directory or file.', takesValue: true },
    { flag: '--read-only', detail: 'Mount a directory or file read-only.', takesValue: true },
    { flag: '--read-write', detail: 'Mount a directory or file read-write.', takesValue: true },
    { flag: '--bind', detail: 'Bind-mount a directory or file over another.', takesValue: true },
    { flag: '--tmpfs', detail: 'Mount an empty tmpfs filesystem on a directory.', takesValue: true },
    { flag: '--x11', detail: 'Sandbox the X11 server.', takesValue: true },
    { flag: '--env', detail: 'Set an environment variable in the jail (NAME=value).', takesValue: true },
    { flag: '--rmenv', detail: 'Remove an environment variable in the jail.', takesValue: true },
    { flag: '--cpu', detail: 'Set the CPU affinity.', takesValue: true },
    { flag: '--rlimit-as', detail: 'Set the maximum address space size.', takesValue: true },
    { flag: '--rlimit-nproc', detail: 'Set the maximum number of processes.', takesValue: true },
];

/**
 * Whether the cursor sits inside a string element of an `extraArgs` array.
 * This is a lightweight, line-based heuristic rather than a full JSON parse:
 * it scans backwards for the nearest `"extraArgs"` key and ensures the
 * enclosing array hasn't been closed before the cursor.
 */
function isInsideExtraArgs(document: vscode.TextDocument, position: vscode.Position): boolean {
    const offset = document.offsetAt(position);
    const text = document.getText();
    const before = text.slice(0, offset);

    const keyIdx = before.lastIndexOf('"extraArgs"');
    if (keyIdx < 0) {
        return false;
    }

    const openIdx = before.indexOf('[', keyIdx);
    if (openIdx < 0) {
        return false;
    }

    // If the array was closed between its opening bracket and the cursor,
    // we are no longer inside it.
    const closeIdx = before.indexOf(']', openIdx);
    return closeIdx < 0;
}

/** Heuristic: is `character` inside a double-quoted string on this line? */
function isCursorInsideString(line: string, character: number): boolean {
    let inString = false;
    for (let i = 0; i < character && i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' && line[i - 1] !== '\\') {
            inString = !inString;
        }
    }
    return inString;
}

/**
 * Whether the cursor sits at an object-key position within a jail object: that
 * is, inside the top-level array, within an object (`{...}`) that has not yet
 * been closed, and on a part of the line that precedes any `:` value separator.
 * This is a lightweight, line-based heuristic rather than a full JSON parse.
 */
function isAtPropertyKey(document: vscode.TextDocument, position: vscode.Position): boolean {
    const offset = document.offsetAt(position);
    const text = document.getText();
    const before = text.slice(0, offset);

    // Must be inside an object that hasn't been closed yet: the nearest
    // unmatched brace before the cursor should be an opening `{`.
    let depth = 0;
    let lastUnmatchedOpen = -1;
    for (let i = 0; i < before.length; i++) {
        const ch = before[i];
        if (ch === '{') {
            if (depth === 0) {
                lastUnmatchedOpen = i;
            }
            depth++;
        } else if (ch === '}') {
            depth--;
        }
    }
    if (depth <= 0 || lastUnmatchedOpen < 0) {
        return false;
    }

    // Within the current object, look at the text since the last property
    // delimiter (`{` or `,`). If a `:` appears before the cursor, we are in a
    // value position rather than a key position.
    const delimIdx = Math.max(before.lastIndexOf('{'), before.lastIndexOf(','));
    const segment = before.slice(delimIdx + 1);
    if (segment.includes(':')) {
        return false;
    }
    // Don't offer key completion inside a nested array value (e.g. extraArgs).
    if (segment.includes('[')) {
        return false;
    }
    return true;
}

/** The set of jail property names already present in the enclosing object. */
function existingKeysInObject(document: vscode.TextDocument, position: vscode.Position): Set<string> {
    const offset = document.offsetAt(position);
    const text = document.getText();
    const before = text.slice(0, offset);

    // Find the opening brace of the current (innermost unclosed) object.
    let depth = 0;
    let openIdx = -1;
    for (let i = 0; i < before.length; i++) {
        const ch = before[i];
        if (ch === '{') {
            if (depth === 0) {
                openIdx = i;
            }
            depth++;
        } else if (ch === '}') {
            depth--;
        }
    }
    const keys = new Set<string>();
    if (openIdx < 0) {
        return keys;
    }

    // Scan the object body (from its opening brace to the cursor) for keys.
    const body = before.slice(openIdx + 1);
    const keyRe = /"([^"\\]*)"\s*:/g;
    let match: RegExpExecArray | null;
    while ((match = keyRe.exec(body)) !== null) {
        keys.add(match[1]);
    }
    return keys;
}

class FirejailFlagCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionItem[] | undefined {
        if (isInsideExtraArgs(document, position)) {
            return this.provideFlagCompletions(document, position);
        }
        if (isAtPropertyKey(document, position)) {
            return this.providePropertyCompletions(document, position);
        }
        return undefined;
    }

    private provideFlagCompletions(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionItem[] {
        const line = document.lineAt(position.line).text;

        return FIREJAIL_FLAGS.map(({ flag, detail, takesValue }) => {
            const item = new vscode.CompletionItem(flag, vscode.CompletionItemKind.Value);
            item.detail = detail;
            item.documentation = new vscode.MarkdownString(
                `\`firejail ${flag}${takesValue ? '=<value>' : ''}\`\n\n${detail}`
            );

            // If the cursor is already inside a JSON string, insert the bare
            // flag; otherwise wrap it in quotes so it forms a valid array element.
            const insideQuotes = isCursorInsideString(line, position.character);
            const value = takesValue ? `${flag}=` : flag;
            item.insertText = insideQuotes ? value : `"${value}"`;

            if (takesValue) {
                item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };
            }
            return item;
        });
    }

    private providePropertyCompletions(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionItem[] {
        const line = document.lineAt(position.line).text;
        const insideQuotes = isCursorInsideString(line, position.character);
        const existing = existingKeysInObject(document, position);

        return JAIL_PROPERTIES
            .filter(({ name }) => !existing.has(name))
            .map(({ name, type, detail }) => {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
                item.detail = `${detail} (${type})`;
                item.documentation = new vscode.MarkdownString(detail);

                // Build the inserted value placeholder based on the property type.
                // SnippetString tab stops let the user fill in the value next.
                let valueSnippet: string;
                switch (type) {
                    case 'boolean':
                        valueSnippet = '${1:true}';
                        break;
                    case 'array':
                        valueSnippet = '[$1]';
                        break;
                    default:
                        valueSnippet = '"$1"';
                        break;
                }

                // The key, optionally already inside quotes the user typed.
                const keyPart = insideQuotes ? name : `"${name}"`;
                item.insertText = new vscode.SnippetString(`${keyPart}: ${valueSnippet}`);

                if (type !== 'boolean') {
                    item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };
                }
                return item;
            });
    }
}

/**
 * Register a completion provider for the jails.json config file. Offers jail
 * property-name completion at object-key positions and firejail flag
 * completion inside the `extraArgs` array. Completion is offered only for the
 * active jails config document, identified by path.
 */
export function registerFirejailCompletionProvider(): vscode.Disposable {
    const provider = new FirejailFlagCompletionProvider();
    return vscode.languages.registerCompletionItemProvider(
        { language: 'json', scheme: 'file' },
        {
            provideCompletionItems(document, position) {
                if (document.uri.fsPath !== getJailsConfigPath()) {
                    return undefined;
                }
                return provider.provideCompletionItems(document, position);
            }
        },
        '"', '-'
    );
}
