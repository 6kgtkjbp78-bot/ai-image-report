/**
 * 邀请码体系（独立模块，便于本地 Node 测试与 Worker 复用）
 *
 * 码结构：10 位 = 6 位随机 + 4 位 HMAC 签名
 *   签名 = HMAC-SHA256(INVITE_SECRET, 'FIELD-INVITE:' + 前6位)
 *   取摘要前 4 字节，逐字节 % 30 映射到 CODE_ALPHABET
 * 优点：批量发码无需写数据库，Worker 验签即可识别真伪；
 *   KV 只负责「每码使用次数」，防止一码转发给多人无限刷 API。
 *
 * 令牌：base64(code.expiresAt).hmacHex前24位，24h 有效，无状态。
 */

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉 0/O/1/I/L，避免手输混淆
export const INVITE_CODE_LEN = 10;

export function normalizeCode(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
}

async function hmacBytes(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

function hexSlice(bytes, n) {
  return Array.from(bytes.slice(0, n)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function codeSignature(payload6, secret) {
  const bytes = await hmacBytes(secret, 'FIELD-INVITE:' + payload6);
  let out = '';
  for (let i = 0; i < 4; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** 自校验：无需数据库即可判断邀请码真伪 */
export async function isValidInviteCode(code, secret) {
  const c = normalizeCode(code);
  if (c.length !== INVITE_CODE_LEN) return false;
  for (const ch of c) if (!CODE_ALPHABET.includes(ch)) return false;
  return (await codeSignature(c.slice(0, 6), secret)) === c.slice(6);
}

export async function signInviteToken(code, secret, ttlHours) {
  const exp = Date.now() + ttlHours * 3600e3;
  const payload = `${code}.${exp}`;
  const sig = hexSlice(await hmacBytes(secret, 'FIELD-TOKEN:' + payload), 12);
  return `${btoa(payload)}.${sig}`;
}

export async function checkInviteToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, error: 'invite_required' };
  const [b64, sig] = parts;
  let payload;
  try {
    payload = atob(b64);
  } catch {
    return { ok: false, error: 'invite_invalid' };
  }
  const cut = payload.lastIndexOf('.');
  const code = cut > 0 ? payload.slice(0, cut) : '';
  const exp = Number(payload.slice(cut + 1));
  if (!code || !Number.isFinite(exp)) return { ok: false, error: 'invite_invalid' };
  const expect = hexSlice(await hmacBytes(secret, 'FIELD-TOKEN:' + payload), 12);
  if (expect !== sig) return { ok: false, error: 'invite_invalid' };
  if (Date.now() > exp) return { ok: false, error: 'invite_expired' };
  return { ok: true, code };
}

/** 查询已用次数；KV 未绑定或读取失败时降级为「不计次但不阻断」 */
export async function inviteUsage(env, code) {
  const kv = env.INVITE_KV;
  if (!kv) return { n: 0, tracked: false };
  try {
    const raw = await kv.get(`c:${code}`);
    const data = raw ? JSON.parse(raw) : null;
    return { n: Number(data?.n || 0), tracked: true };
  } catch {
    return { n: 0, tracked: false };
  }
}

/** 成功出报告后计一次；7 天自动过期清理 */
export async function inviteConsume(env, code) {
  const kv = env.INVITE_KV;
  if (!kv) {
    console.log('[invite] consume skipped: no kv binding', code);
    return;
  }
  try {
    const key = `c:${code}`;
    const raw = await kv.get(key);
    const data = raw ? JSON.parse(raw) : { n: 0, t: Date.now() };
    data.n = Number(data.n || 0) + 1;
    await kv.put(key, JSON.stringify(data), { expirationTtl: 7 * 86400 });
    console.log('[invite] consumed', key, 'n=', data.n);
  } catch (err) {
    console.log('[invite] consume failed', code, String(err && err.message));
  }
}
