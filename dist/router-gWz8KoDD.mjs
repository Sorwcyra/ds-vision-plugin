import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
//#region src/config.ts
const ENV_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)(?::-(.*?))?\}/g;
function interpolate(value) {
	if (typeof value === "string") return value.replace(ENV_PATTERN, (_whole, name, fallback) => {
		return process.env[name] ?? fallback ?? "";
	});
	if (Array.isArray(value)) return value.map(interpolate);
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, interpolate(entry)]));
	return value;
}
function object(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value;
}
function text(value, label) {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
	return value;
}
function positiveInteger(value, fallback, label) {
	if (value === void 0) return fallback;
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
	return value;
}
function stringList(value, fallback, label) {
	if (value === void 0) return fallback;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) throw new Error(`${label} must be a list of non-empty strings`);
	return [...value];
}
function parseChannel(value, index) {
	const item = object(value, `channels[${index}]`);
	const type = item.type ?? "openai-compatible";
	const enabled = item.enabled !== false;
	if (type !== "openai-compatible") throw new Error(`channels[${index}].type is unsupported: ${String(type)}`);
	const headers = item.headers === void 0 ? void 0 : object(item.headers, `channels[${index}].headers`);
	if (headers !== void 0 && Object.values(headers).some((entry) => typeof entry !== "string")) throw new Error(`channels[${index}].headers values must be strings`);
	return {
		id: text(item.id, `channels[${index}].id`),
		type,
		baseUrl: enabled ? text(item.baseUrl, `channels[${index}].baseUrl`) : String(item.baseUrl || "http://disabled.invalid"),
		model: enabled ? text(item.model, `channels[${index}].model`) : String(item.model || "disabled"),
		apiKeyEnv: text(item.apiKeyEnv ?? "VISION_API_KEY", `channels[${index}].apiKeyEnv`),
		...item.apiKeyOptional === true ? { apiKeyOptional: true } : {},
		...!enabled ? { enabled: false } : {},
		...headers !== void 0 ? { headers } : {},
		...item.timeoutMs !== void 0 ? { timeoutMs: positiveInteger(item.timeoutMs, 0, `channels[${index}].timeoutMs`) } : {},
		...item.maxTokens !== void 0 ? { maxTokens: positiveInteger(item.maxTokens, 0, `channels[${index}].maxTokens`) } : {}
	};
}
function parseVisionConfig(input) {
	const root = object(interpolate(parse(input)), "config");
	if (root.version !== 1) throw new Error("config.version must be 1");
	if (!Array.isArray(root.channels)) throw new Error("config.channels must be a list");
	const channels = root.channels.map(parseChannel);
	const ids = /* @__PURE__ */ new Set();
	for (const channel of channels) {
		if (ids.has(channel.id)) throw new Error(`duplicate channel id: ${channel.id}`);
		ids.add(channel.id);
	}
	const routing = object(root.routing ?? {}, "routing");
	const ocr = object(root.ocr ?? {}, "ocr");
	const document = object(root.document ?? {}, "document");
	const limits = object(root.limits ?? {}, "limits");
	const cache = object(root.cache ?? {}, "cache");
	const baidu = ocr.baidu === void 0 ? void 0 : object(ocr.baidu, "ocr.baidu");
	const tesseract = ocr.tesseract === void 0 ? void 0 : object(ocr.tesseract, "ocr.tesseract");
	const mineru = document.mineru === void 0 ? void 0 : object(document.mineru, "document.mineru");
	const race = stringList(routing.race, [], "routing.race");
	const fallback = stringList(routing.fallback, [], "routing.fallback");
	for (const id of [...race, ...fallback]) if (!ids.has(id)) throw new Error(`routing references unknown channel: ${id}`);
	const cacheDirectory = text(cache.directory ?? ".ds-vision-cache", "cache.directory");
	return {
		version: 1,
		routing: {
			race,
			fallback
		},
		channels,
		ocr: {
			...baidu !== void 0 ? { baidu: {
				enabled: baidu.enabled === true,
				apiKeyEnv: text(baidu.apiKeyEnv ?? "BAIDU_API_KEY", "ocr.baidu.apiKeyEnv"),
				secretKeyEnv: text(baidu.secretKeyEnv ?? "BAIDU_SECRET_KEY", "ocr.baidu.secretKeyEnv")
			} } : {},
			...tesseract !== void 0 ? { tesseract: {
				enabled: tesseract.enabled !== false,
				command: text(tesseract.command ?? "tesseract", "ocr.tesseract.command"),
				languages: text(tesseract.languages ?? "eng", "ocr.tesseract.languages")
			} } : {}
		},
		document: { ...mineru !== void 0 ? { mineru: {
			enabled: mineru.enabled !== false,
			command: text(mineru.command ?? "mineru-open-api", "document.mineru.command"),
			mode: mineru.mode === "extract" ? "extract" : "flash"
		} } : {} },
		limits: {
			maxFileBytes: positiveInteger(limits.maxFileBytes, 15728640, "limits.maxFileBytes"),
			timeoutMs: positiveInteger(limits.timeoutMs, 9e4, "limits.timeoutMs"),
			maxTokens: positiveInteger(limits.maxTokens, 1024, "limits.maxTokens")
		},
		cache: {
			enabled: cache.enabled !== false,
			directory: isAbsolute(cacheDirectory) ? cacheDirectory : resolve(process.cwd(), cacheDirectory),
			ttlSeconds: positiveInteger(cache.ttlSeconds, 604800, "cache.ttlSeconds")
		}
	};
}
var ConfigLoader = class {
	path;
	lastMtimeMs = -1;
	current;
	constructor(path) {
		this.path = path;
	}
	async load() {
		const info = await stat(this.path);
		if (this.current !== void 0 && info.mtimeMs === this.lastMtimeMs) return this.current;
		const next = parseVisionConfig(await readFile(this.path, "utf8"));
		this.current = next;
		this.lastMtimeMs = info.mtimeMs;
		return next;
	}
};
//#endregion
//#region src/router.ts
const IMAGE_MIME = /* @__PURE__ */ new Map([
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".webp", "image/webp"],
	[".gif", "image/gif"],
	[".bmp", "image/bmp"],
	[".tif", "image/tiff"],
	[".tiff", "image/tiff"]
]);
const DOCUMENT_EXTENSIONS = /* @__PURE__ */ new Set([
	".pdf",
	".doc",
	".docx",
	".ppt",
	".pptx"
]);
function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}
function abortSignal(parent, timeoutMs, local) {
	return AbortSignal.any([
		parent,
		AbortSignal.timeout(timeoutMs),
		...local === void 0 ? [] : [local]
	]);
}
function within(root, candidate) {
	const path = relative(root, candidate);
	return path === "" || !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
}
async function resolveInput(input, allowedRoots) {
	const candidate = await realpath(resolve(process.cwd(), input));
	if (!(await Promise.all(allowedRoots.map((root) => realpath(resolve(root))))).some((root) => within(root, candidate))) throw new Error(`input is outside allowedRoots: ${candidate}`);
	if (!(await stat(candidate)).isFile()) throw new Error(`input is not a regular file: ${candidate}`);
	return candidate;
}
function contentFromResponse(value) {
	if (typeof value === "string" && value.trim() !== "") return value;
	if (Array.isArray(value)) {
		const text = value.flatMap((item) => {
			if (item !== null && typeof item === "object" && "text" in item && typeof item.text === "string") return [item.text];
			return [];
		}).join("\n");
		return text.trim() === "" ? void 0 : text;
	}
}
async function atomicJson(path, value) {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${randomUUID()}.tmp`;
	await writeFile(temp, JSON.stringify(value), "utf8");
	await rename(temp, path);
}
async function cached(config, key) {
	if (!config.cache.enabled) return void 0;
	const path = join(config.cache.directory, `${key}.json`);
	try {
		const info = await stat(path);
		if (Date.now() - info.mtimeMs > config.cache.ttlSeconds * 1e3) return void 0;
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return;
	}
}
async function saveCache(config, key, value) {
	if (!config.cache.enabled) return;
	await atomicJson(join(config.cache.directory, `${key}.json`), value);
}
async function callVisionChannel(channel, inputName, mime, bytes, prompt, maxTokens, config, noCache, signal) {
	if (channel.enabled === false) throw new Error("disabled");
	const apiKey = process.env[channel.apiKeyEnv];
	if (!channel.apiKeyOptional && !apiKey) throw new Error(`missing environment variable ${channel.apiKeyEnv}`);
	const hash = createHash("sha256").update(bytes).digest("hex");
	const cacheKey = createHash("sha256").update(JSON.stringify([
		1,
		hash,
		prompt,
		channel.id,
		channel.model,
		channel.baseUrl,
		channel.maxTokens ?? maxTokens
	])).digest("hex");
	const hit = noCache ? void 0 : await cached(config, cacheKey);
	if (hit !== void 0) return {
		...hit,
		metadata: {
			...hit.metadata,
			cached: true
		}
	};
	const started = Date.now();
	const response = await fetch(channel.baseUrl, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...apiKey ? { authorization: `Bearer ${apiKey}` } : {},
			...channel.headers
		},
		body: JSON.stringify({
			model: channel.model,
			messages: [{
				role: "user",
				content: [{
					type: "image_url",
					image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` }
				}, {
					type: "text",
					text: prompt
				}]
			}],
			max_tokens: channel.maxTokens ?? maxTokens
		}),
		signal: abortSignal(signal, channel.timeoutMs ?? config.limits.timeoutMs)
	});
	const responseText = await response.text();
	if (!response.ok) throw new Error(`HTTP ${response.status}: ${responseText.slice(0, 300)}`);
	let body;
	try {
		body = JSON.parse(responseText);
	} catch {
		throw new Error("provider returned invalid JSON");
	}
	const result = contentFromResponse(body.choices?.[0]?.message?.content);
	if (result === void 0) throw new Error("provider returned empty content");
	const envelope = {
		task_type: "image_reasoning",
		tool_used: `${channel.id}:${channel.model}`,
		confidence: "high",
		result,
		metadata: {
			channel: channel.id,
			model: channel.model,
			image_sha256: hash,
			input: basename(inputName),
			bytes: bytes.length,
			latency_ms: Date.now() - started,
			cached: false
		}
	};
	if (!noCache) await saveCache(config, cacheKey, envelope);
	return envelope;
}
async function raceChannels(channels, inputName, mime, bytes, prompt, maxTokens, config, noCache, signal) {
	const attempts = [];
	const controllers = channels.map(() => new AbortController());
	const pending = channels.map(async (channel, index) => {
		const started = Date.now();
		try {
			const localSignal = controllers[index]?.signal;
			const envelope = await callVisionChannel(channel, inputName, mime, bytes, prompt, maxTokens, config, noCache, localSignal === void 0 ? signal : AbortSignal.any([signal, localSignal]));
			attempts.push({
				channel: channel.id,
				ok: true,
				latencyMs: Date.now() - started
			});
			return envelope;
		} catch (error) {
			attempts.push({
				channel: channel.id,
				ok: false,
				latencyMs: Date.now() - started,
				error: errorText(error)
			});
			throw error;
		}
	});
	try {
		const envelope = await Promise.any(pending);
		for (const controller of controllers) controller.abort();
		return {
			envelope,
			attempts
		};
	} catch {
		return { attempts };
	}
}
async function runCommand(command, args, signal, timeoutMs) {
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			windowsHide: true,
			signal
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			if (stdout.length < 8e6) stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			if (stderr.length < 1e6) stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolvePromise(stdout);
			else reject(/* @__PURE__ */ new Error(`${command} exited ${String(code)}: ${stderr.slice(-600)}`));
		});
	});
}
async function baiduOcr(bytes, inputName, config, accurate, signal) {
	const options = config.ocr.baidu;
	if (options === void 0 || !options.enabled) throw new Error("Baidu OCR is disabled");
	const apiKey = process.env[options.apiKeyEnv];
	const secret = process.env[options.secretKeyEnv];
	if (!apiKey || !secret) throw new Error(`missing ${options.apiKeyEnv} or ${options.secretKeyEnv}`);
	const tokenUrl = new URL("https://aip.baidubce.com/oauth/2.0/token");
	tokenUrl.searchParams.set("grant_type", "client_credentials");
	tokenUrl.searchParams.set("client_id", apiKey);
	tokenUrl.searchParams.set("client_secret", secret);
	const tokenResponse = await fetch(tokenUrl, {
		method: "POST",
		signal: abortSignal(signal, config.limits.timeoutMs)
	});
	const tokenBody = await tokenResponse.json();
	if (!tokenResponse.ok || !tokenBody.access_token) throw new Error(tokenBody.error_description ?? `token HTTP ${tokenResponse.status}`);
	const endpoint = accurate ? "accurate_basic" : "general_basic";
	const body = new URLSearchParams({ image: bytes.toString("base64") });
	const response = await fetch(`https://aip.baidubce.com/rest/2.0/ocr/v1/${endpoint}?access_token=${encodeURIComponent(tokenBody.access_token)}`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body,
		signal: abortSignal(signal, config.limits.timeoutMs)
	});
	const payload = await response.json();
	if (!response.ok || !payload.words_result) throw new Error(payload.error_msg ?? `OCR HTTP ${response.status}`);
	return {
		task_type: "ocr",
		tool_used: `baidu-ocr:${endpoint}`,
		confidence: "high",
		result: payload.words_result.flatMap((item) => item.words ? [item.words] : []).join("\n"),
		metadata: {
			lines: payload.words_result.length,
			input: basename(inputName)
		}
	};
}
function extensionForMediaType(mediaType) {
	switch (mediaType) {
		case "image/jpeg": return ".jpg";
		case "image/webp": return ".webp";
		case "image/gif": return ".gif";
		case "image/bmp": return ".bmp";
		case "image/tiff": return ".tiff";
		default: return ".png";
	}
}
async function localOcr(bytes, mediaType, inputName, config, signal) {
	const options = config.ocr.tesseract;
	if (options === void 0 || !options.enabled) throw new Error("Tesseract OCR is disabled");
	const temporaryRoot = await mkdtemp(join(tmpdir(), "ds-vision-ocr-"));
	const file = join(temporaryRoot, `input${extensionForMediaType(mediaType)}`);
	try {
		await writeFile(file, bytes, { mode: 384 });
		const result = (await runCommand(options.command, [
			file,
			"stdout",
			"-l",
			options.languages
		], signal, config.limits.timeoutMs)).trim();
		if (result === "") throw new Error("Tesseract returned no text");
		return {
			task_type: "ocr",
			tool_used: `tesseract:${options.languages}`,
			confidence: "medium",
			result,
			metadata: {
				input: basename(inputName),
				local: true
			}
		};
	} finally {
		await rm(temporaryRoot, {
			recursive: true,
			force: true
		});
	}
}
async function findMarkdown(root) {
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			const nested = await findMarkdown(path);
			if (nested !== void 0) return nested;
		} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) return path;
	}
}
async function parseDocument(file, config, signal) {
	const options = config.document.mineru;
	if (options === void 0 || !options.enabled) throw new Error("MinerU document parsing is disabled");
	const output = join(tmpdir(), `ds-vision-mineru-${createHash("sha256").update(file).digest("hex").slice(0, 12)}`);
	await mkdir(output, { recursive: true });
	if (await findMarkdown(output) === void 0) {
		const args = options.mode === "flash" ? [
			"flash-extract",
			file,
			"-o",
			output
		] : [
			"extract",
			file,
			"-o",
			output,
			"-f",
			"md"
		];
		await runCommand(options.command, args, signal, config.limits.timeoutMs);
	}
	const markdown = await findMarkdown(output);
	if (markdown === void 0) throw new Error("MinerU produced no Markdown");
	const result = await readFile(markdown, "utf8");
	return {
		task_type: "document_parsing",
		tool_used: `mineru:${options.mode}`,
		confidence: "high",
		result,
		metadata: {
			input: basename(file),
			output: markdown,
			chars: result.length
		}
	};
}
function chooseIntent(intent, file, prompt, accurateOcr) {
	if (intent !== "auto") return intent;
	const extension = extname(file).toLowerCase();
	if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
	if (accurateOcr || /\bocr\b|文字识别|提取文字/i.test(prompt)) return "ocr";
	return "reason";
}
async function routeImage(request, config, signal, previousAttempts = []) {
	const attempts = [...previousAttempts];
	if (request.intent === "ocr") {
		try {
			return await baiduOcr(request.bytes, request.inputName, config, request.accurateOcr, signal);
		} catch (error) {
			attempts.push({
				tool: "baidu-ocr",
				error: errorText(error)
			});
		}
		try {
			return await localOcr(request.bytes, request.mediaType, request.inputName, config, signal);
		} catch (error) {
			attempts.push({
				tool: "tesseract",
				error: errorText(error)
			});
		}
	}
	const maxTokens = request.complex ? Math.max(2048, config.limits.maxTokens) : config.limits.maxTokens;
	const byId = new Map(config.channels.map((channel) => [channel.id, channel]));
	const race = config.routing.race.flatMap((id) => byId.get(id) ?? []);
	if (race.length > 0) {
		const raced = await raceChannels(race, request.inputName, request.mediaType, request.bytes, request.prompt, maxTokens, config, request.noCache, signal);
		attempts.push(...raced.attempts);
		if (raced.envelope !== void 0) {
			raced.envelope.metadata.race = {
				mode: "first-success",
				attempts: raced.attempts
			};
			return raced.envelope;
		}
	}
	for (const id of config.routing.fallback) {
		const channel = byId.get(id);
		if (channel === void 0) continue;
		const started = Date.now();
		try {
			const result = await callVisionChannel(channel, request.inputName, request.mediaType, request.bytes, request.prompt, maxTokens, config, request.noCache, signal);
			result.metadata.attempts = attempts;
			return result;
		} catch (error) {
			attempts.push({
				channel: id,
				ok: false,
				latencyMs: Date.now() - started,
				error: errorText(error)
			});
		}
	}
	throw new Error(`no vision route succeeded: ${JSON.stringify(attempts)}`);
}
var VisionRouter = class {
	allowedRoots;
	constructor(allowedRoots) {
		this.allowedRoots = allowedRoots;
	}
	async analyze(request, config, signal) {
		const file = await resolveInput(request.path, this.allowedRoots.length > 0 ? this.allowedRoots : [process.cwd()]);
		const info = await stat(file);
		if (info.size > config.limits.maxFileBytes) throw new Error(`file exceeds maxFileBytes (${info.size} > ${config.limits.maxFileBytes})`);
		const intent = chooseIntent(request.intent, file, request.prompt, request.accurateOcr);
		const attempts = [];
		if (intent === "document") try {
			return await parseDocument(file, config, signal);
		} catch (error) {
			attempts.push({
				tool: "mineru",
				error: errorText(error)
			});
			if (!IMAGE_MIME.has(extname(file).toLowerCase())) throw new Error(`document parsing failed: ${JSON.stringify(attempts)}`);
		}
		const bytes = await readFile(file);
		const mediaType = IMAGE_MIME.get(extname(file).toLowerCase());
		if (mediaType === void 0) throw new Error(`unsupported image extension: ${extname(file)}`);
		return await routeImage({
			bytes,
			mediaType,
			inputName: file,
			prompt: request.prompt,
			intent: intent === "ocr" || intent === "document" ? "ocr" : "reason",
			complex: request.complex,
			accurateOcr: request.accurateOcr,
			noCache: request.noCache
		}, config, signal, attempts);
	}
	async analyzeImage(request, config, signal) {
		const bytes = Buffer.from(request.data);
		if (bytes.length > config.limits.maxFileBytes) throw new Error(`image exceeds maxFileBytes (${bytes.length} > ${config.limits.maxFileBytes})`);
		const intent = request.intent === "auto" ? request.accurateOcr || /\bocr\b|文字识别|提取文字/i.test(request.prompt) ? "ocr" : "reason" : request.intent;
		return await routeImage({
			bytes,
			mediaType: request.mediaType,
			inputName: request.name ?? `attachment${extensionForMediaType(request.mediaType)}`,
			prompt: request.prompt,
			intent,
			complex: request.complex,
			accurateOcr: request.accurateOcr,
			noCache: request.noCache
		}, config, signal);
	}
};
//#endregion
export { ConfigLoader as n, parseVisionConfig as r, VisionRouter as t };

//# sourceMappingURL=router-gWz8KoDD.mjs.map