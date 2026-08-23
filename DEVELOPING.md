# Developing

## Setup

An **npm-installed** global Pi is required. Runtime imports and test types resolve from the active `pi` executable, and only the npm layout exposes those packages: the standalone tar.gz build compiles them into a single binary. A standalone Pi is a supported *runtime target*, not a supported development host, and `npm run check` says so by name if the `pi` on `PATH` is the compiled build.

```bash
npm run setup:dev
npm run check
npm test
```

Do not run `npm install` at the repository root. The package has no installed dependencies and must not contain root `node_modules` or a root lockfile. `setup:dev` installs the isolated, locked `tooling/` package containing the TypeScript parser/compiler and Node declarations used by source-policy checks and typechecking. Its ignored `node_modules/` is generated development state, not published runtime code. Pi loads the TypeScript extension directly; there is no runtime build.

To load a local checkout:

```bash
pi install /absolute/path/to/pi-claude-code-provider
```

## Architecture

| Change area | Owning modules | Focused validation |
| --- | --- | --- |
| Extension startup and session lifetime | `extensions/pi-claude-code-provider.ts` | `extension.test.js` |
| Authentication, CLI, and compatibility | `src/auth.ts`, `src/claude-args.ts`, `src/compatibility.ts` | `auth.test.js`, `claude-args.test.js`, `compatibility.test.js` |
| Transcript and provider lifecycle | `src/context-serializer.ts`, `src/provider.ts`, `src/stream-events.ts`, `src/claude-protocol.ts` | `context-serializer.test.js`, `provider.test.js`, `stream-events.test.js` |
| Runtime launch, process trees, and private state | `src/host-runtime.ts`, `src/process-utils.ts`, `src/runtime-directories.ts` | `process-utils.test.js`, `runtime-directories.test.js` |
| Visible web search | `src/web-search.ts` | `web-search.test.js` |
| Diagnostics and metrics | `src/diagnostics.ts`, `src/doctor.ts`, `src/metrics.ts` | `metrics-doctor.test.js` |
| Proposal-only MCP bridge | `bridge/mcp-proposal-server.js` | `mcp-bridge.test.js` |

Pi remains authoritative for prepared context, branches, compaction, active tools, execution, provider handoff, and cancellation. Read the matching Pi checkout's contributor and provider documentation before changing those boundaries. Pi imports remain optional `*` peer dependencies and are not bundled.

## Compatibility baseline

`src/compatibility.ts` owns Pi/Claude version, platform, and model-resolution values; `.github/workflows/ci.yml` owns the Node CI matrix. Update the relevant source and this table together only after the applicable validation gate passes.

| Component | Verified baseline |
| --- | --- |
| Pi | 0.84.2, npm distribution; standalone tar.gz build live-verified on Linux x64 only |
| Claude Code | 2.1.241 |
| Node.js | 24.16.0 on WSL2 and Apple Silicon macOS CI; 22.23.1 on Windows |
| Platform | WSL2 Ubuntu/Linux x64; native Windows x64; GitHub-hosted Apple Silicon macOS deterministic CI |

Pi's distribution is part of the baseline, not an implementation detail: the npm build runs on Node and the standalone tar.gz build is a compiled Bun binary, and `process.execPath` means something different on each. `src/host-runtime.ts` owns that difference in one place (`scriptLaunch`), which sets `BUN_BE_BUN=1` so a compiled Pi binary runs the proposal bridge instead of its own embedded entry point, and pins `--config=` to a neutral `bunfig.toml` in the private request directory. Pi compiles with `--no-compile-autoload-bunfig`, but that protects Pi's own entry point only and does not survive `BUN_BE_BUN`; without the pin, a `bunfig.toml` in the bridge's working directory preloads code into it. Only the joined `--config=` form works, as Bun ignores a space-separated one and then consumes the script path. The mechanism is not Linux-specific: Pi builds all six standalone targets from one `bun build --compile` invocation, and `BUN_BE_BUN` is part of the embedded Bun runtime on each. Record a standalone baseline only after `npm run test:paid:bridge-standalone` passes against that exact build.

Apple Silicon macOS passes the [deterministic GitHub Actions matrix](.github/workflows/ci.yml); subscription-consuming live Claude validation on macOS remains pending. Other platforms and versions continue with advisory warnings, while protocol and isolation mismatches fail closed. Supported effort values are `low`, `medium`, `high`, `xhigh`, and `max`; Pi `off` and `minimal` are hidden.

