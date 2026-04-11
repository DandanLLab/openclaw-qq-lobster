import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

let _cached: string | null = null;

export function getPackageVersion(metaUrl?: string): string {
  if (_cached !== null) return _cached;

  const startFile = metaUrl ? fileURLToPath(metaUrl) : fileURLToPath(import.meta.url);
  let dir = path.dirname(startFile);
  const root = path.parse(dir).root;

  while (dir !== root) {
    const candidate = path.join(dir, "package.json");
    try {
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
        if (pkg.name === "@openclaw/qq" && pkg.version) {
          _cached = pkg.version as string;
          return _cached;
        }
      }
    } catch {
    }
    dir = path.dirname(dir);
  }

  try {
    const require = createRequire(metaUrl ?? import.meta.url);
    for (const rel of ["../../package.json", "../package.json", "./package.json"]) {
      try {
        const pkg = require(rel);
        if (pkg?.version) {
          _cached = pkg.version as string;
          return _cached;
        }
      } catch { }
    }
  } catch { }

  _cached = "unknown";
  return _cached;
}
