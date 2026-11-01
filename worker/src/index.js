/**
 * 形象测评站 API 代理 (Cloudflare Workers)
 *
 * 职责：
 *   1) 代理阿里云百炼 DashScope（浏览器不能直连，且有 CORS 限制）
 *   2) 保管 API Key（放在 Worker Secrets，代码里永不出现明文）
 *   3) 结构化的报告生成 + JSON 容错校验
 *   4) 防刷：来源白名单 + 单 IP 限流 + 每日配额 + 请求体大小限制
 *
 * 接口：
 *   GET  /api/health
 *   POST /api/analyze           -> { report, usage }
 *   POST /api/transform         -> { task_id } | { url }
 *   GET  /api/transform/status?task_id=xxx
 *   GET  /api/asset?url=xxx     -> 图片流（跨域转发）
 *   POST /api/lead              -> 推送线索到企业微信群机器人
 *   POST /api/track             -> 202（埋点，忽略失败）
 */

const MAX_BODY_BYTES = 3 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

function readConfig(env) {
  return {
    dashscopeKey: env.DASHSCOPE_API_KEY || '',
    base: (env.DS_BASE || 'https://dashscope.aliyuncs.com').replace(/\/$/, ''),
    modelVL: env.MODEL_VL || 'qwen3-vl-plus',
    modelEdit: env.MODEL_EDIT || 'qwen-image-edit-plus',
    leadWebhook: env.LEAD_WEBHOOK || '',
    allowedOrigins: (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    strictOrigin: String(env.STRICT_ORIGIN ?? 'true') === 'true',
    quotaAnalyze: Number(env.QUOTA_ANALYZE_PER_DAY || 300),
    quotaTransform: Number(env.QUOTA_TRANSFORM_PER_DAY || 150),
  };
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') return corsPreflight(origin, env);

    const corsHeaders = buildCors(origin, env);

    try {
      if (!url.pathname.startsWith('/api/')) {
        return json({ error: 'not_found' }, 404, corsHeaders);
      }
      // 来源校验（可选严格模式）：非白名单来源拒绝
      if (origin && !isOriginAllowed(origin, env) && readConfig(env).strictOrigin) {
        return json({ error: 'origin_forbidden' }, 403, corsHeaders);
      }
      if (request.method === 'POST') {
        const len = Number(request.headers.get('content-length') || 0);
        if (len > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413, corsHeaders);
      }

      const ip = clientIp(request);
      const routeKey = url.pathname.replace('/api/', '').split('/')[0];

      switch (routeKey) {
        case 'health':
          return json({ ok: true, model: readConfig(env).modelVL }, 200, corsHeaders);

        case 'analyze':
          return withGuard(ip, 'analyze', env, corsHeaders, async () => {
            const body = await readJson(request);
            return handleAnalyze(body, env, corsHeaders);
          });

        case 'transform':
          return withGuard(ip, 'transform', env, corsHeaders, async () => {
            const body = await readJson(request);
            return handleTransform(body, env, corsHeaders);
          });

        case 'transform-status':
        case 'transform/status':
          return handleTransformStatus(url.searchParams.get('task_id'), env, corsHeaders);

        case 'asset':
          return handleAsset(url.searchParams.get('url'), corsHeaders);

        case 'lead':
          return withGuard(ip, 'lead', env, corsHeaders, async () => {
            const body = await readJson(request);
            return handleLead(body, env, request, corsHeaders, ctx);
          });

        case 'track':
          return json({ ok: true }, 202, corsHeaders);

        default:
          return json({ error: 'unknown_route' }, 404, corsHeaders);
      }
    } catch (err) {
      return json({ error: 'internal_error', message: String(err && err.message) }, 500, corsHeaders);
    }
  },
};

/* ------------------------------------------------------------------ */
/* 报告生成                                                            */
/* ------------------------------------------------------------------ */

