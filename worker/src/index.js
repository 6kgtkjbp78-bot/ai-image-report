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
  "share_text": "第一人称的分享文案，像发给朋友的一句话，40字以内，不要营销腔",
  "stars": {
    "first_look": "第一眼吸引力，1-5，0.5 步进",
    "camera": "镜头表现力，1-5",
    "affinity": "亲和感染力，1-5",
    "identity": "个人识别度，1-5",
    "potential": "潜力成长值，1-5，可略高，体现可塑性"
  },
  "conclusion": "测试结论，3句话：先肯定五官或气质底子，再点出一个最影响观感的短板，最后给一句改造预期。60字以内",
  "feature_types": [
    {"part":"额头","type":"类型命名，如：圆润饱满型","desc":"一句具体描述，20字以内"},
    {"part":"眉毛","type":"如：自然弯月眉","desc":"20字以内"},
    {"part":"眼睛","type":"如：杏仁灵动眼","desc":"20字以内"},
    {"part":"鼻子","type":"如：直鼻（细挺型）","desc":"20字以内"},
    {"part":"嘴巴","type":"如：M唇（微丰型）","desc":"20字以内"},
    {"part":"下巴","type":"如：小巧圆润下巴","desc":"20字以内"},
    {"part":"脸型","type":"如：鹅蛋（偏长）脸","desc":"20字以内"}
  ],
  "celebrity": [
    {"name":"与用户同性的真实华人明星","similarity":"70-90 的整数，从高到低","vibe":"一句话气质概括，12字以内","tags":["最相似的面部特征1","特征2"]},
    {"name":"...","similarity":"...","vibe":"...","tags":["...","..."]},
    {"name":"...","similarity":"...","vibe":"...","tags":["...","..."]}
  ],
  "features": {
    "眼睛": {"tags":["眼型标签1","标签2","标签3"],"summary":"一句话总评，25字以内","pros":["具体优势1","优势2","优势3"],"tips":["具体美化建议1","建议2"]},
    "鼻子": {"tags":["鼻型标签1","标签2","标签3"],"summary":"25字以内","pros":["...","...","..."],"tips":["...","..."]},
    "嘴唇": {"tags":["唇形标签1","标签2","标签3"],"summary":"25字以内","pros":["...","...","..."],"tips":["...","..."]}
  },
  "skin_analysis": {
    "type":"肤质类型，如：混合性肌",
    "tone":"肤色，如：自然肤色",
    "undertone":"色调，如：暖色调",
    "texture":"质地，如：毛孔可见",
    "pores":"毛孔，如：略粗毛孔",
    "elasticity":"弹性，如：弹性充足",
    "moisture":"水分，如：水润充盈",
    "pros":["皮肤优势1","优势2","优势3"],
    "cautions":["注意事项1","注意事项2"],
    "tips":["护肤建议1","护肤建议2"]
  },
  "intl_standards": [
    {"item":"三庭比例","yours":"实际观察，如：上庭偏短","standard":"1:1:1","verdict":"一句话评价，15字以内"},
    {"item":"五眼宽度","yours":"...","standard":"五等分","verdict":"..."},
    {"item":"鼻唇角度","yours":"...","standard":"90-95度","verdict":"..."},
    {"item":"下颌线条","yours":"...","standard":"120度左右","verdict":"..."}
  ],
  "energy_radar": [
    {"label":"亲和力","score":"60-95 整数"},
    {"label":"表达力","score":"..."},
    {"label":"判断力","score":"..."},
    {"label":"气场值","score":"..."},
    {"label":"稳定感","score":"..."},
    {"label":"镜头感","score":"..."}
  ],
  "aura_keywords": ["气质关键词1","关键词2","关键词3","关键词4"],
  "impressions": [
    "第一印象评价，像朋友口吻的一句话，20字以内",
    "第二句，侧重气质氛围",
    "第三句，侧重上镜或辨识度"
  ],
  "optimizations": {
    "发型":"结合脸型的具体优化一句，25字以内",
    "妆容":"具体建议一句，男性指底妆/修眉方向，25字以内",
    "穿搭":"色系与剪裁建议一句，25字以内",
    "配饰":"眼镜/配饰建议一句，25字以内"
  },
  "color_recs": [
    {"name":"色系名，如：低饱和奶咖色系","desc":"效果描述，15字以内","colors":["3-4个具体hex色值"]},
    {"name":"...","desc":"...","colors":["..."]},
    {"name":"...","desc":"...","colors":["..."]}
  ],
  "hair_recs": [
    {"name":"具体发型名，如：中长层次直发（男性则男士发型名）","desc":"效果描述，15字以内","prompt":"给图像编辑模型的指令：保持人物五官、表情、服装、背景完全不变，只把发型换成该款，发色自然黑，真实摄影质感。40字以内"},
    {"name":"...","desc":"...","prompt":"..."},
    {"name":"...","desc":"...","prompt":"..."}
  ]
}

