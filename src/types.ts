export type VisionIntent = 'auto' | 'reason' | 'ocr' | 'document'
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export interface ChannelConfig {
  id: string
  type: 'openai-compatible'
  baseUrl: string
  model: string
  apiKeyEnv: string
  apiKeyOptional?: boolean
  enabled?: boolean
  headers?: Record<string, string>
  timeoutMs?: number
  maxTokens?: number
}

export interface VisionConfig {
  version: 1
  routing: {
    race: string[]
    fallback: string[]
  }
  channels: ChannelConfig[]
  ocr: {
    baidu?: {
      enabled: boolean
      apiKeyEnv: string
      secretKeyEnv: string
    }
    tesseract?: {
      enabled: boolean
      command: string
      languages: string
    }
  }
  document: {
    mineru?: {
      enabled: boolean
      command: string
      mode: 'flash' | 'extract'
    }
  }
  limits: {
    maxFileBytes: number
    timeoutMs: number
    maxTokens: number
  }
  cache: {
    enabled: boolean
    directory: string
    ttlSeconds: number
  }
}

export interface VisionEnvelope {
  task_type: 'image_reasoning' | 'document_parsing' | 'ocr'
  tool_used: string
  confidence: 'high' | 'medium' | 'low'
  result: string
  metadata: Record<string, unknown>
}

export interface AnalyzeRequest {
  path: string
  prompt: string
  intent: VisionIntent
  complex: boolean
  accurateOcr: boolean
  noCache: boolean
}

export interface AnalyzeImageRequest extends Omit<AnalyzeRequest, 'path' | 'intent'> {
  data: Uint8Array
  mediaType: ImageMediaType
  name?: string
  intent: Exclude<VisionIntent, 'document'>
}

export interface ChannelAttempt {
  channel: string
  ok: boolean
  latencyMs: number
  error?: string
}
