# pi-mxc

A pi extension that runs the agent's `bash` tool and user `!` and `!!` commands through [Microsoft MXC](https://github.com/microsoft/mxc).

This is bash sandboxing, not isolation of the entire agent. Pi's `read`, `write`, `edit`, `grep`, `find`, `ls`, and `powershell` tools remain local. The pi process, model requests, MCP servers, and other extensions also remain outside MXC. Do not treat this extension as a security boundary for an untrusted agent with those capabilities.

## Install

MXC requires Node.js 24 or later. Its npm package includes native runtime assets.

For a local checkout:

```bash
npm install --ignore-scripts
pi -e ./extensions/mxc.ts
```

To keep the extension enabled across sessions, run `pi install /absolute/path/to/pi-mxc` after installing dependencies in the checkout. This scaffold is not published to npm.

Run `/sandbox init` in pi to create `<agentDir>/pi-mxc.json`. The default location is `~/.pi/agent/pi-mxc.json`. Pi's `PI_CODING_AGENT_DIR` override is supported.

A missing config uses enabled, restrictive defaults without writing a file. Invalid JSON, invalid policy fields, an unavailable backend, or a native launch failure blocks bash. The extension never falls back to local execution while sandboxing is enabled.

## Configure bash access

Use `/sandbox` to show the current configuration. Use `/sandbox help` to list commands.

To grant read-only access to Homebrew tools on Apple silicon:

```text
/sandbox add readonly /opt/homebrew
/sandbox edit
```

In the editor, set `environment.PATH` to `/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`. Both the filesystem grant and `PATH` are needed. The extension does not copy your host environment or shell startup files into MXC.

To permit outbound network traffic:

```text
/sandbox network allow
```

This does not permit ingress or host loopback. Hostname allowlists are not available in this scaffold. Allowing outbound traffic is a broad grant.

Use `/sandbox off` only when you want bash to run locally without MXC. The change persists across sessions. Use `/sandbox on` to restore sandboxing.

Changes apply to the next command, including direct file edits. A running command keeps the configuration it started with. The config is global, with no project override that can weaken it.

See [Configuration reference](docs/configuration.md) for every field and command, or use [pi-mxc.example.json](pi-mxc.example.json) as a starting point.

## Use Git in the sandbox

Local Git commands use your host `HOME` and can read `~/.gitconfig` through the default read-only grant. Each command gets private writable temporary storage, including for Apple's Git launcher. Your other home files remain subject to the filesystem policy.

For an existing config without the Git grant, run:

```text
/sandbox add readonly ~/.gitconfig
```

If Git uses config includes, an XDG config, or a global ignore file outside the workspace, add read-only grants for those files. For a linked worktree, grant read-write access to its external Git metadata directory. The extension does not automatically grant paths referenced by repository files.

Remote fetch, push, and clone still require `/sandbox network allow`. SSH keys, credential helpers, and commit-signing tools need their own explicit access. `~/.ssh` and `~/.gnupg` are denied by default. A read-only grant does not override a denial. Host credential environment variables and SSH agent sockets are not forwarded automatically.

## Host requirements

`auto` selects Seatbelt on macOS, Bubblewrap on Linux, and ProcessContainer on Windows. There is no fallback to a different backend.

- macOS needs a host supported by MXC Seatbelt. The current upstream guide specifies macOS 15 or later.
- Linux needs Bubblewrap and its host prerequisites, including usable namespaces.
- Windows needs a supported MXC ProcessContainer host and an accessible bash executable. Set `shellPath` and its filesystem grants for your installation.

Native MXC validation decides whether the selected host can enforce a policy. Backend discovery is advisory, not a guarantee of execution. Only macOS Seatbelt has been tested live for this scaffold.

The Node SDK's [V1 reference](https://github.com/microsoft/mxc/tree/main/docs/api-reference/node/v1) and [backend guides](https://github.com/microsoft/mxc/tree/main/docs/backends) describe the current platform requirements and enforcement limits.

## Develop and verify

```bash
npm ci --ignore-scripts
npm run check
npm run test:integration
npm run test:rpc
```

`check` runs TypeScript native preview, type-aware Oxlint with the sibling extensions' vendored Anti-Slop rules, Oxfmt, and unit tests. `test:integration` runs actual MXC workloads and requires a usable native backend. It does not skip missing prerequisites. The live tests use Unix bash and `/usr/bin/curl`, so run them on macOS or Linux.

The integration suite checks a local Git workflow, host Git identity, read-only global config, private temporary storage, allowed and denied filesystem operations, symlink containment, environment isolation, loopback networking, shell quoting, exit status, timeout, and cancellation. It does not certify every backend or policy combination.

`test:rpc` requires Python 3 and an installed `pi` command. It starts an isolated pi instance with a temporary agent directory, drives `/sandbox` commands and the JSON editor, and checks actual config files and native user-bash execution. It makes no model calls.

[Design notes](docs/design.md) explain the integration boundaries and follow-up work.
