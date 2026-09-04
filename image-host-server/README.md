# WeChat Printer 图床服务端

轻量自托管图床，为 WeChat Printer 提供图片上传与托管服务。纯 Node.js，无外部依赖。

## 功能

- UUID 鉴权：通过管理页面生成密钥，客户端凭密钥上传
- 图片上传：支持 PNG、JPEG、WebP，最大 10MB
- 静态访问：上传后的图片通过直链访问
- 图片删除：通过密钥 + 文件名删除已上传图片
- 过期清理：可配置自动清理过期图片

## 快速开始

```bash
cd image-host-server
node server.js
```

默认监听 `0.0.0.0:3900`，可通过环境变量修改：

```bash
PORT=3900 HOST=0.0.0.0 node server.js
```

## 管理页面

访问 `http://你的服务器:3900/` 进入管理页面，点击「生成新密钥」即可创建一个上传密钥。

密钥存储在 `data/keys.json`，格式：

```json
{
  "keys": [
    {
      "key": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "createdAt": "2026-09-04T09:00:00.000Z",
      "note": ""
    }
  ]
}
```

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 管理页面 |
| `POST` | `/upload` | 上传图片（需鉴权） |
| `DELETE` | `/file/:name` | 删除图片（需鉴权） |
| `GET` | `/images/:name` | 访问图片（公开） |
| `GET` | `/api/keys` | 列出所有密钥 |
| `POST` | `/api/keys` | 生成新密钥 |
| `DELETE` | `/api/keys/:key` | 删除密钥 |

### 上传图片

```
POST /upload
Headers: Authorization: Bearer <uuid>
Body: multipart/form-data, field name: file
```

响应：

```json
{
  "directUrl": "http://host:3900/images/abc123.png",
  "pageUrl": "",
  "filename": "abc123.png"
}
```

### 删除图片

```
DELETE /file/:name
Headers: Authorization: Bearer <uuid>
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3900` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `MAX_FILE_SIZE` | `10485760` | 最大上传大小（字节） |
| `AUTO_CLEANUP_DAYS` | `0` | 自动清理天数（0=不清理） |

## 数据目录

- `data/keys.json` — 鉴权密钥
- `data/uploads/` — 上传的图片