export const SYSTEM_PROMPT = `你是服务于男士（兼容女性）形象改造机构的首席形象顾问，有十余年男装版型、发型结构与脸型适配、色彩季型、场合着装的实战经验。

你的审美主张：Minimal Chic / Smart Casual / Urban Quiet Luxury —— 克制、干净、有质感，不追求抢眼。

评分准则：
- 分数衡量的是「当前形象的完成度与可塑性」，不是天生颜值。严禁评价天生美丑，严禁比较他人。
- 所有分数落在 62 至 92 之间，主体集中在 70 至 85，禁止出现满分或极低分。
- score_after 必须高于 score_total，差值控制在 6 到 14 之间，代表按你的方案改造后的可达上限。

内容准则：
- 每条 comment 和每条建议都必须具体、可执行、可被造型师直接照做。禁止出现「注意保养」「提升气质」「增强自信」这类空话。
- 必须给出数字：长度用厘米、角度或根数、宽度用指宽、发型用具体名称和长度。
- 语言克制、专业、像一位收费不菲的顾问在说话，不要讨好，不要油腻，不要使用感叹号。

肤色与用色准则（默认按中国用户暖调偏黄肤色判断）：
- 推荐基础色：藏青、炭灰、米白、燕麦。
- 提亮色：灰蓝、驼色、橄榄绿。
- 点缀色：焦糖、酒红、黄铜。
- 明确规避：荧光色、冷白与纯白、冰蓝、冷粉、任何高亮度冷色。

禁止：任何疾病、医学、心理判断；任何涉种族、地域、身体特征的贬损或调侃；任何对体重的羞辱式表达。体脂相关只能描述为「观感」。

输出要求：只输出一个 JSON 对象，不要输出 markdown 代码块，不要输出任何解释性文字，字段名严格使用下方模板。`;

export function buildUserPrompt(p) {
  const bmi = bmiOf(p.height, p.weight);
  return `请分析照片中的人物并结合身体数据，输出形象诊断报告。

【用户资料】
性别：${safeText(p.gender) || '未填'}
身高：${safeNum(p.height)} cm，体重：${safeNum(p.weight)} kg（BMI 约 ${bmi}）
年龄段：${safeText(p.age) || '未填'}
主要场景诉求：${safeText(p.scene) || '日常通勤与社交'}
照片类型：${safeText(p.shot) || '未知'}
说明：照片可能只拍到局部，看得见的部位就基于画面分析，看不见的部位依据身高体重推断，并在对应 comment 里注明「推断」。

【严格输出以下 JSON 结构】
{
  "score_total": 0-100 的整数,
  "score_after": 0-100 的整数,
  "one_line": "一句话诊断，20字以内，要具体不要客套",
  "archetype": { "name": "四字气质类型，如：盐系清冷 / 温润书卷 / 硬朗都市", "slogan": "一句风格主张，18字以内", "keywords": ["关键词1", "关键词2", "关键词3"] },
  "radar": [
    {"key":"bone","label":"骨相轮廓","score":0-100,"comment":"针对脸型与头肩比的具体描述，30字以内"},
    {"key":"skin","label":"皮肤状态","score":0-100,"comment":"肤色冷暖与质感描述，30字以内"},
    {"key":"hair","label":"发型完成度","score":0-100,"comment":"现存发型问题，30字以内"},
    {"key":"frame","label":"身材框架","score":0-100,"comment":"身高体重推导的身架判断，30字以内"},
    {"key":"outfit","label":"穿搭水准","score":0-100,"comment":"当前穿着的版型与配色问题，30字以内"},
    {"key":"aura","label":"气质记忆点","score":0-100,"comment":"最有辨识度的个人特质，30字以内"}
  ],
  "face": {
    "shape": "脸型判断，如：方圆脸偏短",
    "proportion": "三庭五眼与五官量感，一句话",
    "brow_eye": "眉眼现状与问题，一句话",
    "skin_tone": "肤色冷暖与明度，如：暖调偏黄，中低明度",
    "hair_now": "发型现状与核心问题，一句话"
  },
  "body": {
    "bmi": "数字，保留一位小数",
    "build": "体型判断，如：偏瘦但肩窄，视觉重心偏低",
    "ratio": "上下身比例判断",
    "focus": "身材层面最该优先解决的一件事"
  },
  "roi": [
    {"item":"发型","delta":数字保留一位,"reason":"为什么这项收益最高，25字以内"},
    {"item":"穿搭","delta":数字保留一位,"reason":"25字以内"},
    {"item":"妆造","delta":数字保留一位,"reason":"25字以内"}
  ],
  "advice": {
    "hair": [
      {"do":"具体发型做法，含长度或打理方式","avoid":"明确不要做什么"},
      {"do":"...","avoid":"..."},
      {"do":"...","avoid":"..."}
    ],
    "outfit": {
      "palette": ["主色1","主色2","主色3","提亮色"],
      "avoid": ["规避色1","规避色2"],
      "items": ["具体单品1","具体单品2","具体单品3"],
      "fit": "版型与比例处理要点，一句话"
    },
    "grooming": ["眉形或面部毛发具体处理","底妆或护肤方向","香氛或细节建议"]
  },
  "plan_7d": [
    {"day":1,"task":"当天可完成的具体动作"},
    {"day":2,"task":"..."},
    {"day":3,"task":"..."},
    {"day":4,"task":"..."},
    {"day":5,"task":"..."},
    {"day":6,"task":"..."},
    {"day":7,"task":"..."}
  ],
  "transform_prompt": "给图像编辑模型的指令：在不改变人物身份特征的前提下，把发型换成 XX、服装换成 XX、光线干净、背景虚化，正面半身、真实质感、不要改变五官。控制在 80 字以内。",
  "share_text": "第一人称的分享文案，像发给朋友的一句话，40字以内，不要营销腔"
}`;
}

