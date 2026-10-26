import { existsSync, readFileSync } from "node:fs";

import {
  createBashToolDefinition,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  defaultConfig,
  expandPath,
  getConfigPath,
  parseConfig,
  serializeConfig,
  writeConfig,
  type SandboxConfig,
} from "./config.js";
import { createFooter } from "./footer.js";
import { SandboxPolicy, type PolicyScope } from "./policy.js";
import { checkBackend, createSandboxOperations } from "./runtime.js";
import { getToolPolicy } from "./tools.js";

const PERSISTENT_ACTIONS = ["on", "off", "edit", "add", "remove", "network"];

const HELP = [
  "/sandbox [status]                     Show effective config and session overrides",
  "/sandbox init                         Create the saved default config, without overwriting",
  "/sandbox on | off                     Enable or disable bash sandboxing for this session",
  "/sandbox edit                         Edit and validate this session's policy",
  "/sandbox path                         Show the saved config file location",
  "/sandbox add | remove <readonly | readwrite | deny> <path>",
  "/sandbox network <allow | deny>       Change outbound access for this session",
  "/sandbox reset                        Discard all session overrides",
  "/sandbox --persist <on | off | edit | add | remove | network> ...",
  "Changes are session-only unless --persist precedes the action. init always creates a saved config.",
  "Session overrides clear on reset, reload, session switch, fork, or restart.",
  "Changes apply to the next bash command. Running commands keep their existing policy.",
].join("\n");

function updateStatus(ctx: ExtensionContext, policy: SandboxPolicy): void {
  try {
    const config = policy.read();

    if (config.enabled) checkBackend(config);

    ctx.ui.setStatus(
      "pi-mxc",
      `sandbox: ${config.enabled ? "on" : "off"}${policy.hasOverrides ? " (session)" : ""}`,
    );
  } catch (error) {
    ctx.ui.setStatus("pi-mxc", "sandbox: blocked");
    ctx.ui.notify(String(error), "error");
  }
}

function pathList(config: SandboxConfig, name: string): string[] {
  switch (name) {
    case "readonly":
      return config.filesystem.readonlyPaths;
    case "readwrite":
      return config.filesystem.readwritePaths;
    case "deny":
      return config.filesystem.deniedPaths;
    default:
      throw new Error("Path list must be readonly, readwrite, or deny.");
  }
}

