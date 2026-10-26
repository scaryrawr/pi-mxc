# Configuration reference

The extension reads `<agentDir>/pi-mxc.json` before each bash execution. The default agent directory is `~/.pi/agent`. `getAgentDir()` respects `PI_CODING_AGENT_DIR`.

All fields in [the example](../pi-mxc.example.json) except `inheritHostPath` are required. Omitted `inheritHostPath` means `true`, including in existing configs. Unknown fields and malformed values are errors. A missing file uses defaults. A malformed file blocks bash, even if it contains `"enabled": false`.

## Fields

| Field                       | Default                                                 | Meaning                                                                                                              |
| --------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `enabled`                   | `true`                                                  | Whether bash runs through MXC. `false` explicitly permits local bash.                                                |
| `backend`                   | `"auto"`                                                | `auto`, `seatbelt`, `bubblewrap`, or `processcontainer`. `auto` selects by host OS.                                  |
| `shellPath`                 | `/bin/bash` on Unix, `bash.exe` on Windows              | Bash executable inside MXC. The extension supplies `--noprofile --norc -c`.                                          |
| `timeoutMs`                 | `120000`                                                | Positive integer maximum runtime. The bash tool's timeout in seconds can shorten this limit, but cannot lengthen it. |
| `filesystem.readonlyPaths`  | Standard Git files listed below                         | Literal directory or file paths granted read access. Backend baseline system access still applies.                   |
| `filesystem.readwritePaths` | `["."]`                                                 | Literal directory or file paths granted read and write access.                                                       |
| `filesystem.deniedPaths`    | SSH, AWS, GnuPG, and Azure config directories under `~` | Paths denied by MXC, including nested paths within a grant.                                                          |
| `network.egress`            | `"deny"`                                                | Default outbound traffic action, `allow` or `deny`.                                                                  |
| `network.ingress`           | `"deny"`                                                | Default inbound traffic action, `allow` or `deny`.                                                                   |
| `network.hostLoopback`      | `"deny"`                                                | MXC's host-loopback action, `allow` or `deny`.                                                                       |
| `inheritHostPath`           | `true`                                                  | Forward the host PATH and discover read-only tool grants. `false` disables both behaviors.                           |
| `environment`               | `{}`, or the host's valid `XDG_CONFIG_HOME`             | Explicit string-valued entries that override the runtime environment described below.                                |

Paths beginning with `~/` expand against the host home directory. Relative paths in saved defaults resolve against each bash command's working directory. Newly added session paths resolve once against the directory where the grant is made and remain absolute for the session. Paths are not globs. Parent segments such as `..` are rejected because lexical resolution can change the meaning of a policy path containing symlinks. Native MXC performs its own path normalization and validation.

New default policies grant read-only access to these standard Git files:

- `~/.gitconfig`
- `~/.config/git/config`
- `~/.config/git/ignore`
- `~/.config/git/attributes`

A host `XDG_CONFIG_HOME` that is absolute and contains no `..` segments replaces `~/.config` for the last three paths. New defaults also capture that variable in `environment` so Git uses the granted location. Empty, relative, or parent-traversing values are ignored. Only the named files are granted, not the Git or XDG directories. Config includes and arbitrary paths named by Git settings are not followed automatically. Git config files can contain sensitive values even though these grants are read-only.

Existing saved policies retain their exact configured paths and environment; new defaults are not merged into them. `/sandbox add readonly <path>` adds a file for the session, and `/sandbox --persist add readonly <path>` explicitly saves a grant. Changing `environment.XDG_CONFIG_HOME` later requires matching filesystem grants for its Git files.

Each enabled command receives `HOME` set to the host home directory and a private writable temporary directory through `TMPDIR`, `TMP`, and `TEMP`. The extension removes that temporary directory after completion, cancellation, timeout, or launch failure. It does not grant access to other host temporary files. Explicit `environment` entries override these defaults, but custom paths still need filesystem grants. The pi process's `PATH` is also forwarded unless `inheritHostPath` is `false`. New defaults explicitly capture a valid host `XDG_CONFIG_HOME` as described above. Other host environment values are not forwarded.

