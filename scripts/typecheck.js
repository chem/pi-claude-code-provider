import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { locatePiPackages, packageEntry } from "./lib/pi-installation.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const compiler = join(root, "tooling", "node_modules", "typescript", "bin", "tsc");
if (!existsSync(compiler)) {
  throw new Error("TypeScript tooling is not installed; run: npm run setup:dev");
}

const packages = locatePiPackages();
const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-typecheck-"));
try {
  const config = join(directory, "tsconfig.json");
  await writeFile(
    config,
    JSON.stringify(
      {
        extends: join(root, "tsconfig.json"),
        compilerOptions: {
          baseUrl: root,
          paths: {
            "@earendil-works/pi-ai": [packageEntry(packages.piAi, "types")],
            "@earendil-works/pi-coding-agent": [packageEntry(packages.codingAgent, "types")],
            typebox: [packageEntry(packages.typebox, "types")],
          },
          typeRoots: [join(root, "tooling", "node_modules", "@types")],
        },
      },
      null,
      2,
    ),
  );
  const result = spawnSync(process.execPath, [compiler, "--project", config], {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
