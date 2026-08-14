import assert from 'node:assert/strict'
import test from 'node:test'
import { parseVisionConfig } from '../dist/index.mjs'

test('parses channels and expands environment variables', () => {
  process.env.TEST_VISION_URL = 'http://127.0.0.1:4321/v1/chat/completions'
  const config = parseVisionConfig(`
version: 1
routing:
  race: [mock]
  fallback: []
channels:
  - id: mock
    type: openai-compatible
    baseUrl: \${TEST_VISION_URL}
    model: \${TEST_VISION_MODEL:-mock-vl}
    apiKeyEnv: TEST_VISION_KEY
ocr: {}
document: {}
limits: {}
cache:
  enabled: false
  directory: .cache
`)
  assert.equal(config.channels[0].baseUrl, process.env.TEST_VISION_URL)
  assert.equal(config.channels[0].model, 'mock-vl')
  assert.deepEqual(config.routing.race, ['mock'])
})

test('rejects routing entries that do not exist', () => {
  assert.throws(() => parseVisionConfig(`
version: 1
routing: { race: [missing], fallback: [] }
channels: []
  `), /unknown channel/)
})

test('allows empty environment-backed fields on disabled channel slots', () => {
  delete process.env.UNSET_VISION_URL
  delete process.env.UNSET_VISION_MODEL
  const config = parseVisionConfig(`
version: 1
routing: { race: [], fallback: [custom] }
channels:
  - id: custom
    type: openai-compatible
    baseUrl: \${UNSET_VISION_URL}
    model: \${UNSET_VISION_MODEL}
    apiKeyEnv: UNSET_VISION_KEY
    enabled: false
`)
  assert.equal(config.channels[0].enabled, false)
  assert.equal(config.channels[0].baseUrl, 'http://disabled.invalid')
  assert.equal(config.channels[0].model, 'disabled')
})
