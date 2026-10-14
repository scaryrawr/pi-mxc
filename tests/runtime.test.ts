import { existsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { defaultConfig } from "../extensions/config.js";
import { createSandboxOperations, type SandboxProcess } from "../extensions/runtime.js";

interface TestProcessOptions {
  timedOut?: boolean;
  exitCode?: number;
}

function testProcess({ timedOut = false, exitCode = 0 }: TestProcessOptions = {}) {
  const output = new PassThrough();
  const errors = new PassThrough();
  let disposed = false;
  let killed = false;

  const child: SandboxProcess = {
    standardOutput: output,
    standardError: errors,
    warnings: ["test warning"],
    async wait() {
      output.end(Buffer.from("stdout\n"));
      errors.end(Buffer.from("stderr\n"));

      return { exitCode, timedOut };
    },
    kill() {
      killed = true;
    },
    dispose() {
      disposed = true;
    },
  };

  return { child, isDisposed: () => disposed, isKilled: () => killed };
}

describe("MXC bash operations", () => {
  it("uses the host home and a private writable temporary directory, then removes it", async () => {
    let temporaryDirectory = "";

    const operations = createSandboxOperations({
      config: defaultConfig(),
      backend: "seatbelt",
      spawnProcess: async (request) => {
        const environment = request.environment;

        expect(environment?.HOME).toBe(homedir());
        temporaryDirectory = environment?.TMPDIR ?? "";
        expect(temporaryDirectory).not.toBe("");
        expect(environment?.TMP).toBe(temporaryDirectory);
        expect(environment?.TEMP).toBe(temporaryDirectory);
        expect(request.filesystem?.readwritePaths).toContain(temporaryDirectory);

        if (process.platform !== "win32") {
          expect(statSync(temporaryDirectory).mode & 0o777).toBe(0o700);
        }

        writeFileSync(join(temporaryDirectory, "cache"), "temporary data");

        return testProcess().child;
      },
    });

    await operations.exec("git status", "/workspace", { onData() {} });
    expect(existsSync(temporaryDirectory)).toBe(false);
  });

  it("preserves explicitly configured home and temporary paths", async () => {
    const config = defaultConfig();

    config.environment = { HOME: "/custom/home", TMPDIR: "/custom/tmp" };

    const operations = createSandboxOperations({
      config,
      backend: "seatbelt",
      spawnProcess: async (request) => {
        expect(request.environment?.HOME).toBe("/custom/home");
        expect(request.environment?.TMPDIR).toBe("/custom/tmp");

        return testProcess().child;
      },
    });

    await operations.exec("git status", "/workspace", { onData() {} });
  });

  it("streams both outputs, exposes warnings, and returns the workload exit code", async () => {
    const process = testProcess({ exitCode: 7 });
    const chunks: Buffer[] = [];

    const operations = createSandboxOperations({
      config: defaultConfig(),
      backend: "seatbelt",
      spawnProcess: async () => process.child,
    });

    const result = await operations.exec("echo hi", "/workspace", {
      onData: (data) => chunks.push(data),
    });

    expect(result).toEqual({ exitCode: 7 });
    expect(Buffer.concat(chunks).toString()).toContain("stdout\n");
    expect(Buffer.concat(chunks).toString()).toContain("stderr\n");
    expect(Buffer.concat(chunks).toString()).toContain("[MXC warning] test warning");
    expect(process.isDisposed()).toBe(true);
  });

  it("reports a timeout as a failed command and releases the process", async () => {
    const process = testProcess({ timedOut: true });
    let temporaryDirectory = "";

    const operations = createSandboxOperations({
      config: defaultConfig(),
      backend: "seatbelt",
      spawnProcess: async (request) => {
        temporaryDirectory = request.environment?.TMPDIR ?? "";

        return process.child;
      },
    });

    await expect(
      operations.exec("sleep 10", "/workspace", { onData() {}, timeout: 1 }),
    ).rejects.toThrow("timeout:1");
    expect(process.isDisposed()).toBe(true);
    expect(temporaryDirectory).not.toBe("");
    expect(existsSync(temporaryDirectory)).toBe(false);
  });

  it("lets a caller shorten the timeout but not extend the configured cap", async () => {
    const config = defaultConfig();

    config.timeoutMs = 100;
    let observedTimeout: number | undefined;
    let timedOut = false;

    const operations = createSandboxOperations({
      config,
      backend: "seatbelt",
      spawnProcess: async (request) => {
        observedTimeout = request.timeoutMs;

        return testProcess({ timedOut }).child;
      },
    });

    await operations.exec("sleep 10", "/workspace", { onData() {}, timeout: 0.05 });
    expect(observedTimeout).toBe(50);

    timedOut = true;
    await expect(
      operations.exec("sleep 10", "/workspace", { onData() {}, timeout: 10 }),
    ).rejects.toThrow("timeout:0.1");
    expect(observedTimeout).toBe(100);
  });

  it("never spawns when the operation is already cancelled", async () => {
    let spawned = false;

    const operations = createSandboxOperations({
      config: defaultConfig(),
      backend: "seatbelt",
      spawnProcess: async () => {
        spawned = true;

        return testProcess().child;
      },
    });

    await expect(
      operations.exec("echo hi", "/workspace", { onData() {}, signal: AbortSignal.abort() }),
    ).rejects.toThrow("aborted");
    expect(spawned).toBe(false);
  });

  it("kills a process if cancellation occurs while native spawning is pending", async () => {
    const controller = new AbortController();
    const process = testProcess();
    let temporaryDirectory = "";

    const operations = createSandboxOperations({
      config: defaultConfig(),
      backend: "seatbelt",
      spawnProcess: async (request) => {
        temporaryDirectory = request.environment?.TMPDIR ?? "";
        controller.abort();

        return process.child;
      },
    });

    await expect(
      operations.exec("sleep 10", "/workspace", { onData() {}, signal: controller.signal }),
    ).rejects.toThrow("aborted");
    expect(process.isKilled()).toBe(true);
    expect(process.isDisposed()).toBe(true);
    expect(temporaryDirectory).not.toBe("");
    expect(existsSync(temporaryDirectory)).toBe(false);
  });

  it("cleans up temporary files on native launch errors without executing anything locally", async () => {
    let temporaryDirectory = "";

    const operations = createSandboxOperations({
      config: defaultConfig(),
      backend: "seatbelt",
      spawnProcess: async (request) => {
        temporaryDirectory = request.environment?.TMPDIR ?? "";
        expect(existsSync(temporaryDirectory)).toBe(true);
        throw new Error("backend unavailable");
      },
    });

    await expect(operations.exec("echo hi", "/workspace", { onData() {} })).rejects.toThrow(
      "backend unavailable",
    );
    expect(existsSync(temporaryDirectory)).toBe(false);
  });
});