Setting `HOME` does not grant access to the entire home directory. Only configured paths and MXC's backend baseline remain accessible. Git config includes, ignore and attribute files outside the standard locations, credential helpers, and signing tools can require additional grants. Git worktrees can require read-write access to their Git metadata outside the working directory. The extension does not discover or grant these paths automatically.

## Session and saved policy

Policy commands are session-only by default, including filesystem changes, network changes, the JSON editor, and `on` and `off`. Session changes do not create or write a config file. They remain in memory and are not stored in the conversation or restored when a conversation resumes.

Session overrides clear on `/sandbox reset`, reload, session switch, fork, or process restart. Running commands retain the policy captured when they started. Session grants do not propagate to another pi instance.

`--persist` before an action changes saved global defaults. For example, `/sandbox --persist add readonly /opt/tools` saves that grant. Only the requested change is saved; unrelated session changes are not included. Existing session overrides continue to apply over the saved defaults until reset. `/sandbox init` is an explicit exception: it always creates a saved config file without overwriting an existing one. Direct file edits are also persistent.

The effective policy combines the current saved defaults with session overrides before every bash command. Filesystem changes are additions and removals, so a new saved denial is not hidden by an unrelated session grant. Other changed settings override their saved values for the session. A malformed saved config blocks bash even if session overrides exist or sandboxing was disabled for the session.

`/sandbox status` identifies the saved config path, whether session overrides are active, and the effective policy. The status marker includes `(session)` while overrides are active. Reset clears only session overrides; it does not remove existing saved grants or automatic host-tool grants.

## Host tool access

With `inheritHostPath` enabled, tool discovery uses `environment.PATH` if configured, otherwise the pi process's PATH. It grants read-only access to existing absolute PATH directories, their canonical symlink targets, and directories containing linked executable files. For `bin` and `sbin` directories, existing sibling `lib`, `lib64`, `libexec`, and `share` directories are also readable. A prefix containing `Cellar` and either `Library/Homebrew` or `Homebrew/Library/Homebrew` receives a read-only grant for the entire prefix, including dependencies and Homebrew metadata.

Discovery does not execute host commands, source shell profiles, or assume a version manager's installation path. Empty, relative, missing, and inaccessible PATH entries do not create automatic grants. The PATH string itself is preserved. Discovery runs before each command so version-manager link changes take effect without a reload.

These automatic grants expand filesystem read access beyond the configured `readonlyPaths`. PATH directories and linked targets are trusted tool locations and can contain non-tool data. Explicit denied paths and the built-in credential denials still apply. Automatic grants never add write access. Tools that need package caches, downloads, credentials, or manager state require explicit configuration for those operations.

With `inheritHostPath: false`, no PATH or filesystem grants are discovered. An explicit `environment.PATH` is still passed, but its filesystem grants must be configured manually. `/sandbox status` displays the effective PATH and automatic read-only paths separately from the persisted config.

## Built-in restrictions

Every enabled request also denies the agent directory's `auth.json` and `pi-mxc.json`. Bash cannot remove these built-in denials through the config. Other local tools are outside this protection.

UI access, clipboard access, and input injection are disabled. MXC telemetry is explicitly disabled. The extension does not expose learning mode, audit mode, raw Seatbelt profiles, or arbitrary containment options.

## Network limits

The default policy denies outbound traffic, inbound traffic, and host loopback for every bash command. It has no exceptions for `git`, `gh`, or `curl`. Local Git operations remain available within the filesystem policy, but remote Git and GitHub CLI requests require network access.

`/sandbox network allow` applies a blanket outbound grant to bash and all its subprocesses for the current session. `/sandbox --persist network allow` saves that grant globally. Neither form restricts destinations, executables, HTTP methods, or uploads. `/sandbox network deny` restores outbound denial for the session. These commands do not change ingress or host-loopback policy.

