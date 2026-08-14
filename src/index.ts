import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { contentHasImage } from '@deepseek-ai/dsh-llm'
import { installImageAdmissionBridge } from './admission.js'
import { rewriteAttachedImages } from './auto.js'
import { ConfigLoader } from './config.js'
import { VisionRouter } from './router.js'

export const name = 'ds-vision-plugin'
export const inject = ['tools', 'agents', 'attachments', 'llm']

export interface Config {
  configFile: string
  allowedRoots: string[]
  autoConvert: boolean
  autoProviders: string[]
  autoIntent: 'auto' | 'reason' | 'ocr'
  autoPrompt: string
  autoComplex: boolean
  autoAccurateOcr: boolean
  autoFailureMode: 'error' | 'annotate'
}

export const Config: Schema<Config> = Schema.object({
  configFile: Schema.string().default('./vision.yml'),
  allowedRoots: Schema.array(Schema.string()).default([]),
  autoConvert: Schema.boolean().default(true),
  autoProviders: Schema.array(Schema.string()).default(['deepseek-official']),
  autoIntent: Schema.union(['auto', 'reason', 'ocr']).default('auto'),
  autoPrompt: Schema.string().default('Describe the image faithfully and in enough detail for a text-only reasoning model. Extract visible text, code, labels, values, layout, and relevant visual relationships. Do not answer the user; only convert the visual evidence into grounded text.'),
  autoComplex: Schema.boolean().default(true),
  autoAccurateOcr: Schema.boolean().default(false),
  autoFailureMode: Schema.union(['error', 'annotate']).default('annotate'),
})

export function apply(ctx: Context, pluginConfig: Config): void {
  const loader = new ConfigLoader(pluginConfig.configFile)
  const router = new VisionRouter(pluginConfig.allowedRoots)

  if (pluginConfig.autoConvert) {
    ctx.effect(() => installImageAdmissionBridge(ctx, pluginConfig.autoProviders), 'ds-vision-plugin.image-admission')
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || !pluginConfig.autoConvert) return decision
    if (pluginConfig.autoProviders.length > 0
      && (agent.options.provider === undefined || !pluginConfig.autoProviders.includes(agent.options.provider))) {
      return decision
    }
    if (!decision.messages.some(message => contentHasImage(message.content))) return decision
    const config = await loader.load()
    const messages = await rewriteAttachedImages(
      decision.messages,
      ctx.attachments,
      router,
      config,
      {
        intent: pluginConfig.autoIntent,
        prompt: pluginConfig.autoPrompt,
        complex: pluginConfig.autoComplex,
        accurateOcr: pluginConfig.autoAccurateOcr,
        failureMode: pluginConfig.autoFailureMode,
      },
      signal,
    )
    return { kind: 'enter', messages }
  }, { prepend: true })

  ctx.tools.register(defineTool({
    name: 'vision_analyze',
    description: 'Analyze an image, screenshot, scan, chart, UI, or document by file path. Use this whenever the selected text model needs visual understanding or OCR. The tool routes to configured VLM/OCR/document providers and returns grounded text for further reasoning.',
    parameters: {
      path: { type: 'string', required: true, description: 'File path inside an allowed workspace root.' },
      prompt: { type: 'string', description: 'What to inspect or extract from the visual input.' },
      intent: { type: 'string', enum: ['auto', 'reason', 'ocr', 'document'], description: 'Routing intent; auto detects from file and prompt.' },
      complex: { type: 'boolean', description: 'Use a larger output budget for charts, math, code screenshots, or complex UI.' },
      accurate_ocr: { type: 'boolean', description: 'Prefer high-accuracy OCR for scans, receipts, and low-quality text.' },
      no_cache: { type: 'boolean', description: 'Bypass the result cache.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const config = await loader.load()
      const result = await router.analyze({
        path: args.path,
        prompt: args.prompt ?? 'Analyze this visual input and return the useful content.',
        intent: args.intent ?? 'auto',
        complex: args.complex ?? false,
        accurateOcr: args.accurate_ocr ?? false,
        noCache: args.no_cache ?? false,
      }, config, exec.signal)
      return JSON.stringify(result)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_status',
    description: 'Inspect ds-vision-plugin configuration and channel availability without revealing secrets. Use this to diagnose why image recognition is unavailable.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const config = await loader.load()
      return JSON.stringify({
        config_file: pluginConfig.configFile,
        allowed_roots: pluginConfig.allowedRoots.length > 0 ? pluginConfig.allowedRoots : [process.cwd()],
        automatic_web_attachments: {
          enabled: pluginConfig.autoConvert,
          providers: pluginConfig.autoProviders.length > 0 ? pluginConfig.autoProviders : ['*'],
          intent: pluginConfig.autoIntent,
          failure_mode: pluginConfig.autoFailureMode,
        },
        channels: config.channels.map(channel => ({
          id: channel.id,
          enabled: channel.enabled !== false,
          configured: channel.apiKeyOptional === true || Boolean(process.env[channel.apiKeyEnv]),
          model: channel.model,
          base_url: channel.baseUrl,
          api_key_env: channel.apiKeyEnv,
        })),
        routing: config.routing,
        ocr: {
          baidu: Boolean(config.ocr.baidu?.enabled),
          tesseract: Boolean(config.ocr.tesseract?.enabled),
        },
        document: { mineru: Boolean(config.document.mineru?.enabled) },
      })
    },
  }))
}

export { parseVisionConfig } from './config.js'
export { installImageAdmissionBridge } from './admission.js'
export { rewriteAttachedImages } from './auto.js'
export { VisionRouter } from './router.js'
export type { AnalyzeImageRequest, AnalyzeRequest, VisionConfig, VisionEnvelope, VisionIntent } from './types.js'
