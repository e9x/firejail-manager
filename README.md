# Firejail Manager

Manage local [firejail](https://firejail.wordpress.com/) sandboxes as VSCode remote targets. Instead of connecting over SSH to another machine, this extension launches the VSCode remote server *inside* a firejail sandbox on your local machine and connects the editor to it — giving you a confined, configurable environment for opening folders and running code, without leaving your desktop.

## Requirements

- Linux with [firejail](https://firejail.wordpress.com/) installed and on your `$PATH` (or point `firejail.firejailPath` at the binary).

## How it works

Each jail is a firejail sandbox definition. When you connect, the extension:

1. Builds a `firejail` command line from the jail's configuration (see [Jail configuration](#jail-configuration)).
2. Downloads and installs the matching VSCode remote server inside the sandbox.
3. Starts the server and connects the editor to it.

By default the server listens on a Unix socket inside the jail's private directory, so jails can run with no network namespace at all (e.g. `--net=none`). If you assign the jail its own network namespace, the server is reached over `127.0.0.1` instead. Firejail uses the host network by default, in which case no port forwarding is needed.

## Getting started

1. Open the **Remote Explorer** and find the **Firejail Jails** view, or run **Firejail: Connect to Jail...** from the Command Palette.
2. Add a jail with the **+** button in the view title. You'll be asked for a name and a private home directory.
3. Select the jail to open it in a new window (or use **Firejail: Connect Current Window to Jail...**).

## Commands

- **Firejail: Connect to Jail...** — pick a jail and open it in a new window.
- **Firejail: Connect Current Window to Jail...** — connect the current window to a jail.
- **Firejail: Open Jails Config File...** — open the `jails.json` store in the editor.
- **Firejail: Show Log** — open the extension's output log.

The **Firejail Jails** view in the Remote Explorer also provides per-jail actions: add, configure, edit, refresh, remove, and open in a new or current window.

## Jail configuration

Jails are stored in a `jails.json` file. By default this lives in the extension's global storage; set `firejail.configFile` to use a path of your own (`~` is expanded). The file is an array of jail objects validated against [`resources/jails.schema.json`](resources/jails.schema.json), so you get completion and validation when editing it.

A new jail defaults to the equivalent of:

```
firejail --private=DIR --private-tmp --noprofile
```

### Required fields

- `name` — unique jail name (no whitespace or path separators).
- `privateDir` — private home directory for the jail (`firejail --private=DIR`). Supports `~` expansion.

### Common fields

- `privateTmp` (default `true`) — private, empty `/tmp` (`--private-tmp`).
- `noprofile` (default `true`) — don't load any firejail security profile (`--noprofile`).

### Networking

- `net` — new network namespace on an interface (`--net=INTERFACE`).
- `netns` — named network namespace (`--netns=NAME`).
- `dns` — DNS server (`--dns=ADDRESS`).
- `ip` — IP address in the new namespace (`--ip=ADDRESS`).
- `hostname` — jail hostname (`--hostname=NAME`).

### Devices / IPC

`nodbus`, `no3d`, `nosound`, `novideo`, `nodvd`, `notv`, `nou2f`, `noinput`, `privateDev` — map to the matching `firejail --no*` / `--private-dev` flags.

### Security

`nonewprivs`, `noroot`, `seccomp`, `capsDropAll` (`--caps.drop=all`), `apparmor` — map to the matching firejail hardening flags.

### Filesystem

`privateCache`, `disableMnt`, `writableVar`, `writableVarLog`, `writableRunUser`, `keepDevShm`, `machineId` — map to the matching firejail mount/filesystem flags.

### Resource limits

- `timeout` — kill the jail after `hh:mm:ss` (`--timeout`).
- `nice` — nice value for the jailed process (`--nice`).

### Escape hatch

- `extraArgs` — array of raw arguments appended to the `firejail` command line for anything not modelled above.

## Settings

- `firejail.configFile` — absolute path to `jails.json`. Defaults to the extension's global storage location.
- `firejail.firejailPath` — path to the firejail binary. Defaults to `firejail` on `$PATH`.
- `firejail.defaultExtensions` — extensions installed automatically inside every jail.
- `firejail.useSocketPath` (default `true`) — have the server listen on a Unix socket in the jail's private directory instead of a TCP port on `127.0.0.1`. Lets jails run with no network namespace (e.g. `--net=none`).
- `firejail.serverDownloadUrlTemplate` — URL template for the VSCode server download. Variables: `${quality}`, `${version}`, `${commit}`, `${arch}`, `${os}`, `${release}`.
- `firejail.serverVersion` — `match` (default), `latest`, `closest`, or a specific version.
- `firejail.serverValidation` — `strict` (default), `force`, or `skip`.
- `firejail.serverBinaryName` — override the server binary name. Use only when your client has no matching server release.

### Note for VSCode-OSS users

If you are using VSCode-OSS instead of VSCodium, the server version won't match a VSCodium release out of the box. Adjust the server settings, for example:

```json
"firejail.serverBinaryName": "codium-server",
"firejail.serverDownloadUrlTemplate": "https://github.com/VSCodium/vscodium/releases/download/${version}${release}/vscodium-reh-${os}-${arch}-${version}${release}.tar.gz",
"firejail.serverVersion": "latest",
"firejail.serverValidation": "force",
```

VSCodium releases carry an extra `release` part with no VSCode-OSS equivalent, so leaving `serverVersion` at the default `match` will fail. Set it to `latest` to install the latest VSCodium release, or to `closest` to fetch the last VSCodium release for your VSCode version. You can also pin a specific version (e.g. `1.116.0`) or version-release (e.g. `1.116.02821`). Release numbers are listed on the [VSCodium releases page](https://github.com/VSCodium/vscodium/releases/).

When local and remote versions don't match (as on VSCode-OSS), server validation must be relaxed. `force` rewrites the remote server commit to match the local VSCode commit; `skip` skips the commit check entirely (requires remote VSCodium `>=1.120`).

Starting with VSCodium 1.99.0 the `release` number is no longer separated from `version` by a dot, so the download template uses `${version}${release}` as shown above. Before 1.99.0 use the old dotted scheme:

```json
"firejail.serverDownloadUrlTemplate": "https://github.com/VSCodium/vscodium/releases/download/${version}.${release}/vscodium-reh-${os}-${arch}-${version}.${release}.tar.gz",
```

## License

See [LICENSE.txt](LICENSE.txt).
