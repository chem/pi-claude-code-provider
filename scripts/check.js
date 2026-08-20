import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { VERIFIED_VERSIONS, versionStatus } from "../src/compatibility.ts";
import { PI_PEERS, dependencyPolicyErrors } from "./lib/dependency-policy.js";
import { piLaunch } from "./lib/pi-installation.js";
import { documentationPolicyErrors } from "./lib/documentation-policy.js";
import { importedSpecifiers, repositoryFiles } from "./lib/source-policy.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceRoots = ["extensions", "src", "test", "scripts"];
const allowedPeers = new Set(PI_PEERS);

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const dependencyErrors = dependencyPolicyErrors(manifest);
if (dependencyErrors.length)
  throw new Error(dependencyErrors.join("\n"));
if (existsSync(join(root, "node_modules")))
  throw new Error("Project-local node_modules is forbidden; development must use Pi's bundled modules");
if (existsSync(join(root, "package-lock.json")))
  throw new Error("package-lock.json is unnecessary in this zero-install project");
if (!existsSync(join(root, manifest.pi.extensions[0])))
  throw new Error(`Missing Pi extension entry: ${manifest.pi.extensions[0]}`);

const toolingManifest = JSON.parse(readFileSync(join(root, "tooling", "package.json"), "utf8"));
const approvedTooling = { "@types/node": "22.20.1", typescript: "5.9.3" };
if (JSON.stringify(toolingManifest.devDependencies) !== JSON.stringify(approvedTooling))
  throw new Error("tooling/package.json may contain only the pinned TypeScript and @types/node dependencies");
const toolingLock = JSON.parse(readFileSync(join(root, "tooling", "package-lock.json"), "utf8"));
const approvedLockEntries = ["", "node_modules/@types/node", "node_modules/typescript", "node_modules/undici-types"];
if (JSON.stringify(Object.keys(toolingLock.packages).sort()) !== JSON.stringify(approvedLockEntries.sort()))
  throw new Error("tooling/package-lock.json contains an unexpected package");

const files = repositoryFiles(root, sourceRoots);
const documentationErrors = documentationPolicyErrors(
  root,
  repositoryFiles(root, ["."]).filter((path) => path.endsWith(".md")),
  VERIFIED_VERSIONS,
);
if (documentationErrors.length) throw new Error(documentationErrors.join("\n"));
// Deterministic CI must resolve Pi types from the verified baseline; a stale pin
// silently validates the package against a contract it no longer targets.
const workflow = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
const pinnedPi = `@earendil-works/pi-coding-agent@${VERIFIED_VERSIONS.pi}`;
if (!workflow.includes(pinnedPi))
  throw new Error(`.github/workflows/ci.yml must install ${pinnedPi}`);
const runtimeJavaScript = files.filter(
  (path) => (path.startsWith(join(root, "extensions")) || path.startsWith(join(root, "src"))) && path.endsWith(".js"),
);
if (runtimeJavaScript.length)
  throw new Error(`Runtime JavaScript remains: ${runtimeJavaScript.map((path) => relative(root, path)).join(", ")}`);
const developmentTypescript = files.filter(
  (path) => (path.startsWith(join(root, "test")) || path.startsWith(join(root, "scripts"))) && path.endsWith(".ts"),
);
if (developmentTypescript.length)
  throw new Error(`Development TypeScript is outside the runtime boundary: ${developmentTypescript.map((path) => relative(root, path)).join(", ")}`);

for (const path of files.filter((candidate) => candidate.endsWith(".js"))) {
  const syntax = run(process.execPath, ["--check", path]);
  if (syntax.status !== 0)
    throw new Error(`Syntax check failed for ${relative(root, path)}:\n${syntax.stderr}`);
}
for (const path of files.filter((candidate) => candidate.endsWith(".js") || candidate.endsWith(".ts"))) {
  const source = readFileSync(path, "utf8");
  for (const specifier of importedSpecifiers(source)) {
    if (specifier.startsWith(".") || specifier.startsWith("node:") || allowedPeers.has(specifier))
      continue;
    throw new Error(`Undeclared external import ${specifier} in ${relative(root, path)}`);
  }
}

function commandVersion(command, args, pattern, required) {
  const result = run(command, args);
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim();
    if (required)
      throw new Error(`${command} is required for development: ${detail}`);
    console.warn(`warning: ${command} is unavailable; live compatibility was not checked (${detail})`);
    return undefined;
  }
  const version = `${result.stdout}${result.stderr}`.match(pattern)?.[0];
  if (!version && required)
    throw new Error(`Could not parse ${command} version`);
  return version;
}

// Invoke the resolved entry directly: Node cannot execute npm's .cmd shim
// without a shell on Windows, and shell interpolation is unnecessary here.
const piVersionLaunch = piLaunch(["--version"]);
const piVersion = commandVersion(piVersionLaunch.command, piVersionLaunch.args, /\d+\.\d+\.\d+/, true);
const claudeVersion = commandVersion("claude", ["--version"], /\d+\.\d+\.\d+/, false);
for (const status of [
  versionStatus("Pi", piVersion, VERIFIED_VERSIONS.pi),
  ...(claudeVersion ? [versionStatus("Claude Code", claudeVersion, VERIFIED_VERSIONS.claudeCode)] : []),
]) {
  if (status.isVerified)
    console.log(`${status.component} ${status.current}: verified`);
  else
    console.log(`${status.component} ${status.current}: unverified; tested ${status.verified}`);
}

console.log(
  `Checked ${files.filter((path) => path.endsWith(".ts")).length} runtime TypeScript and ${files.filter((path) => path.endsWith(".js")).length} development JavaScript files; zero root packages.`,
);
