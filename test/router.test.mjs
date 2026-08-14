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
