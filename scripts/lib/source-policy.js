import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "../../tooling/node_modules/typescript/lib/typescript.js";

export function repositoryFiles(root, paths) {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...paths], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) return paths.flatMap((path) => filesystemFiles(join(root, path)));
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((path) => join(root, path))
    .filter(existsSync);
}

function filesystemFiles(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && [".git", "node_modules", "coverage", "dist", ".pi", ".pi-subagents", ".ralph"].includes(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...filesystemFiles(child));
    else if (!entry.name.endsWith(".log") && !entry.name.endsWith(".tgz") && entry.name !== ".DS_Store") files.push(child);
  }
  return files;
}

/** Use the pinned parser rather than maintaining a partial JavaScript tokenizer. */
export function importedSpecifiers(source) {
  const file = ts.createSourceFile("policy-source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers = [];
  const add = (literal) => {
    if (!literal || !ts.isStringLiteralLike(literal)) return;
    const text = literal.getText(file);
    if (text.length < 2 || text.at(0) !== text.at(-1)) return;
    if (!specifiers.includes(literal.text)) specifiers.push(literal.text);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return specifiers;
}
