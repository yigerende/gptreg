# 账号设备指纹查询

原注册后台 `/admin/engine/device-fingerprints`，导航位于“平台配置”之后。仅管理员可访问页面和 `GET /api/v1/device-fingerprints`。

- 每页默认 50 条，后端搜索、筛选、排序后分页；参数为 `q`、`match`、`offset`、`limit`（1～200）。
- `q` 搜索邮箱、资产 ID、完整或部分指纹、设备 ID、注册地区、来源任务。`match` 支持 `all`、`fingerprint`（指纹重复）、`device`（设备 ID 重复）、`missing`。
- 读取现有登录态资产及归档资产，不重新生成或修改指纹、设备 ID。展开查看已保存的浏览器、语言、时区、屏幕、GPU 等配置；列表支持复制完整指纹和设备 ID。
- 重复统计在完整记录上按不同邮箱计算，包含已卖出与归档账号，不随当前页或搜索条件改变。缺失值不计为重复；记录不可读时明确提示统计可能不完整。
- 返回字段采用白名单，不返回密码、2FA、Token、Cookie、代理 URL 或代理凭据。沿用平台管理员鉴权及私有前端资源保护。
- 指纹哈希和设备 ID 分别比较；设备 ID 不同不代表浏览器指纹不同。注册地区来自资产保存的代理配置，不作为实际出口 IP 的证明。

验证：`test/device-fingerprints.test.js`、`web/src/DeviceFingerprintsPage.test.tsx`，以及 `test/platform.test.js` 中页面/API 的匿名和成员访问限制。
