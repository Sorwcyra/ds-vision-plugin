#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parse, stringify } from 'yaml'
import { parseVisionConfig } from './config.js'
import { VisionRouter } from './router.js'

interface RawChannel {
  id: string
  type?: string
  baseUrl: string
  model: string
  apiKeyEnv: string
  enabled?: boolean
  apiKeyOptional?: boolean
}

interface RawConfig {
  version: number
  routing: { race: string[]; fallback: string[] }
  channels: RawChannel[]
  [key: string]: unknown
}

const args = process.argv.slice(2)
const command = args.shift() ?? 'configure'

function option(name: string): string | undefined {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

function flag(name: string): boolean {
  return args.includes(`--${name}`)
}

function positionals(): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index]?.startsWith('--')) {
      if (args[index] !== '--set-key') index += 1
      continue
    }
    values.push(args[index] as string)
  }
  return values
}

function defaultConfigPath(): string {
  const dshHome = process.env.DSH_HOME ?? resolve(homedir(), '.dsh')
  return process.env.DS_VISION_CONFIG ?? resolve(dshHome, 'ds-vision', 'vision.yml')
}

function initialConfig(): RawConfig {
  return {
    version: 1,
    routing: {
      race: ['agnes-2.5-flash', 'agnes-2.0-flash', 'glm', 'glm-thinking'],
      fallback: [],
    },
    channels: [
      {
        id: 'agnes-2.5-flash', type: 'openai-compatible',
        baseUrl: '${AGNES_BASE_URL:-https://api.agnes-ai.cn/v1/chat/completions}',
        model: 'agnes-2.5-flash', apiKeyEnv: 'AGNES_API_KEY',
      },
      {
        id: 'agnes-2.0-flash', type: 'openai-compatible',
        baseUrl: '${AGNES_BASE_URL:-https://api.agnes-ai.cn/v1/chat/completions}',
        model: 'agnes-2.0-flash', apiKeyEnv: 'AGNES_API_KEY',
      },
      {
        id: 'glm', type: 'openai-compatible',
        baseUrl: '${GLM_BASE_URL:-https://open.bigmodel.cn/api/paas/v4/chat/completions}',
        model: 'glm-4v-flash', apiKeyEnv: 'GLM_API_KEY',
      },
      {
        id: 'glm-thinking', type: 'openai-compatible',
        baseUrl: '${GLM_BASE_URL:-https://open.bigmodel.cn/api/paas/v4/chat/completions}',
        model: 'glm-4.1v-thinking-flash', apiKeyEnv: 'GLM_API_KEY',
      },
    ],
    ocr: {
      baidu: { enabled: false, apiKeyEnv: 'BAIDU_API_KEY', secretKeyEnv: 'BAIDU_SECRET_KEY' },
      tesseract: { enabled: false, command: 'tesseract', languages: 'chi_sim+eng' },
    },
    document: { mineru: { enabled: false, command: 'mineru-open-api', mode: 'flash' } },
    limits: { maxFileBytes: 15_728_640, timeoutMs: 90_000, maxTokens: 1024 },
    cache: { enabled: true, directory: resolve(homedir(), '.dsh', 'cache', 'ds-vision'), ttlSeconds: 604_800 },
  }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

async function readRawConfig(path: string): Promise<RawConfig> {
  const value = parse(await readFile(path, 'utf8')) as RawConfig
  parseVisionConfig(stringify(value))
  return value
}

async function saveRawConfig(path: string, config: RawConfig): Promise<void> {
  parseVisionConfig(stringify(config))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, stringify(config, { lineWidth: 120 }), { encoding: 'utf8', mode: 0o600 })
}

async function ask(label: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`${label}${fallback === undefined ? '' : ` [${fallback}]`}: `)).trim()
    return answer || fallback || ''
  } finally {
    rl.close()
  }
}

async function confirm(label: string, defaultYes = true): Promise<boolean> {
  const answer = (await ask(`${label} ${defaultYes ? '[Y/n]' : '[y/N]'}`)).toLowerCase()
  return answer === '' ? defaultYes : answer === 'y' || answer === 'yes'
}

async function secret(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.stdin.setRawMode === undefined) return await ask(label)
  process.stdout.write(`${label}: `)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  return await new Promise<string>((resolvePromise, reject) => {
    let value = ''
    const finish = (error?: Error): void => {
      process.stdin.off('data', onData)
      process.stdin.setRawMode?.(false)
      process.stdin.pause()
      process.stdout.write('\n')
      if (error) reject(error)
      else resolvePromise(value)
    }
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new Error('cancelled'))
        if (byte === 13 || byte === 10) return finish()
        if (byte === 8 || byte === 127) {
          if (value.length > 0) {
            value = value.slice(0, -1)
            process.stdout.write('\b \b')
          }
          continue
        }
        value += String.fromCharCode(byte)
        process.stdout.write('*')
      }
    }
    process.stdin.on('data', onData)
  })
}

async function persistWindowsUserEnvironment(name: string, value: string): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error(`automatic user-level key storage is currently supported on Windows only; export ${name} in your shell profile`)
  }
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      windowsHide: true,
      env: { ...process.env, DS_VISION_ENV_NAME: name, DS_VISION_ENV_VALUE: value },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolvePromise() : reject(new Error(stderr || `PowerShell exited ${String(code)}`)))
    child.stdin.end("[Environment]::SetEnvironmentVariable($env:DS_VISION_ENV_NAME, $env:DS_VISION_ENV_VALUE, 'User')\n")
  })
  process.env[name] = value
}

function keyConfigured(name: string): boolean {
  return Boolean(process.env[name])
}

