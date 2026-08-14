import Schema from "@deepseek-ai/schemastery";
import { UserMessage } from "@deepseek-ai/dsh-llm";
import { Context } from "@deepseek-ai/cordis";
import { ImageAttachmentRef, StoredImageAttachment } from "@deepseek-ai/dsh-attachment";
//#region src/types.d.ts
type VisionIntent = 'auto' | 'reason' | 'ocr' | 'document';
type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
interface ChannelConfig {
  id: string;
  type: 'openai-compatible';
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  apiKeyOptional?: boolean;
  enabled?: boolean;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxTokens?: number;
}
interface VisionConfig {
  version: 1;
  routing: {
    race: string[];
    fallback: string[];
  };
  channels: ChannelConfig[];
  ocr: {
    baidu?: {
      enabled: boolean;
      apiKeyEnv: string;
      secretKeyEnv: string;
    };
    tesseract?: {
      enabled: boolean;
      command: string;
      languages: string;
    };
  };
  document: {
    mineru?: {
      enabled: boolean;
      command: string;
      mode: 'flash' | 'extract';
    };
  };
  limits: {
    maxFileBytes: number;
    timeoutMs: number;
    maxTokens: number;
  };
  cache: {
    enabled: boolean;
    directory: string;
    ttlSeconds: number;
  };
}
interface VisionEnvelope {
  task_type: 'image_reasoning' | 'document_parsing' | 'ocr';
  tool_used: string;
  confidence: 'high' | 'medium' | 'low';
  result: string;
  metadata: Record<string, unknown>;
}
interface AnalyzeRequest {
  path: string;
  prompt: string;
  intent: VisionIntent;
  complex: boolean;
  accurateOcr: boolean;
  noCache: boolean;
}
interface AnalyzeImageRequest extends Omit<AnalyzeRequest, 'path' | 'intent'> {
  data: Uint8Array;
  mediaType: ImageMediaType;
  name?: string;
  intent: Exclude<VisionIntent, 'document'>;
}
//#endregion
//#region src/config.d.ts
declare function parseVisionConfig(input: string): VisionConfig;
//#endregion
//#region src/admission.d.ts
/**
 * Let the Host API persist image prompts for routes whose images this plugin
 * will remove in `agent/pre-step`. Harness otherwise rejects a text-only model
 * before that waterfall can run.
 */
declare function installImageAdmissionBridge(ctx: Context, providers: readonly string[]): () => void;
//#endregion
//#region src/router.d.ts
declare class VisionRouter {
  private readonly allowedRoots;
  constructor(allowedRoots: readonly string[]);
  analyze(request: AnalyzeRequest, config: VisionConfig, signal: AbortSignal): Promise<VisionEnvelope>;
  analyzeImage(request: AnalyzeImageRequest, config: VisionConfig, signal: AbortSignal): Promise<VisionEnvelope>;
}
//#endregion
//#region src/auto.d.ts
interface AttachmentReader {
  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>;
}
interface AutoConvertOptions {
  intent: Exclude<VisionIntent, 'document'>;
  prompt: string;
  complex: boolean;
  accurateOcr: boolean;
  failureMode: 'error' | 'annotate';
}
/**
 * Replace every durable core image block with grounded text before a text-only
 * provider records or serializes the proposed step. Nested tool-result content
 * is handled as well as ordinary top-level Web composer attachments.
 */
declare function rewriteAttachedImages(messages: readonly UserMessage[], attachments: AttachmentReader, router: VisionRouter, visionConfig: VisionConfig, options: AutoConvertOptions, signal: AbortSignal): Promise<UserMessage[]>;
//#endregion
//#region src/index.d.ts
declare const name = "ds-vision-plugin";
declare const inject: string[];
interface Config {
  configFile: string;
  allowedRoots: string[];
  autoConvert: boolean;
  autoProviders: string[];
  autoIntent: 'auto' | 'reason' | 'ocr';
  autoPrompt: string;
  autoComplex: boolean;
  autoAccurateOcr: boolean;
  autoFailureMode: 'error' | 'annotate';
}
declare const Config: Schema<Config>;
declare function apply(ctx: Context, pluginConfig: Config): void;
//#endregion
export { type AnalyzeImageRequest, type AnalyzeRequest, Config, type VisionConfig, type VisionEnvelope, type VisionIntent, VisionRouter, apply, inject, installImageAdmissionBridge, name, parseVisionConfig, rewriteAttachedImages };
//# sourceMappingURL=index.d.mts.map