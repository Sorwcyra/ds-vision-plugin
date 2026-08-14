# Verification report

Date: 2026-08-14

## Compatibility basis

- Official DeepSeek Harness source audited at commit `47f943859bef60e4160492346772ded9b24f765a` from `deepseek-ai/deepseek-harness`.
- The four default visual routes and endpoints were cross-checked against `Sorwcyra/ds-vision-skill` commit `5c150b9103be3962d442c624ffeae73f6077df27`.
- The implementation uses the documented `agent/pre-step` waterfall and `ctx.attachments.readImage()` service. Because the Host API checks `inputModalities` before persisting a prompt, a reversible provider-scoped wrapper on `ctx.llm.resolveModelInfo()` admits images only where automatic conversion is enabled. The official DeepSeek adapter still rejects any remaining core image block with `UNSUPPORTED_CONTENT`.
- Type checking and integration tests use the published `0.1.0-rc.6` packages for `dsh-agent`, `dsh-attachment`, `dsh-llm`, and `dsh-tools` with Cordis `4.0.1`.

## Automated verification

`pnpm run check` completes successfully. It runs strict TypeScript checking and 12 Node tests covering:

1. OpenAI-compatible image request serialization and successful text extraction.
2. Automatic replacement of a pasted Web attachment at its original content position.
3. Preservation of message identity, source, and accompanying user text.
4. Provider allowlisting: multimodal routes remain untouched while `deepseek-official` is converted.
5. Nested image conversion inside tool-result content.
6. Visible failure annotation with no image block leaked to the text-only adapter.
7. Strict runtime failure mode.
8. Loading through a real Cordis `Context`, provider-scoped Host image admission, registration of both tools, and execution of the real `agent/pre-step` waterfall.
9. YAML parsing, environment interpolation, and invalid-route rejection.
10. Manual file-tool root confinement.
11. Concurrent start of all four named default models, cancellation after the first valid response, and absence of `glm-4.6v-flash`.
12. CLI creation of the default race plus addition of an arbitrary user-owned OpenAI-compatible fallback model.

All 12 tests pass with zero failures, skips, or cancellations.

## Bundle verification

- `pnpm run pack:check` succeeds and lists only the declared runtime artifacts and documentation.
- `pnpm pack --pack-destination ./artifacts` produces `artifacts/ds-vision-plugin-0.3.0.tgz`.
- The tarball was installed into an isolated `DSH_HOME` using the official source CLI. The generated profile declares `ds-vision-plugin: 0.3.0` and appends `ds-vision-plugin` after `@deepseek-ai/dsh-base` in `dsh.profile.bundles`.
- `dsh --profile vision-e2e --dump-config` contains the `ds-vision` row plus `autoConvert`, `autoProviders`, `autoIntent`, and `autoFailureMode`.
- Importing `ds-vision-plugin` from the isolated installed profile succeeds and exposes `apply`, `rewriteAttachedImages`, and `VisionRouter`.

## Real Host admission verification

- An isolated official `dsh web` profile was started on a separate local port with the `0.2.1` bundle and a local OpenAI-compatible mock VLM.
- A real `session.create` selected `deepseek-official` / `deepseek-v4-flash`, whose adapter declares text-only input.
- A real `session.prompt` containing the supplied PNG returned `{ ok: true, value: { accepted: true } }`; the previous `MODEL_DOES_NOT_SUPPORT_IMAGES` response did not occur.
- The mock VLM independently recorded `request:image=true`, proving that the admitted durable attachment reached the automatic conversion backend before the DeepSeek call.

## External-service boundary

Automated tests use local mock OpenAI-compatible VLMs. In addition, the supplied screenshot was sent once through the configured real four-model race with cache bypassed; `glm:glm-4v-flash` returned the first valid result in 4.6 seconds and correctly identified the visible Harness image-support warning. The race configuration contained Agnes 2.5 Flash, Agnes 2.0 Flash, GLM-4V-Flash, and GLM-4.1V-Thinking-Flash; it contained no GLM 4.6 model.
