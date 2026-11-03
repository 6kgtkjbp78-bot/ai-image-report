import { API_BASE } from './config.js';

async function post(path, payload) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    throw new Error('服务端返回异常');
  }
  if (!res.ok) {
    const err = new Error(ERR_TEXT[data.error] || data.message || data.error || `请求失败 ${res.status}`);
    err.code = data.error || `http_${res.status}`;
    throw err;
  }
  return data;
}

const ERR_TEXT = {
  missing_api_key: '服务端尚未配置模型密钥，请先在 Worker 里设置 DASHSCOPE_API_KEY',
  bad_image: '图片格式不支持，请换一张 JPG 或 PNG',
  payload_too_large: '图片过大，请压缩后重试',
  rate_limited: '操作太频繁了，请稍后再试',
  daily_quota_exceeded: '今日额度已用完，明天再来',
  analyze_failed: '分析失败，请重试一次',
  transform_failed: '生成失败，请重试一次',
  transform_throttled: '图片服务限流排队中，请稍候',
  origin_forbidden: '来源不允许',
  invite_required: '请先输入邀请码',
  invite_invalid: '邀请码不正确，请核对后再试',
  invite_expired: '激活已过期，请重新输入邀请码',
  invite_exhausted: '该邀请码的测评次数已用完，请联系客服补发',
  invite_not_configured: '系统尚未配置邀请码，请联系客服',
};

/** 邀请码激活：返回 { token, expires_in, remaining } */
export async function verifyInvite(code) {
  return post('/api/invite/verify', { code });
}

export async function analyze(imageDataUrl, profile, inviteToken) {
  const data = await post('/api/analyze', { image: imageDataUrl, profile, invite_token: inviteToken || '' });
  if (!data.report) throw new Error('未返回报告内容');
  return { report: data.report, usage: data.usage };
}

export async function transform(imageDataUrl, prompt) {
  return post('/api/transform', { image: imageDataUrl, prompt });
}

/** 异步任务轮询：1.5s 一次，最多 40 次（约 60s） */
export async function pollTransform(taskId, onTick) {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${API_BASE}/api/transform/status?task_id=${encodeURIComponent(taskId)}`);
    const data = await res.json().catch(() => ({}));
    if (data.url) return data.url;
    if (data.status === 'FAILED' || data.status === 'UNKNOWN') throw new Error('生成失败，请重试');
    onTick?.(i);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('生成超时，请重试');
}

/** 通过代理把结果图转成本地 blob，避免跨域污染画布 */
export function assetBlobUrl(remoteUrl) {
  return `${API_BASE}/api/asset?url=${encodeURIComponent(remoteUrl)}`;
}

export async function submitLead(payload) {
  return post('/api/lead', payload);
}

export function track(event, payload) {
  const body = JSON.stringify({ event, payload, t: Date.now() });
  const url = `${API_BASE}/api/track`;
  if (navigator.sendBeacon) {
    try {
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      return;
    } catch {
      /* 降级到 fetch */
    }
  }
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
}
