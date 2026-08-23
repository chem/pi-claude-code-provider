import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export function documentationPolicyErrors(root, markdownFiles, verifiedVersions) {
  const errors = [];
  for (const path of markdownFiles) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const reference = match[1].trim();
      if (/^(?:https?:|mailto:|#)/.test(reference)) continue;
      const [relativePath, anchor] = reference.split("#", 2);
      const target = resolve(dirname(path), decodeURIComponent(relativePath));
      if (!existsSync(target)) {
        errors.push(`Broken Markdown link in ${relative(root, path)}: ${reference}`);
        continue;
      }
      if (anchor && target.endsWith(".md")) {
        const anchors = markdownAnchors(readFileSync(target, "utf8"));
        if (!anchors.has(anchor)) errors.push(`Broken Markdown anchor in ${relative(root, path)}: ${reference}`);
      }
    }
  }
  const compatibilityPath = join(root, "DEVELOPING.md");
  const compatibility = readFileSync(compatibilityPath, "utf8");
  const readme = readFileSync(join(root, "README.md"), "utf8");
  if (!readme.includes("](DEVELOPING.md#compatibility-baseline)")) {
    errors.push("README.md must link to DEVELOPING.md#compatibility-baseline");
  }
  for (const [component, version] of Object.entries(verifiedVersions)) {
    if (!compatibility.includes(version)) errors.push(`DEVELOPING.md omits verified version ${version}`);
    if (readme.includes(version)) {
      errors.push(`README.md duplicates verified ${component} version ${version}; DEVELOPING.md owns compatibility baselines`);
    }
  }
  return errors;
}

function markdownAnchors(source) {
  const anchors = new Set();
  const counts = new Map();
  for (const line of source.split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/)?.[1];
    if (!heading) continue;
    const base = heading
      .toLowerCase()
      .replace(/[`*_~]/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}
