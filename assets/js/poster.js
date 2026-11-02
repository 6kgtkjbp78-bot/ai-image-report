import { drawRadar } from './report.js';
import { BRAND } from './config.js';

/* ------------------------------------------------------------------ */
/* 颜值气质分析报告 · 单页海报（对齐参考样式：米白底 + 棕金点缀）      */
/* ------------------------------------------------------------------ */

const W = 1080;
const C = {
  bg: '#F6F1E8',
  card: '#FFFDF8',
  line: 'rgba(90, 70, 45, 0.16)',
  ink: '#2B2620',
  ink2: '#6B6154',
  ink3: '#9A8F7D',
  brown: '#8A6D4B',
  gold: '#C9A25E',
  goldSoft: '#F0E4CC',
  chipBg: '#EFE7D8',
};

const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function panel(ctx, x, y, w, h, r = 20) {
  rr(ctx, x, y, w, h, r);
  ctx.fillStyle = C.card;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = C.line;
  ctx.stroke();
}

function sectionTitle(ctx, num, title, x, y) {
  ctx.fillStyle = C.brown;
  ctx.beginPath();
  ctx.arc(x + 15, y - 6, 15, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#FFF';
  ctx.font = `600 19px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(num), x + 15, y - 5);
  ctx.textAlign = 'left';
  ctx.fillStyle = C.ink;
  ctx.font = `600 26px ${FONT}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(title, x + 40, y + 2);
}

function wrapText(ctx, text, x, y, maxW, lineH, maxLines = 10) {
  const chars = String(text).split('');
  let line = '';
  let lines = 0;
  for (const ch of chars) {
    if (ctx.measureText(line + ch).width > maxW && line) {
      ctx.fillText(line, x, y);
      y += lineH;
      lines++;
      line = ch;
      if (lines >= maxLines - 1) break;
    } else {
      line += ch;
    }
  }
  if (line && lines < maxLines) {
    ctx.fillText(line, x, y);
    y += lineH;
  }
  return y;
}

function drawStars(ctx, x, y, value, size = 22) {
  const full = Math.floor(value);
  const half = value - full >= 0.5;
  for (let i = 0; i < 5; i++) {
    const sx = x + i * (size + 6);
    ctx.font = `${size}px ${FONT}`;
    if (i < full) {
      ctx.fillStyle = C.gold;
      ctx.fillText('★', sx, y);
    } else if (i === full && half) {
      ctx.fillStyle = '#DCD3C2';
      ctx.fillText('★', sx, y);
      ctx.save();
      ctx.beginPath();
      ctx.rect(sx, y - size, size / 2 + 2, size + 6);
      ctx.clip();
      ctx.fillStyle = C.gold;
      ctx.fillText('★', sx, y);
      ctx.restore();
    } else {
      ctx.fillStyle = '#DCD3C2';
      ctx.fillText('★', sx, y);
    }
  }
}

function drawCover(ctx, img, x, y, w, h, r = 16) {
  const ir = img.width / img.height;
  const tr = w / h;
  let sw, sh, sx, sy;
  if (ir > tr) {
    sh = img.height;
    sw = sh * tr;
    sx = (img.width - sw) / 2;
    sy = 0;
  } else {
    sw = img.width;
    sh = sw / tr;
    sx = 0;
    sy = (img.height - sh) / 2;
  }
  ctx.save();
  rr(ctx, x, y, w, h, r);
  ctx.clip();
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  ctx.restore();
  rr(ctx, x, y, w, h, r);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = C.line;
  ctx.stroke();
}

function chip(ctx, text, x, y, padX = 22, h = 44, fs = 20) {
  ctx.font = `500 ${fs}px ${FONT}`;
  const w = ctx.measureText(text).width + padX * 2;
  rr(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = C.chipBg;
  ctx.fill();
  ctx.fillStyle = C.ink;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, y + h / 2 + 1);
  ctx.textBaseline = 'alphabetic';
  return w;
}

const STAR_ROWS = [
  ['first_look', '第一眼吸引力'],
  ['camera', '镜头表现力'],
  ['affinity', '亲和感染力'],
  ['identity', '个人识别度'],
  ['potential', '潜力成长值'],
];

const FEAT_ICONS = { 额头: '◠', 眉毛: '⌒', 眼睛: '👁', 鼻子: '👃', 嘴巴: '👄', 下巴: '◡', 脸型: '◯' };

/**
 * @param {object} args
 *  report: 完整报告 JSON
 *  photo: HTMLImageElement 用户照片
 *  hairImages: (HTMLImageElement|null)[] 3 款发型 AI 图
 *  brandName: 底部品牌名
 */
export async function buildPoster({ report, photo, hairImages = [], brandName }) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  /* ---- 布局常量 ---- */
  const M = 36; // 外边距
  const GAP = 20;
  const innerW = W - M * 2;

  const headerH = 150;
  const row1H = 620; // 评分 + 照片 + 五官类型
  const row2H = 380; // 关键词 + 能量雷达
  const row3H = 210; // 外在印象
  const row4H = 560; // 发型推荐
  const row5H = 330; // 色彩推荐
  const row55H = 330; // 皮相分析
  const row6H = 330; // 优化建议
  const footerH = 130;

  const H =
    headerH + row1H + row2H + row3H + row4H + row5H + row55H + row6H + footerH + GAP * 7 + M;

  canvas.width = W;
  canvas.height = H;

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  /* ---- 头部 ---- */
  let y = M + 26;
  ctx.fillStyle = C.ink3;
  ctx.font = `500 16px ${FONT}`;
  ctx.fillText('AI 生成内容 · 仅供个人形象优化参考', M + 4, y);
  y += 52;
  ctx.textAlign = 'center';
  ctx.fillStyle = C.ink;
  ctx.font = `700 62px ${FONT}`;
  ctx.fillText('✦ 颜值气质分析报告 ✦', W / 2, y);
  y += 34;
  ctx.fillStyle = C.brown;
  rr(ctx, W / 2 - 220, y, 440, 46, 23);
  ctx.fillStyle = C.goldSoft;
  ctx.fill();
  ctx.fillStyle = C.brown;
  ctx.font = `500 22px ${FONT}`;
  ctx.fillText('多维度解析你的颜值与气质优势', W / 2, y + 31);
  ctx.textAlign = 'left';
  y += 46 + 14;

  /* ---- 第一行：① 总体结果 | 照片 | ② 五官类型 ---- */
  const colLW = 300;
  const colRW = 380;
  const colCW = innerW - colLW - colRW - GAP * 2;
  const row1Y = y;

  // ① 总体测试结果
  panel(ctx, M, row1Y, colLW, row1H);
  let cy = row1Y + 48;
  sectionTitle(ctx, 1, '总体测试结果', M + 18, cy);
  cy += 46;
  ctx.fillStyle = C.ink2;
  ctx.font = `500 18px ${FONT}`;
  ctx.fillText('综合颜值评分', M + 24, cy);
  cy += 74;
  ctx.fillStyle = C.brown;
  ctx.font = `700 92px ${FONT}`;
  ctx.fillText(String(report.score_total), M + 24, cy);
  const scoreW = ctx.measureText(String(report.score_total)).width;
  ctx.fillStyle = C.ink3;
  ctx.font = `500 24px ${FONT}`;
  ctx.fillText('/100', M + 30 + scoreW, cy);
  cy += 30;
  for (const [key, label] of STAR_ROWS) {
    ctx.fillStyle = C.ink;
    ctx.font = `500 19px ${FONT}`;
    ctx.fillText(label, M + 24, cy + 16);
    drawStars(ctx, M + 140, cy + 18, report.stars[key], 19);
    cy += 42;
  }
  cy += 10;
  ctx.fillStyle = C.brown;
  ctx.font = `600 18px ${FONT}`;
  ctx.fillText('测试结论', M + 24, cy);
  cy += 30;
  ctx.fillStyle = C.ink2;
  ctx.font = `400 17px ${FONT}`;
  wrapText(ctx, report.conclusion, M + 24, cy, colLW - 48, 27, 5);

  // 照片
  drawCover(ctx, photo, M + colLW + GAP, row1Y, colCW, row1H, 20);

  // ② 五官类型测试
  const rx = M + colLW + GAP + colCW + GAP;
  panel(ctx, rx, row1Y, colRW, row1H);
  cy = row1Y + 48;
  sectionTitle(ctx, 2, '五官类型测试', rx + 18, cy);
  cy += 44;
  for (const f of report.feature_types) {
    ctx.fillStyle = C.brown;
    ctx.font = `600 18px ${FONT}`;
    ctx.fillText(`${FEAT_ICONS[f.part] || '·'} ${f.part}｜${f.type}`, rx + 24, cy);
    cy += 26;
    ctx.fillStyle = C.ink3;
    ctx.font = `400 15px ${FONT}`;
    ctx.fillText(f.desc.slice(0, 24), rx + 24, cy);
    cy += 22;
    if (f.part !== '脸型') {
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(rx + 24, cy);
      ctx.lineTo(rx + colRW - 24, cy);
      ctx.stroke();
    }
    cy += 14;
  }
  y = row1Y + row1H + GAP;

  /* ---- 第二行：③ 气质关键词 | ④ 能量分析图 ---- */
  const row3LW = 360;
  panel(ctx, M, y, row3LW, row2H);
  cy = y + 48;
  sectionTitle(ctx, 3, '气质关键词报告', M + 18, cy);
  cy += 36;
  let cx0 = M + 24;
  for (let i = 0; i < report.aura_keywords.length; i++) {
    const w = chip(ctx, report.aura_keywords[i], cx0, cy, 24, 52, 22);
    if (i % 2 === 0) {
      cx0 += w + 16;
    } else {
      cx0 = M + 24;
      cy += 68;
    }
  }
  // 外在印象融入左卡下方留白
  cy = y + row2H - 78;
  ctx.fillStyle = C.ink3;
  ctx.font = `400 15px ${FONT}`;
  ctx.fillText('关键词由五官特征、神态与', M + 24, cy);
  ctx.fillText('整体氛围综合提炼', M + 24, cy + 24);

  const rx2 = M + row3LW + GAP;
  const rw2 = innerW - row3LW - GAP;
  panel(ctx, rx2, y, rw2, row2H);
  cy = y + 48;
  sectionTitle(ctx, 4, '能量分析图', rx2 + 18, cy);
  drawRadar(ctx, rx2 + rw2 / 2, y + row2H / 2 + 26, 118, report.energy_radar, {
    labels: true,
    showScore: true,
    font: FONT,
    labelFont: `500 17px ${FONT}`,
    labelPad: 26,
    labelColor: C.ink2,
    fill: 'rgba(138, 109, 75, 0.22)',
    stroke: C.brown,
    ringStroke: 'rgba(90, 70, 45, 0.14)',
    dataLine: 2,
  });
  y += row2H + GAP;

  /* ---- ⑤ 外在印象总结 ---- */
  panel(ctx, M, y, innerW, row3H);
  cy = y + 48;
  sectionTitle(ctx, 5, '外在印象总结', M + 18, cy);
  cy += 44;
  ctx.font = `400 21px ${FONT}`;
  ctx.fillStyle = C.ink2;
  for (const q of report.impressions) {
    ctx.fillText(`“ ${q} ”`, M + 30, cy);
    cy += 42;
  }
  y += row3H + GAP;

  /* ---- ⑥ 发型推荐 ---- */
  panel(ctx, M, y, innerW, row4H);
  cy = y + 48;
  sectionTitle(ctx, 6, '发型推荐', M + 18, cy);
  ctx.fillStyle = C.ink3;
  ctx.font = `400 16px ${FONT}`;
  ctx.fillText(
    report.face_rule
      ? `（【${report.face_rule.type}】适配 · ${report.face_rule.focus}）`
      : '（根据脸型与气质推荐，图为款式参考）',
    M + 190,
    cy + 2
  );
  const cardW = (innerW - 48 - 24 * 2) / 3;
  const imgH = cardW * 1.18;
  let hx = M + 24;
  for (let i = 0; i < 3; i++) {
    const rec = report.hair_recs[i];
    const iy = cy + 26;
    const img = hairImages[i];
    if (img) {
      drawCover(ctx, img, hx, iy, cardW, imgH, 14);
    } else {
      rr(ctx, hx, iy, cardW, imgH, 14);
      ctx.fillStyle = '#EDE6D8';
      ctx.fill();
      ctx.fillStyle = C.ink3;
      ctx.font = `400 17px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('参考图待更新', hx + cardW / 2, iy + imgH / 2);
      ctx.textAlign = 'left';
    }
    // 角标：款式参考（非本人效果图）
    rr(ctx, hx + cardW - 92, iy + 12, 80, 30, 15);
    ctx.fillStyle = 'rgba(43, 38, 32, 0.55)';
    ctx.fill();
    ctx.fillStyle = '#FFF';
    ctx.font = `400 14px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('款式参考', hx + cardW - 52, iy + 32);
    ctx.textAlign = 'left';
    let ty = iy + imgH + 34;
    ctx.fillStyle = C.ink;
    ctx.font = `600 21px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(rec.name, hx + cardW / 2, ty);
    ty += 28;
    ctx.fillStyle = C.ink3;
    ctx.font = `400 16px ${FONT}`;
    ctx.fillText(rec.desc, hx + cardW / 2, ty);
    ctx.textAlign = 'left';
    hx += cardW + 24;
  }
  if (report.face_rule) {
    ctx.fillStyle = C.ink3;
    ctx.font = `400 15px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(`口诀 · ${report.face_rule.mantra}`, W / 2, y + row4H - 16);
    ctx.textAlign = 'left';
  }
  y += row4H + GAP;

  /* ---- ⑦ 色彩推荐 ---- */
  panel(ctx, M, y, innerW, row5H);
  cy = y + 48;
  sectionTitle(ctx, 7, '色彩推荐', M + 18, cy);
  ctx.fillStyle = C.ink3;
  ctx.font = `400 16px ${FONT}`;
  ctx.fillText('（找到更适合你的专属色系）', M + 190, cy + 2);
  const ccW = (innerW - 48 - 24 * 2) / 3;
  hx = M + 24;
  for (const rec of report.color_recs) {
    const iy = cy + 26;
    rr(ctx, hx, iy, ccW, 190, 14);
    ctx.fillStyle = '#FBF8F1';
    ctx.fill();
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 1;
    ctx.stroke();
    // 色条
    const swW = (ccW - 40) / rec.colors.length;
    rec.colors.forEach((hex, j) => {
      ctx.fillStyle = hex;
      rr(ctx, hx + 20 + j * swW, iy + 22, swW - 6, 58, 8);
      ctx.fill();
    });
    ctx.fillStyle = C.ink;
    ctx.font = `600 20px ${FONT}`;
    ctx.fillText(rec.name, hx + 20, iy + 116);
    ctx.fillStyle = C.ink3;
    ctx.font = `400 15px ${FONT}`;
    wrapText(ctx, rec.desc, hx + 20, iy + 144, ccW - 40, 22, 2);
    hx += ccW + 24;
  }
  y += row5H + GAP;

  /* ---- ⑧ 皮相分析 ---- */
  panel(ctx, M, y, innerW, row55H);
  cy = y + 48;
  sectionTitle(ctx, 8, '皮相分析', M + 18, cy);
  const sk = report.skin_analysis;
  // 左：七项指标紧凑网格（2列×4行）
  const skinCells = [
    ['肤质类型', sk.type],
    ['肤色', sk.tone],
    ['色调', sk.undertone],
    ['质地', sk.texture],
    ['毛孔', sk.pores],
    ['弹性', sk.elasticity],
    ['水分', sk.moisture],
  ];
  const cellW = 218;
  const cellH = 52;
  const cellGX = 14;
  const cellGY = 12;
  const gridX = M + 24;
  const gridY = cy + 24;
  skinCells.forEach(([k, v], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const gx = gridX + col * (cellW + cellGX);
    const gy = gridY + row * (cellH + cellGY);
    const wCell = i === skinCells.length - 1 ? cellW * 2 + cellGX : cellW; // 最后一格跨两列
    rr(ctx, gx, gy, wCell, cellH, 10);
    ctx.fillStyle = '#FBF8F1';
    ctx.fill();
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = C.ink3;
    ctx.font = `400 13px ${FONT}`;
    ctx.fillText(k, gx + 14, gy + 21);
    ctx.fillStyle = C.ink;
    ctx.font = `600 17px ${FONT}`;
    ctx.fillText(v, gx + 14, gy + 43);
  });
  // 右：优势 + 注意事项
  const skRx = gridX + cellW * 2 + cellGX + 40;
  let skY = gridY + 22;
  ctx.fillStyle = C.brown;
  ctx.font = `600 18px ${FONT}`;
  ctx.fillText('皮肤优势', skRx, skY);
  skY += 32;
  ctx.fillStyle = C.ink2;
  ctx.font = `400 17px ${FONT}`;
  for (const t of sk.pros) {
    ctx.fillStyle = '#6FA287';
    ctx.fillText('✓', skRx, skY);
    ctx.fillStyle = C.ink2;
    ctx.fillText(t, skRx + 24, skY);
    skY += 30;
  }
  skY += 12;
  ctx.fillStyle = '#C06B8E';
  ctx.font = `600 18px ${FONT}`;
  ctx.fillText('注意事项', skRx, skY);
  skY += 32;
  ctx.font = `400 17px ${FONT}`;
  for (const t of sk.cautions) {
    ctx.fillStyle = '#C07A4A';
    ctx.fillText('!', skRx + 4, skY);
    ctx.fillStyle = C.ink2;
    ctx.fillText(t, skRx + 24, skY);
    skY += 30;
  }
  y += row55H + GAP;

  /* ---- ⑨ 优化建议 ---- */
  panel(ctx, M, y, innerW, row6H);
  cy = y + 48;
  sectionTitle(ctx, 9, '优化建议', M + 18, cy);
  cy += 48;
  const OPT_ROWS = ['发型', '妆容', '穿搭', '配饰'];
  for (const key of OPT_ROWS) {
    ctx.strokeStyle = C.gold;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(M + 38, cy - 7, 13, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = C.gold;
    ctx.font = `600 18px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('✓', M + 38, cy - 1);
    ctx.textAlign = 'left';
    ctx.fillStyle = C.ink;
    ctx.font = `600 20px ${FONT}`;
    ctx.fillText(`${key}：`, M + 62, cy);
    const labelW = ctx.measureText(`${key}：`).width;
    ctx.fillStyle = C.ink2;
    ctx.font = `400 19px ${FONT}`;
    ctx.fillText(report.optimizations[key], M + 62 + labelW + 4, cy);
    cy += 56;
  }
  y += row6H + GAP;

  /* ---- 底部 ---- */
  const fy = y + 44;
  ctx.textAlign = 'center';
  ctx.fillStyle = C.brown;
  ctx.font = `600 30px ${FONT}`;
  ctx.fillText('♥ 你的脸，不只是好看，还有清晰可见的气质优势。 ♥', W / 2, fy);
  ctx.fillStyle = C.ink3;
  ctx.font = `400 16px ${FONT}`;
  ctx.fillText(`${brandName || BRAND.name} · ${BRAND.shop} · AI 生成内容仅供参考`, W / 2, fy + 40);
  ctx.textAlign = 'left';

  return canvas;
}
