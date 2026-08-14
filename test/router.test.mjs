import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { VisionRouter } from '../dist/index.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ds-vision-plugin-test-'))
  const image = join(root, 'image.png')
  await writeFile(image, Buffer.from('89504e470d0a1a0a', 'hex'))
  return { root, image }
}

test('routes an allowed image to an OpenAI-compatible VLM', async t => {
  const { root, image } = await fixture()
  let received
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ choices: [{ message: { content: 'a red square' } }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  assert.equal(typeof address, 'object')
  process.env.TEST_VISION_KEY = 'secret'
  const config = {
    version: 1,
    routing: { race: ['mock'], fallback: [] },
    channels: [{
      id: 'mock', type: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${address.port}/v1/chat/completions`,
      model: 'mock-vl', apiKeyEnv: 'TEST_VISION_KEY',
    }],
    ocr: {}, document: {},
    limits: { maxFileBytes: 1024, timeoutMs: 5_000, maxTokens: 100 },
    cache: { enabled: false, directory: join(root, 'cache'), ttlSeconds: 60 },
  }
  const result = await new VisionRouter([root]).analyze({
    path: image, prompt: 'describe', intent: 'reason', complex: false,
    accurateOcr: false, noCache: true,
  }, config, new AbortController().signal)
  assert.equal(result.result, 'a red square')
  assert.equal(result.tool_used, 'mock:mock-vl')
  assert.equal(received.messages[0].content[0].type, 'image_url')
})

test('starts all four named models concurrently and keeps the first valid response', async t => {
  const { root, image } = await fixture()
  const received = []
  const delays = new Map([
    ['agnes-2.5-flash', 120], ['agnes-2.0-flash', 160],
    ['glm-4v-flash', 40], ['glm-4.1v-thinking-flash', 200],
  ])
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    received.push(body.model)
    await new Promise(resolve => setTimeout(resolve, delays.get(body.model)))
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ choices: [{ message: { content: `winner:${body.model}` } }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  assert.equal(typeof address, 'object')
  process.env.TEST_FOUR_RACE_KEY = 'secret'
  const models = ['agnes-2.5-flash', 'agnes-2.0-flash', 'glm-4v-flash', 'glm-4.1v-thinking-flash']
  const ids = ['agnes-2.5-flash', 'agnes-2.0-flash', 'glm', 'glm-thinking']
  const config = {
    version: 1,
    routing: { race: ids, fallback: [] },
    channels: ids.map((id, index) => ({
      id, type: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${address.port}/v1/chat/completions`,
      model: models[index], apiKeyEnv: 'TEST_FOUR_RACE_KEY',
    })),
    ocr: {}, document: {},
    limits: { maxFileBytes: 1024, timeoutMs: 5_000, maxTokens: 100 },
    cache: { enabled: false, directory: join(root, 'cache'), ttlSeconds: 60 },
  }
  const result = await new VisionRouter([root]).analyze({
    path: image, prompt: 'describe', intent: 'reason', complex: false,
    accurateOcr: false, noCache: true,
  }, config, new AbortController().signal)
  assert.equal(result.result, 'winner:glm-4v-flash')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(new Set(received), new Set(models))
})

test('refuses files outside configured roots', async () => {
  const { root } = await fixture()
  const other = await mkdtemp(join(tmpdir(), 'ds-vision-plugin-outside-'))
  const image = join(other, 'outside.png')
  await writeFile(image, 'x')
  const router = new VisionRouter([root])
  const config = {
    version: 1, routing: { race: [], fallback: [] }, channels: [], ocr: {}, document: {},
    limits: { maxFileBytes: 1024, timeoutMs: 1000, maxTokens: 10 },
    cache: { enabled: false, directory: join(root, 'cache'), ttlSeconds: 60 },
  }
  await assert.rejects(() => router.analyze({
    path: image, prompt: '', intent: 'reason', complex: false, accurateOcr: false, noCache: true,
  }, config, new AbortController().signal), /outside allowedRoots/)
})
