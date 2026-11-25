// Removes generated folders: build, dist and node_modules.

import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve against the project root, so the result doesn't depend on the cwd.
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = ["build", "dist", "node_modules"];

for (const target of targets) {
  await rm(resolve(rootDir, target), { recursive: true, force: true, maxRetries: 3 });
  console.log(`removed ${target}/`);
}
