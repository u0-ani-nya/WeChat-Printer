# WeChat Printer 图床服务端（PHP 版）

轻量自托管图床，为 WeChat Printer 提供图片上传与托管服务。PHP + Nginx，无需 Node.js。

## 功能

- UUID 鉴权：通过管理页面生成密钥，客户端凭密钥上传
- 图片上传：支持 PNG、JPEG、WebP，最大 10MB
- 静态访问：上传后的图片通过直链访问（Nginx 直接返回，不走 PHP）
- 图片删除：通过密钥 + 文件名删除已上传图片
- 管理面板：密码登录，生成/删除密钥，查看统计

## 快速部署

### 1. 放置文件

将 `image-host-server/` 目录放到你的服务器上，例如：

```bash
scp -r image-host-server/ your-server:/var/www/image-host/
```

### 2. 配置

编辑 `config.php`：

```php
// 修改管理密码
define('ADMIN_PASSWORD', '你的强密码');
```

### 3. 配置 Nginx

复制并修改 Nginx 配置：

```bash
cp nginx.conf.example /etc/nginx/sites-available/image-host
# 编辑 server_name、root、alias 路径
ln -s /etc/nginx/sites-available/image-host /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

### 4. 设置目录权限

```bash
chown -R www-data:www-data data/
chmod -R 755 data/
```

### 5. 访问

打开 `http://你的域名/`，用配置的密码登录，生成上传密钥。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 管理页面（需登录） |
| `POST` | `/api/login` | 登录 |
| `POST` | `/api/logout` | 登出 |
| `GET` | `/api/keys` | 列出密钥（需登录） |
| `POST` | `/api/keys` | 生成密钥（需登录） |
| `DELETE` | `/api/keys/:key` | 删除密钥（需登录） |
| `POST` | `/upload` | 上传图片（需 Bearer Token） |
| `DELETE` | `/file/:name` | 删除图片（需 Bearer Token） |
| `GET` | `/images/:name` | 访问图片（公开） |

### 上传图片

```
POST /upload
Headers: Authorization: Bearer <uuid>
Body: multipart/form-data, field name: file
```

响应：

```json
{
  "directUrl": "http://your-domain/images/abc123.png",
  "pageUrl": "",
  "filename": "abc123.png"
}
```

## 文件结构

```
image-host-server/
├── index.php           # 主入口（路由 + 页面）
├── config.php          # 配置文件
├── nginx.conf.example  # Nginx 配置示例
├── README.md
└── data/
    ├── keys.json       # 鉴权密钥（自动生成）
    └── uploads/        # 上传的图片
```

## 安全建议

- 修改 `config.php` 中的管理密码
- 使用 HTTPS（加 SSL 证书）
- 不要暴露 `data/` 目录
- 定期检查并清理不需要的密钥
