import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const ActionSchema = Type.Union([Type.Literal("allow"), Type.Literal("deny")]);

const PathsSchema = Type.Array(Type.String({ minLength: 1, pattern: "\\S", maxLength: 4096 }));

export const SandboxConfigSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    backend: Type.Union([
      Type.Literal("auto"),
      Type.Literal("seatbelt"),
      Type.Literal("bubblewrap"),
      Type.Literal("processcontainer"),
    ]),
    shellPath: Type.String({ minLength: 1, pattern: "\\S" }),
    timeoutMs: Type.Integer({ minimum: 1, maximum: 2147483647 }),
    filesystem: Type.Object(
      {
        readonlyPaths: PathsSchema,
        readwritePaths: PathsSchema,
        deniedPaths: PathsSchema,
      },
      { additionalProperties: false },
    ),
    network: Type.Object(
      {
        egress: ActionSchema,
        ingress: ActionSchema,
        hostLoopback: ActionSchema,
      },
      { additionalProperties: false },
    ),
    environment: Type.Record(Type.String(), Type.String()),
  },
  { additionalProperties: false },
);

export type SandboxConfig = Static<typeof SandboxConfigSchema>;

export function defaultConfig(): SandboxConfig {
  return {
    enabled: true,
    backend: "auto",
    shellPath: process.platform === "win32" ? "bash.exe" : "/bin/bash",
    timeoutMs: 120000,
    filesystem: {
      readonlyPaths: [],
      readwritePaths: ["."],
      deniedPaths: ["~/.ssh", "~/.aws", "~/.gnupg", "~/.azure"],
    },
    network: { egress: "deny", ingress: "deny", hostLoopback: "deny" },
    environment: {},
  };
}

export function getConfigPath(): string {
  return join(getAgentDir(), "pi-mxc.json");
}

export function parseConfig(text: string): SandboxConfig {
  const input: unknown = JSON.parse(text);

  if (!Value.Check(SandboxConfigSchema, input)) {
    const errors = [...Value.Errors(SandboxConfigSchema, input)].map(
      (error) => `${error.instancePath || "/"}: ${error.message}`,
    );

    throw new Error(`Invalid sandbox config:\n${errors.join("\n")}`);
  }

  for (const paths of Object.values(input.filesystem)) {
    if (paths.some((path) => path.split(/[\\/]/).includes(".."))) {
      throw new Error("Policy paths cannot contain '..'. Use an absolute path instead.");
    }
  }

  if (input.network.hostLoopback === "allow" && input.network.ingress === "deny") {
    throw new Error("hostLoopback=allow requires ingress=allow.");
  }

  return input;
}

export function readConfig(path = getConfigPath()): SandboxConfig {
  try {
    return parseConfig(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return defaultConfig();
    }

    throw new Error(`Cannot load ${path}. Bash is blocked until this is fixed.\n${String(error)}`, {
      cause: error,
    });
  }
}

export function serializeConfig(config: SandboxConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function writeConfig(config: SandboxConfig, path = getConfigPath()): void {
  parseConfig(serializeConfig(config));
  mkdirSync(dirname(path), { recursive: true });

  const temporaryPath = `${path}.${randomUUID()}.tmp`;

  try {
    writeFileSync(temporaryPath, serializeConfig(config), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
