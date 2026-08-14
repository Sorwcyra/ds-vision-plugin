# Changelog

## 0.4.1 - 2026-08-14

- Quickstart now leaves the Web port unspecified unless `--port` is provided, allowing DeepSeek Harness to own its configured default (currently 3080).

## 0.4.0 - 2026-08-14

- Added `ds-vision quickstart`, a one-command install, non-destructive configuration, Web startup, and browser-opening flow.
- Made no-command CLI use equivalent to `quickstart`; repeated runs reuse the installed matching version and existing configuration.
- Added safe handling for an already occupied Web port so a running service is opened instead of duplicated.
- Expanded CI compatibility coverage to Windows, Ubuntu, and macOS on Node.js 22.19 and 24.

## 0.3.0 - 2026-08-14

- Replaced the single `glm-4.6v-flash` example with the original four-model concurrent race from `ds-vision-skill`: Agnes 2.5 Flash, Agnes 2.0 Flash, GLM-4V-Flash, and GLM-4.1V-Thinking-Flash.
- Added the `ds-vision` command-line configuration helper with guided setup, masked Windows user-key storage, status reporting, and arbitrary OpenAI-compatible model addition.
- Made the default configuration location stable under `~/.dsh/ds-vision/vision.yml` while preserving the `DS_VISION_CONFIG` override.
- Added automated coverage proving that all four named models start and the first valid response wins, plus CLI custom-model coverage.

## 0.2.1 - 2026-08-14

- Added a reversible Host model-capability bridge so Harness accepts image prompts for text-only routes covered by automatic conversion.
- Fixed Web submissions being rejected with `MODEL_DOES_NOT_SUPPORT_IMAGES` before `agent/pre-step` could convert their attachments.
- Added integration coverage for capability admission, provider scoping, and restoration when the plugin unloads.

## 0.2.0 - 2026-08-14

- Added automatic Web composer image conversion at the official `agent/pre-step` boundary.
- Added direct reads from Harness's durable attachment store, including nested image handling.
- Added provider allowlisting, OCR/VLM auto-routing, strict or annotated failure modes, and status reporting.
- Added byte-based VLM and OCR routing so automatic attachments never need a user-visible file path.
- Added integration tests covering attachment conversion, provider filtering, nested blocks, and failures.

## 0.1.0 - 2026-08-14

- Initial DeepSeek Harness bundle.
- Added VLM racing and fallback routing, Baidu/Tesseract OCR, MinerU document parsing, caching, root confinement, and status diagnostics.
