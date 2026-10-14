import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultConfig, type SandboxConfig } from "../extensions/config.js";
import { checkBackend, createSandboxOperations } from "../extensions/runtime.js";

let directory: string;

let workspace: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-mxc-live-"));
  workspace = join(directory, "workspace");
  mkdirSync(workspace);
  checkBackend(defaultConfig());
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function execute(
  command: string,
  config: SandboxConfig = defaultConfig(),
  signal?: AbortSignal,
) {
  const chunks: Buffer[] = [];
  const operations = createSandboxOperations({ config, backend: checkBackend(config) });
  const options = { onData: (data: Buffer) => chunks.push(data) };

  const result = await operations.exec(
    command,
    workspace,
    signal ? { ...options, signal } : options,
  );

  return { ...result, output: Buffer.concat(chunks).toString() };
}

describe("real MXC containment", () => {
  it("executes bash syntax without changing quoting or expanding it in a host shell", async () => {
    const result = await execute(
      `printf '%s\\n' 'apostrophe: '\\'' dollar: $HOME backtick: \u0060id\u0060'; printf 'error\\n' >&2; exit 7`,
    );

    expect(result.exitCode).toBe(7);
    expect(result.output).toContain("apostrophe: ' dollar: $HOME backtick: `id`\n");
    expect(result.output).toContain("error\n");
  });

  it("allows workspace writes but blocks reads and writes outside its policy", async () => {
    writeFileSync(join(directory, "outside.txt"), "outside-secret");

    const result = await execute(
      "printf 'written' > inside.txt; cat inside.txt; cat ../outside.txt; printf 'escape' > ../escape.txt",
    );

    expect(readFileSync(join(workspace, "inside.txt"), "utf8")).toBe("written");
    expect(result.output).toContain("written");
    expect(result.output).not.toContain("outside-secret");
    expect(result.exitCode).not.toBe(0);
    expect(() => readFileSync(join(directory, "escape.txt"))).toThrow();
  });

  it("denies an explicit secret even inside the writable workspace", async () => {
    writeFileSync(join(workspace, "secret.txt"), "do-not-leak");
    const config = defaultConfig();

    config.filesystem.deniedPaths.push("secret.txt");
    const result = await execute("cat secret.txt; printf 'changed' > secret.txt", config);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).not.toContain("do-not-leak");
    expect(readFileSync(join(workspace, "secret.txt"), "utf8")).toBe("do-not-leak");
  });

  it("does not follow a workspace symlink into an ungranted directory", async () => {
    writeFileSync(join(directory, "symlink-secret.txt"), "symlink-secret");
    symlinkSync(join(directory, "symlink-secret.txt"), join(workspace, "link.txt"));

    const result = await execute("cat link.txt");

    expect(result.exitCode).not.toBe(0);
    expect(result.output).not.toContain("symlink-secret");
  });

  it("does not inherit host credentials but passes explicitly configured environment values", async () => {
    const oldValue = process.env.PI_MXC_TEST_SECRET;

    process.env.PI_MXC_TEST_SECRET = "host-secret";

    try {
      const result = await execute('printf "%s" "${PI_MXC_TEST_SECRET-unset}"');

      expect(result.output).toBe("unset");
      const config = defaultConfig();

      config.environment.PI_MXC_TEST_SECRET = "explicit-value";
      expect((await execute('printf "%s" "$PI_MXC_TEST_SECRET"', config)).output).toBe(
        "explicit-value",
      );
    } finally {
      if (oldValue === undefined) delete process.env.PI_MXC_TEST_SECRET;
      else process.env.PI_MXC_TEST_SECRET = oldValue;
    }
  });

  it("blocks loopback networking by default and permits it only with explicit grants", async () => {
    const server = createServer((_request, response) => response.end("loopback-response"));

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node returns a TCP address or a Unix socket name at this I/O boundary.
    if (address === null || typeof address === "string") throw new Error("Missing server port");

    const command = `/usr/bin/curl --silent --show-error --max-time 2 http://127.0.0.1:${address.port}`;

    try {
      const denied = await execute(command);

      expect(denied.exitCode).not.toBe(0);
      expect(denied.output).not.toContain("loopback-response");

      const config = defaultConfig();

      config.network = { egress: "allow", ingress: "allow", hostLoopback: "allow" };
      const allowed = await execute(command, config);

      expect(allowed.exitCode).toBe(0);
      expect(allowed.output).toBe("loopback-response");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("enforces the configured timeout", async () => {
    const config = defaultConfig();

    config.timeoutMs = 150;
    await expect(execute("sleep 10", config)).rejects.toThrow("timeout:0.15");
  });

  it("cancels a running native process", async () => {
    const controller = new AbortController();
    const cancellation = setTimeout(() => controller.abort(), 200);

    try {
      await expect(execute("sleep 10", defaultConfig(), controller.signal)).rejects.toThrow(
        "aborted",
      );
    } finally {
      clearTimeout(cancellation);
    }
  });
});
