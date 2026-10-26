import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  sep,
} from "node:path";

import type { SandboxConfig } from "./config.js";

export function getToolPolicy(config: SandboxConfig) {
  const environment: Record<string, string> = {};
  const readonlyPaths = new Set<string>();

  if (config.inheritHostPath === false) return { environment, readonlyPaths: [] };

  const hostPath = process.env.PATH ?? process.env.Path;
  const path = config.environment.PATH ?? hostPath;

  if (path === undefined) return { environment, readonlyPaths: [] };

  environment.PATH = path;

  function addDirectory(directory: string): void {
    if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return;

    readonlyPaths.add(directory);
    readonlyPaths.add(realpathSync(directory));
  }

  function addRuntimeDirectories(directory: string): void {
    addDirectory(directory);

    if (!["bin", "sbin"].includes(basename(directory))) return;

    const prefix = dirname(directory);

    for (const sibling of ["lib", "lib64", "libexec", "share"]) {
      addDirectory(join(prefix, sibling));
    }

    // Homebrew executables also load dependencies and metadata across the prefix.
    const hasHomebrew =
      existsSync(join(prefix, "Library", "Homebrew")) ||
      existsSync(join(prefix, "Homebrew", "Library", "Homebrew"));

    if (existsSync(join(prefix, "Cellar")) && hasHomebrew) {
      addDirectory(prefix);
    }
  }

  for (const entry of path.split(delimiter)) {
    // Relative PATH entries must not grant access outside the command's workspace.
    if (!isAbsolute(entry)) continue;

    const directory = normalize(entry);

    try {
      if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) continue;

      readonlyPaths.add(directory);
      addRuntimeDirectories(realpathSync(directory));

      for (const executable of readdirSync(directory, { withFileTypes: true })) {
        if (!executable.isSymbolicLink()) continue;

        try {
          const target = realpathSync(join(directory, executable.name));

          if (statSync(target).isFile()) addRuntimeDirectories(dirname(target));
        } catch {
          // Broken or inaccessible executable links are not usable tools.
        }
      }
    } catch {
      // Stale or inaccessible PATH directories are common after tool upgrades.
    }
  }

  const paths = [...readonlyPaths];

  return {
    environment,
    readonlyPaths: paths.filter(
      (directory, index) =>
        !paths.some((parent, parentIndex) => {
          if (parent === directory) return false;

          const child = relative(parent, directory);

          if (child === "") return parentIndex < index;

          return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
        }),
    ),
  };
}
