import { release } from "node:os";

export const VERIFIED_VERSIONS = Object.freeze({
  pi: "0.84.2",
  claudeCode: "2.1.241",
});

const VERIFIED_PLATFORMS = "WSL2 Ubuntu/linux-x64; native Windows/win32-x64; Apple Silicon macOS/darwin-arm64";

export const EXPECTED_MODEL_RESOLUTIONS = Object.freeze({
  // No --model override: Claude selects the account's runtime default.
  default: null,
  sonnet: "claude-sonnet-5",
  fable: "claude-fable-5",
  opus: "claude-opus-5",
  haiku: "claude-haiku-4-5-20251001",
});

export interface VersionStatus {
  component: string;
  current: string;
  verified: string;
  isVerified: boolean;
  warning?: string;
}

export function platformStatus(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
  kernelRelease: string = release(),
  wslDistribution: string | undefined = process.env.WSL_DISTRO_NAME,
): VersionStatus {
  const current = `${platform}/${architecture}`;
  if (platform === "win32" && architecture === "x64") {
    return {
      component: "Platform",
      current,
      verified: VERIFIED_PLATFORMS,
      isVerified: true,
    };
  }
  if (platform === "win32") {
    return {
      component: "Platform",
      current,
      verified: VERIFIED_PLATFORMS,
      isVerified: false,
      warning: `${current} is unverified; the native Windows verified baseline is x64`,
    };
  }
  if (
    platform === "linux" &&
    architecture === "x64" &&
    /microsoft.*wsl2/i.test(kernelRelease) &&
    /^ubuntu(?:-|$)/i.test(wslDistribution ?? "")
  ) {
    return {
      component: "Platform",
      current,
      verified: VERIFIED_PLATFORMS,
      isVerified: true,
    };
  }
  if (platform === "linux") {
    return {
      component: "Platform",
      current,
      verified: VERIFIED_PLATFORMS,
      isVerified: false,
      warning: `${current} is a compatibility candidate; the verified platform baselines are ${VERIFIED_PLATFORMS}`,
    };
  }
  if (platform === "darwin" && architecture === "arm64") {
    return {
      component: "Platform",
      current,
      verified: VERIFIED_PLATFORMS,
      isVerified: true,
    };
  }
  return {
    component: "Platform",
    current,
    verified: VERIFIED_PLATFORMS,
    isVerified: false,
    warning: `${current} is unverified; continuing with runtime validation`,
  };
}

/** Dismiss only the startup advisory for an explicitly acknowledged platform.
 * Doctor/report metadata and runtime validation remain unchanged.
 */
export function startupPlatformWarning(
  status: VersionStatus,
  acknowledgedPlatform: string | undefined = process.env.PI_CLAUDE_CODE_PROVIDER_ACKNOWLEDGED_PLATFORM,
): string | undefined {
  return acknowledgedPlatform === status.current ? undefined : status.warning;
}

/** Return verification metadata; mismatches never block execution by themselves. */
export function versionStatus(component: string, current: string, verified: string): VersionStatus {
  return {
    component,
    current,
    verified,
    isVerified: current === verified,
  };
}
