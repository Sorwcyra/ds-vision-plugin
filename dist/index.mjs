import { n as ConfigLoader, r as parseVisionConfig, t as VisionRouter } from "./router-gWz8KoDD.mjs";
import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { contentHasImage } from "@deepseek-ai/dsh-llm";
//#region src/admission.ts
function providerIsEnabled(provider, providers) {
	return providers.length === 0 || providers.includes(provider);
}
/**
* Let the Host API persist image prompts for routes whose images this plugin
* will remove in `agent/pre-step`. Harness otherwise rejects a text-only model
* before that waterfall can run.
*/
function installImageAdmissionBridge(ctx, providers) {
	const llm = ctx.llm;
	const ownDescriptor = Object.getOwnPropertyDescriptor(llm, "resolveModelInfo");
	const original = llm.resolveModelInfo.bind(llm);
	const wrapped = async (provider, model, signal) => {
		const info = await original(provider, model, signal);
		if (!providerIsEnabled(provider, providers)) return info;
		const modalities = info.inputModalities;
		if (modalities?.includes("image")) return info;
		return {
			...info,
			inputModalities: [...modalities ?? [], "image"]
		};
	};
	Object.defineProperty(llm, "resolveModelInfo", {
		configurable: true,
		enumerable: ownDescriptor?.enumerable ?? false,
		writable: true,
		value: wrapped
	});
	return () => {
		if (llm.resolveModelInfo !== wrapped) return;
		if (ownDescriptor === void 0) delete llm.resolveModelInfo;
		else Object.defineProperty(llm, "resolveModelInfo", ownDescriptor);
	};
}
//#endregion
//#region src/auto.ts
function errorText(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 500);
}
function visibleText(blocks) {
	return blocks.flatMap((block) => {
		if (block.type === "text") return [block.text];
		if (block.type === "tool-result") return [visibleText(block.content)];
		return [];
	}).join("").trim();
}
function countImages(blocks) {
	return blocks.reduce((count, block) => count + (block.type === "image" ? 1 : block.type === "tool-result" ? countImages(block.content) : 0), 0);
}
function imageName(ref, index) {
	return ref.name?.trim() || `attachment-${index}`;
}
function renderAnalysis(ref, index, total, tool, result) {
	return [
		`[Image ${index}/${total}: ${imageName(ref, index)}; converted by ${tool}]`,
		"<visual-content>",
		result,
		"</visual-content>"
	].join("\n");
}
function renderFailure(ref, index, total, error) {
	return `[Image ${index}/${total}: ${imageName(ref, index)} could not be converted for the text-only model: ${errorText(error)}]`;
}
/**
* Replace every durable core image block with grounded text before a text-only
* provider records or serializes the proposed step. Nested tool-result content
* is handled as well as ordinary top-level Web composer attachments.
*/
async function rewriteAttachedImages(messages, attachments, router, visionConfig, options, signal) {
	const total = messages.reduce((count, message) => count + countImages(message.content), 0);
	if (total === 0) return [...messages];
	const counter = { value: 0 };
	const rewriteContent = async (blocks, accompanyingText) => await Promise.all(blocks.map(async (block) => {
		if (block.type === "tool-result") return {
			...block,
			content: await rewriteContent(block.content, accompanyingText)
		};
		if (block.type !== "image") return block;
		const index = ++counter.value;
		try {
			const stored = await attachments.readImage(block.attachment, signal);
			signal.throwIfAborted();
			const prompt = [
				options.prompt,
				`This is image ${index} of ${total}.`,
				accompanyingText.length > 0 ? `The user's accompanying text is:\n${accompanyingText}` : ""
			].filter(Boolean).join("\n\n");
			const converted = await router.analyzeImage({
				data: stored.data,
				mediaType: stored.ref.mediaType,
				...stored.ref.name === void 0 ? {} : { name: stored.ref.name },
				prompt,
				intent: options.intent,
				complex: options.complex,
				accurateOcr: options.accurateOcr,
				noCache: false
			}, visionConfig, signal);
			return {
				type: "text",
				text: renderAnalysis(stored.ref, index, total, converted.tool_used, converted.result)
			};
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			if (options.failureMode === "error") throw new Error(`ds-vision-plugin failed to convert image ${index}/${total}: ${errorText(error)}`, { cause: error });
			return {
				type: "text",
				text: renderFailure(block.attachment, index, total, error)
			};
		}
	}));
	return await Promise.all(messages.map(async (message) => {
		if (countImages(message.content) === 0) return message;
		const content = await rewriteContent(message.content, visibleText(message.content));
		return {
			...message,
			content
		};
	}));
}
//#endregion
//#region src/index.ts
const name = "ds-vision-plugin";
const inject = [
	"tools",
	"agents",
	"attachments",
	"llm"
];
const Config = Schema.object({
	configFile: Schema.string().default("./vision.yml"),
	allowedRoots: Schema.array(Schema.string()).default([]),
	autoConvert: Schema.boolean().default(true),
	autoProviders: Schema.array(Schema.string()).default(["deepseek-official"]),
	autoIntent: Schema.union([
		"auto",
		"reason",
		"ocr"
	]).default("auto"),
	autoPrompt: Schema.string().default("Describe the image faithfully and in enough detail for a text-only reasoning model. Extract visible text, code, labels, values, layout, and relevant visual relationships. Do not answer the user; only convert the visual evidence into grounded text."),
	autoComplex: Schema.boolean().default(true),
	autoAccurateOcr: Schema.boolean().default(false),
	autoFailureMode: Schema.union(["error", "annotate"]).default("annotate")
});
function apply(ctx, pluginConfig) {
	const loader = new ConfigLoader(pluginConfig.configFile);
	const router = new VisionRouter(pluginConfig.allowedRoots);
	if (pluginConfig.autoConvert) ctx.effect(() => installImageAdmissionBridge(ctx, pluginConfig.autoProviders), "ds-vision-plugin.image-admission");
	ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal.aborted || !pluginConfig.autoConvert) return decision;
		if (pluginConfig.autoProviders.length > 0 && (agent.options.provider === void 0 || !pluginConfig.autoProviders.includes(agent.options.provider))) return decision;
		if (!decision.messages.some((message) => contentHasImage(message.content))) return decision;
		const config = await loader.load();
		return {
			kind: "enter",
			messages: await rewriteAttachedImages(decision.messages, ctx.attachments, router, config, {
				intent: pluginConfig.autoIntent,
				prompt: pluginConfig.autoPrompt,
				complex: pluginConfig.autoComplex,
				accurateOcr: pluginConfig.autoAccurateOcr,
				failureMode: pluginConfig.autoFailureMode
			}, signal)
		};
	}, { prepend: true });
	ctx.tools.register(defineTool({
		name: "vision_analyze",
		description: "Analyze an image, screenshot, scan, chart, UI, or document by file path. Use this whenever the selected text model needs visual understanding or OCR. The tool routes to configured VLM/OCR/document providers and returns grounded text for further reasoning.",
		parameters: {
			path: {
				type: "string",
				required: true,
				description: "File path inside an allowed workspace root."
			},
			prompt: {
				type: "string",
				description: "What to inspect or extract from the visual input."
			},
			intent: {
				type: "string",
				enum: [
					"auto",
					"reason",
					"ocr",
					"document"
				],
				description: "Routing intent; auto detects from file and prompt."
			},
			complex: {
				type: "boolean",
				description: "Use a larger output budget for charts, math, code screenshots, or complex UI."
			},
			accurate_ocr: {
				type: "boolean",
				description: "Prefer high-accuracy OCR for scans, receipts, and low-quality text."
			},
			no_cache: {
				type: "boolean",
				description: "Bypass the result cache."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		timeoutMs: 18e4,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const config = await loader.load();
			const result = await router.analyze({
				path: args.path,
				prompt: args.prompt ?? "Analyze this visual input and return the useful content.",
				intent: args.intent ?? "auto",
				complex: args.complex ?? false,
				accurateOcr: args.accurate_ocr ?? false,
				noCache: args.no_cache ?? false
			}, config, exec.signal);
			return JSON.stringify(result);
		}
	}));
	ctx.tools.register(defineTool({
		name: "vision_status",
		description: "Inspect ds-vision-plugin configuration and channel availability without revealing secrets. Use this to diagnose why image recognition is unavailable.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		isConcurrencySafe: () => true,
		async execute() {
			const config = await loader.load();
			return JSON.stringify({
				config_file: pluginConfig.configFile,
				allowed_roots: pluginConfig.allowedRoots.length > 0 ? pluginConfig.allowedRoots : [process.cwd()],
				automatic_web_attachments: {
					enabled: pluginConfig.autoConvert,
					providers: pluginConfig.autoProviders.length > 0 ? pluginConfig.autoProviders : ["*"],
					intent: pluginConfig.autoIntent,
					failure_mode: pluginConfig.autoFailureMode
				},
				channels: config.channels.map((channel) => ({
					id: channel.id,
					enabled: channel.enabled !== false,
					configured: channel.apiKeyOptional === true || Boolean(process.env[channel.apiKeyEnv]),
					model: channel.model,
					base_url: channel.baseUrl,
					api_key_env: channel.apiKeyEnv
				})),
				routing: config.routing,
				ocr: {
					baidu: Boolean(config.ocr.baidu?.enabled),
					tesseract: Boolean(config.ocr.tesseract?.enabled)
				},
				document: { mineru: Boolean(config.document.mineru?.enabled) }
			});
		}
	}));
}
//#endregion
export { Config, VisionRouter, apply, inject, installImageAdmissionBridge, name, parseVisionConfig, rewriteAttachedImages };

//# sourceMappingURL=index.mjs.map