【补充规则】
- celebrity 必须给同性别的真实华人明星；相似度是面部特征层面的近似，不要给完全不像的。
- 所有标签、描述都要基于照片可见证据，禁止套话。
- 男性用户的「妆容」指男士底妆、修眉、控油；「发型推荐」必须是男士发型。
- color_recs 的色系要遵守肤色用色准则，hex 色值要真实可渲染。

【发型推荐铁律】
- hair_recs 的 3 款必须是同一风格族内的变化（长度/纹理/刘海形态不同），主方向必须与 transform_prompt 一致，禁止三款风格互相打架。
- 推荐前先判断脸型与发际线，严格规避放大短板的发型：
  · 方圆脸偏短、发际线不整齐、额角后移 → 禁止全露额发型（前刺、背头、飞机头），优先带刘海的碎盖/逗号刘海/侧分纹理。
  · 长脸 → 禁止继续拉高颅顶的蓬松款，优先两侧有量感、带刘海的横向平衡款。
  · 圆脸 → 禁止齐刘海厚盖，优先露部分额头、顶部有高度的款。
- 每款都要是理发店里能剪出来的真实发型，禁止臆造名称。`;
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
          max_tokens: 8000,
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
  if (!res.ok) {
    const throttled = /Throttling|RateQuota|rate limit/i.test(raw);
    return json(
      { error: throttled ? 'transform_throttled' : 'transform_failed', message: raw.slice(0, 400) },
      throttled ? 429 : 502,
      corsHeaders
    );
  }

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

  /* ---------------- 新报告字段兜底 ---------------- */

  const isFemale = /女/.test(String(profile?.gender || ''));

  const starRaw = d.stars && typeof d.stars === 'object' ? d.stars : {};
  const star = (k, fb) => {
    const v = Number(starRaw[k]);
    if (!Number.isFinite(v)) return fb;
    return Math.min(5, Math.max(2.5, Math.round(v * 2) / 2));
  };
  const stars = {
    first_look: star('first_look', 4),
    camera: star('camera', 3.5),
    affinity: star('affinity', 4),
    identity: star('identity', 3.5),
    potential: star('potential', 4.5),
  };

  const ftRaw = Array.isArray(d.feature_types) ? d.feature_types : [];
  const FT_PARTS = ['额头', '眉毛', '眼睛', '鼻子', '嘴巴', '下巴', '脸型'];
  const feature_types = FT_PARTS.map((part, i) => {
    const hit = ftRaw.find((f) => f && String(f.part || '').includes(part)) || ftRaw[i] || {};
    return {
      part,
      type: typeof hit.type === 'string' && hit.type.trim() ? hit.type.slice(0, 12) : '标准型',
      desc: typeof hit.desc === 'string' && hit.desc.trim() ? hit.desc.slice(0, 30) : '比例协调，无明显短板',
    };
  });

  const celebRaw = Array.isArray(d.celebrity) ? d.celebrity : [];
  const celebDefault = isFemale
    ? [['周也', '清冷灵气的少女颜'], ['章若楠', '温柔干净的初恋脸'], ['倪妮', '高级耐看的氛围感']]
    : [['吴磊', '干净清爽的少年感'], ['白敬亭', '清秀克制的盐系感'], ['李现', '硬朗耐看的都市感']];
  const celebrity = [0, 1, 2].map((i) => {
    const hit = celebRaw[i] || {};
    const sim = clamp(hit.similarity, 60, 95, 82 - i * 3);
    return {
      name: typeof hit.name === 'string' && hit.name.trim() ? hit.name.slice(0, 6) : celebDefault[i][0],
      similarity: sim,
      vibe: typeof hit.vibe === 'string' && hit.vibe.trim() ? hit.vibe.slice(0, 16) : celebDefault[i][1],
      tags: Array.isArray(hit.tags) && hit.tags.length
        ? hit.tags.slice(0, 2).map((t) => String(t).slice(0, 8))
        : ['面部轮廓', '五官量感'],
    };
  });

  const featRaw = d.features && typeof d.features === 'object' ? d.features : {};
  const normFeature = (key, defSummary) => {
    const f = featRaw[key] && typeof featRaw[key] === 'object' ? featRaw[key] : {};
    return {
      tags: Array.isArray(f.tags) && f.tags.length ? f.tags.slice(0, 3).map((t) => String(t).slice(0, 8)) : ['形态标准', '比例协调', '量感适中'],
      summary: typeof f.summary === 'string' && f.summary.trim() ? f.summary.slice(0, 40) : defSummary,
      pros: Array.isArray(f.pros) && f.pros.length ? f.pros.slice(0, 3).map((t) => String(t).slice(0, 30)) : ['形态自然，比例协调'],
      tips: Array.isArray(f.tips) && f.tips.length ? f.tips.slice(0, 2).map((t) => String(t).slice(0, 30)) : ['保持干净清爽即可'],
    };
  };
  const features = {
    眼睛: normFeature('眼睛', '眼部形态自然，神态放松'),
    鼻子: normFeature('鼻子', '鼻部线条自然，与面部比例协调'),
    嘴唇: normFeature('嘴唇', '唇形自然，上下唇比例协调'),
  };

  const sk = d.skin_analysis && typeof d.skin_analysis === 'object' ? d.skin_analysis : {};
  const skin_analysis = {
    type: typeof sk.type === 'string' && sk.type.trim() ? sk.type.slice(0, 10) : '混合性肌',
    tone: typeof sk.tone === 'string' && sk.tone.trim() ? sk.tone.slice(0, 10) : '自然肤色',
    undertone: typeof sk.undertone === 'string' && sk.undertone.trim() ? sk.undertone.slice(0, 10) : '暖色调',
    texture: typeof sk.texture === 'string' && sk.texture.trim() ? sk.texture.slice(0, 10) : '纹理细腻',
    pores: typeof sk.pores === 'string' && sk.pores.trim() ? sk.pores.slice(0, 10) : '毛孔正常',
    elasticity: typeof sk.elasticity === 'string' && sk.elasticity.trim() ? sk.elasticity.slice(0, 10) : '弹性正常',
    moisture: typeof sk.moisture === 'string' && sk.moisture.trim() ? sk.moisture.slice(0, 10) : '水分适中',
    pros: Array.isArray(sk.pros) && sk.pros.length ? sk.pros.slice(0, 3).map((t) => String(t).slice(0, 24)) : ['肤质整体健康', '屏障状态稳定'],
    cautions: Array.isArray(sk.cautions) && sk.cautions.length ? sk.cautions.slice(0, 2).map((t) => String(t).slice(0, 24)) : ['注意清洁，预防毛孔堵塞', '注意防晒，预防光老化'],
    tips: Array.isArray(sk.tips) && sk.tips.length ? sk.tips.slice(0, 2).map((t) => String(t).slice(0, 30)) : ['保持充足水分摄入', '选择温和的洁面产品'],
  };

  const intlRaw = Array.isArray(d.intl_standards) ? d.intl_standards : [];
  const INTL = [
    ['三庭比例', '1:1:1'],
    ['五眼宽度', '五等分'],
    ['鼻唇角度', '90-95度'],
    ['下颌线条', '120度左右'],
  ];
  const intl_standards = INTL.map(([item, standard], i) => {
    const hit = intlRaw.find((s) => s && String(s.item || '').includes(item.slice(0, 2))) || intlRaw[i] || {};
    return {
      item,
      standard,
      yours: typeof hit.yours === 'string' && hit.yours.trim() ? hit.yours.slice(0, 16) : '接近标准',
      verdict: typeof hit.verdict === 'string' && hit.verdict.trim() ? hit.verdict.slice(0, 24) : '比例协调，无明显偏离',
    };
  });

  const ENERGY = ['亲和力', '表达力', '判断力', '气场值', '稳定感', '镜头感'];
  const energyRaw = Array.isArray(d.energy_radar) ? d.energy_radar : [];
  const energy_radar = ENERGY.map((label, i) => {
    const hit = energyRaw.find((e) => e && e.label === label) || energyRaw[i] || {};
    return { label, score: clamp(hit.score, 55, 96, 78 + ((i * 7) % 12)) };
  });

  const aura_keywords = Array.isArray(d.aura_keywords) && d.aura_keywords.length
    ? d.aura_keywords.slice(0, 4).map((k) => String(k).slice(0, 6))
    : ['干净清爽', '耐看', '上镜感', '可塑性强'];
  while (aura_keywords.length < 4) aura_keywords.push(['干净清爽', '耐看', '上镜感', '可塑性强'][aura_keywords.length]);

  const impressions = Array.isArray(d.impressions) && d.impressions.length
    ? d.impressions.slice(0, 3).map((s) => String(s).slice(0, 30))
    : ['第一眼干净舒服，越看越有味道。', '气质克制，有自己的节奏感。', '五官条件在线，上镜不吃亏。'];
  while (impressions.length < 3) impressions.push('整体协调，风格可塑性强。');

  const optRaw = d.optimizations && typeof d.optimizations === 'object' ? d.optimizations : {};
  const optimizations = {
    发型: typeof optRaw['发型'] === 'string' ? optRaw['发型'].slice(0, 40) : '保持头顶蓬松与层次，避免贴头皮。',
    妆容: typeof optRaw['妆容'] === 'string' ? optRaw['妆容'].slice(0, 40) : isFemale ? '清透底妆，突出五官优势部位。' : '控油哑光底妆，修眉去杂毛。',
    穿搭: typeof optRaw['穿搭'] === 'string' ? optRaw['穿搭'].slice(0, 40) : '以低饱和高级色系为主，剪裁合身。',
    配饰: typeof optRaw['配饰'] === 'string' ? optRaw['配饰'].slice(0, 40) : '小巧精致为主，提升细节质感。',
  };

  const COLOR_DEFAULTS = [
    { name: '藏青炭灰系', desc: '克制高级，通勤不出错', colors: ['#1B2C4A', '#3A4149', '#5B6470', '#8892A0'] },
    { name: '米白燕麦系', desc: '柔和提亮，亲和力加分', colors: ['#EFE9DD', '#D9CFBC', '#C4B79F', '#A99B80'] },
    { name: '灰蓝驼色系', desc: '冷暖平衡，显白提气', colors: ['#7C93A8', '#5F7A93', '#B08D5E', '#8C6B45'] },
  ];
  const colorRaw = Array.isArray(d.color_recs) ? d.color_recs : [];
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const color_recs = [0, 1, 2].map((i) => {
    const hit = colorRaw[i] || {};
    const fb = COLOR_DEFAULTS[i];
    const colors = Array.isArray(hit.colors) ? hit.colors.map((c) => String(c)).filter((c) => HEX.test(c)).slice(0, 4) : [];
    return {
      name: typeof hit.name === 'string' && hit.name.trim() ? hit.name.slice(0, 12) : fb.name,
      desc: typeof hit.desc === 'string' && hit.desc.trim() ? hit.desc.slice(0, 24) : fb.desc,
      colors: colors.length >= 3 ? colors : fb.colors,
    };
  });

  const HAIR_DEFAULTS = isFemale
    ? [['中长层次直发', '简约自然，修饰脸型'], ['轻法式八字刘海', '柔和减龄，提升氛围感'], ['自然微卷锁骨发', '温柔慵懒，增强灵动感']]
    : [['微分碎盖', '蓬松纹理，修饰脸型'], ['美式前刺', '利落立体，增强轮廓'], ['侧分油头', '成熟克制，通勤质感']];
  const hairRawRec = Array.isArray(d.hair_recs) ? d.hair_recs : [];
  const hair_recs = [0, 1, 2].map((i) => {
    const hit = hairRawRec[i] || {};
    const fb = HAIR_DEFAULTS[i];
    const name = typeof hit.name === 'string' && hit.name.trim() ? hit.name.slice(0, 14) : fb[0];
    return {
      name,
      desc: typeof hit.desc === 'string' && hit.desc.trim() ? hit.desc.slice(0, 24) : fb[1],
      prompt:
        typeof hit.prompt === 'string' && hit.prompt.trim()
          ? hit.prompt.slice(0, 120)
          : `保持人物五官、表情、服装、背景完全不变，只把发型换成「${name}」，发色自然黑，真实摄影质感，不要改变五官`,
    };
  });

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
    stars,
    conclusion:
      typeof d.conclusion === 'string' && d.conclusion.trim()
        ? d.conclusion.slice(0, 80)
        : '五官比例协调，底子在线；当前发型与穿搭拉低了整体完成度；按方案调整后，精致度和辨识度都会明显提升。',
    feature_types,
    celebrity,
    features,
    skin_analysis,
    intl_standards,
    energy_radar,
    aura_keywords,
    impressions,
    optimizations,
    color_recs,
    hair_recs,
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
