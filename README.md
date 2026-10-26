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

Use `/sandbox` to show the effective policy and whether session overrides are active. Use `/sandbox help` to list commands.

Policy commands change only the current session unless you put `--persist` before the action:

```text
/sandbox add readwrite /path/to/project
/sandbox --persist add readonly /path/to/shared/tools
/sandbox reset
```

The first grant is temporary. The second changes saved defaults for future sessions. `/sandbox reset` discards session overrides without changing saved defaults. Session overrides also clear on reload, session switch, fork, or restart, including when you resume an old conversation. Newly added session paths are resolved against the granting directory, so changing directories does not redirect a grant. Existing saved grants remain in place until you explicitly remove them.

By default, bash inherits the pi process's `PATH`. The extension discovers tool directories and grants read-only access to their runtimes, including version-manager links such as fnm and Homebrew installations. It does not run shell startup files or copy your entire host environment. Start pi from a shell where your tools already work.

`/sandbox status` shows the effective PATH and automatic read-only grants. Set `environment.PATH` in `/sandbox edit` to use a different tool search path. Discovery then uses that path instead of the host PATH.

Automatic discovery expands read access to PATH directories, linked executable locations, and runtime files. Homebrew discovery grants its whole installation prefix so tools can load dependencies. Explicit denials still apply, and tool installations remain read-only unless another grant permits writes. Package caches and tool-manager state outside the workspace need separate write grants.

To keep the previous manual policy, set `inheritHostPath` to `false` in `/sandbox edit`. Then configure both `environment.PATH` and the required filesystem grants yourself.

Keep outbound networking denied for normal agent work. For a user-provided link, use a separate web fetch tool if one is installed. This extension does not provide or restrict that tool.

`/sandbox network allow` grants outbound access to every bash command in this session, including `curl`, scripts, and subprocesses. It does not distinguish reads from uploads. Do not enable it just to read a pasted link. `--persist network allow` saves the broad grant for future sessions.

If you explicitly need unrestricted outbound access:

```text
/sandbox network allow
```

This does not permit ingress or host loopback. Hostname allowlists are not available in this scaffold. Restore the restriction with `/sandbox network deny` when finished.

Use `/sandbox off` only when you want bash to run locally without MXC for this session. Use `/sandbox on` to restore sandboxing, or `/sandbox reset` to restore all saved defaults. Saving a disabled default requires `/sandbox --persist off`.

Changes apply to the next command. A running command keeps the configuration it started with. Saved defaults are global, with no project override that can weaken them. Direct edits to the config file are persistent. `--persist` changes saved defaults only and never saves unrelated session grants; active session overrides continue to apply until reset.

See [Configuration reference](docs/configuration.md) for every field and command, or use [pi-mxc.example.json](pi-mxc.example.json) as a starting point.

## Use Git in the sandbox

New default policies grant read-only access to `~/.gitconfig`, `~/.config/git/config`, `~/.config/git/ignore`, and `~/.config/git/attributes`. If the host has a valid absolute `XDG_CONFIG_HOME`, defaults use its `git` files instead and explicitly set that variable for sandboxed commands. Empty, relative, or parent-traversing XDG paths fall back to `~/.config`.

Only those files are granted, not their containing directories. Git config can contain sensitive values, so review it before granting access. Existing saved policies are not expanded automatically.

To add the standard files to an existing policy for this session, run:

```text
/sandbox add readonly ~/.gitconfig
/sandbox add readonly ~/.config/git/config
/sandbox add readonly ~/.config/git/ignore
/sandbox add readonly ~/.config/git/attributes
```

For a custom XDG location, use its paths and set `environment.XDG_CONFIG_HOME` in `/sandbox edit`. Use `--persist` before an action only to save that change globally.

Local Git commands use your host `HOME`. Each command gets private writable temporary storage, including for Apple's Git launcher. Your other home files remain subject to the filesystem policy.

If Git uses config includes or ignore and attribute files at other locations, add read-only grants for those files. For a linked worktree, grant read-write access to its external Git metadata directory. The extension does not automatically grant paths referenced by repository files.

Remote fetch, push, clone, and GitHub CLI requests are blocked by default. There is no network exemption for `git` or `gh`. The current `/sandbox network allow` option enables networking for all bash commands, not just those tools. Prefer a separately controlled Git or GitHub tool if available rather than opening bash networking.

SSH keys, credential helpers, and commit-signing tools need their own explicit access. `~/.ssh` and `~/.gnupg` are denied by default. A read-only grant does not override a denial. Host credential environment variables and SSH agent sockets are not forwarded automatically.

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

The integration suite checks host Node execution, linked tool runtimes and read-only enforcement, a local Git workflow, host Git identity, read-only global config, private temporary storage, allowed and denied filesystem operations, symlink containment, environment isolation, loopback networking, shell quoting, exit status, timeout, and cancellation. It does not certify every backend or policy combination.

`test:rpc` requires Python 3 and an installed `pi` command. It starts an isolated pi instance with a temporary agent directory, drives `/sandbox` commands and the JSON editor, and checks actual config files, session-switch cleanup, and native user-bash execution. It makes no model calls. Inside an existing sandbox, use `npm run test:rpc -- --commands-only` to verify policy commands without launching nested native sandboxes.

[Design notes](docs/design.md) explain the integration boundaries and follow-up work.
