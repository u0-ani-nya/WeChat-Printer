# WeChat Printer

本机运行的微信支付小票机打印工具：网页负责编辑和预览票面，本地 Node.js 服务负责调用打印接口、Telegram 和图床。服务默认只监听 `127.0.0.1`，不对局域网暴露。

## 界面预览

![WeChat Printer 小票编辑页面](docs/screenshot.jpg)

## 功能

- 文本打印：文字、放大文字、空行、图片、二维码、表格。
- 票面预览，支持开发者模式直接编辑请求 JSON。
- 图片处理：等比缩放（宽280）、伽马/对比度调整、透明背景处理、Floyd–Steinberg 黑白化；高度超过280时自动分片连续打印。
- Telegram 转发：私聊文字/图片/WebP sticker（可选 WebM），按消息顺序合并打印，识别粗体/斜体/链接（链接自动生成二维码）。
- 图床：支持 Imgchr、CloudFlare ImgBed、自定义图床。
- 打印保护：过滤已知无法打印的字符。
- 单消息省纸：单条消息打印时不插入分隔线，打完文字即停止。
- 本地日志：控制台输出请求、打印、Telegram、图床与错误信息。

## 系统要求

- Node.js 18+
- 现代浏览器
- 已绑定微信收款设备的微信小票机
- 如需要处理 Telegram sticker 则需安装 `ffmpeg`（WebM 抽帧还需 `ffprobe`）

无 `package.json`，仅用 Node.js 内置模块，无需 `npm install`。

## 快速开始

先克隆本仓库并进入项目目录：

```bash
git clone https://github.com/lemonno2333/WeChat-Printer.git
cd WeChat-Printer
```

**macOS**：双击 `start-local.command`，或：

```bash
node start-local.js
```

**Windows**：双击 `start-local.bat`，或：
```bat
node start-local.js
```

启动后访问 <http://127.0.0.1:4173>。只启动服务（不开浏览器）用 `node server.js`；`Ctrl+C` 停止。

若 macOS 阻止脚本运行：`chmod +x start-local.command`。

## 第一次使用

1. “文本打印”的“设备与接口”中填写设备 SN、SID 和 `account_type`；三项都必填。
2. 也可以点击“从 JSON 导入”，粘贴包含这三项的请求 JSON，自动保存并选中设备。
3. 添加对应节点，检查预览，点击“发送打印”即可。
4. 如需 Telegram 转发：在“消息监听”填写 Bot Token；设备 SN、SID 和 `account_type` 会复用“文本打印”中的唯一 `device`，点击“开始监听”即可。
5. 如需打印 Telegram 图片/sticker：确认“图床设置”可用。

设备和 Telegram 配置可存浏览器，也可在设置中切换为项目目录下的 `config.json`。

首次使用本地配置时，可复制示例并替换其中的占位值：

```bash
cp config.example.json config.json
```

`config.json` 可能包含 Bot Token、代理地址和图床凭据，请勿提交或分享；`config.example.json` 仅包含示例占位值。

示例中的 `device` 是唯一设备配置，包含 SN、SID 和 `accountType`；文本打印、设备保存入口和 Telegram 会复用这组信息，`savedDevices` 以及 `telegram` 下的设备字段不再单独保存。JSON 不支持注释，因此示例中的 `__说明` 字段用于文字说明，程序会忽略它。

## 日志

日志只输出到控制台，不写入本地文件，且不记录查询参数。级别：`INFO`（正常事件）、`WARN`（过滤/限流/非 2xx）、`ERROR`（网络/图床/打印/Telegram 异常）。

## Telegram 监听

仅处理私聊文字与图片/sticker；群聊、频道、指令、文件、视频、语音等会被忽略。

- 500ms 内的连续消息合并为一批，按 Telegram 消息顺序排列（文字在前则先文字后图，反之亦然），caption 直接打印在图片下方。单条消息不插入分隔线。
- 可限制单批字数、每用户每分钟任务数，并自定义打印中/完成/失败/过滤/限流的回复文案。
- 图片等比缩放到宽280后黑白化；高度超过280时自动分片连续打印。WebM sticker 可选取首帧/第二帧/倒数第二帧/末帧。
- 相同媒体按 `file_unique_id` 缓存处理结果，避免重复处理。Imgchr 默认缓存 7 天；ImgBed 缓存天数可配置（`0` 为永不过期）。

