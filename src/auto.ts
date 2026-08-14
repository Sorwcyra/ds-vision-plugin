import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { VisionConfig, VisionIntent } from './types.js'
import type { VisionRouter } from './router.js'

export interface AttachmentReader {
  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>
}

export interface AutoConvertOptions {
  intent: Exclude<VisionIntent, 'document'>
  prompt: string
  complex: boolean
  accurateOcr: boolean
  failureMode: 'error' | 'annotate'
}

function errorText(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  return value.replace(/[\r\n]+/g, ' ').slice(0, 500)
}

function visibleText(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => {
    if (block.type === 'text') return [block.text]
    if (block.type === 'tool-result') return [visibleText(block.content)]
    return []
  }).join('').trim()
}

function countImages(blocks: readonly ContentBlock[]): number {
  return blocks.reduce((count, block) => count + (
    block.type === 'image'
      ? 1
      : block.type === 'tool-result' ? countImages(block.content) : 0
  ), 0)
}

function imageName(ref: ImageAttachmentRef, index: number): string {
  return ref.name?.trim() || `attachment-${index}`
}

function renderAnalysis(
  ref: ImageAttachmentRef,
  index: number,
  total: number,
  tool: string,
  result: string,
): string {
  return [
    `[Image ${index}/${total}: ${imageName(ref, index)}; converted by ${tool}]`,
    '<visual-content>',
    result,
    '</visual-content>',
  ].join('\n')
}

function renderFailure(ref: ImageAttachmentRef, index: number, total: number, error: unknown): string {
  return `[Image ${index}/${total}: ${imageName(ref, index)} could not be converted for the text-only model: ${errorText(error)}]`
}

/**
 * Replace every durable core image block with grounded text before a text-only
 * provider records or serializes the proposed step. Nested tool-result content
 * is handled as well as ordinary top-level Web composer attachments.
 */
export async function rewriteAttachedImages(
  messages: readonly UserMessage[],
  attachments: AttachmentReader,
  router: VisionRouter,
  visionConfig: VisionConfig,
  options: AutoConvertOptions,
  signal: AbortSignal,
): Promise<UserMessage[]> {
  const total = messages.reduce((count, message) => count + countImages(message.content), 0)
  if (total === 0) return [...messages]
  const counter = { value: 0 }

  const rewriteContent = async (
    blocks: readonly ContentBlock[],
    accompanyingText: string,
  ): Promise<ContentBlock[]> => await Promise.all(blocks.map(async block => {
    if (block.type === 'tool-result') {
      return { ...block, content: await rewriteContent(block.content, accompanyingText) }
    }
    if (block.type !== 'image') return block

    const index = ++counter.value
    try {
      const stored = await attachments.readImage(block.attachment, signal)
      signal.throwIfAborted()
      const prompt = [
        options.prompt,
        `This is image ${index} of ${total}.`,
        accompanyingText.length > 0 ? `The user's accompanying text is:\n${accompanyingText}` : '',
      ].filter(Boolean).join('\n\n')
      const converted = await router.analyzeImage({
        data: stored.data,
        mediaType: stored.ref.mediaType,
        ...(stored.ref.name === undefined ? {} : { name: stored.ref.name }),
        prompt,
        intent: options.intent,
        complex: options.complex,
        accurateOcr: options.accurateOcr,
        noCache: false,
      }, visionConfig, signal)
      return {
        type: 'text' as const,
        text: renderAnalysis(stored.ref, index, total, converted.tool_used, converted.result),
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason
      if (options.failureMode === 'error') {
        throw new Error(`ds-vision-plugin failed to convert image ${index}/${total}: ${errorText(error)}`, { cause: error })
      }
      return { type: 'text' as const, text: renderFailure(block.attachment, index, total, error) }
    }
  }))

  return await Promise.all(messages.map(async message => {
    if (countImages(message.content) === 0) return message
    const content = await rewriteContent(message.content, visibleText(message.content))
    return { ...message, content }
  }))
}
