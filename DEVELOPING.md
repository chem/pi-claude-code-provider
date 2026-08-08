# Developing

## Setup

A global Pi installation is required. Runtime imports and test types resolve from the active `pi` executable.

```bash
npm run setup:dev
npm run check
npm test
```

Do not run `npm install` at the repository root. The package has no installed dependencies and must not contain root `node_modules` or a root lockfile. `setup:dev` installs the isolated, locked `tooling/` package containing TypeScript and Node declarations. Pi loads the TypeScript extension directly; there is no runtime build.

To load a local checkout:

```bash
pi install /absolute/path/to/pi-claude-code-provider
```

## Architecture

- `extensions/pi-claude-code-provider.ts` registers the provider, doctor command, web-search tool, and session cleanup.
- `src/auth.ts`, `src/claude-args.ts`, and `src/compatibility.ts` own executable, authentication, CLI, and compatibility policy.
- `src/context-serializer.ts`, `src/provider.ts`, and `src/stream-events.ts` own the semantic transcript and main request lifecycle.
- `src/process-utils.ts` and `src/runtime-directories.ts` own process-tree and private-state cleanup.
- `src/web-search.ts` owns separately isolated visible web search.
- `src/diagnostics.ts`, `src/doctor.ts`, and `src/metrics.ts` own content-free diagnostics.
- `bridge/mcp-proposal-server.js` exposes tool schemas but cannot execute them.
- `scripts/`, `test/`, and `tooling/` contain validation and development support.

Pi remains authoritative for prepared context, branches, compaction, active tools, execution, provider handoff, and cancellation. Read the matching Pi checkout's contributor and provider documentation before changing those boundaries. Pi imports remain optional `*` peer dependencies and are not bundled.

## Compatibility baseline

Machine-readable values live in `src/compatibility.ts`; update code and this table together only after the applicable validation gate passes.

| Component | Verified baseline |
| --- | --- |
| Pi | 0.84.1 |
| Claude Code | 2.1.226 |
| Node.js | 24.16.0 on WSL2 and Apple Silicon macOS CI; 22.23.1 on Windows |
| Platform | WSL2 Ubuntu/Linux x64; native Windows x64; GitHub-hosted Apple Silicon macOS deterministic CI |

Apple Silicon macOS passes the [deterministic GitHub Actions matrix](.github/workflows/ci.yml); subscription-consuming live Claude validation on macOS remains pending. Other platforms and versions continue with advisory warnings, while protocol and isolation mismatches fail closed. Supported effort values are `low`, `medium`, `high`, `xhigh`, and `max`; Pi `off` and `minimal` are hidden.

## Validation

`npm run check` enforces dependency and import policy, Markdown links and versions, source boundaries, JavaScript syntax, and strict TypeScript. `npm test` runs deterministic tests. Neither command performs Claude inference or consumes subscription quota; `check` may run `claude --version` for advisory metadata.

Subscription-consuming commands are named `test:paid:*`. They show the detected subscription, request caps, and quota/spend warning, then require the exact phrase `USE PAID CLAUDE QUOTA`. Noninteractive execution additionally requires `PI_CLAUDE_CODE_PROVIDER_CONFIRM_PAID_TESTS=1`. The underlying scripts refuse direct invocation, perform no automatic retries, and atomically claim a stage and aggregate slot before every provider or web-search Claude launch.

| Command | Maximum Claude launches |
| --- | ---: |
| `npm run test:paid:smoke` | 1 |
| `npm run test:paid:post-tools` | 6 |
| `npm run test:paid:full` | 28 |
| `npm run test:paid:cache` | 3 |
| `npm run test:paid:fable` | 1 |
| `npm run test:paid:opus` | 1 |
| `npm run test:paid:matrix` | 20 |
| `npm run test:paid:release` | 51 |

The release suite covers text, tool, image, isolation, recovery, Unicode, history, web search, cache reuse, the gated aliases, and the supported effort matrix. Fable 5 is not served through subscription plans, so `fable` is excluded from the matrix and the release gate; `npm run test:paid:fable` remains available for accounts with usage credits enabled. Successful RPC harnesses close stdin so Pi can run session shutdown and flush metrics before exit.

Each request serializes the complete current transcript. Cache-hit percentage is `cacheRead / (input + cacheRead + cacheWrite) * 100`; cache writes seed later reuse and are not hits. Preserve append-stable history blocks and sorted tool catalogs when changing serialization.

## Platform and compatibility work

Windows cleanup must remain rooted at the exact retained child PID. Never replace it with `/IM`, name-based PowerShell termination, or global process enumeration. Automatic stale-directory recovery stays disabled on Windows; inspect Node's temporary root and package markers before removing confirmed stale state.

`streamSimple` owns both halves of Pi's provider request contract: apply the `onPayload` replacement before launching Claude, and invoke `onResponse` once initialization validates, before publishing content. Dropping either silently disables the matching Pi extension event for this provider.

When updating Claude compatibility:

1. Compare the required CLI flags, initialization fields, stream records, and exact tool inventory.
2. Cover readiness, invalid or oversized JSONL, timeouts, aborts, error exits, and descendant cleanup deterministically.
3. Run guarded live, cache, and model gates only with explicit quota authorization.
4. Update machine-readable and written baselines only after the gates pass.

When updating Pi compatibility, read the current package, extension, provider, session, and compaction contracts, then test a clean Git or packed installation.

## Release procedure

1. Confirm the worktree is clean and the npm name and metadata are correct.
2. Promote `[Unreleased]` in `CHANGELOG.md` to a dated version entry.
3. Run `npm run release:check` and inspect `npm pack --dry-run`.
4. Install the tarball in a fresh temporary directory and list its models with Pi.
5. If runtime code changed, run the explicitly authorized paid release gate.
6. Run `npm publish --dry-run` and inspect the exact inventory.
7. Publish, tag, and create the GitHub release only with maintainer authorization.

This repository contains no automatic publishing workflow.

## Documentation and Git hygiene

- `README.md` owns installation, usage, configuration, material limitations, and troubleshooting.
- `DESIGN.md` owns architecture and security design.
- `DEVELOPING.md` owns setup, validation, compatibility, and release procedures.
- `CONTRIBUTING.md` owns contribution requirements.
- `SECURITY.md` owns vulnerability reporting.
- `CHANGELOG.md` owns user-visible release history.

Do not commit credentials, Claude state, prompts, temporary transport data, diagnostic reports, metrics logs, coverage, root dependencies, or a root lockfile. Stage explicit paths and inspect every diff before committing.
