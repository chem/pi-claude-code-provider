import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const expected = {
  name: "pi-claude-code-provider",
  author: "chem <sineverbisnon@gmail.com>",
  repository: "git+https://github.com/chem/pi-claude-code-provider.git",
};

if (manifest.name !== expected.name) throw new Error(`Unexpected npm name: ${manifest.name}`);
if (manifest.private === true) throw new Error("package.json is still private");
if (manifest.author !== expected.author) throw new Error("Unexpected npm author/contact");
if (manifest.repository?.url !== expected.repository) throw new Error("Unexpected repository URL");
if (manifest.publishConfig?.access !== "public") throw new Error("npm access must be explicitly public");
if (manifest.pi?.extensions?.length !== 1) throw new Error("Exactly one Pi extension entry is required");
if (manifest.os !== undefined) throw new Error("The package must not exclude a supported operating system");

const repository = run("git", ["ls-files", "--cached", "--others", "--exclude-standard"])
  .trim().split("\n").filter((path) => path && existsSync(join(root, path)));
const suspiciousNames = /(^|\/)(?:\.env(?:\..*)?|\.npmrc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx|tgz|log))$/i;
const forbiddenContent = [
  { label: "absolute home path", pattern: /\/(?:home|Users)\/[A-Za-z0-9._-]+\// },
  { label: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "GitHub token", pattern: /\b(?:github_pat_|gh[opusr]_)[A-Za-z0-9_]{20,}\b/ },
  { label: "Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
];
for (const path of repository) {
  if (suspiciousNames.test(path)) throw new Error(`Suspicious release file: ${path}`);
  const contents = readFileSync(join(root, path), "utf8");
  for (const check of forbiddenContent) {
    if (check.pattern.test(contents)) throw new Error(`${check.label} found in ${path}`);
  }
}

const packResult = JSON.parse(runNpm(["pack", "--dry-run", "--json", "--ignore-scripts"]));
const packed = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
if (!packed || !Array.isArray(packed.files)) throw new Error("npm pack returned an unexpected result");
const inventory = packed.files.map((file) => file.path).sort();
const required = [
  "LICENSE",
  "README.md",
  "bridge/mcp-proposal-server.js",
  "extensions/pi-claude-code-provider.ts",
  "package.json",
];
for (const path of required) {
  if (!inventory.includes(path)) throw new Error(`npm package is missing ${path}`);
}
const forbiddenPackageRoots = [".github/", "scripts/", "test/", "tooling/"];
for (const path of inventory) {
  if (forbiddenPackageRoots.some((prefix) => path.startsWith(prefix))) {
    throw new Error(`Development-only path would be published: ${path}`);
  }
  if (path === "tsconfig.json") {
    throw new Error(`Development-only file would be published: ${path}`);
  }
}
if (packed.unpackedSize > 1024 * 1024) {
  throw new Error(`Unpacked npm package exceeds 1 MiB: ${packed.unpackedSize} bytes`);
}

console.log(`Release check passed: ${inventory.length} npm files, ${packed.size} packed bytes, ${packed.unpackedSize} unpacked bytes.`);

function runNpm(args) {
  const bundledCli = join(process.execPath, "..", "node_modules", "npm", "bin", "npm-cli.js");
  const npmCli = process.env.npm_execpath || (existsSync(bundledCli) ? bundledCli : undefined);
  return npmCli ? run(process.execPath, [npmCli, ...args]) : run("npm", args);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout;
}
