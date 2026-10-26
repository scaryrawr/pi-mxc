import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultConfig } from "../extensions/config.js";
import { getToolPolicy } from "../extensions/tools.js";

let directory: string;

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "pi-mxc-tools-")));
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

function makeDirectory(...parts: string[]): string {
  const path = join(directory, ...parts);

  mkdirSync(path, { recursive: true });

  return path;
}

describe("host tool discovery", () => {
  it("follows a version-manager directory link and grants its npm runtime, not the whole manager", () => {
    const installation = makeDirectory("versions", "node-v24", "installation");
    const bin = makeDirectory("versions", "node-v24", "installation", "bin");
    const lib = makeDirectory("versions", "node-v24", "installation", "lib");
    const alias = join(directory, "current");

    symlinkSync(installation, alias, "dir");
    const config = defaultConfig();

    config.environment.PATH = join(alias, "bin");
    const policy = getToolPolicy(config);

    expect(policy.environment.PATH).toBe(join(alias, "bin"));
    expect(policy.readonlyPaths).toEqual(expect.arrayContaining([join(alias, "bin"), bin, lib]));
    expect(policy.readonlyPaths).not.toContain(directory);
    expect(policy.readonlyPaths).not.toContain(join(directory, "versions"));

    const nextInstallation = makeDirectory("versions", "node-v25", "installation");
    const nextBin = makeDirectory("versions", "node-v25", "installation", "bin");

    rmSync(alias);
    symlinkSync(nextInstallation, alias, "dir");
    const updated = getToolPolicy(config);

    expect(updated.readonlyPaths).toContain(nextBin);
    expect(updated.readonlyPaths).not.toContain(bin);
  });

  it("follows executable links into packages outside PATH", () => {
    const bin = makeDirectory("local", "bin");
    const packageDirectory = makeDirectory("packages", "cli");
    const cli = join(packageDirectory, "cli.js");

    writeFileSync(cli, "#!/usr/bin/env node\n");
    symlinkSync(cli, join(bin, "cli"));
    symlinkSync(join(directory, "missing"), join(bin, "stale"));
    const config = defaultConfig();

    config.environment.PATH = bin;
    const policy = getToolPolicy(config);

    expect(policy.readonlyPaths).toContain(packageDirectory);
    expect(policy.readonlyPaths).not.toContain(join(directory, "packages"));
  });

  it.each(["Library/Homebrew", "Homebrew/Library/Homebrew"])(
    "discovers a Homebrew prefix with %s without assuming its host location",
    (repository) => {
      const bin = makeDirectory("brew", "bin");
      const prefix = join(directory, "brew");

      makeDirectory("brew", "Cellar");
      makeDirectory("brew", repository);
      const config = defaultConfig();

      config.environment.PATH = bin;
      expect(getToolPolicy(config).readonlyPaths).toEqual([prefix]);
    },
  );

  it("uses only an explicit PATH, skips missing and relative entries, and deduplicates grants", () => {
    const bin = makeDirectory("custom", "bin");
    const config = defaultConfig();

    config.environment.PATH = ["", ".", "relative/bin", join(directory, "missing"), bin, bin].join(
      delimiter,
    );
    config.environment.API_TOKEN = "explicit-secret";
    const policy = getToolPolicy(config);

    expect(policy.environment).toEqual({ PATH: config.environment.PATH });
    expect(policy.readonlyPaths).toEqual([bin]);
  });

  it("can disable all automatic PATH forwarding and filesystem grants", () => {
    const config = defaultConfig();

    config.inheritHostPath = false;
    config.environment.PATH = makeDirectory("custom", "bin");
    expect(getToolPolicy(config)).toEqual({ environment: {}, readonlyPaths: [] });
  });
});
