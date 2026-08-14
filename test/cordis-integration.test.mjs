import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../dist/index.mjs'

test('loads as a real Cordis plugin and rewrites the pre-step waterfall', async t => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ choices: [{ message: { content: 'Cordis integration recognized the image.' } }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  assert.equal(typeof address, 'object')
  process.env.TEST_CORDIS_VISION_KEY = 'secret'

  const root = await mkdtemp(join(tmpdir(), 'ds-vision-cordis-test-'))
  const configFile = join(root, 'vision.yml')
  await writeFile(configFile, `
version: 1
routing: { race: [mock], fallback: [] }
channels:
  - id: mock
    baseUrl: http://127.0.0.1:${address.port}/v1/chat/completions
    model: mock-vl
    apiKeyEnv: TEST_CORDIS_VISION_KEY
cache: { enabled: false, directory: ${JSON.stringify(join(root, 'cache'))} }
`)
  const ref = {
    attachmentId: `sha256:${'e'.repeat(64)}`,
    mediaType: 'image/png', bytes: 8, width: 1, height: 1, name: 'cordis.png',
  }
  const ctx = new Context()
  const tools = []
  const textOnlyModel = {
    provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash',
    inputModalities: ['text'], context: { contextWindow: 128_000 },
  }
  const llm = {
    async resolveModelInfo(provider, model) {
      return { ...textOnlyModel, provider, id: model }
    },
  }
  ctx.provide('agents', {})
  ctx.provide('tools', { register: tool => void tools.push(tool) })
  ctx.provide('llm', llm)
  ctx.provide('attachments', {
    imageLimits: {},
    async readImage() {
      return { ref, data: Buffer.from('89504e470d0a1a0a', 'hex') }
    },
  })
  await ctx.plugin(plugin, {
    configFile,
    allowedRoots: [],
    autoConvert: true,
    autoProviders: ['deepseek-official'],
    autoIntent: 'reason',
    autoPrompt: 'Convert it.',
    autoComplex: false,
    autoAccurateOcr: false,
    autoFailureMode: 'error',
  })
  assert.deepEqual(tools.map(tool => tool.name), ['vision_analyze', 'vision_status'])

  const bridgedModel = await ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-v4-flash')
  assert.deepEqual(bridgedModel.inputModalities, ['text', 'image'])
  const untouchedModel = await ctx.llm.resolveModelInfo('another-provider', 'text-model')
  assert.deepEqual(untouchedModel.inputModalities, ['text'])

  const message = {
    id: 'cordis-message', role: 'user', source: { kind: 'user' },
    content: [{ type: 'image', attachment: ref }],
  }
  const signal = new AbortController().signal
  const decision = await ctx.waterfall('agent/pre-step', {
    agent: { options: { provider: 'deepseek-official' } },
    messages: [message], turn: 1, step: 1, signal,
  }, async () => ({ kind: 'enter', messages: [message] }))
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages[0].content[0].type, 'text')
  assert.match(decision.messages[0].content[0].text, /Cordis integration recognized/)

  await ctx.fiber.dispose()
  const restoredModel = await llm.resolveModelInfo('deepseek-official', 'deepseek-v4-flash')
  assert.deepEqual(restoredModel.inputModalities, ['text'])
})
