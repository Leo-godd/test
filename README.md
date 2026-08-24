# 心理探索平台 V1

平台层第一版，暂不包含具体测试内容。

商业流程：闲鱼成交 → 后台生成验证码 → 发网址+验证码 → 用户验证 → 测试中心 → 48小时有效 → 最多5台浏览器设备。

## Cloudflare
1. 创建 D1 数据库 `psych-platform`。
2. 把 `wrangler.toml` 的 `database_id` 换成真实 ID。
3. `npx wrangler d1 migrations apply psych-platform --remote`
4. `npx wrangler secret put ADMIN_TOKEN`
5. `npx wrangler deploy`

页面：`/` 首页、`/login.html` 验证码、`/tests.html` 测试中心、`/admin.html` 后台。

验证码第一次成功验证时开始48小时倒计时；最多5台浏览器设备。浏览器本地 device token 不是永久硬件指纹，清理站点数据/换浏览器可能算新设备。
