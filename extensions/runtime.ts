import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { finished } from "node:stream/promises";

import { getAgentDir, type BashOperations } from "@earendil-works/pi-coding-agent";
import {
  getPlatformSupport,
  spawn,
  type ContainerRequest,
  type MxcProcess,
} from "@microsoft/mxc-sdk/v1";

import { getConfigPath, type SandboxConfig } from "./config.js";

export type SandboxBackend = Exclude<SandboxConfig["backend"], "auto">;

export type SandboxProcess = Pick<
  MxcProcess,
  "standardOutput" | "standardError" | "wait" | "kill" | "dispose" | "warnings"
>;

export type SandboxSpawner = (request: ContainerRequest) => Promise<SandboxProcess>;

function selectedBackend(config: SandboxConfig): SandboxBackend {
  if (config.backend !== "auto") return config.backend;

  switch (process.platform) {
    case "darwin":
      return "seatbelt";
    case "linux":
      return "bubblewrap";
    case "win32":
      return "processcontainer";
    default:
      throw new Error(`MXC sandboxing is not supported on ${process.platform}.`);
  }
}

export function checkBackend(config: SandboxConfig): SandboxBackend {
  const backend = selectedBackend(config);
  const support = getPlatformSupport();

  if (!support.isSupported || !support.availableMethods.includes(backend)) {
    throw new Error(
      `MXC backend ${backend} is unavailable: ${support.unavailableReasons?.[backend] ?? support.reason ?? "check MXC host prerequisites"}`,
    );
  }

  return backend;
}

function expandPath(path: string, cwd: string): string {
  if (path === "~") return homedir();

  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));

  if (isAbsolute(path)) return path;

  return resolve(cwd, path);
}

function quoteArgument(argument: string): string {
  if (process.platform === "win32") {
    return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  }

  return `'${argument.replaceAll("'", "'\\''")}'`;
}

interface RequestOptions {
  config: SandboxConfig;
  backend: SandboxBackend;
  command: string;
  cwd: string;
  timeout: number | undefined;
}

export function buildRequest({
  config,
  backend,
  command,
  cwd,
  timeout,
}: RequestOptions): ContainerRequest {
  const timeoutMs =
    timeout === undefined ? config.timeoutMs : Math.min(config.timeoutMs, timeout * 1000);

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Sandbox timeout must be positive and finite.");
  }

  const deniedPaths = config.filesystem.deniedPaths.map((path) => expandPath(path, cwd));

  deniedPaths.push(getConfigPath(), join(getAgentDir(), "auth.json"));

  return {
    command: `${quoteArgument(config.shellPath)} --noprofile --norc -c ${quoteArgument(command)}`,
    workingDirectory: cwd,
    containment: { type: backend },
    timeoutMs: Math.ceil(timeoutMs),
    filesystem: {
      readonlyPaths: config.filesystem.readonlyPaths.map((path) => expandPath(path, cwd)),
      readwritePaths: config.filesystem.readwritePaths.map((path) => expandPath(path, cwd)),
      deniedPaths: [...new Set(deniedPaths)],
    },
    network: {
      egress: { default: config.network.egress },
      ingress: { default: config.network.ingress, hostLoopback: config.network.hostLoopback },
    },
    ui: { disable: true, clipboard: "none", allowInputInjection: false },
    environment: { ...config.environment },
    inheritDefaultEnvironment: true,
  };
}

const spawnSandbox: SandboxSpawner = (request) => spawn(request, { telemetry: { enabled: false } });

interface OperationsOptions {
  config: SandboxConfig;
  backend: SandboxBackend;
  spawnProcess?: SandboxSpawner;
}

export function createSandboxOperations({
  config,
  backend,
  spawnProcess = spawnSandbox,
}: OperationsOptions): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      if (signal?.aborted) throw new Error("aborted");

      const child = await spawnProcess(buildRequest({ config, backend, command, cwd, timeout }));
      const onAbort = () => child.kill();

      try {
        const output = child.standardOutput;
        const errors = child.standardError;
        const drains: Promise<void>[] = [];

        for (const stream of [output, errors]) {
          if (stream !== null) {
            stream.on("data", onData);
            drains.push(finished(stream, { cleanup: true }));
          }
        }

        signal?.addEventListener("abort", onAbort, { once: true });

        if (signal?.aborted) onAbort();

        const [result] = await Promise.all([child.wait(), ...drains]);

        for (const warning of child.warnings) {
          onData(Buffer.from(`\n[MXC warning] ${warning}\n`));
        }

        if (signal?.aborted) throw new Error("aborted");

        if (result.timedOut) {
          throw new Error(`timeout:${Math.min(timeout ?? Infinity, config.timeoutMs / 1000)}`);
        }

        return { exitCode: result.exitCode };
      } finally {
        signal?.removeEventListener("abort", onAbort);
        child.dispose();
      }
    },
  };
}
