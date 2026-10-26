import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultConfig, readConfig, writeConfig } from "../extensions/config.js";
import { SandboxPolicy } from "../extensions/policy.js";

let directory: string;

let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-mxc-policy-"));
  path = join(directory, "pi-mxc.json");
  writeConfig(defaultConfig(), path);
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("session sandbox policy", () => {
  it("applies a session grant without changing the saved policy or a different session", () => {
    const original = readFileSync(path, "utf8");
    const policy = new SandboxPolicy(path);

    policy.update({
      scope: "session",
      cwd: directory,
      mutate: (config) => config.filesystem.readwritePaths.push("/extra-access"),
    });

    expect(policy.read().filesystem.readwritePaths).toContain("/extra-access");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(new SandboxPolicy(path).read().filesystem.readwritePaths).not.toContain("/extra-access");
  });

  it("never creates a config file for session changes", () => {
    rmSync(path);
    const policy = new SandboxPolicy(path);

    policy.update({
      scope: "session",
      cwd: directory,
      mutate: (config) => {
        config.enabled = false;
      },
    });
    expect(policy.read().enabled).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it("anchors new relative grants to the granting directory and resets all overrides", () => {
    const policy = new SandboxPolicy(path);

    policy.update({
      scope: "session",
      cwd: directory,
      mutate(config) {
        config.filesystem.readonlyPaths.push("tools");
        config.enabled = false;
        config.network.egress = "allow";
        config.environment.CI = "1";
      },
    });
    const snapshot = policy.read();

    expect(snapshot.filesystem.readonlyPaths).toContain(join(directory, "tools"));
    expect(snapshot.filesystem.readonlyPaths).not.toContain("tools");
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.network.egress).toBe("allow");
    expect(snapshot.environment.CI).toBe("1");
    expect(policy.hasOverrides).toBe(true);
    policy.reset();
    expect(policy.hasOverrides).toBe(false);
    expect(policy.read()).toEqual(defaultConfig());
    expect(snapshot.enabled).toBe(false);
  });

  it("persists only the requested change, never unrelated session grants", () => {
    const policy = new SandboxPolicy(path);

    policy.update({
      scope: "session",
      cwd: directory,
      mutate: (config) => config.filesystem.readwritePaths.push("/temporary-access"),
    });
    policy.update({
      scope: "persist",
      cwd: directory,
      mutate: (config) => config.filesystem.readonlyPaths.push("/saved-access"),
    });

    expect(policy.read().filesystem.readwritePaths).toContain("/temporary-access");
    expect(policy.read().filesystem.readonlyPaths).toContain("/saved-access");
    const saved = new SandboxPolicy(path).read();

    expect(saved.filesystem.readwritePaths).not.toContain("/temporary-access");
    expect(saved.filesystem.readonlyPaths).toContain("/saved-access");
  });

  it("keeps later saved restrictions visible beneath session edits", () => {
    const policy = new SandboxPolicy(path);

    policy.update({
      scope: "session",
      cwd: directory,
      mutate: (config) => {
        config.filesystem.readonlyPaths = ["/session-tool"];
      },
    });
    const saved = readConfig(path);

    saved.filesystem.deniedPaths.push("/new-secret");
    saved.filesystem.readonlyPaths.push("/new-saved-tool");
    saved.timeoutMs = 500;
    writeConfig(saved, path);
    const effective = policy.read();

    expect(effective.filesystem.deniedPaths).toContain("/new-secret");
    expect(effective.filesystem.readonlyPaths).toContain("/new-saved-tool");
    expect(effective.filesystem.readonlyPaths).toContain("/session-tool");
    expect(effective.filesystem.readonlyPaths).not.toContain("~/.gitconfig");
    expect(effective.timeoutMs).toBe(500);
    policy.reset();
    expect(policy.read().filesystem.readonlyPaths).toContain("~/.gitconfig");
  });

  it("blocks malformed saved policy even when the session disabled sandboxing", () => {
    const policy = new SandboxPolicy(path);

    policy.update({
      scope: "session",
      cwd: directory,
      mutate: (config) => {
        config.enabled = false;
      },
    });
    writeFileSync(path, "{");
    expect(() => policy.read()).toThrow("Bash is blocked");
  });

  it("rejects invalid changes without mutating session state or saved defaults", () => {
    const original = readFileSync(path, "utf8");
    const policy = new SandboxPolicy(path);

    expect(() =>
      policy.update({
        scope: "session",
        cwd: directory,
        mutate: (config) => {
          config.filesystem.readonlyPaths.push("../outside");
        },
      }),
    ).toThrow("cannot contain '..'");
    expect(policy.hasOverrides).toBe(false);
    expect(policy.read()).toEqual(defaultConfig());
    expect(readFileSync(path, "utf8")).toBe(original);
  });
});