async function handleAnalyze(body, env, corsHeaders) {
  const cfg = readConfig(env);
  if (!cfg.dashscopeKey) return json({ error: 'missing_api_key' }, 500, corsHeaders);

  const image = normalizeImage(body.image);
  if (!image) return json({ error: 'bad_image' }, 400, corsHeaders);

  const profile = body.profile || {};
  const userPrompt = buildUserPrompt(profile);

  // 最多两次尝试：第二次降低温度并加大重复惩罚，提升 JSON 稳定性
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const payload = {
        model: cfg.modelVL,
        input: {
          messages: [
            { role: 'system', content: [{ text: SYSTEM_PROMPT }] },
            { role: 'user', content: [{ image }, { text: userPrompt }] },
          ],
        },
        parameters: {
          enable_thinking: false,
          temperature: attempt === 0 ? 0.7 : 0.3,
          max_tokens: 3000,
        },
      };
      const res = await fetch(`${cfg.base}/api/v1/services/aigc/multimodal-generation/generation`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.dashscopeKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const raw = await res.text();
      if (!res.ok) {
        lastErr = `dashscope_${res.status}: ${raw.slice(0, 400)}`;
        continue;
      }
      const text = extractText(raw);
      if (!text) {
        lastErr = 'empty_model_output';
        continue;
      }
      const parsed = parseLooseJson(text);
      if (!parsed) {
        lastErr = 'json_parse_failed';
        continue;
      }
      const report = normalizeReport(parsed, profile);
      const usage = extractUsage(raw);
      return json({ report, usage, raw_len: text.length }, 200, corsHeaders);
    } catch (err) {
      lastErr = String(err && err.message);
    }
  }
  return json({ error: 'analyze_failed', message: lastErr }, 502, corsHeaders);
}

/* ------------------------------------------------------------------ */
/* 改造后模拟图                                                        */
/* ------------------------------------------------------------------ */