async function handleCommand(
  args: string,
  ctx: ExtensionCommandContext,
  policy: SandboxPolicy,
): Promise<void> {
  const scope: PolicyScope = /^--persist(?:\s|$)/.test(args.trim()) ? "persist" : "session";
  const input = scope === "persist" ? args.trim().slice("--persist".length).trim() : args.trim();
  const [action = "status", ...remaining] = input.split(/\s+/).filter(Boolean);
  const path = getConfigPath();
  const rest = input.slice(action.length).trim();

  if (scope === "persist" && !PERSISTENT_ACTIONS.includes(action)) {
    throw new Error("--persist must precede on, off, edit, add, remove, or network.");
  }

  switch (action) {
    case "status": {
      const config = policy.read();
      const backend = config.enabled ? checkBackend(config) : "disabled";
      const tools = getToolPolicy(config);
      const toolStatus = config.inheritHostPath === false ? "disabled" : "enabled";

      ctx.ui.notify(
        [
          `Saved defaults: ${path}`,
          `Session overrides: ${policy.hasOverrides ? "active, not saved" : "none"}`,
          `Bash sandbox: ${backend}`,
          `Host PATH tools: ${toolStatus}`,
          `PATH: ${config.environment.PATH ?? tools.environment.PATH ?? "MXC default"}`,
          "Automatic read-only paths:",
          ...tools.readonlyPaths,
          "Effective policy:",
          serializeConfig(config),
        ].join("\n"),
        "info",
      );

      return;
    }

    case "help":
      ctx.ui.notify(HELP, "info");

      return;
    case "path":
      ctx.ui.notify(path, "info");

      return;
    case "init":
      if (existsSync(path)) throw new Error(`Config already exists: ${path}`);
      writeConfig(defaultConfig());
      updateStatus(ctx, policy);
      ctx.ui.notify(`Created saved defaults at ${path}.`, "info");

      return;
    case "reset":
      policy.reset();
      updateStatus(ctx, policy);
      ctx.ui.notify("Session overrides cleared. Bash uses saved defaults again.", "info");

      return;
    case "edit": {
      if (!ctx.hasUI)
        throw new Error(
          "/sandbox edit requires a UI. Editing the config file directly changes saved defaults.",
        );

      const text =
        scope === "persist"
          ? existsSync(path)
            ? readFileSync(path, "utf8")
            : serializeConfig(defaultConfig())
          : serializeConfig(policy.read());

      const edited = await ctx.ui.editor(
        `MXC bash sandbox policy (${scope === "persist" ? "saved defaults" : "session only"})`,
        text,
      );

      if (edited === undefined) return;

      const config = parseConfig(edited);

      if (scope === "persist") writeConfig(config);
      else
        policy.update({
          scope,
          cwd: ctx.cwd,
          mutate: (current) => {
            Object.assign(current, config);

            if (config.inheritHostPath === undefined) delete current.inheritHostPath;
          },
        });
      break;
    }

    case "on":
    case "off": {
      policy.update({
        scope,
        cwd: ctx.cwd,
        mutate: (config) => {
          config.enabled = action === "on";
        },
      });
      break;
    }

    case "add":
    case "remove": {
      const [listName = ""] = remaining;
      const entry = rest.slice(listName.length).trim();

      if (!entry)
        throw new Error("Supply a path after the list name. Paths are literal, not globs.");

      policy.update({
        scope,
        cwd: ctx.cwd,
        mutate(config) {
          const paths = pathList(config, listName);

          const index =
            scope === "session"
              ? paths.findIndex((path) => expandPath(path, ctx.cwd) === expandPath(entry, ctx.cwd))
              : paths.indexOf(entry);

          if (action === "add" && index < 0) paths.push(entry);

          if (action === "remove" && index >= 0) paths.splice(index, 1);
        },
      });
      break;
    }

    case "network": {
      const [access] = remaining;

      if (remaining.length !== 1 || (access !== "allow" && access !== "deny")) {
        throw new Error("Usage: /sandbox network <allow | deny>");
      }

      policy.update({
        scope,
        cwd: ctx.cwd,
        mutate: (config) => {
          config.network.egress = access;
        },
      });
      break;
    }

    default:
      throw new Error(HELP);
  }

  updateStatus(ctx, policy);
  ctx.ui.notify(
    scope === "persist"
      ? `Saved defaults at ${path}. Session overrides still apply until reset.`
      : "Changed this session only. Nothing was saved. Use --persist before the action to change saved defaults.",
    "info",
  );
}

export default function mxc(pi: ExtensionAPI): void {
  const policy = new SandboxPolicy();

  pi.registerTool({
    ...createBashToolDefinition(process.cwd()),
    async execute(id, params, signal, onUpdate, ctx) {
      const config = policy.read();

      const tool = config.enabled
        ? createBashToolDefinition(ctx.cwd, {
            operations: createSandboxOperations({ config, backend: checkBackend(config) }),
            exposeSessionEnvironment: false,
          })
        : createBashToolDefinition(ctx.cwd);

      return tool.execute(id, params, signal, onUpdate, ctx);
    },
  });

  pi.on("user_bash", () => {
    const config = policy.read();

    if (!config.enabled) return;

    return { operations: createSandboxOperations({ config, backend: checkBackend(config) }) };
  });

  pi.on("session_start", (_event, ctx) => {
    policy.reset();

    if (ctx.mode === "tui") {
      ctx.ui.setFooter((tui, theme, footerData) => ({
        ...createFooter(ctx, pi, theme, footerData),
        dispose: footerData.onBranchChange(() => tui.requestRender()),
      }));
    }

    updateStatus(ctx, policy);
  });

  pi.registerCommand("sandbox", {
    description: "Configure MXC bash sandboxing. /sandbox help lists commands.",
    getArgumentCompletions(prefix) {
      const commands = [
        "status",
        "help",
        "init",
        "on",
        "off",
        "edit",
        "path",
        "add",
        "remove",
        "network",
        "reset",
        "--persist",
      ];

      const persistent = prefix.startsWith("--persist ");
      const input = persistent ? prefix.slice("--persist ".length) : prefix;
      const candidates = persistent ? PERSISTENT_ACTIONS : commands;

      const items = candidates.flatMap((command) =>
        command.startsWith(input)
          ? [{ value: `${persistent ? "--persist " : ""}${command}`, label: command }]
          : [],
      );

      return items.length > 0 ? items : null;
    },
    async handler(args, ctx) {
      try {
        await handleCommand(args || "status", ctx, policy);
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    },
  });
}
