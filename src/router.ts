import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  AnalyzeRequest,
  ChannelAttempt,
  ChannelConfig,
  VisionConfig,
  VisionEnvelope,
  VisionIntent,
} from './types.js'

const IMAGE_MIME = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.bmp', 'image/bmp'],
  ['.tif', 'image/tiff'], ['.tiff', 'image/tiff'],
])
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx'])

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortSignal(parent: AbortSignal, timeoutMs: number, local?: AbortSignal): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(timeoutMs), ...(local === undefined ? [] : [local])])
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

async function resolveInput(input: string, allowedRoots: readonly string[]): Promise<string> {
  const candidate = await realpath(resolve(process.cwd(), input))
  const roots = await Promise.all(allowedRoots.map(root => realpath(resolve(root))))
  if (!roots.some(root => within(root, candidate))) {
    throw new Error(`input is outside allowedRoots: ${candidate}`)
  }
  const info = await stat(candidate)
  if (!info.isFile()) throw new Error(`input is not a regular file: ${candidate}`)
  return candidate
}

function contentFromResponse(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (Array.isArray(value)) {
    const text = value.flatMap(item => {
      if (item !== null && typeof item === 'object' && 'text' in item && typeof item.text === 'string') return [item.text]
      return []
    }).join('\n')
    return text.trim() === '' ? undefined : text
  }
  return undefined
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(value), 'utf8')
  await rename(temp, path)
}

async function cached(config: VisionConfig, key: string): Promise<VisionEnvelope | undefined> {
  if (!config.cache.enabled) return undefined
  const path = join(config.cache.directory, `${key}.json`)
  try {
    const info = await stat(path)
    if (Date.now() - info.mtimeMs > config.cache.ttlSeconds * 1000) return undefined
    return JSON.parse(await readFile(path, 'utf8')) as VisionEnvelope
  } catch {
    return undefined
  }
}

async function saveCache(config: VisionConfig, key: string, value: VisionEnvelope): Promise<void> {
  if (!config.cache.enabled) return
  await atomicJson(join(config.cache.directory, `${key}.json`), value)
}

