import { constants } from "node:fs";
import { accessSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export function findOnPath(name) {
  const extensions = process.platform === "win32"
    ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((value) => value.toLowerCase())]
    : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        return realpathSync(candidate);
      } catch {
        // Try the next extension or PATH entry.
      }
    }
  }
  throw new Error(`${name} was not found on PATH`);
}

function firstPackageRoot(candidates, name) {
  for (const candidate of candidates) {
    try {
      readFileSync(join(candidate, "package.json"));
      return candidate;
    } catch {
      // Try the next layout supported by npm's global installer.
    }
  }
  throw new Error(`Cannot resolve Pi's bundled ${name}; reinstall the active pi executable or update the tooling`);
}

export function locatePiPackages() {
  const piCli = findOnPath("pi");
  const shimDirectory = dirname(piCli);
  const codingAgent = firstPackageRoot(
    [
      // pi.dev's Windows installer keeps its shims beside node_modules.
      join(shimDirectory, "node_modules", "@earendil-works", "pi-coding-agent"),
      // A normal npm global bin symlink resolves to <package>/dist/cli.js.
      dirname(dirname(piCli)),
    ],
    "pi-coding-agent",
  );
  const nestedModules = join(codingAgent, "node_modules");
  const globalModules = dirname(dirname(codingAgent));
  return {
    codingAgent,
    piAi: firstPackageRoot(
      [join(nestedModules, "@earendil-works", "pi-ai"), join(dirname(codingAgent), "pi-ai")],
      "pi-ai",
    ),
    typebox: firstPackageRoot([join(nestedModules, "typebox"), join(globalModules, "typebox")], "typebox"),
  };
}

export function piCliEntry(codingAgent = locatePiPackages().codingAgent) {
  const manifest = JSON.parse(readFileSync(join(codingAgent, "package.json"), "utf8"));
  const entry = manifest.bin?.pi;
  if (typeof entry !== "string") throw new Error(`Cannot resolve Pi's CLI entry at ${codingAgent}`);
  return join(codingAgent, entry);
}

export function packageEntry(packageRoot, condition) {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const entry = manifest.exports?.["."]?.[condition] ?? (condition === "import" ? manifest.module : manifest.types);
  if (typeof entry !== "string") {
    throw new Error(`Cannot resolve the ${condition} entry for ${manifest.name} at ${packageRoot}`);
  }
  return join(packageRoot, entry);
}