## 图床配置

**Imgchr**：无需凭据，需能访问 `imgchr.com`。

**CloudFlare ImgBed**：需填写根地址，可选配置 API Token、上传认证码、上传渠道、缓存天数、自动删除过期图片（需 Token 具备 `upload`+`delete` 权限）。

**自定义图床**：需填写服务器地址和 UUID 密钥。项目附带了一个轻量图床服务端（`image-host-server/`，PHP + Nginx），可部署在自己的服务器上供朋友使用。详见 [image-host-server/README.md](image-host-server/README.md)。

## 图片打印

图片可以本地上传，也可以直接填写在线 URL 打印。本地上传会依次裁剪、调整参数并生成黑白 PNG 后上传取直链；填 URL 则不重新上传，预览通过 `/api/image` 代理。

图片处理流程：缩放到宽280、等比计算高度；高度超过280时自动切分为多个280×280 的条，连续打印拼接为完整图片。

## 开发者模式

可直接编辑打印请求 JSON；发送前校验根节点、`device_sn`、`sid` 和 `account_type`。

约束：表格最多 16 列且每行列数固定（不支持合并单元格/跨列）；文字用 `text.column[].value`；放大文字/表格支持 `height`/`width` 的 0/1/2 倍率；二维码为 `icon.type = 1`，尺寸由设备固定；已知无法打印字符会统一过滤。

## 配置与运行时文件

| 文件 | 说明 |
| --- | --- |
| `config.json` | 本地配置文件，可能含 Bot Token、代理地址、图床凭据（明文，切勿提交或分享）。 |
| `config.example.json` | 可复制使用的本地配置示例，不含真实凭据；`__说明` 字段包含使用提示。 |
| `.sticker-cache.json` | Telegram 图片/sticker 处理结果缓存。 |
| `output/` | 已有输出目录，非运行必需。 |

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址（非必要不要改为 `0.0.0.0`）。 |
| `PORT` | `4173` | 监听端口。 |
| `WECHAT_PRINTER_FFMPEG` | `ffmpeg` | FFmpeg 路径。 |
| `WECHAT_PRINTER_FFPROBE` | `ffprobe` | FFprobe 路径。 |

## 开发与测试

```bash
for test in *.test.js; do node "$test" || exit 1; done
node --check server.js
node --check start-local.js
```

## HTTP 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/` | 网页界面 |
| `POST` | `/api/print?sid=...` | 转发打印请求 |
| `GET/POST/DELETE` | `/api/config` | 读取/保存/清除本地配置 |
| `POST` | `/api/image-host/upload` | 上传处理后的图片 |
| `POST` | `/api/settings/image-host` | 更新图床设置 |
| `POST` | `/api/telegram/start` | 开始 Telegram 监听 |
| `POST` | `/api/telegram/stop` | 停止监听 |
| `GET` | `/api/telegram/status` | 监听状态与日志 |
| `GET` | `/api/telegram/blacklist` | 查看封控用户 |
| `DELETE` | `/api/telegram/blacklist/:userId` | 解除封控 |
| `GET` | `/api/image?url=...` | 图片预览代理 |

仅供本机网页使用，无独立身份认证层。

## 故障排查

- **端口占用**：`PORT=4174 node start-local.js`
- **页面打不开**：确认终端出现 `local app is running`，手动访问对应端口
- **打印失败**：查看终端 `打印接口请求失败`/`打印失败` 日志，在开发者模式检查 HTTP 状态与响应体；重点排查 SN/SID/网络
- **Telegram 无法连接**：检查 Bot Token、SN、SID、API 地址、代理；`开始监听` 会先校验 Token（`getMe`），轮询失败会显示重试与错误原因
- **sticker 处理失败**：终端运行 `ffmpeg -version` / `ffprobe -version` 确认已安装，或用环境变量指定路径

## 项目结构

```text
.
├── index.html
├── styles.css
├── app.js
├── server.js
├── printable-text.js
├── telegram-layout.js
├── print-response.js
├── start-local.js
├── start-local.command
└── start-local.bat
```

## 延伸阅读

如果想了解小票机更详细的打印能力范围，可以移步至[微信小票机 P4 的不完全折腾笔记](https://lemonno.xyz/archives/P4.html)。

## 许可证

本项目采用 [MIT License](LICENSE)。
