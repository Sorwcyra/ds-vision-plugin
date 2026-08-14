# ds-vision-plugin

An installable vision plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It registers native `vision_analyze` and `vision_status` tools so a text-only primary model can turn workspace images, scans, charts, UI screenshots, and documents into grounded text before continuing its reasoning.

## Features

- First-success racing across OpenAI-compatible VLMs, followed by ordered fallbacks.
- Custom endpoints and local Ollama/LM Studio support.
- Baidu OCR, local Tesseract OCR, and MinerU document parsing.
- Reloaded YAML configuration, caching, timeouts, file limits, and real-path root confinement.
- A stable JSON envelope with `task_type`, `tool_used`, `confidence`, `result`, and `metadata`.
- Secrets are referenced by environment-variable name and never returned by `vision_status`.

## Install

Requires Node.js 22.19+ or 24+ and a compatible DeepSeek Harness 0.1.x release.

For end users, the recommended path is [`ds-harness-docker`](https://github.com/Sorwcyra/ds-harness-docker), which embeds a pinned revision of this plugin. To add the plugin to an existing Harness profile directly:

```sh
dsh plugin --profile web add github:Sorwcyra/ds-vision-plugin#59eec2f17ef2918f46d94e66537035d835013116
```

For a local development checkout:

```sh
pnpm install
pnpm run build
dsh plugin --profile web add file:/absolute/path/to/ds-vision-plugin
dsh web --dump-config
```

Copy `config.example.yml` to `vision.yml`, then set `DS_VISION_CONFIG`, `DS_VISION_ALLOWED_ROOTS`, and at least one provider key. Edit the YAML to enable custom or local channels. Put only environment-variable names in `apiKeyEnv`; never commit keys.

Ask the agent to inspect a path such as `/workspace/chart.png`. Use `vision_status()` for secret-free diagnostics.

DeepSeek's text-only route cannot directly accept composer image attachments. This plugin implements the safe file-path → vision tool → text → DeepSeek path. Harness native attachments and `read_image` continue to work when the selected primary route truly supports image input, and other Harness vision plugins can coexist normally.

## Verify

```sh
pnpm run build
pnpm run check
npm pack --dry-run
```

Built `dist/` files are committed so a Git checkout does not need an install-time `prepare` script. Pin remote installs to a tag or commit. MIT licensed.
