

# 🌉 web-model-bridge

**Bridge web AI models through OpenAI-compatible API**

Use Claude, ChatGPT, DeepSeek, and 8 more AI models — completely free, zero API tokens.

[License: MIT](LICENSE)
[Node.js](https://nodejs.org/)
[TypeScript](https://www.typescriptlang.org/)
[Tests](#testing)

[Quick Start](#quick-start) · [Supported Models](#supported-models) · [Configuration](#configuration) · [API Reference](#api-reference) · [Nix / NixOS](#nix--nixos) · [Contributing](#contributing)



---

## What is this?

**web-model-bridge** is a standalone HTTP service that lets any AI tool use web-based AI models through their free browser interfaces. It acts as a bridge between AI tools (OpenClaw, Claude Code, Cursor, etc.) and web AI platforms (Claude, ChatGPT, DeepSeek, etc.).

```
Your AI Tool  →  web-model-bridge  →  Browser  →  Web AI Model
(OpenClaw)       (localhost:3456)     (Chrome)    (claude.ai)
```

**How it works:** You log into AI websites once through a Dashboard. The bridge then uses your browser session to forward API requests — no API keys, no tokens, no cost.

## Why web-model-bridge?

Compared to alternatives like gpt4free (66K stars), CLIProxyAPI (23K stars), and chat2api (3.4K stars):

| | web-model-bridge | gpt4free | CLIProxyAPI | chat2api |
|---|---|---|---|---|
| **Approach** | Real browser automation | Reverse-engineered APIs | CLI OAuth proxy | Token simulation |
| **Anti-blocking** | **Strongest** — real browser fingerprint | Weak — APIs break often | Medium | Weak — Cloudflare blocks |
| **Cost** | **Free** — web free tier only | Free | **Needs $20-100/mo subscription** | Free |
| **Platforms** | **11 platforms, 16 models** | Varies (unstable) | 4-5 platforms | ChatGPT only |
| **API formats** | **OpenAI + Anthropic** | OpenAI only | OpenAI + Anthropic | OpenAI only |
| **Language** | TypeScript (Node.js native) | Python | Go | Python |

**Core advantages:**

1. **Strongest anti-blocking** — Uses Playwright real browser, websites can't distinguish from normal browsing
2. **Truly free** — Only needs free web accounts, no paid subscriptions required
3. **Widest coverage** — 11 platforms (international + Chinese), 16 models in one bridge
4. **Dual API format** — Both `/v1/chat/completions` (OpenAI) and `/v1/messages` (Anthropic), works with every AI tool
5. **Node.js ecosystem** — TypeScript native, `npx web-model-bridge` zero-install startup

## Features


| Feature                | Description                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------- |
| 🔌 **11 Providers**    | Claude, ChatGPT, DeepSeek, Kimi, Qwen, GLM, Grok, Gemini, Perplexity, Doubao, Xiaomimo |
| 🔄 **Dual API Format** | OpenAI (`/v1/chat/completions`) + Anthropic (`/v1/messages`)                           |
| 🖥️ **Web Dashboard**  | Visual management — login, status, one-click API URL copy                              |
| 🚀 **One Command**     | `npx web-model-bridge` — auto environment check, auto open Dashboard                   |
| 🔒 **Secure**          | Localhost-only by default, optional Bearer token, browser-isolated cookies             |
| 💻 **Cross-Platform**  | macOS, Linux, Windows                                                                  |
| 🎯 **Zero Config**     | Works out of the box, optional YAML config for customization                           |


## Quick Start

### 1. Start the bridge

```bash
npx web-model-bridge
```

This will:

- ✓ Check your environment (Node.js, Chrome)
- ✓ Start HTTP server on port 3456
- ✓ Open Dashboard in your browser

### 2. Login to AI providers

In the Dashboard ([http://localhost:3456](http://localhost:3456)), click **Login** next to any provider. A browser window opens — log in as you normally would. Done.

### 3. Connect your AI tool

**OpenClaw** — Add to `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "webmodel": {
        "baseUrl": "http://127.0.0.1:3456/v1",
        "apiKey": "not-needed",
        "api": "openai-completions",
        "models": [
          { "id": "deepseek-web/deepseek-v4", "name": "DeepSeek V4 (Free)", "contextWindow": 128000, "maxTokens": 8192 }
        ]
      }
    }
  }
}
```

**Claude Code:**

```bash
export ANTHROPIC_BASE_URL="http://localhost:3456"
export ANTHROPIC_API_KEY="not-needed"
claude
```

**Cursor:** Settings → Models → Override OpenAI Base URL → `http://localhost:3456/v1`

**Any OpenAI-compatible tool:** Set base URL to `http://localhost:3456/v1`

## Supported Models


| Model ID                            | Name                 | Context | Platform          |
| ----------------------------------- | -------------------- | ------- | ----------------- |
| `claude-web/claude-sonnet-4-6`      | Claude Sonnet 4.6    | 1M      | claude.ai         |
| `claude-web/claude-haiku-4-5`       | Claude Haiku 4.5     | 200K    | claude.ai         |
| `chatgpt-web/gpt-5.3`               | GPT-5.3              | 128K    | chatgpt.com       |
| `chatgpt-web/gpt-5.4-mini`          | GPT-5.4 Mini         | 128K    | chatgpt.com       |
| `deepseek-web/deepseek-v4`          | DeepSeek V4          | 128K    | chat.deepseek.com |
| `deepseek-web/deepseek-v4-reasoner` | DeepSeek V4 Reasoner | 128K    | chat.deepseek.com |
| `kimi-web/kimi-k2.5`                | Kimi K2.5            | 256K    | kimi.moonshot.cn  |
| `qwen-web/qwen-3.5-plus`            | Qwen 3.5 Plus        | 262K    | chat.qwen.ai      |
| `qwen-web/qwq`                      | QwQ                  | 32K     | chat.qwen.ai      |
| `glm-web/glm-5`                     | GLM-5                | 128K    | chatglm.cn        |
| `grok-web/grok-3`                   | Grok 3               | 128K    | grok.com          |
| `gemini-web/gemini-3-flash`         | Gemini 3 Flash       | 1M      | gemini.google.com |
| `gemini-web/gemini-2.5-pro`         | Gemini 2.5 Pro       | 1M      | gemini.google.com |
| `perplexity-web/perplexity-default` | Perplexity           | 128K    | perplexity.ai     |
| `doubao-web/doubao-seed-2.0-pro`    | Doubao Seed 2.0 Pro  | 256K    | doubao.com        |
| `xiaomimo-web/mimo-v2-pro`          | MiMo V2 Pro          | 1M      | xiaomimimo.com    |


## Configuration

### Command Line Options

```bash
web-model-bridge                         # Start with defaults
web-model-bridge -p 8080                 # Custom port
web-model-bridge --host 0.0.0.0          # Allow remote access (use with --auth-token)
web-model-bridge --auth-token mysecret   # Require Bearer token
web-model-bridge --no-open               # Don't auto-open browser
web-model-bridge -v                      # Verbose logging (shows environment check)
```

### Config File

`~/.webmodel/config.yml`:

```yaml
server:
  port: 3456
  host: 127.0.0.1
  authToken: null

browser:
  idleShutdown: 300    # Close Chrome after 5 min idle

providers:
  enabled:             # Enable only what you need
    - claude-web
    - deepseek-web
    - qwen-web

logging:
  level: info
```

## API Reference

### OpenAI Format

```bash
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-web/deepseek-v4",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### Anthropic Format

```bash
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: not-needed" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-web/claude-sonnet-4-6",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Management Endpoints


| Endpoint                | Method | Description               |
| ----------------------- | ------ | ------------------------- |
| `/`                     | GET    | Web Dashboard             |
| `/v1/chat/completions`  | POST   | OpenAI-compatible chat    |
| `/v1/messages`          | POST   | Anthropic-compatible chat |
| `/v1/models`            | GET    | List available models     |
| `/webmodel/providers`   | GET    | Provider auth status      |
| `/webmodel/health`      | GET    | Server health check       |
| `/webmodel/auth/login`  | POST   | Trigger provider login    |
| `/webmodel/auth/logout` | POST   | Clear provider auth       |


## Architecture

```
┌──────────────────────────────┐
│  AI Tools (OpenClaw, Claude  │
│  Code, Cursor, Open WebUI)   │
└──────────┬───────────────────┘
           │ HTTP
           ▼
┌──────────────────────────────┐
│  web-model-bridge            │
│  ┌────────────────────────┐  │
│  │ HTTP Layer             │  │
│  │ OpenAI + Anthropic API │  │
│  └───────────┬────────────┘  │
│  ┌───────────▼────────────┐  │
│  │ Core Layer             │  │
│  │ Registry + SSE Stream  │  │
│  └───────────┬────────────┘  │
│  ┌───────────▼────────────┐  │
│  │ Infra Layer            │  │
│  │ Chrome + Auth + Config │  │
│  └────────────────────────┘  │
└──────────┬───────────────────┘
           │ CDP
           ▼
┌──────────────────────────────┐
│  Chrome (silent, background) │
│  Logged into AI websites     │
└──────────────────────────────┘
```

## Nix / NixOS

The flake exposes a package, an overlay, and a home-manager module.

### Try it without installing

```bash
nix run github:linuxhsj/WebModel
```

### Add to your flake

```nix
# flake.nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    web-model-bridge = {
      url = "github:linuxhsj/WebModel";
      inputs.nixpkgs.follows = "nixpkgs"; # reuse your nixpkgs — no extra instance
    };
  };

  outputs = { nixpkgs, home-manager, web-model-bridge, ... }: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        # 1. Inject the overlay so pkgs.web-model-bridge is available everywhere
        { nixpkgs.overlays = [ web-model-bridge.overlays.default ]; }

        home-manager.nixosModules.home-manager
        {
          home-manager.users.alice = {
            imports = [ web-model-bridge.homeManagerModules.default ];

            # 2. Enable the module — the package comes from pkgs via the overlay
            programs.web-model-bridge = {
              enable  = true;
              port    = 3456;        # default
              host    = "127.0.0.1"; # default
              # configFile = ./webmodel.yml;   # optional YAML config
              # extraArgs  = [ "--no-open" ];  # optional extra CLI flags
            };
          };
        }
      ];
    };
  };
}
```

The home-manager module:
- Adds `web-model-bridge` to `home.packages` (binary in `$PATH`)
- Creates a **systemd user service** (`systemctl --user start web-model-bridge`) that auto-starts the server on login

### Available module options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enable` | bool | `false` | Enable the module |
| `package` | package | `pkgs.web-model-bridge` | Override the package |
| `port` | port | `3456` | Listening port |
| `host` | string | `"127.0.0.1"` | Bind address |
| `configFile` | path \| null | `null` | Path to YAML config file |
| `extraArgs` | list of string | `[]` | Extra CLI arguments |

### Just the overlay (without home-manager)

```nix
{ nixpkgs.overlays = [ web-model-bridge.overlays.default ]; }

# then anywhere in your config:
environment.systemPackages = [ pkgs.web-model-bridge ];
```

---

## Troubleshooting


| Problem                      | Solution                                                   |
| ---------------------------- | ---------------------------------------------------------- |
| "Chrome not found"           | Install Google Chrome. Run with `-v` to see detected paths |
| "Browser not connected"      | Chrome may have crashed. Restart web-model-bridge          |
| Cookie expired               | Click **Re-login** in Dashboard — no restart needed        |
| Port 3456 in use             | Use `-p 8080` or any free port                             |
| Claude Code 404              | `ANTHROPIC_BASE_URL` must NOT end with `/v1`               |
| Cursor connection fails      | Some Cursor versions require ngrok for localhost           |
| Windows: Chrome not detected | Ensure Chrome is in default install path (Program Files)   |


## Testing

```bash
npm test              # All tests (132 passing)
npm run test:unit     # Unit tests only
npm run test:integration  # Integration tests
npm run test:coverage # Coverage report
npm run typecheck     # TypeScript strict check
```

## Development

```bash
git clone https://github.com/linuxhsj/WebModel.git
cd WebModel
npm install
npm run dev           # Start in dev mode
npm test              # Run tests
npm run build         # Build for distribution
```

## Contributing

Contributions welcome! Areas where help is needed:

- 🌐 New provider adapters
- 🧪 E2E test coverage
- 📱 Mobile-friendly Dashboard
- 🐳 Docker image
- 🔧 Real upstream API endpoint discovery

## License

[MIT](LICENSE)