#!/usr/bin/env node
/**
 * 本地压测脚本：直接用 Node 打百炼，验证 prompt 与 JSON 稳定性（不经过 Cloudflare）
 *
 * 用法：
 *   DASHSCOPE_API_KEY=sk-xxx node tools/local-test.mjs /path/to/photo.jpg
 *   DASHSCOPE_API_KEY=sk-xxx node tools/local-test.mjs ./photos   # 目录则批量跑
 *
 * 可选环境变量：
 *   PROFILE_HEIGHT=183 PROFILE_WEIGHT=75 PROFILE_GENDER=男 PROFILE_SCENE=职场通勤与商务场合
 *   MODEL_VL=qwen3-vl-plus
 */

import fs from 'node:fs';
import path from 'node:path';
import { SYSTEM_PROMPT, buildUserPrompt, parseLooseJson, normalizeReport } from '../worker/src/index.js';

const KEY = process.env.DASHSCOPE_API_KEY;
const BASE = process.env.DS_BASE || 'https://dashscope.aliyuncs.com';
const MODEL = process.env.MODEL_VL || 'qwen3-vl-plus';

if (!KEY) {
  console.error('缺少环境变量 DASHSCOPE_API_KEY');
  process.exit(1);
}

const target = process.argv[2];
if (!target) {
  console.error('用法：node tools/local-test.mjs <照片路径或目录>');
  process.exit(1);
}

const files = fs.statSync(target).isDirectory()
  ? fs
      .readdirSync(target)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .map((f) => path.join(target, f))
  : [target];

const profile = {
  gender: process.env.PROFILE_GENDER || '男',
  height: Number(process.env.PROFILE_HEIGHT || 183),
  weight: Number(process.env.PROFILE_WEIGHT || 75),
  age: process.env.PROFILE_AGE || '25-32',
  scene: process.env.PROFILE_SCENE || '职场通勤与商务场合',
  shot: '自拍或半身照',
};

async function run(file) {
  const mime = path.extname(file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
  const dataUrl = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  const body = {
    model: MODEL,
    input: {
      messages: [
        { role: 'system', content: [{ text: SYSTEM_PROMPT }] },
        { role: 'user', content: [{ image: dataUrl }, { text: buildUserPrompt(profile) }] },
      ],
    },
    parameters: { enable_thinking: false, temperature: 0.7, max_tokens: 3000 },
  };

  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/v1/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);

  const data = JSON.parse(raw);
  const content = data?.output?.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map((c) => c?.text || '').join('') : '';
  const ok = Boolean(parseLooseJson(text));
  const report = normalizeReport(parseLooseJson(text) || {}, profile);
  return {
    file: path.basename(file),
    ms: Date.now() - t0,
    jsonOk: ok,
    usage: data.usage,
    report,
  };
}

let ok = 0;
for (const file of files) {
  try {
    const r = await run(file);
    ok += r.jsonOk ? 1 : 0;
    console.log(
      `[${r.jsonOk ? 'OK ' : 'FAIL'}] ${r.file} ${r.ms}ms  tokens(in/out)=${r.usage?.input_tokens}/${r.usage?.output_tokens}  ` +
        `得分 ${r.report.score_total}→${r.report.score_after}  类型「${r.report.archetype.name}」`
    );
    console.log(`      一句话：${r.report.one_line}`);
    console.log(`      最高收益：${r.report.roi[0].item} +${r.report.roi[0].delta} 分 —— ${r.report.roi[0].reason}`);
  } catch (err) {
    console.log(`[ERR ] ${path.basename(file)} ${err.message}`);
  }
}

console.log(`\nJSON 成功率：${ok}/${files.length}`);