async function handleTransform(body, env, corsHeaders) {
  const cfg = readConfig(env);
  if (!cfg.dashscopeKey) return json({ error: 'missing_api_key' }, 500, corsHeaders);

  const image = normalizeImage(body.image);
  if (!image) return json({ error: 'bad_image' }, 400, corsHeaders);

  const prompt = cleanInstruction(body.prompt) || '保持人物身份不变，发型改为干净利落的短发，服装改为深色简约质感上衣，光线柔和，背景虚化，真实摄影质感，不要改变五官';

  const payload = {
    model: cfg.modelEdit,
    input: {
      messages: [{ role: 'user', content: [{ image }, { text: prompt }] }],
    },
    parameters: { n: 1, watermark: false, prompt_extend: true },
  };

  const res = await fetch(`${cfg.base}/api/v1/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.dashscopeKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  if (!res.ok) return json({ error: 'transform_failed', message: raw.slice(0, 400) }, 502, corsHeaders);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json({ error: 'transform_bad_response' }, 502, corsHeaders);
  }

  // 同步返回：直接取图片地址
  const syncUrl = extractImageUrl(data);
  if (syncUrl) return json({ url: syncUrl, mode: 'sync' }, 200, corsHeaders);

  // 异步返回：拿 task_id 让前端轮询
  const taskId = data?.output?.task_id || data?.task_id;
  if (taskId) return json({ task_id: taskId, mode: 'async' }, 200, corsHeaders);

  return json({ error: 'transform_no_result', message: raw.slice(0, 300) }, 502, corsHeaders);
}

async function handleTransformStatus(taskId, env, corsHeaders) {
  if (!taskId) return json({ error: 'missing_task_id' }, 400, corsHeaders);
  const cfg = readConfig(env);
  const res = await fetch(`${cfg.base}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${cfg.dashscopeKey}` },
  });
  const raw = await res.text();
  if (!res.ok) return json({ status: 'FAILED', message: raw.slice(0, 200) }, 200, corsHeaders);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json({ status: 'RUNNING' }, 200, corsHeaders);
  }
  const taskStatus = data?.task_status || data?.output?.task_status || 'RUNNING';
  const url = extractImageUrl(data);
  return json({ status: taskStatus, url: url || null }, 200, corsHeaders);
}

async function handleAsset(target, corsHeaders) {
  if (!target || !/^https:\/\//.test(target)) {
    return json({ error: 'bad_asset_url' }, 400, corsHeaders);
  }
  const upstream = await fetch(target, { headers: { Accept: 'image/*' } });
  if (!upstream.ok) return json({ error: 'asset_fetch_failed' }, 502, corsHeaders);
  const headers = new Headers(corsHeaders);
  headers.set('Content-Type', upstream.headers.get('Content-Type') || 'image/jpeg');
  headers.set('Cache-Control', 'public, max-age=86400');
  return new Response(upstream.body, { status: 200, headers });
}

/* ------------------------------------------------------------------ */
/* 线索推送                                                            */
/* ------------------------------------------------------------------ */

async function handleLead(body, env, request, corsHeaders, ctx) {
  const cfg = readConfig(env);
  const name = cleanInstruction(body.name, 20) || '未留名';
  const contact = `${cleanInstruction(body.phone, 30) || '-'} / ${cleanInstruction(body.wechat, 40) || '-'}`;
  const expect = cleanInstruction(body.expect_time, 30) || '未填写';
  const summary = cleanInstruction(body.summary, 300) || '';

  const content = [
    '【形象测评站 · 新的预约】',
    `姓名：${name}`,
    `手机/微信：${contact}`,
    `期望到店：${expect}`,
    summary ? `测评摘要：${summary}` : '',
    `时间：${new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19)}`,
  ]
    .filter(Boolean)
    .join('\n');

  if (cfg.leadWebhook) {
    const pusher = fetch(cfg.leadWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content } }),
    }).catch(() => null);
    if (ctx && ctx.waitUntil) ctx.waitUntil(pusher);
    else await pusher;
  }
  return json({ ok: true, pushed: Boolean(cfg.leadWebhook) }, 200, corsHeaders);
}

/* ------------------------------------------------------------------ */
/* 安全：来源校验 + 限流                                               */
/* ------------------------------------------------------------------ */

function isOriginAllowed(origin, env) {
  const { allowedOrigins } = readConfig(env);
  if (!allowedOrigins.length) return true;
  return allowedOrigins.some((o) => o === origin || origin.endsWith(o.replace('https://', '')));
}

const buckets = new Map(); // ip:kind -> timestamps[]

async function withGuard(ip, kind, env, corsHeaders, next) {
  const cfg = readConfig(env);
  const now = Date.now();

  // 单 IP 限流：analyze 10次/时、transform 5次/时、lead 10次/时
  const hourly = { analyze: 10, transform: 5, lead: 10 }[kind] || 10;
  const key = `${ip}:${kind}`;
  const hits = (buckets.get(key) || []).filter((t) => now - t < 3600e3);
  if (hits.length >= hourly) {
    buckets.set(key, hits);
    return json({ error: 'rate_limited', retry_in: 3600 - Math.floor((now - hits[0]) / 1000) }, 429, corsHeaders);
  }
  hits.push(now);
  buckets.set(key, hits);

  // 每日总配额（按 isolate 计数，跨机房近似值，防止账单失控的兜底）
  const dayKey = `${kind}:day:${new Date(now + 8 * 3600e3).toISOString().slice(0, 10)}`;
  const quota = kind === 'transform' ? cfg.quotaTransform : cfg.quotaAnalyze;
  const used = Number(buckets.get(dayKey) || 0);
  if (used >= quota) return json({ error: 'daily_quota_exceeded' }, 429, corsHeaders);
  buckets.set(dayKey, used + 1);

  if (buckets.size > 20000) buckets.clear(); // 简易内存保护

  return next();
}

function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  );
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function corsPreflight(origin, env) {
  const headers = buildCors(origin, env);
  return new Response(null, { status: 204, headers });
}

function buildCors(origin, env) {
  const { allowedOrigins } = readConfig(env);
  const allow = allowedOrigins.length
    ? allowedOrigins.includes(origin)
      ? origin
      : allowedOrigins[0]
    : origin || '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function normalizeImage(value) {
  if (typeof value !== 'string') return null;
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(value.trim());
  if (!m) return null;
  if (value.length > MAX_BODY_BYTES * 1.4) return null;
  return `data:image/${m[1] === 'jpg' ? 'jpeg' : m[1]};base64,${m[2]}`;
}

function extractText(raw) {
  try {
    const data = JSON.parse(raw);
    const content = data?.output?.choices?.[0]?.message?.content;
    if (Array.isArray(content)) {
      return content.map((c) => c?.text || '').join('').trim();
    }
    if (typeof content === 'string') return content.trim();
    return data?.choices?.[0]?.message?.content || '';
  } catch {
    return '';
  }
}

function extractImageUrl(data) {
  const content = data?.output?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    for (const item of content) if (item?.image) return item.image;
  }
  const results = data?.output?.results || data?.results;
  if (Array.isArray(results)) {
    for (const r of results) if (r?.url) return r.url;
  }
  const choices = data?.output?.choices?.[0]?.message?.content;
  if (choices && choices[0] && choices[0].image) return choices[0].image;
  return null;
}

function extractUsage(raw) {
  try {
    const u = JSON.parse(raw)?.usage;
    return u ? { input: u.input_tokens, output: u.output_tokens } : null;
  } catch {
    return null;
  }
}

/** 剥离 ```json 围栏、取最外层花括号，容错解析 */
export function parseLooseJson(text) {
  const cleaned = text
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* 继续尝试截取 */
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function clamp(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function safeText(v) {
  return typeof v === 'string' ? v.slice(0, 40) : '';
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

function cleanInstruction(v, max = 200) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\r\n`]/g, ' ').trim().slice(0, max);
}

function bmiOf(height, weight) {
  const h = Number(height) / 100;
  const w = Number(weight);
  if (!Number.isFinite(h) || !Number.isFinite(w) || h <= 0) return 0;
  return Math.round((w / (h * h)) * 10) / 10;
}

const RADAR_KEYS = [
  ['bone', '骨相轮廓'],
  ['skin', '皮肤状态'],
  ['hair', '发型完成度'],
  ['frame', '身材框架'],
  ['outfit', '穿搭水准'],
  ['aura', '气质记忆点'],
];

/** 兜底：把模型输出的任意形态整理成前端可直接渲染的结构 */
export function normalizeReport(d, profile) {
  const radarRaw = Array.isArray(d.radar) ? d.radar : [];
  const radar = RADAR_KEYS.map(([key, label], i) => {
    const hit = radarRaw.find((r) => r && (r.key === key || r.label === label)) || radarRaw[i] || {};
    return {
      key,
      label: typeof hit.label === 'string' ? hit.label.slice(0, 8) : label,
      score: clamp(hit.score, 55, 95, 72),
      comment: typeof hit.comment === 'string' ? hit.comment.slice(0, 60) : '依据照片与身高体重推断',
    };
  });

  const roiRaw = Array.isArray(d.roi) ? d.roi : [];
  const roi = ['发型', '穿搭', '妆造'].map((item, i) => {
    const hit = roiRaw.find((r) => r && String(r.item).includes(item.slice(0, 2))) || roiRaw[i] || {};
    return {
      item,
      delta: Math.min(9, Math.max(0.3, Number(hit.delta) || [4.2, 2.8, 1.1][i])),
      reason: typeof hit.reason === 'string' ? hit.reason.slice(0, 50) : '投入产出比最高的改动项',
    };
  });

  const hairRaw = Array.isArray(d.advice?.hair) ? d.advice.hair : [];
  const hair = [0, 1, 2].map((i) => ({
    do: typeof hairRaw[i]?.do === 'string' ? hairRaw[i].do.slice(0, 60) : '建议到店与造型师当面确认长度与纹理',
    avoid: typeof hairRaw[i]?.avoid === 'string' ? hairRaw[i].avoid.slice(0, 40) : '避免自行大面积推剪',
  }));

  const planRaw = Array.isArray(d.plan_7d) ? d.plan_7d : [];
  const plan = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
    day,
    task: typeof planRaw[day - 1]?.task === 'string' ? planRaw[day - 1].task.slice(0, 60) : '按本报告调整一处细节并记录照片',
  }));

  const total = clamp(d.score_total, 60, 92, 74);
  const after = clamp(d.score_after, total + 4, Math.min(98, total + 16), Math.min(96, total + 10));

  return {
    score_total: total,
    score_after: after,
    one_line:
      typeof d.one_line === 'string' && d.one_line.trim()
        ? d.one_line.slice(0, 40)
        : '底子在线，输在细节没有被处理',
    archetype: {
      name: typeof d.archetype?.name === 'string' ? d.archetype.name.slice(0, 8) : '都市克制型',
      slogan: typeof d.archetype?.slogan === 'string' ? d.archetype.slogan.slice(0, 30) : '干净比抢眼更重要',
      keywords: Array.isArray(d.archetype?.keywords)
        ? d.archetype.keywords.slice(0, 3).map((k) => String(k).slice(0, 6))
        : ['低饱和', '直线条', '哑光质感'],
    },
    radar,
    face: pickStrings(d.face, ['shape', 'proportion', 'brow_eye', 'skin_tone', 'hair_now'], {
      shape: '依据画面判断的脸型',
      proportion: '五官量感适中',
      brow_eye: '眉形可作精细修整',
      skin_tone: '暖调偏黄，中低明度',
      hair_now: '发型缺少纹理与蓬松度',
    }),
    body: {
      bmi: bmiOf(profile?.height, profile?.weight),
      build: String(d.body?.build || '依据身高体重的体型判断').slice(0, 40),
      ratio: String(d.body?.ratio || '上下身比例待到店实测').slice(0, 40),
      focus: String(d.body?.focus || '优先解决肩部与腰线').slice(0, 40),
    },
    roi,
    advice: {
      hair,
      outfit: {
        palette: Array.isArray(d.advice?.outfit?.palette)
          ? d.advice.outfit.palette.slice(0, 5).map((c) => String(c).slice(0, 6))
          : ['藏青', '炭灰', '米白', '灰蓝'],
        avoid: Array.isArray(d.advice?.outfit?.avoid)
          ? d.advice.outfit.avoid.slice(0, 3).map((c) => String(c).slice(0, 6))
          : ['荧光色', '冷白'],
        items: Array.isArray(d.advice?.outfit?.items)
          ? d.advice.outfit.items.slice(0, 4).map((c) => String(c).slice(0, 14))
          : ['合身深色直筒裤', '哑光质感外套'],
        fit: String(d.advice?.outfit?.fit || '上短下长，腰线提高').slice(0, 50),
      },
      grooming: Array.isArray(d.advice?.grooming)
        ? d.advice.grooming.slice(0, 3).map((g) => String(g).slice(0, 50))
        : ['修整眉形，保持干净边界', '控油为主的哑光底妆方向'],
    },
    plan_7d: plan,
    transform_prompt:
      typeof d.transform_prompt === 'string' && d.transform_prompt.trim()
        ? d.transform_prompt.slice(0, 200)
        : '保持人物身份与五官不变，发型改为干净利落的短发，服装改为深色简约上衣，柔和光线，背景虚化，真实摄影质感',
    share_text:
      typeof d.share_text === 'string' && d.share_text.trim()
        ? d.share_text.slice(0, 60)
        : `测出来 ${total} 分，说我改完能到 ${after} 分。有点想试试。`,
  };
}

function pickStrings(source, keys, fallback) {
  const out = { ...fallback };
  const src = source && typeof source === 'object' ? source : {};
  for (const k of keys) {
    const v = src[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.slice(0, 40);
  }
  return out;
}
