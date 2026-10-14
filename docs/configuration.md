# Configuration reference

The extension reads `<agentDir>/pi-mxc.json` before each bash execution. The default agent directory is `~/.pi/agent`. `getAgentDir()` respects `PI_CODING_AGENT_DIR`.

All fields in [the example](../pi-mxc.example.json) are required. Unknown fields and malformed values are errors. A missing file uses defaults. A malformed file blocks bash, even if it contains `"enabled": false`.

## Fields

| Field                       | Default                                                 | Meaning                                                                                                                       |
| --------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                   | `true`                                                  | Whether bash runs through MXC. `false` explicitly permits local bash.                                                         |
| `backend`                   | `"auto"`                                                | `auto`, `seatbelt`, `bubblewrap`, or `processcontainer`. `auto` selects by host OS.                                           |
| `shellPath`                 | `/bin/bash` on Unix, `bash.exe` on Windows              | Bash executable inside MXC. The extension supplies `--noprofile --norc -c`.                                                   |
| `timeoutMs`                 | `120000`                                                | Positive integer maximum runtime. The bash tool's timeout in seconds can shorten this limit, but cannot lengthen it.          |
| `filesystem.readonlyPaths`  | `["~/.gitconfig"]`                                      | Literal directory or file paths granted read access. Backend baseline system access still applies.                            |
| `filesystem.readwritePaths` | `["."]`                                                 | Literal directory or file paths granted read and write access.                                                                |
| `filesystem.deniedPaths`    | SSH, AWS, GnuPG, and Azure config directories under `~` | Paths denied by MXC, including nested paths within a grant.                                                                   |
| `network.egress`            | `"deny"`                                                | Default outbound traffic action, `allow` or `deny`.                                                                           |
| `network.ingress`           | `"deny"`                                                | Default inbound traffic action, `allow` or `deny`.                                                                            |
| `network.hostLoopback`      | `"deny"`                                                | MXC's host-loopback action, `allow` or `deny`.                                                                                |
| `environment`               | `{}`                                                    | Explicit string-valued environment entries layered onto MXC's default environment. Host environment values are not forwarded. |

Paths beginning with `~/` expand against the host home directory. Relative paths resolve against the command's working directory. Paths are not globs. Parent segments such as `..` are rejected because lexical resolution can change the meaning of a policy path containing symlinks. Native MXC performs its own path normalization and validation.

The default read-only grant lets Git read `user.name`, `user.email`, and other settings from `~/.gitconfig` without granting write access. Existing config files keep their configured paths. To add this grant to an existing config, run `/sandbox add readonly ~/.gitconfig`.

Every enabled request also denies the agent directory's `auth.json` and `pi-mxc.json`. Bash cannot remove these built-in denials through the config. Other local tools are outside this protection.

UI access, clipboard access, and input injection are disabled. MXC telemetry is explicitly disabled. The extension does not expose learning mode, audit mode, raw Seatbelt profiles, or arbitrary containment options.

## Network limits

`hostLoopback: "allow"` requires `ingress: "allow"`. Seatbelt cannot enforce the opposite combination. Enabling ingress is a broad grant, and a listener can become reachable from the LAN if it binds a non-loopback address.

On Seatbelt, `hostLoopback: "deny"` also blocks outbound connections to the host's other bound addresses and the sandbox's own loopback listeners. It is not limited to the literal address `127.0.0.1`.

This scaffold has no hostname, CIDR, port, or proxy rules. Supported network policy and baseline filesystem access differ by backend. MXC rejects requests it cannot enforce, subject to the limitations documented by each backend.

## Commands

| Command                                                  | Result                                                                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `/sandbox` or `/sandbox status`                          | Displays the config path, config, and selected backend availability.                                                                      |
| `/sandbox help`                                          | Lists commands.                                                                                                                           |
| `/sandbox path`                                          | Displays the config path without parsing the file.                                                                                        |
| `/sandbox init`                                          | Creates a default config. Refuses to overwrite an existing file.                                                                          |
| `/sandbox on`                                            | Persists `enabled: true`.                                                                                                                 |
| `/sandbox off`                                           | Persists `enabled: false`. Subsequent bash commands run locally.                                                                          |
| `/sandbox edit`                                          | Opens pi's JSON editor. Validates the result before replacing the file. Cancellation leaves it unchanged. Supported in TUI and RPC modes. |
| `/sandbox add readonly <path>`                           | Adds a read-only path without duplicates.                                                                                                 |
| `/sandbox add readwrite <path>`                          | Adds a read-write path without duplicates.                                                                                                |
| `/sandbox add deny <path>`                               | Adds a denied path without duplicates.                                                                                                    |
| `/sandbox remove <readonly \| readwrite \| deny> <path>` | Removes an exact path entry. A missing entry is a no-op.                                                                                  |
| `/sandbox network <allow \| deny>`                       | Changes only `network.egress`.                                                                                                            |

The path is the remainder of the command. Spaces are preserved, and shell quoting is not interpreted. For example, `/sandbox add readonly /opt/my tools` adds `/opt/my tools` without quote characters.

Config writes use a unique temporary file and an atomic rename. On Unix, newly written files have mode `0600`. The last complete write wins if separate pi processes edit concurrently. An editor holds a snapshot, so saving it can replace intervening changes from another session.

Manual changes need no reload. The footer reports the state at session start or the last config command, not a continuously monitored native process state. Unsupported print-mode UI calls do not affect enforcement.

## Repair errors

`/sandbox edit` opens the raw file even if it is invalid. Invalid edits leave the existing file unchanged. `/sandbox path` works without loading the config. Other mutation commands require a valid existing config and do not silently replace malformed policy.

Backend discovery does not validate every policy field. Native validation occurs on launch. A failed launch produces a failed bash result and never a local retry.
