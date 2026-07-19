import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function repositoryFiles(root, paths) {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...paths], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return paths.flatMap((path) => filesystemFiles(join(root, path)));
  }
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
    if (entry.isDirectory() && [".git", "node_modules", "coverage", "dist", ".pi", ".pi-subagents", ".ralph"].includes(entry.name)) {
      continue;
    }
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...filesystemFiles(child));
    else if (!entry.name.endsWith(".log") && !entry.name.endsWith(".tgz") && entry.name !== ".DS_Store") files.push(child);
  }
  return files;
}

export function importedSpecifiers(source) {
  const tokens = tokenize(source);
  const specifiers = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === "import" && tokens[index - 1]?.value !== ".") {
      if (tokens[index + 1]?.type === "string") specifiers.push(tokens[index + 1].value);
      else if (tokens[index + 1]?.value === "(" && tokens[index + 2]?.type === "string") {
        specifiers.push(tokens[index + 2].value);
      } else {
        const from = findBeforeStatementEnd(tokens, index + 1, "from");
        if (from !== -1 && tokens[from + 1]?.type === "string") specifiers.push(tokens[from + 1].value);
      }
    } else if (token.value === "export") {
      const from = findBeforeStatementEnd(tokens, index + 1, "from");
      if (from !== -1 && tokens[from + 1]?.type === "string") specifiers.push(tokens[from + 1].value);
    }
  }
  return [...new Set(specifiers)];
}

function findBeforeStatementEnd(tokens, start, value) {
  for (let index = start; index < tokens.length && tokens[index].value !== ";"; index += 1) {
    if (tokens[index].value === value) return index;
  }
  return -1;
}

function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
    } else if (character === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2);
      if (index === -1) break;
    } else if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else if (character === "/" && startsRegex(tokens)) {
      index += 1;
      let inCharacterClass = false;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index] === "[") {
          inCharacterClass = true;
          index += 1;
        } else if (source[index] === "]") {
          inCharacterClass = false;
          index += 1;
        } else if (source[index] === "/" && !inCharacterClass) {
          index += 1;
          while (index < source.length && /[A-Za-z]/.test(source[index])) index += 1;
          break;
        } else index += 1;
      }
    } else if (character === '"' || character === "'") {
      const quote = character;
      let value = "";
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\" && index + 1 < source.length) {
          value += source[index + 1];
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push({ type: "string", value });
    } else if (character === "`") {
      const template = templateExpressionTokens(source, index);
      tokens.push(...template.tokens);
      index = template.end;
    } else if (/[A-Za-z_$]/.test(character)) {
      const start = index++;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
      tokens.push({ type: "identifier", value: source.slice(start, index) });
    } else {
      tokens.push({ type: "punctuation", value: character });
      index += 1;
    }
  }
  return tokens;
}

function templateExpressionTokens(source, start) {
  const tokens = [];
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
    } else if (source[index] === "`") {
      return { tokens, end: index + 1 };
    } else if (source[index] === "$" && source[index + 1] === "{") {
      const end = expressionEnd(source, index + 2);
      tokens.push(...tokenize(source.slice(index + 2, end)));
      index = end + 1;
    } else index += 1;
  }
  return { tokens, end: source.length };
}

function expressionEnd(source, start) {
  let depth = 1;
  let index = start;
  while (index < source.length) {
    if (source[index] === '"' || source[index] === "'") index = quotedEnd(source, index);
    else if (source[index] === "`") index = templateLiteralEnd(source, index);
    else if (source[index] === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index + 2);
      index = newline === -1 ? source.length : newline;
    } else if (source[index] === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else if (source[index] === "{") {
      depth += 1;
      index += 1;
    } else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
      index += 1;
    } else index += 1;
  }
  return source.length;
}

function quotedEnd(source, start) {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") index += 2;
    else if (source[index] === quote) return index + 1;
    else index += 1;
  }
  return source.length;
}

function templateLiteralEnd(source, start) {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") index += 2;
    else if (source[index] === "`") return index + 1;
    else if (source[index] === "$" && source[index + 1] === "{") index = expressionEnd(source, index + 2) + 1;
    else index += 1;
  }
  return source.length;
}

function startsRegex(tokens) {
  const previous = tokens.at(-1)?.value;
  return previous === undefined
    || ["(", "[", "{", "=", ":", ",", ";", "!", "?", "&", "|"].includes(previous)
    || ["return", "case", "throw", "else", "do"].includes(previous);
}
