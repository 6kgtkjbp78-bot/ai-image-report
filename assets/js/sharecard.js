import { BRAND } from './config.js';
import { drawRadar } from './report.js';
import { loadImage } from './image.js';

const W = 1080;
const H = 1440;
const L = 96; // 内容左边距
const R = 984; // 内容右边距

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCover(ctx, img, x, y, w, h, r = 0) {
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  ctx.clip();
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

function wrap(ctx, text, maxWidth, maxLines = 3) {
  const out = [];
  let line = '';
  for (const ch of String(text)) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      out.push(line);
      line = ch;
      if (out.length >= maxLines - 1) break;
    } else {
      line = test;
    }
  }
  if (line) out.push(line);
  return out.slice(0, maxLines);
}

/**
 * 绘制 1080×1440 分享卡
 * @param {{report:object, photoUrl:string, afterUrl:string|null, qrImage:HTMLImageElement|null}} input
 */
export async function buildShareCard({ report, photoUrl, afterUrl, qrImage }) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const F = BRAND.font;

  ctx.fillStyle = BRAND.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#FFFFFF';
  roundRect(ctx, 48, 48, W - 96, H - 96, 36);
  ctx.fill();
  ctx.strokeStyle = 'rgba(21,24,29,0.08)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // 头部
  ctx.fillStyle = BRAND.navy;
  ctx.font = `600 30px ${F}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(BRAND.name, L, 118);
  ctx.fillStyle = BRAND.ink3;
  ctx.font = `18px ${F}`;
  ctx.textAlign = 'right';
  const today = new Date();
  ctx.fillText(`${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`, R, 118);
  ctx.textAlign = 'left';

  ctx.strokeStyle = 'rgba(21,24,29,0.08)';
  ctx.beginPath();
  ctx.moveTo(L, 148);
  ctx.lineTo(R, 148);
  ctx.stroke();

  // 分数
  const total = String(report.score_total);
  ctx.fillStyle = BRAND.ink;
  ctx.font = `600 104px ${F}`;
  ctx.fillText(total, L, 240);
  const totalWidth = ctx.measureText(total).width;

  ctx.fillStyle = BRAND.blue;
  ctx.font = `600 30px ${F}`;
  ctx.fillText(`改造可达 ${report.score_after}`, L + totalWidth + 26, 240);

  ctx.fillStyle = BRAND.ink3;
  ctx.font = `20px ${F}`;
  ctx.fillText('当前完成度', L, 272);

  ctx.fillStyle = BRAND.ink2;
  ctx.font = `26px ${F}`;
  const lines = wrap(ctx, report.one_line, R - 540, 3);
  lines.forEach((line, i) => ctx.fillText(line, 540, 200 + i * 40));

  // 照片区
  const photoTop = 372;
  const photoH = 380;
  const photo = await loadImage(photoUrl);

  if (afterUrl) {
    const after = await loadImage(afterUrl);
    const halfW = (R - L - 20) / 2;
    ctx.fillStyle = BRAND.ink3;
    ctx.font = `22px ${F}`;
    ctx.fillText('现状', L, photoTop - 8);
    ctx.fillText('改造预测', L + halfW + 20, photoTop - 8);
    drawCover(ctx, photo, L, photoTop, halfW, photoH, 18);
    drawCover(ctx, after, L + halfW + 20, photoTop, halfW, photoH, 18);
    // AI 标识
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    roundRect(ctx, L + halfW + 40, photoTop + 16, 120, 40, 8);
    ctx.fill();
    ctx.fillStyle = BRAND.ink2;
    ctx.font = `20px ${F}`;
    ctx.fillText('AI 生成', L + halfW + 58, photoTop + 43);
  } else {
    ctx.fillStyle = BRAND.ink3;
    ctx.font = `22px ${F}`;
    ctx.fillText('我的现状', L, photoTop - 8);
    drawCover(ctx, photo, L, photoTop, R - L, photoH, 18);
  }

  // 类型
  const baseY = 812;
  ctx.fillStyle = BRAND.ink;
  ctx.font = `600 38px ${F}`;
  ctx.fillText(report.archetype.name, L, baseY);
  const nameWidth = ctx.measureText(report.archetype.name).width;

  let tagX = L + nameWidth + 24;
  ctx.font = `20px ${F}`;
  for (const kw of report.archetype.keywords.slice(0, 3)) {
    const tw = ctx.measureText(kw).width + 28;
    if (tagX + tw > R) break;
    ctx.fillStyle = BRAND.blueSoft;
    roundRect(ctx, tagX, baseY - 28, tw, 40, 20);
    ctx.fill();
    ctx.fillStyle = BRAND.navy;
    ctx.fillText(kw, tagX + 14, baseY - 1);
    tagX += tw + 10;
  }

  ctx.fillStyle = BRAND.ink2;
  ctx.font = `24px ${F}`;
  ctx.fillText(wrap(ctx, report.archetype.slogan, R - L, 1)[0], L, 854);

  // 雷达 + 维度分
  drawRadar(ctx, 290, 1105, 140, report.radar, {
    scale: 2.6,
    font: F,
    labels: true,
    showScore: true,
    labelPad: 30,
    labelFont: `22px ${F}`,
    labelColor: BRAND.ink2,
    ringLine: 1.2,
    dataLine: 2.4,
  });

  ctx.font = `22px ${F}`;
  ctx.textBaseline = 'middle';
  report.radar.forEach((d, i) => {
    const y = 990 + i * 54;
    ctx.fillStyle = BRAND.ink2;
    ctx.textAlign = 'left';
    ctx.fillText(d.label, 540, y);
    ctx.fillStyle = BRAND.navy;
    ctx.textAlign = 'right';
    ctx.fillText(String(d.score), R, y);
    ctx.fillStyle = BRAND.blueSoft;
    roundRect(ctx, 540, y + 16, R - 540, 6, 3);
    ctx.fill();
    ctx.fillStyle = BRAND.blue;
    roundRect(ctx, 540, y + 16, (R - 540) * (Math.max(0, d.score - 50) / 50), 6, 3);
    ctx.fill();
  });
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // 底部
  ctx.strokeStyle = 'rgba(21,24,29,0.08)';
  ctx.beginPath();
  ctx.moveTo(L, 1300);
  ctx.lineTo(R, 1300);
  ctx.stroke();

  ctx.fillStyle = BRAND.ink;
  ctx.font = `600 26px ${F}`;
  const top = report.roi[0];
  ctx.fillText(`改造优先级：${top.item} +${top.delta} 分`, L, 1348);

  ctx.fillStyle = BRAND.ink3;
  ctx.font = `18px ${F}`;
  ctx.fillText(`${BRAND.shop} · 本报告由 AI 生成，仅作形象参考`, L, 1380);

  if (qrImage) {
    drawCover(ctx, qrImage, R - 96, 1308, 96, 96, 10);
  } else {
    ctx.textAlign = 'right';
    ctx.fillStyle = BRAND.navy;
    ctx.font = `600 22px ${F}`;
    ctx.fillText('扫码预约改造', R, 1364);
    ctx.textAlign = 'left';
  }

  return canvas;
}

export function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/** 优先唤起系统分享（可直接送进微信），不支持则下载 */
export async function publishCanvas(canvas, report, holder) {
  const blob = await canvasToBlob(canvas);
  const url = URL.createObjectURL(blob);

  holder.innerHTML = '';
  const img = document.createElement('img');
  img.className = 'share-preview';
  img.src = url;
  img.alt = '我的形象测评卡片';
  holder.appendChild(img);

  const text = report.share_text || `我的形象诊断 ${report.score_total} 分，改造可达 ${report.score_after} 分`;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* 无剪贴板权限时忽略 */
  }

  const file = new File([blob], 'my-image-report.png', { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '我的形象诊断报告', text });
      return { mode: 'share' };
    } catch (err) {
      if (err && err.name === 'AbortError') return { mode: 'cancel' };
    }
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = 'my-image-report.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return { mode: 'download' };
}
