import type { Context } from '@deepseek-ai/cordis'
import type { LlmResolvedModelInfo, ModelModality } from '@deepseek-ai/dsh-llm'

type ResolveModelInfo = (
  provider: string,
  model: string,
  signal?: AbortSignal,
) => Promise<LlmResolvedModelInfo>

interface LlmWithModelResolution {
  resolveModelInfo: ResolveModelInfo
}

function providerIsEnabled(provider: string, providers: readonly string[]): boolean {
  return providers.length === 0 || providers.includes(provider)
}

/**
 * Let the Host API persist image prompts for routes whose images this plugin
 * will remove in `agent/pre-step`. Harness otherwise rejects a text-only model
 * before that waterfall can run.
 */
export function installImageAdmissionBridge(
  ctx: Context,
  providers: readonly string[],
): () => void {
  const llm = ctx.llm as LlmWithModelResolution
  const ownDescriptor = Object.getOwnPropertyDescriptor(llm, 'resolveModelInfo')
  const original = llm.resolveModelInfo.bind(llm)
  const wrapped: ResolveModelInfo = async (provider, model, signal) => {
    const info = await original(provider, model, signal)
    if (!providerIsEnabled(provider, providers)) return info
    const modalities = info.inputModalities
    if (modalities?.includes('image')) return info
    return {
      ...info,
      inputModalities: [...(modalities ?? []), 'image'] as ModelModality[],
    }
  }

  Object.defineProperty(llm, 'resolveModelInfo', {
    configurable: true,
    enumerable: ownDescriptor?.enumerable ?? false,
    writable: true,
    value: wrapped,
  })

  return () => {
    if (llm.resolveModelInfo !== wrapped) return
    if (ownDescriptor === undefined) delete (llm as Partial<LlmWithModelResolution>).resolveModelInfo
    else Object.defineProperty(llm, 'resolveModelInfo', ownDescriptor)
  }
}