## Validation

`npm run check` enforces dependency and import policy, Markdown links and versions, source boundaries, JavaScript syntax, and strict TypeScript. `npm test` runs deterministic tests. Neither command performs Claude inference or consumes subscription quota; `check` may run `claude --version` for advisory metadata.

Subscription-consuming commands are named `test:paid:*`. They show the detected subscription, request caps, and quota/spend warning, then require the exact phrase `USE PAID CLAUDE QUOTA`. Noninteractive execution additionally requires `PI_CLAUDE_CODE_PROVIDER_CONFIRM_PAID_TESTS=1`. The underlying scripts refuse direct invocation, perform no automatic retries, and atomically claim a stage and aggregate slot before every provider or web-search Claude launch.

| Command | Maximum Claude launches |
| --- | ---: |
| `npm run test:paid:smoke` | 1 |
| `npm run test:paid:bridge` | 3 |
| `npm run test:paid:bridge-standalone` | 3 |
| `npm run test:paid:post-tools` | 6 |
| `npm run test:paid:full` | 28 |
| `npm run test:paid:cache` | 3 |
| `npm run test:paid:fable` | 1 |
| `npm run test:paid:opus` | 1 |
| `npm run test:paid:matrix` | 20 |
| `npm run test:paid:release` | 57 |

`PI_CLAUDE_CODE_PROVIDER_PI_BIN` selects which Pi executable the live scripts launch; without it they launch the npm-hosted CLI entry. This is deliberately separate from package resolution, so one npm-hosted development host can drive both distributions. `bridge-standalone` refuses to start unless that variable is set; point it at an extracted tar.gz `pi`.

Both bridge lanes are required, and `test:paid:release` runs both. A `--no-tools` turn passes even when the proposal bridge never starts, so only a turn that actually round-trips a tool distinguishes a working bridge from a broken one. `/pi-claude-code-provider-doctor` performs the same handshake without consuming quota.

The release suite covers text, tool, image, isolation, recovery, Unicode, history, web search, cache reuse, both bridge lanes, the gated aliases, and the supported effort matrix. Fable is technically selectable, but validating it on Pro consumes separate paid credits rather than the included subscription allocation, so it is deliberately excluded from the release matrix; the blocking Sonnet and Opus cases already exercise the shared transport. `npm run test:paid:fable` remains an opt-in one-launch case for a maintainer who separately authorizes that spend. Successful RPC harnesses close stdin so Pi can run session shutdown and flush metrics before exit.

Each request serializes the complete current transcript. Cache-hit percentage is `cacheRead / (input + cacheRead + cacheWrite) * 100`; cache writes seed later reuse and are not hits. Preserve append-stable history blocks and sorted tool catalogs when changing serialization. Claude Code 2.1.233 introduced a changing `<total_tokens>` reminder that broke reuse across fresh print-mode processes; the provider pins `totalTokensReminder: "off"` following [bcherny's maintainer guidance](https://github.com/anthropics/claude-code/issues/81259#issuecomment-5311888970). The setting is otherwise undocumented, so do not remove it without a replacement cache probe and new upstream guidance.

## Platform and compatibility work

Windows cleanup must remain rooted at the exact retained child PID. Never replace it with `/IM`, name-based PowerShell termination, or global process enumeration. Automatic stale-directory recovery stays disabled on Windows; inspect Node's temporary root and package markers before removing confirmed stale state.

`streamSimple` owns both halves of Pi's provider request contract: apply the `onPayload` replacement before launching Claude, and invoke `onResponse` once initialization validates, before publishing content. Dropping either silently disables the matching Pi extension event for this provider.

When updating Claude compatibility:

1. Compare the required CLI flags, initialization fields, stream records, and exact tool inventory.
2. Cover readiness, invalid or oversized JSONL, timeouts, aborts, error exits, and descendant cleanup deterministically.
3. Run guarded live, cache, and model gates only with explicit quota authorization.
4. Update machine-readable and written baselines only after the gates pass.

When updating Pi compatibility, read the current package, extension, provider, session, and compaction contracts, then test a clean Git or packed installation on both the npm and standalone distributions.

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
