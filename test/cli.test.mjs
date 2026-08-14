import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
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

  const prepared = await run(process.execPath, [
    'dist/cli.mjs', 'quickstart', '--config', config, '--no-install', '--no-start',
  ], { cwd: process.cwd() })
  assert.match(prepared.stdout, /Quickstart preparation complete/)
  const preserved = parse(await readFile(config, 'utf8'))
  assert.equal(preserved.channels.find(channel => channel.id === 'user-vlm').model, 'user-vision-model')
})

test('quickstart reuses an occupied Web port instead of launching a duplicate service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ds-vision-port-test-'))
  const config = join(root, 'ds-vision', 'vision.yml')
  const packageValue = JSON.parse(await readFile('package.json', 'utf8'))
  const installedDirectory = join(root, 'profiles', 'web', 'node_modules', 'ds-vision-plugin')
  await mkdir(installedDirectory, { recursive: true })
  await writeFile(join(installedDirectory, 'package.json'), JSON.stringify({ version: packageValue.version }))
  await run(process.execPath, ['dist/cli.mjs', 'configure', '--config', config], { cwd: process.cwd() })
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const result = await run(process.execPath, [
      'dist/cli.mjs', 'quickstart', '--port', String(address.port), '--no-install', '--no-open',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, DSH_HOME: root, DS_VISION_CONFIG: config },
    })
    assert.match(result.stdout, /already in use/)
  } finally {
    server.close()
    await once(server, 'close')
  }
})
