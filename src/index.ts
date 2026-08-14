import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ConfigLoader } from './config.js'
import { VisionRouter } from './router.js'

export const name = 'ds-vision-plugin'
export const inject = ['tools']

export interface Config {
  configFile: string
  allowedRoots: string[]
}

export const Config: Schema<Config> = Schema.object({
  configFile: Schema.string().default('./vision.yml'),
  allowedRoots: Schema.array(Schema.string()).default([]),
})

export function apply(ctx: Context, pluginConfig: Config): void {
  const loader = new ConfigLoader(pluginConfig.configFile)
  const router = new VisionRouter(pluginConfig.allowedRoots)

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
export { VisionRouter } from './router.js'
export type { AnalyzeRequest, VisionConfig, VisionEnvelope, VisionIntent } from './types.js'
