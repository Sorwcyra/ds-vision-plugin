import Schema from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/types.d.ts
type VisionIntent = 'auto' | 'reason' | 'ocr' | 'document';
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
//#endregion
//#region src/config.d.ts
declare function parseVisionConfig(input: string): VisionConfig;
//#endregion
//#region src/router.d.ts
declare class VisionRouter {
  private readonly allowedRoots;
  constructor(allowedRoots: readonly string[]);
  analyze(request: AnalyzeRequest, config: VisionConfig, signal: AbortSignal): Promise<VisionEnvelope>;
}
//#endregion
//#region src/index.d.ts
declare const name = "ds-vision-plugin";
declare const inject: string[];
interface Config {
  configFile: string;
  allowedRoots: string[];
}
declare const Config: Schema<Config>;
declare function apply(ctx: Context, pluginConfig: Config): void;
//#endregion
export { type AnalyzeRequest, Config, type VisionConfig, type VisionEnvelope, type VisionIntent, VisionRouter, apply, inject, name, parseVisionConfig };
//# sourceMappingURL=index.d.mts.map