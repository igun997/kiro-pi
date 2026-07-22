<div align="center">

# kiro-pi 🐸

[![License](https://img.shields.io/github/license/igun997/kiro-pi?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=for-the-badge)]()

<img src="assets/keropi.svg" alt="Original green frog mark" width="96">

**Kiro provider for Pi**

Streaming Kiro provider backed by Kiro's AWS CodeWhisperer-compatible API.

[GitHub](https://github.com/igun997/kiro-pi) · [Issues](https://github.com/igun997/kiro-pi/issues)

</div>

> `kiro-pi` is an independent project. It is not affiliated with Kiro, AWS, Sanrio, or `MasuRii/pi-kiro-provider`. The frog mark is original project artwork and is not official Keroppi artwork.

## Requirements

- [Pi](https://github.com/badlogic/pi-mono) with a compatible Pi 0.74–0.81 runtime
- Node.js 20 or newer
- Kiro authentication through Pi OAuth, or an explicit `KIRO_ACCESS_TOKEN`

Kiro CLI is optional. Install it if you want account-visible model discovery from existing local CLI credentials.

## Install

### Pi package install

```bash
pi install npm:kiro-pi
```

Restart Pi, then reload extensions if needed:

```text
/reload
```

Install directly from GitHub instead:

```bash
pi install git:github.com/igun997/kiro-pi
```

### Local checkout

```bash
git clone https://github.com/igun997/kiro-pi.git
cd kiro-pi
npm install
npm run check
pi install -l .
```

Run checkout directly during development:

```bash
pi -e ./index.ts
```

### Optional: Kiro CLI

Kiro CLI is not required for Pi prompts. It enables read-only reuse of local CLI authentication for model discovery.

Use the [official Kiro CLI installation guide](https://kiro.dev/docs/cli/installation/). Quick installs:

**macOS or Linux**

```bash
curl -fsSL https://cli.kiro.dev/install | bash
```

**Windows PowerShell**

```powershell
irm 'https://cli.kiro.dev/install.ps1' | iex
```

Authenticate after installation:

```bash
kiro-cli --version
kiro-cli
```

For Ubuntu `.deb`, AppImage, zip, ARM64, or musl Linux instructions, follow the official guide.

## Use

Authenticate with Pi, then select Kiro:

```text
/login kiro
/model kiro/auto
```

Supported login labels include AWS Builder ID, Google, and GitHub. You can also select Kiro from the command line:

```bash
pi --provider kiro --model auto
```

Set any discovered model with:

```text
/model kiro/<model-id>
```

`auto` remains available as a fallback. Model IDs depend on Kiro account entitlements and region.

## Features

- Streaming Kiro responses through Pi's provider API
- Text and image input, including image-only turns
- PNG, JPEG/JPG, GIF, and WebP image payloads
- Streamed reasoning text, signatures, and redacted reasoning replay
- Tool calls and fragmented tool input handling
- Token usage, cache usage, rate metadata, and metering diagnostics
- AWS Builder ID, Google, and GitHub OAuth flows
- Optional Kiro profile ARN support
- Authorization-header hardening so configured headers cannot override managed credentials
- File-only debug logging when explicitly enabled

## Authentication and model discovery

Prompt requests use one of these credential sources:

1. Pi's stored `kiro` OAuth credential.
2. Explicit `$KIRO_ACCESS_TOKEN` or another configured API key.

Kiro CLI credentials are read-only and currently used for live model discovery. They are not automatically substituted for Pi prompt-request credentials. Provider reads valid local CLI state from:

- `~/.aws/sso/cache/kiro-auth-token.json`
- `~/.local/share/kiro-cli/data.sqlite3`

Provider never writes or refreshes Kiro CLI files. If CLI authentication expires, authenticate again with `kiro-cli` or use `/login kiro` for Pi.

When network discovery is available, `kiro-pi` calls Kiro's regional management endpoint and imports account-visible model IDs, display names, context limits, reasoning levels, and rate metadata. Discovery refreshes at provider startup, session start/reload, and multi-auth readiness events. If discovery fails or runs without valid local CLI or event-provided auth, the last-known or built-in fallback models remain available.

> Discovery sends the bearer token to Kiro's management endpoint. Credential values are never logged.

## Configuration

Runtime configuration is optional. Copy the example file into the extension root:

```bash
cp config/config.example.json config.json
```

Common options:

| Option | Description |
|---|---|
| `enabled` | Enable or disable provider registration. |
| `debug` | Write file-only diagnostics under `debug/debug.log`. |
| `upstreamUrl` | CodeWhisperer or Amazon Q streaming endpoint. |
| `endpoint` | `codewhisperer` or `amazonq`; inferred when omitted. |
| `apiKey` | Explicit token reference; defaults to `$KIRO_ACCESS_TOKEN`. |
| `requestTimeoutMs` | Streaming/OAuth request timeout. |
| `profileArn` | Optional Kiro profile ARN. |
| `headers` | Additional non-authorization headers. |
| `oauth` | OAuth endpoint and sign-in configuration. |
| `models` | Optional replacement model catalog. |
| `modelDefaults` | Defaults applied to configured models. |

Authorization headers in global, model-default, or model-specific configuration are intentionally ignored. Managed provider credentials remain authoritative.

## Development

```bash
npm install
npm run check
npm run package:dry-run
```

`npm run check` runs typecheck, lint, tests, and build validation.

## Lineage

`kiro-pi` began from [`MasuRii/pi-kiro-provider`](https://github.com/MasuRii/pi-kiro-provider) and now follows its own repository, branding, model discovery, Kiro CLI integration, tests, and maintenance workflow. Upstream MIT attribution remains in [`LICENSE`](LICENSE), with historical references in [`CHANGELOG.md`](CHANGELOG.md).

## License

[MIT](LICENSE)
