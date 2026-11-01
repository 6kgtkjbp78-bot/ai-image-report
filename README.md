# 形界 FIELD · AI 形象测评站

上传一张照片 + 身高体重 → AI 从五个维度诊断 → 生成可直接执行的改造报告 → 一键导出评分卡片 → 预约到店。

- 前端：纯静态（无构建、无第三方 CDN），部署在 GitHub Pages
- 后端：Cloudflare Workers 代理阿里云百炼模型（浏览器不能直连百炼，且 API Key 不能暴露）

## 目录

```
index.html                 单页：落地 / 上传 / 分析中 / 报告
assets/css/style.css       浅色极简，移动端优先
assets/js/config.js        ⚠️ 唯一需要改的外网地址 API_BASE + 品牌信息
assets/js/main.js          流程编排、加载动效、本地持久化
assets/js/image.js         压缩 / EXIF 修正 / IndexedDB 存取
assets/js/api.js           与 Worker 通信
assets/js/report.js        报告渲染 + 雷达图绘制（分享卡共用）
assets/js/sharecard.js     1080×1440 Canvas 分享卡片
worker/src/index.js        Worker：prompt、JSON 校验、限流、代理
worker/wrangler.toml       Worker 配置（非敏感）
tools/local-test.mjs       本地直连百炼压测脚本
```

## 一、需要注册的账号（3 个）

### 1. 阿里云 → 百炼（AI 能力）
1. 注册并**完成实名认证**（个人实名即可，不实名没有免费额度）
2. 进入「百炼大模型服务平台」控制台 → 同意协议自动开通
3. 右上角头像 → **API-KEY** → 创建新的 API-KEY，地域务必选 **华北2（北京）**
4. 建议：控制台开启「免费额度用完即停」+ 账单预警阈值 ¥50
5. 记下 `sk-xxxxxxxx`（只显示一次）

### 2. Cloudflare（Worker 代理，免费版够用）
1. 注册 cloudflare.com，Workers & Pages 页右侧复制 **Account ID**
2. 本机部署用 OAuth：`npx wrangler login`（浏览器点一下即可）

### 3. GitHub（代码托管 + Pages）
1. 注册 github.com → 新建仓库（**必须 Public**，免费版 Pages 只对公开仓库开放）
2. Settings → Developer settings → Personal access tokens → **Fine-grained token**
   - 仅选择该仓库；权限勾 `Contents: Read and write`
3. 把仓库 git remote 指向你的仓库后推送

> 可选：企业微信群机器人（留资实时通知）、自定义域名（国内访问更稳，需备案）。

## 二、部署

### 前端 → GitHub Pages
```bash
cd 项目根目录
git init && git add . && git commit -m "feat: ai image report"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```
仓库 Settings → Pages → Source 选 **Deploy from a branch** → `main` / `/ (root)` → Save。
没有构建步骤，约 1–2 分钟生效，地址形如 `https://<用户名>.github.io/<仓库名>/`。

### Worker → Cloudflare
```bash
cd worker
npm i -D wrangler
npx wrangler login
npx wrangler secret put DASHSCOPE_API_KEY     # 粘贴 sk-xxx
npx wrangler secret put LEAD_WEBHOOK          # 可选：企业微信群机器人 webhook
npx wrangler deploy                            # 输出 https://xxx.workers.dev
```
把输出的 Worker 地址填进 `assets/js/config.js` 的 `API_BASE`，重新 push。

### 本地联调
```bash
cd worker && npx wrangler dev     # 默认 http://localhost:8787
# 浏览器打开：http://localhost:8000/?api=http://localhost:8787
```
地址会被记进 localStorage，方便多次调试；换回来时在 URL 再带一次 `?api=` 即可。

### 上线自检
```bash
curl https://<你的worker>.workers.dev/api/health
DASHSCOPE_API_KEY=sk-xxx node tools/local-test.mjs 一张照片.jpg
```

## 三、安全与合规

- API Key 只存在 Worker Secrets，**永不出现在代码或公开仓库**
- Worker 有三层防刷：来源白名单（上线前在 wrangler.toml 填 `ALLOWED_ORIGINS`，并把 `STRICT_ORIGIN` 改成 `"true"`）、单 IP 限流、每日总配额
- 照片在前端压缩时已剥离 EXIF（含 GPS），服务端只做转发不落库
- 改造模拟图上必须保留「AI 生成」标识（已在页面与分享卡实现）
- 备案完成后，页脚需放置 ICP 备案号

## 四、成本

| 项目 | 单价 | 单次消耗 |
|---|---|---|
| qwen3-vl-plus 分析 | ¥1–3 / 百万输入 token，¥10–30 / 百万输出 | 约 ¥0.03 |
| qwen-image-edit-plus 改造图 | ¥0.2 / 张 | ¥0.2 |

新用户约 7000 万免费 tokens + 100 张免费图片环境下，可完整跑数百次测评。

## 五、已知限制与后续

- `github.io` 与 `workers.dev` 在中国大陆访问不稳定：验证有需求后，建议迁到已备案域名 + 国内 CDN / 函数计算 —— 只需改 `assets/js/config.js` 里的 `API_BASE`
- 限流用的是 Worker 实例内存计数，跨机房为近似值；要严格限流需升级到付费版使用 Rate Limiting API
- 模型输出偶发格式漂移：`normalizeReport` 做了一整套字段兜底，保证页面永远渲染得出来
