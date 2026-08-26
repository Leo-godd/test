# 心理探索平台 V2

当前版本把平台基础设施统一为：

首页测试列表 → 选择具体测试 → 输入该测试专属验证码 → 48 小时授权 → 最多 5 台浏览器设备 → 进入对应测试。

## Cloudflare D1

项目使用 `migration/` 目录中的 D1 migrations。

首次部署或迁移：

```bash
npx wrangler d1 migrations apply psych-platform --remote
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

## 页面

- `/` 测试列表
- `/test-placeholder.html?test=stress-map` 压力地图验证码页
- `/test-placeholder.html?test=meaning` 人生意义探索验证码页
- `/tests.html?test=meaning` 已授权测试占位页
- `/admin.html` 管理后台

## 验证码规则

- 每个验证码绑定一个 `test_slug`。
- 第一次成功验证时开始计算 48 小时。
- 同一个验证码最多绑定 5 台浏览器设备。
- 同一设备在有效期内可以重复进入对应测试。
- 作废后的验证码不能再次使用。
- 验证码只在服务器端以 SHA-256 hash 保存，后台只显示一次完整验证码，数据库列表显示 preview。

## 注意

`localStorage` 中的 device token 是浏览器设备标识，不是真正的硬件指纹；清理站点数据、换浏览器或换设备可能被视为新设备。
