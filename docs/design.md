# Design notes

## Integration choice

Two approaches fit the initial requirement.

A launcher could start the whole pi process inside MXC. That would cover its file tools and extension code, but pi would need grants for credentials, session files, model networking, and installed extensions. An extension cannot retroactively isolate the process that loaded it.

A tool adapter can sandbox child bash workloads through MXC's Node SDK. This matches pi's checked sandbox example and preserves built-in bash rendering, output truncation, file accumulation, cancellation conventions, and programmatic results. It leaves pi's other tools and integrations outside the sandbox.

This scaffold uses the tool adapter. It is a bash restriction for a trusted pi installation, not a complete agent containment solution. A full-agent launcher is separate follow-up work. These alternatives were evaluated serially, without independent subagent review.

## Modules and execution flow

- `extensions/config.ts` owns the TypeBox schema, agent-directory path, parsing, defaults, and atomic writes.
- `extensions/runtime.ts` builds typed MXC V1 requests and implements `BashOperations` with streaming output and native lifecycle ownership.
- `extensions/mxc.ts` registers the bash replacement, user-bash hook, status, and `/sandbox` command.

For an agent bash call, the extension reads and validates the config, checks the selected backend, and creates pi's bash tool definition with MXC operations. The operations build a request, spawn a native sandbox, consume both output streams, await process and stream completion, and dispose the handle. User bash follows the same operations path. Explicitly disabled config uses pi's local bash behavior.

Config and backend errors fail closed. No mutable initialization flag can accidentally select local execution after a native error. Each command captures its own config. Commands can run in parallel without sharing container handles.

The runtime sets `HOME` to the host home directory so Git can find the default read-only `~/.gitconfig` grant. Each execution also gets a private writable temporary directory through `TMPDIR`, `TMP`, and `TEMP`. This lets Git and Apple's Git launcher create temporary files without granting access to the host's entire temporary directory. The runtime removes the directory in a `finally` block, including on native launch errors. Separate executions do not share temporary storage.

Explicitly configured environment values override these defaults. Other environment values come from MXC's default environment. Neither pi's session environment nor the rest of the host environment is forwarded. The request always selects an explicit native backend rather than relying on an ambiguous default containment type.

## Why one config

Policy lives only in the agent directory. Project files cannot silently override a user's sandbox policy. Required fields and rejection of unknown keys catch misspelled restrictions rather than quietly dropping them. Commands read the current file before mutation. Invalid policy requires explicit repair instead of resetting to defaults.

A missing file has enabled defaults but is not created on startup. `/sandbox init` owns creation, so merely loading the package does not write user configuration.

## Verification and follow-up

Unit tests cover policy persistence, malformed config, cancellation during spawn, native launch errors, and stream handling through an explicit process seam. The native integration suite exercises real containment rather than replacing the SDK with module mocks.

Live verification currently covers macOS Seatbelt only. Linux Bubblewrap and Windows ProcessContainer need host-specific validation. A future full-agent launcher, broader file-tool coverage, or network proxy support must define its security boundary before expanding the extension's claims.
