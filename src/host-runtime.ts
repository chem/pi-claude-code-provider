export interface ScriptLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Launch a JavaScript file under the Node or compiled Bun runtime hosting Pi. */
export function scriptLaunch(
  script: string,
  args: readonly string[] = [],
  bunConfigPath?: string,
  runtime: string = process.execPath,
  bunVersion: string | undefined = process.versions.bun,
): ScriptLaunch {
  // Bun accepts only the joined form; a separate value consumes the script path.
  const bunArgs = bunVersion && bunConfigPath ? [`--config=${bunConfigPath}`] : [];
  return {
    command: runtime,
    args: [...bunArgs, script, ...args],
    env: bunVersion ? { BUN_BE_BUN: "1" } : {},
  };
}

export const NEUTRAL_BUN_CONFIG = "# Intentionally empty: neutralizes working-directory bunfig preload.\n";

export function needsBunConfig(bunVersion: string | undefined = process.versions.bun): boolean {
  return Boolean(bunVersion);
}

export function hostRuntimeDescription(
  execPath: string = process.execPath,
  bunVersion: string | undefined = process.versions.bun,
  nodeVersion: string = process.versions.node,
): string {
  return `${bunVersion ? `Bun ${bunVersion}` : `Node ${nodeVersion}`} at ${execPath}`;
}
