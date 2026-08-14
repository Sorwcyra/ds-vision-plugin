import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { parse } from 'yaml'

const run = promisify(execFile)

test('CLI creates the four-model race and adds arbitrary custom models', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-vision-cli-test-'))
  const config = join(root, 'vision.yml')
  await run(process.execPath, ['dist/cli.mjs', 'configure', '--config', config], { cwd: process.cwd() })
  await run(process.execPath, [
    'dist/cli.mjs', 'add', '--config', config,
    '--id', 'user-vlm', '--base-url', 'https://example.test/v1/chat/completions',
    '--model', 'user-vision-model', '--api-key-env', 'USER_VLM_KEY', '--pool', 'fallback',
  ], { cwd: process.cwd() })
  const value = parse(await readFile(config, 'utf8'))
  assert.deepEqual(value.routing.race, ['agnes-2.5-flash', 'agnes-2.0-flash', 'glm', 'glm-thinking'])
  assert.deepEqual(value.routing.fallback, ['user-vlm'])
  assert.equal(value.channels.find(channel => channel.id === 'glm').model, 'glm-4v-flash')
  assert.equal(value.channels.find(channel => channel.id === 'glm-thinking').model, 'glm-4.1v-thinking-flash')
  assert.equal(value.channels.find(channel => channel.id === 'user-vlm').model, 'user-vision-model')
  assert.equal(value.channels.some(channel => channel.model.includes('4.6')), false)
})
