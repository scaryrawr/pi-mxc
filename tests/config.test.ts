import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultConfig, parseConfig, readConfig, writeConfig } from "../extensions/config.js";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-mxc-config-"));
  vi.stubEnv("XDG_CONFIG_HOME", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("sandbox configuration", () => {
  it("sandboxes bash with outbound traffic denied when the file is missing", () => {
    const config = readConfig(join(directory, "missing.json"));

    expect(config.enabled).toBe(true);
    expect(config.network).toEqual({ egress: "deny", ingress: "deny", hostLoopback: "deny" });
    expect(config.filesystem.readonlyPaths).toEqual([
      "~/.gitconfig",
      join("~", ".config", "git", "config"),
      join("~", ".config", "git", "ignore"),
      join("~", ".config", "git", "attributes"),
    ]);
    expect(config.filesystem.readwritePaths).toEqual(["."]);
  });

  it("uses an absolute XDG config location for Git without granting the entire directory", () => {
    const xdg = join(directory, "xdg-config");

    vi.stubEnv("XDG_CONFIG_HOME", xdg);
    const config = defaultConfig();

    expect(config.filesystem.readonlyPaths).toEqual([
      "~/.gitconfig",
      join(xdg, "git", "config"),
      join(xdg, "git", "ignore"),
      join(xdg, "git", "attributes"),
    ]);
    expect(config.environment.XDG_CONFIG_HOME).toBe(xdg);
    expect(config.filesystem.readonlyPaths).not.toContain(xdg);
    expect(config.filesystem.readonlyPaths).not.toContain(join(xdg, "git"));
  });

  it.each(["", "relative/config", "/config/../secrets"])(
    "ignores invalid XDG_CONFIG_HOME %j",
    (xdg) => {
      vi.stubEnv("XDG_CONFIG_HOME", xdg);
      const config = defaultConfig();

      expect(config.filesystem.readonlyPaths).toContain(join("~", ".config", "git", "config"));
      expect(config.environment).not.toHaveProperty("XDG_CONFIG_HOME");
    },
  );

  it("keeps existing saved policies unchanged instead of adding new default grants", () => {
    const path = join(directory, "existing.json");
    const config = defaultConfig();

    config.filesystem.readonlyPaths = ["~/.gitconfig"];
    writeConfig(config, path);
    const original = readFileSync(path, "utf8");

    vi.stubEnv("XDG_CONFIG_HOME", join(directory, "different-xdg"));
    const saved = readConfig(path);

    expect(saved.filesystem.readonlyPaths).toEqual(["~/.gitconfig"]);
    expect(saved.environment).toEqual({});
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("persists a complete config in a new agent directory without leaving temporary files", () => {
    const path = join(directory, "agent", "pi-mxc.json");
    const config = defaultConfig();

    config.enabled = false;
    config.filesystem.readonlyPaths.push("/opt/tools");
    writeConfig(config, path);

    expect(readConfig(path).enabled).toBe(false);
    expect(readConfig(path).filesystem.readonlyPaths).toEqual([
      "~/.gitconfig",
      join("~", ".config", "git", "config"),
      join("~", ".config", "git", "ignore"),
      join("~", ".config", "git", "attributes"),
      "/opt/tools",
    ]);
    expect(readFileSync(path, "utf8")).toContain('"enabled": false');

    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("blocks malformed JSON rather than disabling sandboxing", () => {
    const path = join(directory, "pi-mxc.json");

    writeFileSync(path, "{");
    expect(() => readConfig(path)).toThrow("Bash is blocked");
    expect(readFileSync(path, "utf8")).toBe("{");
  });

  it("rejects misspelled policy fields, missing fields, and non-sandbox backends", () => {
    expect(() => parseConfig(JSON.stringify({ ...defaultConfig(), enable: false }))).toThrow(
      "Invalid sandbox config",
    );
    expect(() => parseConfig('{"enabled":false}')).toThrow("Invalid sandbox config");
    expect(() => parseConfig(JSON.stringify({ ...defaultConfig(), backend: "process" }))).toThrow(
      "Invalid sandbox config",
    );
  });

  it("accepts existing configs without inheritHostPath and rejects non-boolean values", () => {
    const config = defaultConfig();

    delete config.inheritHostPath;
    expect(parseConfig(JSON.stringify(config)).inheritHostPath).toBeUndefined();
    expect(() => parseConfig(JSON.stringify({ ...config, inheritHostPath: "false" }))).toThrow(
      "Invalid sandbox config",
    );
  });

  it("refuses an invalid edit without replacing the persisted config", () => {
    const path = join(directory, "pi-mxc.json");

    writeConfig(defaultConfig(), path);
    const original = readFileSync(path, "utf8");

    expect(() => writeConfig({ ...defaultConfig(), timeoutMs: 0 }, path)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("rejects parent segments instead of resolving a symlink-sensitive denied path lexically", () => {
    const config = defaultConfig();

    config.filesystem.deniedPaths.push("/tmp/../secret");
    expect(() => parseConfig(JSON.stringify(config))).toThrow("cannot contain '..'");
  });

  it("rejects a loopback grant that Seatbelt cannot enforce", () => {
    const config = defaultConfig();

    config.network.hostLoopback = "allow";
    expect(() => parseConfig(JSON.stringify(config))).toThrow("requires ingress=allow");
  });
});
