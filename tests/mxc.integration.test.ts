import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

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

  it.runIf(process.platform === "darwin")(
    "does not use the workspace as the macOS home or create Library directories there",
    async () => {
      const result = await execute(`/usr/bin/osascript -l JavaScript -e '
        ObjC.import("Foundation");
        const home = $.NSHomeDirectory();
        const cache = $.NSSearchPathForDirectoriesInDomains($.NSCachesDirectory, $.NSUserDomainMask, true).firstObject;
        console.log(ObjC.unwrap(home));
        console.log(ObjC.unwrap(cache));
        $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(cache, true, $.NSDictionary.dictionary, null);
      '`);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(`${homedir()}\n`);
      expect(result.output).toContain(`${join(homedir(), "Library", "Caches")}\n`);
      expect(existsSync(join(workspace, "Library"))).toBe(false);
    },
  );

  it("runs the host Node installation with only automatic tool grants", async () => {
    const config = defaultConfig();

    config.environment.PATH = [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
    const result = await execute("node -p 'process.version'", config);

    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe(process.version);
  });

  it("runs linked tools with their runtime files, keeps them read-only, and honors denials", async () => {
    const installation = join(directory, "tool-installation");
    const bin = join(installation, "bin");
    const lib = join(installation, "lib");
    const alias = join(directory, "tool-current");
    const script = join(lib, "fixture-tool");
    const data = join(lib, "data.txt");

    mkdirSync(bin, { recursive: true });
    mkdirSync(lib);
    writeFileSync(data, "tool-runtime-data");
    writeFileSync(script, `#!/bin/bash\ncat '${data}'\n`, { mode: 0o755 });
    symlinkSync("../lib/fixture-tool", join(bin, "fixture-tool"));
    symlinkSync(installation, alias);
    const config = defaultConfig();

    config.environment.PATH = `${join(alias, "bin")}:/usr/bin:/bin`;
    const result = await execute("fixture-tool", config);

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("tool-runtime-data");
    expect((await execute(`printf changed > '${data}'`, config)).exitCode).not.toBe(0);
    expect(readFileSync(data, "utf8")).toBe("tool-runtime-data");

    config.filesystem.deniedPaths.push(data);
    const denied = await execute("fixture-tool", config);

    expect(denied.exitCode).not.toBe(0);
    expect(denied.output).not.toContain("tool-runtime-data");
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

  it("supports local Git workflows using the host identity without permitting global config changes", async () => {
    const home = join(directory, "home");
    const path = join(home, ".gitconfig");
    const contents = "[user]\n\tname = Sandbox User\n\temail = sandbox@example.com\n";
    const originalHome = process.env.HOME;

    mkdirSync(home);
    writeFileSync(path, contents);
    process.env.HOME = home;

    try {
      const config = defaultConfig();

      config.environment.GIT_CONFIG_NOSYSTEM = "1";

      const identity = await execute(
        "git config --global user.name && git config --global user.email",
        config,
      );

      expect(identity.exitCode).toBe(0);
      expect(identity.output).toContain("Sandbox User\n");
      expect(identity.output).toContain("sandbox@example.com\n");

      const workflow = await execute(
        `set -eu
         git init --initial-branch=main repository
         cd repository
         printf 'original\\n' > tracked.txt
         git add tracked.txt
         git commit -m initial
         git switch -c feature
         printf 'changed\\n' > tracked.txt
         git diff --exit-code && exit 1
         git stash push -m saved
         git stash pop
         git add tracked.txt
         git commit -m changed
         git log -1 --format='%an <%ae>: %s'
         git status --porcelain
         git clone --bare . ../remote.git
         git remote add origin ../remote.git
         git push origin feature
         git fetch origin
         git clone ../remote.git ../clone
         git -C ../clone show HEAD:tracked.txt`,
        config,
      );

      expect(workflow.exitCode).toBe(0);
      expect(workflow.output).toContain("Sandbox User <sandbox@example.com>: changed");
      expect(workflow.output).toContain("changed\n");
      expect(readFileSync(join(workspace, "clone", "tracked.txt"), "utf8")).toBe("changed\n");

      const update = await execute("git config --global user.name Changed", config);

      expect(update.exitCode).not.toBe(0);
      expect(readFileSync(path, "utf8")).toBe(contents);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  }, 20000);

  it.each([false, true])(
    "reads standard Git files without exposing sibling files, custom XDG=%s",
    async (customXdg) => {
      const home = join(directory, customXdg ? "git-custom-home" : "git-default-home");
      const xdg = customXdg ? join(directory, "git-custom-xdg") : join(home, ".config");
      const gitDirectory = join(xdg, "git");
      const configPath = join(gitDirectory, "config");
      const originalHome = process.env.HOME;
      const originalXdg = process.env.XDG_CONFIG_HOME;

      mkdirSync(gitDirectory, { recursive: true });
      mkdirSync(home, { recursive: true });
      writeFileSync(configPath, "[user]\n\tname = XDG User\n\temail = xdg@example.com\n");
      writeFileSync(join(gitDirectory, "ignore"), "global-ignore.tmp\n");
      writeFileSync(join(gitDirectory, "attributes"), "*.txt test-attribute=global\n");
      writeFileSync(join(gitDirectory, "credentials"), "sibling-secret");
      process.env.HOME = home;

      if (customXdg) process.env.XDG_CONFIG_HOME = xdg;
      else delete process.env.XDG_CONFIG_HOME;

      try {
        const config = defaultConfig();

        config.environment.GIT_CONFIG_NOSYSTEM = "1";

        const result = await execute(
          `set -eu
        git init --initial-branch=main ${customXdg ? "git-custom" : "git-default"}
        cd ${customXdg ? "git-custom" : "git-default"}
        git config --global user.name
        printf ignored > global-ignore.tmp
        printf tracked > tracked.txt
        git check-ignore global-ignore.tmp
        git check-attr test-attribute -- tracked.txt`,
          config,
        );

        expect(result.exitCode).toBe(0);
        expect(result.output).toContain("XDG User\n");
        expect(result.output).toContain("global-ignore.tmp\n");
        expect(result.output).toContain("tracked.txt: test-attribute: global\n");
        const sibling = await execute(`cat '${join(gitDirectory, "credentials")}'`, config);

        expect(sibling.exitCode).not.toBe(0);
        expect(sibling.output).not.toContain("sibling-secret");
        expect((await execute("git config --global user.name Changed", config)).exitCode).not.toBe(
          0,
        );
        expect(readFileSync(configPath, "utf8")).toContain("name = XDG User");
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;

        if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = originalXdg;
      }
    },
  );

  it("provides writable temporary storage without exposing other host temporary files", async () => {
    const secret = join(directory, "temporary-secret.txt");

    writeFileSync(secret, "host-temporary-secret");

    const result = await execute(
      `set -eu; file=$(mktemp); printf 'scratch-data' > "$file"; cat "$file"; printf '\\n%s\\n' "$TMPDIR"; cat '${secret}'`,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("scratch-data");
    expect(result.output).not.toContain("host-temporary-secret");
    const temporaryDirectory = result.output.split("\n")[1];

    expect(temporaryDirectory).toContain("pi-mxc-");
    expect(existsSync(temporaryDirectory ?? "")).toBe(false);
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
