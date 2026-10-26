import {
  expandPath,
  getConfigPath,
  parseConfig,
  readConfig,
  serializeConfig,
  writeConfig,
  type SandboxConfig,
} from "./config.js";

export type PolicyScope = "session" | "persist";

type ConfigMutation = (config: SandboxConfig) => void;

type Settings = Omit<SandboxConfig, "filesystem" | "network">;

interface PolicyUpdate {
  scope: PolicyScope;
  cwd: string;
  mutate: ConfigMutation;
}

export class SandboxPolicy {
  private overrides: ConfigMutation[] = [];

  constructor(private readonly path = getConfigPath()) {}

  get hasOverrides(): boolean {
    return this.overrides.length > 0;
  }

  reset(): void {
    this.overrides = [];
  }

  read(): SandboxConfig {
    const config = readConfig(this.path);

    for (const override of this.overrides) override(config);

    return parseConfig(serializeConfig(config));
  }

  update({ scope, cwd, mutate }: PolicyUpdate): void {
    const before = scope === "persist" ? readConfig(this.path) : this.read();
    const after = structuredClone(before);

    mutate(after);
    parseConfig(serializeConfig(after));

    if (scope === "persist") {
      writeConfig(after, this.path);

      return;
    }

    for (const key of [
      "enabled",
      "backend",
      "shellPath",
      "timeoutMs",
      "inheritHostPath",
      "environment",
    ] satisfies (keyof Settings)[]) {
      this.recordSetting(key, before, after);
    }

    for (const key of [
      "egress",
      "ingress",
      "hostLoopback",
    ] satisfies (keyof SandboxConfig["network"])[]) {
      if (before.network[key] === after.network[key]) continue;

      const value = after.network[key];

      this.overrides.push((config) => {
        config.network[key] = value;
      });
    }

    for (const key of [
      "readonlyPaths",
      "readwritePaths",
      "deniedPaths",
    ] satisfies (keyof SandboxConfig["filesystem"])[]) {
      const removed = before.filesystem[key].filter(
        (path) => !after.filesystem[key].includes(path),
      );

      const added = after.filesystem[key].flatMap((path) =>
        before.filesystem[key].includes(path) ? [] : [expandPath(path, cwd)],
      );

      if (removed.length === 0 && added.length === 0) continue;

      this.overrides.push((config) => {
        config.filesystem[key] = [
          ...new Set([
            ...config.filesystem[key].filter((path) => !removed.includes(path)),
            ...added,
          ]),
        ];
      });
    }
  }

  private recordSetting<Key extends keyof Settings>(
    key: Key,
    before: SandboxConfig,
    after: SandboxConfig,
  ): void {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) return;

    const value = structuredClone(after[key]);

    this.overrides.push((config) => {
      config[key] = structuredClone(value);
    });
  }
}
