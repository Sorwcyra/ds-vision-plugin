# ds-vision-plugin

An installable DeepSeek Harness bundle that lets a text-only DeepSeek model accept images pasted or dropped into the Web composer. A narrowly scoped Host capability bridge admits the prompt for configured routes; the plugin then reads Harness's durable attachment, sends the verified image bytes to a configured vision model or OCR engine, replaces the image block with grounded text at the official `agent/pre-step` boundary, and lets DeepSeek continue normally.

No Harness source patch is required. The bundle also keeps the explicit `vision_analyze` and `vision_status` tools for workspace files and diagnostics.

## Why this plugin

- **Native paste/drop UX:** users attach images directly in the Harness Web composer without first saving a path or naming a tool.
- **The proven `ds-vision-skill` four-model pattern:** Agnes 2.5, Agnes 2.0, GLM-4V-Flash, and GLM-4.1V-Thinking-Flash start together; the first valid response is handed to DeepSeek.
- **No GLM 4.6 dependency:** the default configuration, routing, and tests contain no `glm-4.6v-flash` route.
- **No Harness source fork:** the implementation uses a scoped Host capability bridge, durable attachments, and the official `agent/pre-step` extension.
- **Low setup friction:** the CLI creates configuration, reports channel readiness, saves masked keys on Windows, adds arbitrary OpenAI-compatible models, and verifies a real image.
- **Open-ended routing:** user models are not limited to three slots and can join either the concurrent race or ordered fallback.
- **Explicit failure behavior:** images are never silently discarded; deployments choose visible annotation or strict failure.

The four-way race can start four provider requests for each uncached image. It is recommended when latency and availability matter most. If request count, cost, or data exposure matters more, remove channels from `routing.race` or prefer local VLM/OCR routes.

## What it does

```text
Web paste/drop -> Harness attachment store -> ds-vision-plugin
               -> VLM / OCR -> text block -> text-only DeepSeek
```

- Automatic conversion for Web image attachments; default route filter: `deepseek-official`.
- Multiple images per message and images nested in tool results.
- Four-model first-success race: `agnes-2.5-flash`, `agnes-2.0-flash`, `glm-4v-flash`, and `glm-4.1v-thinking-flash`; losing requests are cancelled.
- `glm-4.6v-flash` is not used.
- Any number of user-owned OpenAI-compatible models can be added to the race or ordered fallback.
- Prompt-aware OCR routing to Baidu OCR or local Tesseract; VLM fallback if OCR is unavailable.
- Custom hosted endpoints plus local Ollama/LM Studio support.
- YAML hot reload, result caching, timeouts, size limits, and real-path confinement for the manual file tool.
- Strict failure or visible failure annotation; images are never silently dropped.
- Secrets are named by environment variable and are not returned by `vision_status`.

## Install the bundle

Requirements: Node.js 22.19+ or 24+, and DeepSeek Harness `0.1.0-rc.6` (or a compatible `0.1.x` build exposing `agents`, `attachments`, `llm`, and `tools`).

Install the current GitHub version:

```powershell
$env:npm_config_ignore_workspace_root_check = 'true'
npx -y @deepseek-ai/dsh plugin --profile web add "github:Sorwcyra/ds-vision-plugin"
```

Using the prebuilt tarball from this repository:

```powershell
$env:npm_config_ignore_workspace_root_check = 'true'
npx -y @deepseek-ai/dsh plugin --profile web add "C:\absolute\path\to\ds-vision-plugin-0.3.0.tgz"
```

If `dsh` is installed globally, `dsh plugin ...` is equivalent. Restart the running `dsh web` process after an install or update; refreshing the browser alone does not reload bundles.

Or install a local checkout:

```sh
pnpm install
pnpm run build
dsh plugin --profile web add file:/absolute/path/to/ds-vision-plugin
```

Verify that the bundle layer and `ds-vision` row are present:

```sh
dsh --profile web --dump-config
```

## Configuration CLI

After installation, create the default four-model race and inspect missing keys:

```powershell
& "$env:USERPROFILE\.dsh\profiles\web\node_modules\.bin\ds-vision.cmd" configure
& "$env:USERPROFILE\.dsh\profiles\web\node_modules\.bin\ds-vision.cmd" status
```

Save GLM or Agnes keys interactively on Windows (input is masked):

