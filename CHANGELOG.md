# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.1] - 2026-07-23

Initial public release of `kiro-pi` on npm.

### Added
- Streaming Kiro provider for Pi backed by Kiro's AWS CodeWhisperer-compatible API, with text and image input, streamed reasoning, tool calls, token/metering diagnostics, and Authorization-header hardening.
- AWS Builder ID, Google, and GitHub OAuth sign-in plus account-visible model discovery, with read-only reuse of local Kiro CLI credentials.
- Kiro account usage checks: the `/kiro-usage` command and the `kiro_usage` tool report credit usage, remaining balance, subscription plan, overage status, and monthly reset date via Kiro's `GetUsageLimits` API. Uses the managed `kiro` OAuth credential and falls back to read-only Kiro CLI state.
- GitHub Actions CI (`npm run check` on Node 20 and 22) and a tag-driven release workflow that publishes to npm on `v*.*.*` tags.

> The version history below (0.1.x-0.2.x) is inherited lineage from [`MasuRii/pi-kiro-provider`](https://github.com/MasuRii/pi-kiro-provider) and predates the independent `kiro-pi` npm package.

## [0.2.2] - 2026-07-03

### Changed
- Widened Pi peer dependency ranges to 0.80 and added security dependency overrides. ([ce50099](https://github.com/MasuRii/pi-kiro-provider/commit/ce50099c1071da42f69a2c637bf124ea4634ff12))
- Extracted shared credentials and HTTP utilities to reduce duplication. ([1c2fbe3](https://github.com/MasuRii/pi-kiro-provider/commit/1c2fbe34689f92794bff56ca7f4fc372fcf69b16))

## [0.2.1] - 2026-06-16

### Fixed
- Validated that parsed model cost values are non-negative finite numbers to prevent invalid cost metadata from silently passing through.
- Added stricter bounds checking for malformed event stream frames, returning `null` instead of silently reading past the header section boundary.

## [0.2.0] - 2026-06-01

### Added
- Added lazy loading for Kiro OAuth and streaming modules to reduce startup cost.

### Changed
- Widened Pi peer dependency compatibility to include Pi 0.77.x and 0.78.x.

### Fixed
- Corrected the default Kiro API key placeholder to reference `$KIRO_ACCESS_TOKEN` consistently in config and docs.

## [0.1.0] - 2026-05-27

### Added
- Prepared npm/GitHub release metadata, package contents, README, changelog, license, and package ignore rules for public review.
- Added the initial Kiro provider extension with OAuth registration, Pi provider registration, runtime provider replay for pi-multi-auth, configurable model metadata, and file-gated debug logging.
