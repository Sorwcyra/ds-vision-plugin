# ds-vision-plugin

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的可安装视觉插件。它为纯文本主模型注册 `vision_analyze` 与 `vision_status` 两个原生工具，把工作区中的图片、截图、扫描件和文档先转换为可靠文本，再交还给 DeepSeek 继续推理。

## 能力

- 多个 OpenAI-compatible 视觉模型并发竞速，首个成功结果胜出。
- 自定义视觉模型、本地 Ollama／LM Studio 以及顺序降级。
- 百度 OCR、容器内 Tesseract OCR、MinerU 文档解析。
- 配置文件热读取、结果缓存、超时、大小限制和真实路径隔离。
- 输出统一 JSON：`task_type`、`tool_used`、`confidence`、`result`、`metadata`。
- 不读取或展示密钥；密钥仅通过指定的环境变量注入。

## 安装

要求 Node.js 22.19+ 或 24+，以及 DeepSeek Harness `0.1.0-rc.6` 或兼容的 `0.1.x` 版本。

### 推荐：Docker 一键部署

[`ds-harness-docker`](https://github.com/Sorwcyra/ds-harness-docker) 已把本插件按固定 Git 提交内置进镜像，普通使用者无需单独安装：

```powershell
git clone https://github.com/Sorwcyra/ds-harness-docker.git
cd ds-harness-docker
.\scripts\start.ps1 -Workspace "C:\path\to\project"
```

Linux/macOS 使用 `./scripts/start.sh --workspace /absolute/project/path`。随后编辑 Docker 仓库中的 `.env` 和 `config/vision.yml`；完整步骤见其 [部署手册](https://github.com/Sorwcyra/ds-harness-docker/blob/main/docs/DEPLOY.zh-CN.md)。

### 安装到已有 Harness

远程安装应固定完整提交 SHA：

```sh
dsh plugin --profile web add github:Sorwcyra/ds-vision-plugin#59eec2f17ef2918f46d94e66537035d835013116
```

本地开发安装：

```sh
pnpm install
pnpm run build
dsh plugin --profile web add file:/absolute/path/to/ds-vision-plugin
```

检查组合结果：

```sh
dsh web --dump-config
```

插件包通过 `dsh.bundle` 和 `cordis.patch.yml` 安装，不是 Codex／Claude skill，也不需要修改 Harness 源码。

## 配置

复制 `config.example.yml` 为 `vision.yml`，然后设置：

```sh
export DS_VISION_CONFIG=/absolute/path/to/vision.yml
export DS_VISION_ALLOWED_ROOTS=/absolute/workspace/root
export GLM_API_KEY=...
export AGNES_API_KEY=...
```

Windows 的多个允许目录用分号分隔；Linux/macOS 用冒号分隔。API 地址、模型、竞速组、降级组、OCR、MinerU、缓存和限额都在 `vision.yml` 中修改。`apiKeyEnv` 只填写环境变量名，不要把密钥写进 YAML。

第三方视觉模型示例：

```yaml
- id: custom-1
  type: openai-compatible
  baseUrl: https://example.com/v1/chat/completions
  model: your-vision-model
  apiKeyEnv: VISION_CUSTOM_1_API_KEY
  enabled: true
```

## 使用

向 Harness 说明图片路径和任务即可，例如“分析 `/workspace/chart.png` 的趋势”。模型应调用：

```text
vision_analyze(path, prompt, intent, complex, accurate_ocr, no_cache)
```

配置诊断使用 `vision_status()`，返回的状态不会包含密钥。

DeepSeek 官方纯文本模型不能直接接收 Web 输入框附加的图片。Harness 原生附件要求当前模型路由声明并真实支持 `image`；本插件提供的是安全的“文件路径 → 视觉工具 → 文本 → DeepSeek”路径。若选择真正的多模态主模型，Harness 自带的附件和 `read_image` 仍可与本插件及其他视觉插件同时使用。

## 开发与发布

```sh
pnpm run build
pnpm run check
npm pack --dry-run
```

仓库提交构建后的 `dist/`，因此从 GitHub checkout 安装不依赖安装期执行 `prepare`。远程安装仍应锁定 tag 或 commit。

## 安全

插件只允许访问 `allowedRoots` 内经 `realpath` 解析后的普通文件，可阻止 `..` 和符号链接逃逸。云端通道会把文件内容发送给对应提供商；敏感文件应使用本地模型或 Tesseract。许可证为 MIT。