async function callVisionChannel(
  channel: ChannelConfig,
  file: string,
  bytes: Buffer,
  prompt: string,
  maxTokens: number,
  config: VisionConfig,
  noCache: boolean,
  signal: AbortSignal,
): Promise<VisionEnvelope> {
  if (channel.enabled === false) throw new Error('disabled')
  const apiKey = process.env[channel.apiKeyEnv]
  if (!channel.apiKeyOptional && !apiKey) throw new Error(`missing environment variable ${channel.apiKeyEnv}`)
  const mime = IMAGE_MIME.get(extname(file).toLowerCase())
  if (mime === undefined) throw new Error(`unsupported image extension: ${extname(file)}`)
  const hash = createHash('sha256').update(bytes).digest('hex')
  const cacheKey = createHash('sha256').update(JSON.stringify([
    1, hash, prompt, channel.id, channel.model, channel.baseUrl, channel.maxTokens ?? maxTokens,
  ])).digest('hex')
  const hit = noCache ? undefined : await cached(config, cacheKey)
  if (hit !== undefined) return { ...hit, metadata: { ...hit.metadata, cached: true } }

  const started = Date.now()
  const response = await fetch(channel.baseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...channel.headers,
    },
    body: JSON.stringify({
      model: channel.model,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } },
        { type: 'text', text: prompt },
      ] }],
      max_tokens: channel.maxTokens ?? maxTokens,
    }),
    signal: abortSignal(signal, channel.timeoutMs ?? config.limits.timeoutMs),
  })
  const responseText = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${responseText.slice(0, 300)}`)
  let body: unknown
  try { body = JSON.parse(responseText) } catch { throw new Error('provider returned invalid JSON') }
  const record = body as { choices?: Array<{ message?: { content?: unknown } }> }
  const result = contentFromResponse(record.choices?.[0]?.message?.content)
  if (result === undefined) throw new Error('provider returned empty content')
  const envelope: VisionEnvelope = {
    task_type: 'image_reasoning',
    tool_used: `${channel.id}:${channel.model}`,
    confidence: 'high',
    result,
    metadata: {
      channel: channel.id,
      model: channel.model,
      image_sha256: hash,
      bytes: bytes.length,
      latency_ms: Date.now() - started,
      cached: false,
    },
  }
  if (!noCache) await saveCache(config, cacheKey, envelope)
  return envelope
}

async function raceChannels(
  channels: ChannelConfig[],
  file: string,
  bytes: Buffer,
  prompt: string,
  maxTokens: number,
  config: VisionConfig,
  noCache: boolean,
  signal: AbortSignal,
): Promise<{ envelope?: VisionEnvelope; attempts: ChannelAttempt[] }> {
  const attempts: ChannelAttempt[] = []
  const controllers = channels.map(() => new AbortController())
  const pending = channels.map(async (channel, index) => {
    const started = Date.now()
    try {
      const localSignal = controllers[index]?.signal
      const envelope = await callVisionChannel(
        channel, file, bytes, prompt, maxTokens, config, noCache,
        localSignal === undefined ? signal : AbortSignal.any([signal, localSignal]),
      )
      attempts.push({ channel: channel.id, ok: true, latencyMs: Date.now() - started })
      return envelope
    } catch (error) {
      attempts.push({ channel: channel.id, ok: false, latencyMs: Date.now() - started, error: errorText(error) })
      throw error
    }
  })
  try {
    const envelope = await Promise.any(pending)
    for (const controller of controllers) controller.abort()
    return { envelope, attempts }
  } catch {
    return { attempts }
  }
}

async function runCommand(command: string, args: string[], signal: AbortSignal, timeoutMs: number): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, signal })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { if (stdout.length < 8_000_000) stdout += chunk })
    child.stderr.on('data', chunk => { if (stderr.length < 1_000_000) stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(stdout)
      else reject(new Error(`${command} exited ${String(code)}: ${stderr.slice(-600)}`))
    })
  })
}

async function baiduOcr(file: string, config: VisionConfig, accurate: boolean, signal: AbortSignal): Promise<VisionEnvelope> {
  const options = config.ocr.baidu
  if (options === undefined || !options.enabled) throw new Error('Baidu OCR is disabled')
  const apiKey = process.env[options.apiKeyEnv]
  const secret = process.env[options.secretKeyEnv]
  if (!apiKey || !secret) throw new Error(`missing ${options.apiKeyEnv} or ${options.secretKeyEnv}`)
  const tokenUrl = new URL('https://aip.baidubce.com/oauth/2.0/token')
  tokenUrl.searchParams.set('grant_type', 'client_credentials')
  tokenUrl.searchParams.set('client_id', apiKey)
  tokenUrl.searchParams.set('client_secret', secret)
  const tokenResponse = await fetch(tokenUrl, { method: 'POST', signal: abortSignal(signal, config.limits.timeoutMs) })
  const tokenBody = await tokenResponse.json() as { access_token?: string; error_description?: string }
  if (!tokenResponse.ok || !tokenBody.access_token) throw new Error(tokenBody.error_description ?? `token HTTP ${tokenResponse.status}`)
  const endpoint = accurate ? 'accurate_basic' : 'general_basic'
  const body = new URLSearchParams({ image: (await readFile(file)).toString('base64') })
  const response = await fetch(`https://aip.baidubce.com/rest/2.0/ocr/v1/${endpoint}?access_token=${encodeURIComponent(tokenBody.access_token)}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
    signal: abortSignal(signal, config.limits.timeoutMs),
  })
  const payload = await response.json() as { words_result?: Array<{ words?: string }>; error_msg?: string }
  if (!response.ok || !payload.words_result) throw new Error(payload.error_msg ?? `OCR HTTP ${response.status}`)
  return {
    task_type: 'ocr', tool_used: `baidu-ocr:${endpoint}`, confidence: 'high',
    result: payload.words_result.flatMap(item => item.words ? [item.words] : []).join('\n'),
    metadata: { lines: payload.words_result.length, input: basename(file) },
  }
}

async function localOcr(file: string, config: VisionConfig, signal: AbortSignal): Promise<VisionEnvelope> {
  const options = config.ocr.tesseract
  if (options === undefined || !options.enabled) throw new Error('Tesseract OCR is disabled')
  const result = (await runCommand(options.command, [file, 'stdout', '-l', options.languages], signal, config.limits.timeoutMs)).trim()
  if (result === '') throw new Error('Tesseract returned no text')
  return {
    task_type: 'ocr', tool_used: `tesseract:${options.languages}`, confidence: 'medium', result,
    metadata: { input: basename(file), local: true },
  }
}

