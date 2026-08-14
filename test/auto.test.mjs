import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, rewriteAttachedImages, VisionRouter } from '../dist/index.mjs'

function imageRef(id = 'a', name = 'pasted.png') {
  return {
    attachmentId: `sha256:${id.repeat(64)}`,
    mediaType: 'image/png',
    bytes: 8,
    width: 1,
    height: 1,
    name,
  }
}

function config(baseUrl) {
  return {
    version: 1,
    routing: { race: ['mock'], fallback: [] },
    channels: [{
      id: 'mock',
      type: 'openai-compatible',
      baseUrl,
      model: 'mock-vl',
      apiKeyEnv: 'TEST_AUTO_VISION_KEY',
    }],
    ocr: {},
    document: {},
    limits: { maxFileBytes: 1024, timeoutMs: 5_000, maxTokens: 100 },
    cache: { enabled: false, directory: join(tmpdir(), 'ds-vision-auto-test-cache'), ttlSeconds: 60 },
  }
}

const options = {
  intent: 'auto',
  prompt: 'Convert visual evidence to text.',
  complex: false,
  accurateOcr: false,
  failureMode: 'annotate',
}

test('automatically replaces a Web attachment with VLM text in place', async t => {
  let received
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ choices: [{ message: { content: 'A chart rises from 10 to 42.' } }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  assert.equal(typeof address, 'object')
  process.env.TEST_AUTO_VISION_KEY = 'secret'

  const ref = imageRef()
  const attachments = {
    async readImage(requested) {
      assert.equal(requested, ref)
      return { ref, data: Buffer.from('89504e470d0a1a0a', 'hex') }
    },
  }
  const message = {
    id: 'message-1',
    role: 'user',
    source: { kind: 'user' },
    content: [
      { type: 'text', text: 'What trend does this show? ' },
      { type: 'image', attachment: ref },
    ],
  }
  const rewritten = await rewriteAttachedImages(
    [message],
    attachments,
    new VisionRouter([]),
    config(`http://127.0.0.1:${address.port}/v1/chat/completions`),
    options,
    new AbortController().signal,
  )

  assert.equal(rewritten[0].id, message.id)
  assert.equal(rewritten[0].source, message.source)
  assert.deepEqual(rewritten[0].content.map(block => block.type), ['text', 'text'])
  assert.match(rewritten[0].content[1].text, /A chart rises from 10 to 42/)
  assert.equal(received.messages[0].content[0].type, 'image_url')
  assert.match(received.messages[0].content[1].text, /What trend does this show/)
})

test('rewrites nested images and annotates conversion failures instead of leaking image blocks', async () => {
  const ref = imageRef('b', 'nested.png')
  const message = {
    id: 'message-2',
    role: 'user',
    source: { kind: 'plugin', plugin: 'test' },
    content: [{
      type: 'tool-result',
      toolCallId: 'call-1',
      content: [{ type: 'image', attachment: ref }],
    }],
  }
  const unavailable = config('http://127.0.0.1:1/v1/chat/completions')
  unavailable.limits.timeoutMs = 50
  const rewritten = await rewriteAttachedImages(
    [message],
    { readImage: async () => ({ ref, data: Buffer.from('89504e470d0a1a0a', 'hex') }) },
    new VisionRouter([]),
    unavailable,
    options,
    new AbortController().signal,
  )

  const nested = rewritten[0].content[0].content[0]
  assert.equal(nested.type, 'text')
  assert.match(nested.text, /could not be converted/)
})

test('strict failure mode rejects a step when no visual route succeeds', async () => {
  const ref = imageRef('c')
  const message = {
    id: 'message-3', role: 'user', source: { kind: 'user' },
    content: [{ type: 'image', attachment: ref }],
  }
  const unavailable = config('http://127.0.0.1:1/v1/chat/completions')
  unavailable.limits.timeoutMs = 50
  await assert.rejects(() => rewriteAttachedImages(
    [message],
    { readImage: async () => ({ ref, data: Buffer.from('89504e470d0a1a0a', 'hex') }) },
    new VisionRouter([]),
    unavailable,
    { ...options, failureMode: 'error' },
    new AbortController().signal,
  ), /failed to convert image 1\/1/)
})

test('plugin wires the automatic conversion into agent/pre-step for DeepSeek only', async t => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ choices: [{ message: { content: 'Recognized pasted image.' } }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  assert.equal(typeof address, 'object')
  process.env.TEST_AUTO_VISION_KEY = 'secret'

  const root = await mkdtemp(join(tmpdir(), 'ds-vision-hook-test-'))
  const configFile = join(root, 'vision.yml')
  await writeFile(configFile, `
version: 1
routing: { race: [mock], fallback: [] }
channels:
  - id: mock
    baseUrl: http://127.0.0.1:${address.port}/v1/chat/completions
    model: mock-vl
    apiKeyEnv: TEST_AUTO_VISION_KEY
cache: { enabled: false, directory: ${JSON.stringify(join(root, 'cache'))} }
`)
  const ref = imageRef('d')
  let reads = 0
  let preStep
  const ctx = {
    llm: {
      async resolveModelInfo(provider, model) {
        return { provider, id: model, name: model, inputModalities: ['text'] }
      },
    },
    attachments: {
      async readImage() {
        reads += 1
        return { ref, data: Buffer.from('89504e470d0a1a0a', 'hex') }
      },
    },
    tools: { register() {} },
    effect(setup) {
      setup()
    },
    on(name, callback, registrationOptions) {
      if (name === 'agent/pre-step') {
        preStep = callback
        assert.deepEqual(registrationOptions, { prepend: true })
      }
    },
  }
  apply(ctx, {
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
  assert.equal(typeof preStep, 'function')
  const messages = [{
    id: 'message-hook', role: 'user', source: { kind: 'user' },
    content: [{ type: 'image', attachment: ref }],
  }]
  const signal = new AbortController().signal
  const skipped = await preStep(
    { agent: { options: { provider: 'multimodal' } }, signal },
    async () => ({ kind: 'enter', messages }),
  )
  assert.equal(skipped.messages[0].content[0].type, 'image')
  assert.equal(reads, 0)

  const converted = await preStep(
    { agent: { options: { provider: 'deepseek-official' } }, signal },
    async () => ({ kind: 'enter', messages }),
  )
  assert.equal(converted.messages[0].content[0].type, 'text')
  assert.match(converted.messages[0].content[0].text, /Recognized pasted image/)
  assert.equal(reads, 1)
})