A separately installed web fetch tool runs outside this bash sandbox. It can read user-provided links without opening bash networking, but its own implementation determines its network restrictions. The extension does not install a fetch tool or route blocked commands to one.

Checking whether a shell command starts with `git` or `gh` would not enforce a network boundary. Shell commands can contain other commands, Git can execute hooks and helpers, and `gh api` can send write requests. Narrower access requires a separately enforced destination policy or a dedicated tool with a validated operation interface. An HTTPS destination allowlist alone would still allow uploads to those destinations.

`hostLoopback: "allow"` requires `ingress: "allow"`. Seatbelt cannot enforce the opposite combination. Enabling ingress is a broad grant, and a listener can become reachable from the LAN if it binds a non-loopback address.

On Seatbelt, `hostLoopback: "deny"` also blocks outbound connections to the host's other bound addresses and the sandbox's own loopback listeners. It is not limited to the literal address `127.0.0.1`.

This scaffold has no hostname, CIDR, port, or proxy rules. Supported network policy and baseline filesystem access differ by backend. MXC rejects requests it cannot enforce, subject to the limitations documented by each backend.

## Commands

| Command                                                                  | Result                                                                                                                                 |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/sandbox` or `/sandbox status`                                          | Displays the saved config path, session-override state, effective policy, tool grants, and selected backend availability.              |
| `/sandbox help`                                                          | Lists commands.                                                                                                                        |
| `/sandbox path`                                                          | Displays the config path without parsing the file.                                                                                     |
| `/sandbox init`                                                          | Creates a default config. Refuses to overwrite an existing file.                                                                       |
| `/sandbox on`                                                            | Sets `enabled: true` for the session.                                                                                                  |
| `/sandbox off`                                                           | Sets `enabled: false` for the session. Subsequent bash commands run locally.                                                           |
| `/sandbox edit`                                                          | Edits the effective session policy. Validates before applying changes. Cancellation leaves policy unchanged. Supported in TUI and RPC. |
| `/sandbox add readonly <path>`                                           | Adds a read-only path without duplicates.                                                                                              |
| `/sandbox add readwrite <path>`                                          | Adds a read-write path without duplicates.                                                                                             |
| `/sandbox add deny <path>`                                               | Adds a denied path without duplicates.                                                                                                 |
| `/sandbox remove <readonly \| readwrite \| deny> <path>`                 | Removes a path for the session, comparing expanded paths. A missing entry is a no-op.                                                  |
| `/sandbox network <allow \| deny>`                                       | Changes only `network.egress` for the session.                                                                                         |
| `/sandbox reset`                                                         | Discards all session overrides without modifying saved defaults.                                                                       |
| `/sandbox --persist <on \| off \| edit \| add \| remove \| network> ...` | Changes saved defaults only. Persistent path removal matches an exact saved entry.                                                     |

The optional `--persist` flag precedes the action, not the path. The path is the remainder of the command. Spaces are preserved, and shell quoting is not interpreted. For example, `/sandbox add readonly /opt/my tools` adds `/opt/my tools` without quote characters.

Persistent config writes use a unique temporary file and an atomic rename. On Unix, newly written files have mode `0600`. The last complete write wins if separate pi processes edit concurrently. An editor holds a snapshot, so saving it can replace intervening changes from another session.

Manual changes to saved defaults need no reload, though active session overrides still apply. The footer reports the state at session start or the last config command, not a continuously monitored native process state. Unsupported print-mode UI calls do not affect enforcement.

## Repair errors

`/sandbox --persist edit` opens the raw saved file even if it is invalid. Invalid edits leave the existing file unchanged. The default session editor requires a valid saved policy. `/sandbox path` works without loading the config. Other mutation commands require a valid existing config and do not silently replace malformed policy.

Backend discovery does not validate every policy field. Native validation occurs on launch. A failed launch produces a failed bash result and never a local retry.
