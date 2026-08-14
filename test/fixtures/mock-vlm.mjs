import { createServer } from 'node:http'

const port = Number(process.env.MOCK_VLM_PORT ?? 41081)
const server = createServer((request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(404).end()
    return
  }
  let body = ''
  request.setEncoding('utf8')
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    const hasImage = body.includes('data:image/')
    process.stdout.write(`request:image=${String(hasImage)}\n`)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      choices: [{ message: { content: hasImage
        ? 'E2E_VISION_BRIDGE_OK: the pasted image reached the visual conversion backend.'
        : 'E2E_VISION_BRIDGE_MISSING_IMAGE' } }],
    }))
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`mock-vlm:${port}\n`)
})
