import { existsSync, readFileSync } from "node:fs";

import {
  createBashToolDefinition,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  defaultConfig,
  getConfigPath,
  parseConfig,
  readConfig,
  serializeConfig,
  writeConfig,
  type SandboxConfig,
} from "./config.js";
import { checkBackend, createSandboxOperations } from "./runtime.js";

const HELP = [
  "/sandbox [status]                     Show config and backend availability",
  "/sandbox init                         Create the default config, without overwriting",
  "/sandbox on | off                     Persistently enable or disable bash sandboxing",
  "/sandbox edit                         Edit and validate the JSON config",
  "/sandbox path                         Show the config file location",
  "/sandbox add | remove <readonly | readwrite | deny> <path>",
  "/sandbox network <allow | deny>       Change outbound access, not ingress or loopback",
  "Changes apply to the next bash command. Running commands keep their existing policy.",
].join("\n");

function updateStatus(ctx: ExtensionContext): void {
  try {
    const config = readConfig();
    const status = config.enabled ? `bash sandbox: ${checkBackend(config)}` : "bash sandbox: off";

    ctx.ui.setStatus("pi-mxc", status);
  } catch (error) {
    ctx.ui.setStatus("pi-mxc", "bash sandbox: blocked");
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

async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const [action = "status", ...remaining] = args.trim().split(/\s+/).filter(Boolean);
  const path = getConfigPath();
  const rest = args.trim().slice(action.length).trim();

  switch (action) {
    case "status": {
      const config = readConfig();
      const backend = config.enabled ? checkBackend(config) : "disabled";

      ctx.ui.notify(`${path}\nBash sandbox: ${backend}\n${serializeConfig(config)}`, "info");

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
      break;
    case "edit": {
      if (!ctx.hasUI) throw new Error(`Edit ${path} directly. /sandbox edit requires a UI.`);

      const text = existsSync(path) ? readFileSync(path, "utf8") : serializeConfig(defaultConfig());
      const edited = await ctx.ui.editor("MXC bash sandbox config", text);

      if (edited === undefined) return;

      writeConfig(parseConfig(edited));
      break;
    }

    case "on":
    case "off": {
      const config = readConfig();

      config.enabled = action === "on";
      writeConfig(config);
      break;
    }

    case "add":
    case "remove": {
      const [listName = ""] = remaining;
      const entry = rest.slice(listName.length).trim();

      if (!entry)
        throw new Error("Supply a path after the list name. Paths are literal, not globs.");

      const config = readConfig();
      const paths = pathList(config, listName);
      const index = paths.indexOf(entry);

      if (action === "add" && index < 0) paths.push(entry);

      if (action === "remove" && index >= 0) paths.splice(index, 1);

      writeConfig(config);
      break;
    }

    case "network": {
      const [access] = remaining;

      if (remaining.length !== 1 || (access !== "allow" && access !== "deny")) {
        throw new Error("Usage: /sandbox network <allow | deny>");
      }

      const config = readConfig();

      config.network.egress = access;
      writeConfig(config);
      break;
    }

    default:
      throw new Error(HELP);
  }

  updateStatus(ctx);
  ctx.ui.notify(`Saved ${path}. Applies to the next bash command.`, "info");
}

export default function mxc(pi: ExtensionAPI): void {
  pi.registerTool({
    ...createBashToolDefinition(process.cwd()),
    async execute(id, params, signal, onUpdate, ctx) {
      const config = readConfig();

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
    const config = readConfig();

    if (!config.enabled) return;

    return { operations: createSandboxOperations({ config, backend: checkBackend(config) }) };
  });

  pi.on("session_start", (_event, ctx) => updateStatus(ctx));

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
      ];

      const items = commands.flatMap((command) =>
        command.startsWith(prefix) ? [{ value: command, label: command }] : [],
      );

      return items.length > 0 ? items : null;
    },
    async handler(args, ctx) {
      try {
        await handleCommand(args || "status", ctx);
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    },
  });
}