async function showStatus(path: string): Promise<void> {
  if (!await exists(path)) {
    console.log(`Configuration not found: ${path}`)
    console.log('Run: ds-vision configure')
    return
  }
  const config = parseVisionConfig(await readFile(path, 'utf8'))
  console.log(`Configuration: ${path}`)
  console.log(`Race: ${config.routing.race.join(' + ') || '(empty)'}`)
  console.log(`Fallback: ${config.routing.fallback.join(' -> ') || '(empty)'}`)
  for (const channel of config.channels) {
    const state = channel.enabled === false
      ? 'disabled'
      : channel.apiKeyOptional || keyConfigured(channel.apiKeyEnv) ? 'ready' : `missing ${channel.apiKeyEnv}`
    console.log(`- ${channel.id}: ${channel.model} [${state}]`)
  }
}

async function setChannelKey(configPath: string, channelId: string): Promise<void> {
  const config = await readRawConfig(configPath)
  const channel = config.channels.find(item => item.id === channelId)
  if (!channel) throw new Error(`unknown channel: ${channelId}`)
  const value = option('key') ?? await secret(`Enter ${channel.apiKeyEnv}`)
  if (!value) throw new Error('key cannot be empty')
  await persistWindowsUserEnvironment(channel.apiKeyEnv, value)
  console.log(`Saved ${channel.apiKeyEnv} to the Windows user environment (value hidden).`)
  console.log('Restart dsh web to make the new key visible to the service.')
}

async function addModel(configPath: string): Promise<void> {
  const config = await readRawConfig(configPath)
  const id = option('id') ?? await ask('Channel id')
  if (!id || config.channels.some(channel => channel.id === id)) throw new Error(`channel id is empty or already exists: ${id}`)
  const baseUrl = option('base-url') ?? await ask('Full OpenAI-compatible chat/completions URL')
  const model = option('model') ?? await ask('Model id')
  const suggestedEnv = `VISION_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
  const apiKeyEnv = option('api-key-env') ?? await ask('API key environment variable', suggestedEnv)
  const pool = option('pool') ?? (process.stdin.isTTY ? await ask('Pool: race or fallback', 'fallback') : 'fallback')
  if (!baseUrl || !model || !apiKeyEnv || !['race', 'fallback'].includes(pool)) throw new Error('invalid model options')
  config.channels.push({ id, type: 'openai-compatible', baseUrl, model, apiKeyEnv })
  config.routing[pool as 'race' | 'fallback'].push(id)
  await saveRawConfig(configPath, config)
  console.log(`Added ${id} to ${pool}: ${configPath}`)
  if (flag('set-key') || (process.stdin.isTTY && await confirm(`Set ${apiKeyEnv} now?`, false))) {
    await setChannelKey(configPath, id)
  }
}

async function configure(configPath: string): Promise<void> {
  if (!await exists(configPath)) {
    await saveRawConfig(configPath, initialConfig())
    console.log(`Created four-model race configuration: ${configPath}`)
  } else {
    console.log(`Keeping existing configuration: ${configPath}`)
  }
  await showStatus(configPath)
  if (!process.stdin.isTTY) return
  if (!keyConfigured('GLM_API_KEY') && await confirm('Configure GLM_API_KEY now?', false)) {
    await setChannelKey(configPath, 'glm')
  }
  if (!keyConfigured('AGNES_API_KEY') && await confirm('Configure AGNES_API_KEY now?', false)) {
    await setChannelKey(configPath, 'agnes-2.5-flash')
  }
  if (await confirm('Add another OpenAI-compatible vision model?', false)) await addModel(configPath)
  console.log('Configuration complete. Restart dsh web, paste an image, and send it normally.')
}

async function verify(configPath: string): Promise<void> {
  const image = option('image')
  if (!image) throw new Error('verify requires --image PATH')
  const absoluteImage = resolve(image)
  const config = parseVisionConfig(await readFile(configPath, 'utf8'))
  const result = await new VisionRouter([dirname(absoluteImage)]).analyze({
    path: absoluteImage,
    prompt: option('prompt') ?? 'Describe this image accurately and briefly.',
    intent: 'reason',
    complex: flag('complex'),
    accurateOcr: false,
    noCache: flag('no-cache'),
  }, config, new AbortController().signal)
  console.log(`Winner: ${result.tool_used}`)
  console.log(`Confidence: ${result.confidence}`)
  console.log(result.result)
}

function help(): void {
  console.log(`ds-vision configuration helper

  ds-vision configure [--config PATH]               create/inspect the four-model race
  ds-vision status [--config PATH]                  show configured and missing channels
  ds-vision key CHANNEL [--key VALUE]               save a channel key (interactive recommended)
  ds-vision add [--id ID --base-url URL --model M]  add any OpenAI-compatible model
                [--api-key-env NAME] [--pool race|fallback] [--set-key]
  ds-vision verify --image PATH [--complex]          run one real first-success race

Default race: agnes-2.5-flash + agnes-2.0-flash + glm-4v-flash + glm-4.1v-thinking-flash
The obsolete glm-4.6v-flash route is not used.`)
}

async function main(): Promise<void> {
  const configPath = resolve(option('config') ?? defaultConfigPath())
  if (command === 'configure' || command === 'init') await configure(configPath)
  else if (command === 'status') await showStatus(configPath)
  else if (command === 'key') await setChannelKey(configPath, positionals()[0] ?? '')
  else if (command === 'add') await addModel(configPath)
  else if (command === 'verify') await verify(configPath)
  else if (command === 'help' || command === '--help' || command === '-h') help()
  else throw new Error(`unknown command: ${command}`)
}

main().catch((error: unknown) => {
  console.error(`ds-vision: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
