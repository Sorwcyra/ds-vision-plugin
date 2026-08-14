import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { parse } from 'yaml'
import type { ChannelConfig, VisionConfig } from './types.js'

const ENV_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)(?::-(.*?))?\}/g

function interpolate(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_PATTERN, (_whole, name: string, fallback: string | undefined) => {
      return process.env[name] ?? fallback ?? ''
    })
  }
  if (Array.isArray(value)) return value.map(interpolate)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, interpolate(entry)]))
  }
  return value
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  return value
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`)
  return value as number
}

function stringList(value: unknown, fallback: string[], label: string): string[] {
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${label} must be a list of non-empty strings`)
  }
  return [...value]
}

function parseChannel(value: unknown, index: number): ChannelConfig {
  const item = object(value, `channels[${index}]`)
  const type = item.type ?? 'openai-compatible'
  const enabled = item.enabled !== false
  if (type !== 'openai-compatible') throw new Error(`channels[${index}].type is unsupported: ${String(type)}`)
  const headers = item.headers === undefined ? undefined : object(item.headers, `channels[${index}].headers`)
  if (headers !== undefined && Object.values(headers).some(entry => typeof entry !== 'string')) {
    throw new Error(`channels[${index}].headers values must be strings`)
  }
  return {
    id: text(item.id, `channels[${index}].id`),
    type,
    // Disabled template slots may intentionally reference unset environment
    // variables. They become strict as soon as the channel is enabled.
    baseUrl: enabled ? text(item.baseUrl, `channels[${index}].baseUrl`) : String(item.baseUrl || 'http://disabled.invalid'),
    model: enabled ? text(item.model, `channels[${index}].model`) : String(item.model || 'disabled'),
    apiKeyEnv: text(item.apiKeyEnv ?? 'VISION_API_KEY', `channels[${index}].apiKeyEnv`),
    ...(item.apiKeyOptional === true ? { apiKeyOptional: true } : {}),
    ...(!enabled ? { enabled: false } : {}),
    ...(headers !== undefined ? { headers: headers as Record<string, string> } : {}),
    ...(item.timeoutMs !== undefined ? { timeoutMs: positiveInteger(item.timeoutMs, 0, `channels[${index}].timeoutMs`) } : {}),
    ...(item.maxTokens !== undefined ? { maxTokens: positiveInteger(item.maxTokens, 0, `channels[${index}].maxTokens`) } : {}),
  }
}

export function parseVisionConfig(input: string): VisionConfig {
  const root = object(interpolate(parse(input)), 'config')
  if (root.version !== 1) throw new Error('config.version must be 1')
  if (!Array.isArray(root.channels)) throw new Error('config.channels must be a list')
  const channels = root.channels.map(parseChannel)
  const ids = new Set<string>()
  for (const channel of channels) {
    if (ids.has(channel.id)) throw new Error(`duplicate channel id: ${channel.id}`)
    ids.add(channel.id)
  }

  const routing = object(root.routing ?? {}, 'routing')
  const ocr = object(root.ocr ?? {}, 'ocr')
  const document = object(root.document ?? {}, 'document')
  const limits = object(root.limits ?? {}, 'limits')
  const cache = object(root.cache ?? {}, 'cache')
  const baidu = ocr.baidu === undefined ? undefined : object(ocr.baidu, 'ocr.baidu')
  const tesseract = ocr.tesseract === undefined ? undefined : object(ocr.tesseract, 'ocr.tesseract')
  const mineru = document.mineru === undefined ? undefined : object(document.mineru, 'document.mineru')

  const race = stringList(routing.race, [], 'routing.race')
  const fallback = stringList(routing.fallback, [], 'routing.fallback')
  for (const id of [...race, ...fallback]) {
    if (!ids.has(id)) throw new Error(`routing references unknown channel: ${id}`)
  }

  const cacheDirectory = text(cache.directory ?? '.ds-vision-cache', 'cache.directory')
  return {
    version: 1,
    routing: { race, fallback },
    channels,
    ocr: {
      ...(baidu !== undefined ? { baidu: {
        enabled: baidu.enabled === true,
        apiKeyEnv: text(baidu.apiKeyEnv ?? 'BAIDU_API_KEY', 'ocr.baidu.apiKeyEnv'),
        secretKeyEnv: text(baidu.secretKeyEnv ?? 'BAIDU_SECRET_KEY', 'ocr.baidu.secretKeyEnv'),
      } } : {}),
      ...(tesseract !== undefined ? { tesseract: {
        enabled: tesseract.enabled !== false,
        command: text(tesseract.command ?? 'tesseract', 'ocr.tesseract.command'),
        languages: text(tesseract.languages ?? 'eng', 'ocr.tesseract.languages'),
      } } : {}),
    },
    document: {
      ...(mineru !== undefined ? { mineru: {
        enabled: mineru.enabled !== false,
        command: text(mineru.command ?? 'mineru-open-api', 'document.mineru.command'),
        mode: mineru.mode === 'extract' ? 'extract' : 'flash',
      } } : {}),
    },
    limits: {
      maxFileBytes: positiveInteger(limits.maxFileBytes, 15 * 1024 * 1024, 'limits.maxFileBytes'),
      timeoutMs: positiveInteger(limits.timeoutMs, 90_000, 'limits.timeoutMs'),
      maxTokens: positiveInteger(limits.maxTokens, 1024, 'limits.maxTokens'),
    },
    cache: {
      enabled: cache.enabled !== false,
      directory: isAbsolute(cacheDirectory) ? cacheDirectory : resolve(process.cwd(), cacheDirectory),
      ttlSeconds: positiveInteger(cache.ttlSeconds, 7 * 24 * 60 * 60, 'cache.ttlSeconds'),
    },
  }
}

export class ConfigLoader {
  private lastMtimeMs = -1
  private current?: VisionConfig

  constructor(readonly path: string) {}

  async load(): Promise<VisionConfig> {
    const info = await stat(this.path)
    if (this.current !== undefined && info.mtimeMs === this.lastMtimeMs) return this.current
    const next = parseVisionConfig(await readFile(this.path, 'utf8'))
    this.current = next
    this.lastMtimeMs = info.mtimeMs
    return next
  }
}