async function findMarkdown(root: string): Promise<string | undefined> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = await findMarkdown(path)
      if (nested !== undefined) return nested
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) return path
  }
  return undefined
}

async function parseDocument(file: string, config: VisionConfig, signal: AbortSignal): Promise<VisionEnvelope> {
  const options = config.document.mineru
  if (options === undefined || !options.enabled) throw new Error('MinerU document parsing is disabled')
  const output = join(tmpdir(), `ds-vision-mineru-${createHash('sha256').update(file).digest('hex').slice(0, 12)}`)
  await mkdir(output, { recursive: true })
  const existing = await findMarkdown(output)
  if (existing === undefined) {
    const args = options.mode === 'flash'
      ? ['flash-extract', file, '-o', output]
      : ['extract', file, '-o', output, '-f', 'md']
    await runCommand(options.command, args, signal, config.limits.timeoutMs)
  }
  const markdown = await findMarkdown(output)
  if (markdown === undefined) throw new Error('MinerU produced no Markdown')
  const result = await readFile(markdown, 'utf8')
  return {
    task_type: 'document_parsing', tool_used: `mineru:${options.mode}`, confidence: 'high', result,
    metadata: { input: basename(file), output: markdown, chars: result.length },
  }
}

function chooseIntent(intent: VisionIntent, file: string, prompt: string, accurateOcr: boolean): Exclude<VisionIntent, 'auto'> {
  if (intent !== 'auto') return intent
  const extension = extname(file).toLowerCase()
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document'
  if (accurateOcr || /\bocr\b|文字识别|提取文字/i.test(prompt)) return 'ocr'
  return 'reason'
}

export class VisionRouter {
  constructor(private readonly allowedRoots: readonly string[]) {}

  async analyze(request: AnalyzeRequest, config: VisionConfig, signal: AbortSignal): Promise<VisionEnvelope> {
    const file = await resolveInput(request.path, this.allowedRoots.length > 0 ? this.allowedRoots : [process.cwd()])
    const info = await stat(file)
    if (info.size > config.limits.maxFileBytes) {
      throw new Error(`file exceeds maxFileBytes (${info.size} > ${config.limits.maxFileBytes})`)
    }
    const intent = chooseIntent(request.intent, file, request.prompt, request.accurateOcr)
    const attempts: unknown[] = []
    if (intent === 'document') {
      try { return await parseDocument(file, config, signal) } catch (error) {
        attempts.push({ tool: 'mineru', error: errorText(error) })
        if (!IMAGE_MIME.has(extname(file).toLowerCase())) {
          throw new Error(`document parsing failed: ${JSON.stringify(attempts)}`)
        }
      }
    }
    if (intent === 'ocr' || intent === 'document') {
      try { return await baiduOcr(file, config, request.accurateOcr, signal) } catch (error) {
        attempts.push({ tool: 'baidu-ocr', error: errorText(error) })
      }
      try { return await localOcr(file, config, signal) } catch (error) {
        attempts.push({ tool: 'tesseract', error: errorText(error) })
      }
    }

    const bytes = await readFile(file)
    const byId = new Map(config.channels.map(channel => [channel.id, channel]))
    const race = config.routing.race.flatMap(id => byId.get(id) ?? [])
    if (race.length > 0) {
      const raced = await raceChannels(
        race, file, bytes, request.prompt, request.complex ? Math.max(2048, config.limits.maxTokens) : config.limits.maxTokens,
        config, request.noCache, signal,
      )
      attempts.push(...raced.attempts)
      if (raced.envelope !== undefined) {
        raced.envelope.metadata.race = { mode: 'first-success', attempts: raced.attempts }
        return raced.envelope
      }
    }
    for (const id of config.routing.fallback) {
      const channel = byId.get(id)
      if (channel === undefined) continue
      const started = Date.now()
      try {
        const result = await callVisionChannel(
          channel, file, bytes, request.prompt,
          request.complex ? Math.max(2048, config.limits.maxTokens) : config.limits.maxTokens,
          config, request.noCache, signal,
        )
        result.metadata.attempts = attempts
        return result
      } catch (error) {
        attempts.push({ channel: id, ok: false, latencyMs: Date.now() - started, error: errorText(error) })
      }
    }
    throw new Error(`no vision route succeeded: ${JSON.stringify(attempts)}`)
  }
}