```powershell
& "$env:USERPROFILE\.dsh\profiles\web\node_modules\.bin\ds-vision.cmd" key glm
& "$env:USERPROFILE\.dsh\profiles\web\node_modules\.bin\ds-vision.cmd" key agnes-2.5-flash
```

One `GLM_API_KEY` enables both GLM models; one `AGNES_API_KEY` enables both Agnes models. Channels with missing keys are skipped immediately.

Run one live race and print the winning model:

```powershell
& "$env:USERPROFILE\.dsh\profiles\web\node_modules\.bin\ds-vision.cmd" verify --image "C:\path\test.png"
```

Add any OpenAI-compatible model without editing YAML:

```powershell
& "$env:USERPROFILE\.dsh\profiles\web\node_modules\.bin\ds-vision.cmd" add `
  --id my-vlm --base-url "https://example.com/v1/chat/completions" `
  --model "your-vision-model" --api-key-env "MY_VLM_API_KEY" --pool fallback
```

Use `--pool race` for concurrent first-success selection or `--pool fallback` for ordered use after the four defaults. The generated default is `~/.dsh/ds-vision/vision.yml`; `DS_VISION_CONFIG` can override it.

Linux/macOS:

```sh
export DS_VISION_CONFIG=/absolute/path/to/vision.yml
export GLM_API_KEY=...
export AGNES_API_KEY=...
dsh web
```

Windows PowerShell:

```powershell
$env:DS_VISION_CONFIG = 'C:\absolute\path\to\vision.yml'
$env:GLM_API_KEY = '...'
$env:AGNES_API_KEY = '...'
dsh web
```

### Automatic attachment settings

The bundle patch accepts these environment overrides:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DS_VISION_AUTO_CONVERT` | `true` | Set to `false` to disable automatic Web attachment conversion. |
| `DS_VISION_AUTO_PROVIDERS` | `deepseek-official` | Comma-separated primary provider routes. Empty in a custom patch means all providers. |
| `DS_VISION_AUTO_INTENT` | `auto` | `auto`, `reason`, or `ocr`. Auto selects OCR when the request asks for text extraction. |
| `DS_VISION_AUTO_FAILURE_MODE` | `annotate` | `annotate` replaces a failed image with a visible error marker; `error` fails the step. |

For advanced overrides (`autoPrompt`, `autoComplex`, `autoAccurateOcr`), replace the complete `ds-vision` row config in the profile's `cordis.patch.yml`; Harness patch layers replace row configs rather than deep-merging them.

## Use

Start the Web profile, choose the DeepSeek provider, paste or drop one or more PNG/JPEG/WebP/GIF images into the composer, add an optional question, and send. No path or tool name is needed. The converted visual description becomes the model-facing durable message, so the settled transcript shows the generated text rather than retaining a core image block that the text-only adapter would reject.

For a workspace file, the model can still call:

```text
vision_analyze(path, prompt, intent, complex, accurate_ocr, no_cache)
```

Use `vision_status()` to inspect effective routing and automatic-conversion status without exposing keys.

## Privacy and failure behavior

Automatic Web attachments are read only through Harness's verified private attachment service. A configured cloud channel receives the image bytes. `allowedRoots` applies to explicit file paths, not Web attachments. Use a local VLM/Tesseract or disable automatic conversion for sensitive images.

The default `annotate` mode removes an unsupported image block only after emitting a clear conversion-failure marker, allowing DeepSeek to explain the issue. Use `error` when a failed conversion must stop the request.

## Build and verify

```sh
pnpm run build
pnpm run check
pnpm run pack:check
pnpm pack --pack-destination ./artifacts
```

### Simulate the default `ds-vision-skill` race

Run the deterministic four-model Mock without provider keys:

```powershell
pnpm run build
pnpm run test:race
```

| Model | Mock latency |
| --- | ---: |
| `glm-4v-flash` | 40 ms |
| `agnes-2.5-flash` | 120 ms |
| `agnes-2.0-flash` | 160 ms |
| `glm-4.1v-thinking-flash` | 200 ms |

The test asserts that all four requests start, `glm-4v-flash` wins first-success selection, and no 4.6 model exists in the default. The full `pnpm run check` additionally covers Host image admission, attachment-to-text conversion, failure modes, arbitrary CLI-added models, and path security.

See `VERIFICATION.md` for the tested upstream commit, automated cases, package contents, and isolated Harness installation result. MIT licensed.
