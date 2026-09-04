<?php
// ─── 配置 ───

// 管理页面密码（首次使用请修改）
define('ADMIN_PASSWORD', 'changeme');

// 上传密钥鉴权文件
define('KEYS_FILE', __DIR__ . '/data/keys.json');

// 图片存储目录
define('UPLOADS_DIR', __DIR__ . '/data/uploads/');

// 最大文件大小（字节）
define('MAX_FILE_SIZE', 10 * 1024 * 1024);

// 允许的 MIME 类型
define('ALLOWED_TYPES', [
    'image/png'  => 'png',
    'image/jpeg' => 'jpg',
    'image/webp' => 'webp',
]);

// 自动清理天数（0 = 不清理）
define('AUTO_CLEANUP_DAYS', 0);
