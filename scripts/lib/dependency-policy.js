export const PI_PEERS = Object.freeze([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "typebox",
]);

export function dependencyPolicyErrors(manifest) {
  const errors = [];
  const allowed = new Set(PI_PEERS);
  if (manifest.dependencies && Object.keys(manifest.dependencies).length)
    errors.push("package.json must not declare dependencies");
  if (manifest.devDependencies && Object.keys(manifest.devDependencies).length)
    errors.push("package.json must not declare devDependencies");
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!allowed.has(name) || range !== "*")
      errors.push(`Unexpected peer dependency: ${name}@${range}`);
    if (!manifest.peerDependenciesMeta?.[name]?.optional)
      errors.push(`Pi peer dependency must be optional to prevent local installation: ${name}`);
  }
  for (const name of PI_PEERS) {
    if (manifest.peerDependencies?.[name] !== "*")
      errors.push(`Missing Pi peer dependency: ${name}`);
  }
  return errors;
}
