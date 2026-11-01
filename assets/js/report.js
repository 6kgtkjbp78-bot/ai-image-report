import { h } from './dom.js';
import { COLOR_MAP, BRAND } from './config.js';

/* ------------------------------------------------------------------ */
/* 雷达图（报告页与分享卡共用）                                        */
/* ------------------------------------------------------------------ */

export function drawRadar(ctx, cx, cy, r, radar, opts = {}) {
  const n = radar.length;
  if (n < 3) return;
  const min = 50;
  const span = 50; // 显示区间 50-100，让差异更明显
  const norm = (s) => Math.max(0.08, Math.min(1, (s - min) / span));
  const ui = opts.scale || 1;
  const labelFont = opts.labelFont || `${13 * ui}px ${opts.font || 'sans-serif'}`;
  const scoreFont = opts.scoreFont || `${11 * ui}px ${opts.font || 'sans-serif'}`;
  const ringStroke = opts.ringStroke || 'rgba(21,24,29,0.10)';
  const ringLine = (opts.ringLine || 1) * ui;

  const point = (i, rr) => {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [cx + rr * Math.cos(ang), cy + rr * Math.sin(ang)];
  };

  // 网格环
  ctx.lineWidth = ringLine;
  ctx.strokeStyle = ringStroke;
  for (let ring = 4; ring >= 1; ring--) {
    const rr = (r * ring) / 4;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const [x, y] = point(i, rr);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }

  // 轴线
  for (let i = 0; i < n; i++) {
    const [x, y] = point(i, r);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  // 数据面
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const [x, y] = point(i, r * norm(radar[i].score));
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = opts.fill || 'rgba(53,96,143,0.16)';
  ctx.fill();
  ctx.lineWidth = (opts.dataLine || 2) * ui;
  ctx.strokeStyle = opts.stroke || BRAND.blue;
  ctx.stroke();

  // 顶点
  ctx.fillStyle = BRAND.blue;
  for (let i = 0; i < n; i++) {
    const [x, y] = point(i, r * norm(radar[i].score));
    ctx.beginPath();
    ctx.arc(x, y, 2.6 * ui, 0, Math.PI * 2);
    ctx.fill();
  }

  // 标签
  if (opts.labels !== false) {
    ctx.font = labelFont;
    ctx.fillStyle = opts.labelColor || BRAND.ink2;
    const pad = (opts.labelPad || 20) * ui;
    for (let i = 0; i < n; i++) {
      const rr = r + pad;
      const [x, y] = point(i, rr);
      const cos = Math.cos(-Math.PI / 2 + (i * 2 * Math.PI) / n);
      ctx.textAlign = Math.abs(cos) < 0.25 ? 'center' : cos > 0 ? 'left' : 'right';
      ctx.textBaseline = 'middle';
      const label = opts.showScore
        ? `${radar[i].label} ${radar[i].score}`
        : radar[i].label;
      ctx.fillText(label, x, y);
    }
    ctx.textAlign = 'left';
  }
  void scoreFont;
}

/* ------------------------------------------------------------------ */
/* 报告渲染                                                            */
/* ------------------------------------------------------------------ */

function card(title, note, children) {
  return h('section', { class: 'card' }, [
    h('p', { class: 'card-title' }, [h('span', { text: title }), note ? h('span', { text: note }) : null]),
    ...[].concat(children),
  ]);
}

function kv(pairs) {
  return h('div', { class: 'kv-grid' }, pairs.map(([k, v]) => h('div', { class: 'kv' }, [h('b', { text: k }), h('span', { text: v })])));
}

function radarCard(report) {
  const wrap = h('div', { class: 'radar-wrap' });
  const canvas = h('canvas', { class: 'radar-canvas', width: 640, height: 520 });
  wrap.appendChild(canvas);

  const list = h(
    'ul',
    { class: 'dim-list' },
    report.radar.map((d) =>
      h('li', { class: 'dim-item' }, [
        h('b', { text: d.label }),
        h('span', { text: d.comment }),
        h('em', { class: 'dim-score', text: d.score }),
      ])
    )
  );

  requestAnimationFrame(() => paint(canvas, report));

  return card('五维诊断', '', [wrap, list]);
}

function paint(canvas, report) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || 320;
  const cssH = Math.round(cssW * 0.82);
  canvas.style.height = `${cssH}px`;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawRadar(ctx, cssW / 2, cssH / 2 + 4, Math.min(cssW, cssH) / 2 - 34, report.radar, {
    labels: true,
    showScore: true,
    font: BRAND.font,
    labelPad: 22,
  });
}

function roiCard(report) {
  const max = Math.max(...report.roi.map((r) => r.delta), 0.1);
  const rows = report.roi.map((r, i) =>
    h('div', { class: `roi-item${i === 0 ? ' top' : ''}` }, [
      h('div', { class: 'roi-head' }, [
        h('b', { text: r.item }),
        h('em', { text: `+${r.delta} 分` }),
      ]),
      h('div', { class: 'roi-bar' }, [h('i', { style: `width:${Math.round((r.delta / max) * 100)}%` })]),
      h('p', { class: 'roi-reason', text: r.reason }),
    ])
  );
  return card('改造优先级', '按投入产出排序', rows);
}

function paletteRow(report) {
  const swatches = report.advice.outfit.palette.map((name) => {
    const color = COLOR_MAP[name] || '#D9D7D0';
    return h('div', { class: 'swatch' }, [
      h('i', { style: `background:${color}` }),
      h('span', { text: name }),
    ]);
  });
  return h('div', { class: 'palette' }, swatches);
}

function adviceCard(report) {
  const hair = report.advice.hair.map((item) =>
    h('li', {}, [
      h('span', { class: 'advice-do', text: item.do }),
      h('div', { class: 'advice-avoid', text: item.avoid }),
    ])
  );

  return card('专属改造方案', '', [
    h('p', { class: 'card-title', text: '发型' }),
    h('ul', { class: 'advice' }, hair),
    h('p', { class: 'card-title', text: '穿搭 · 适用色板', style: 'margin-top:18px' }),
    paletteRow(report),
    h('p', { class: 'roi-reason', text: `规避：${report.advice.outfit.avoid.join('、')}` }),
    h('p', { class: 'roi-reason', text: `建议单品：${report.advice.outfit.items.join(' / ')}` }),
    h('p', { class: 'roi-reason', text: `版型要点：${report.advice.outfit.fit}` }),
    h('p', { class: 'card-title', text: '妆造与细节', style: 'margin-top:18px' }),
    h('ul', { class: 'advice' }, report.advice.grooming.map((g) => h('li', { text: g }))),
  ]);
}

function planCard(report) {
  const saved = JSON.parse(localStorage.getItem('plan:progress') || '{}');
  const list = report.plan_7d.map((p) => {
    const box = h('input', { type: 'checkbox' });
    const item = h('label', { class: `plan-item${saved[p.day] ? ' done' : ''}` }, [
      box,
      h('b', { class: 'plan-day', text: `D${p.day}` }),
      h('span', { text: p.task }),
    ]);
    box.checked = Boolean(saved[p.day]);
    box.addEventListener('change', () => {
      item.classList.toggle('done', box.checked);
      const all = JSON.parse(localStorage.getItem('plan:progress') || '{}');
      all[p.day] = box.checked;
      localStorage.setItem('plan:progress', JSON.stringify(all));
    });
    return item;
  });
  return card('七天改造清单', '进度存在本机', list);
}

export function transformCard(state, handlers) {
  const compare = h('div', { class: 'compare' });
  const btn = h('button', { class: 'btn btn-ghost btn-block', text: '生成改造后的我' }, []);
  const note = h('p', { class: 'micro', text: '基于同一张照片生成改造模拟图，约需 20-40 秒' });

  function paint() {
    compare.innerHTML = '';
    const before = h('figure', {}, [
      h('img', { src: state.photoUrl, alt: '改造前' }),
      h('figcaption', { text: '现状' }),
    ]);
    compare.appendChild(before);
    if (state.afterUrl) {
      compare.appendChild(
        h('figure', {}, [
          h('img', { src: state.afterUrl, alt: '改造后' }),
          h('figcaption', {}, [document.createTextNode('改造预测'), h('span', { class: 'ai-badge', text: 'AI 生成' })]),
        ])
      );
    }
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      await handlers.onGenerateTransform(() => {
        btn.textContent = '渲染中…';
      });
      note.textContent = '改造模拟图为 AI 生成，仅供方向参考，实际效果以到店实施为准';
    } catch (err) {
      note.textContent = err.message || '生成失败，请重试';
    } finally {
      btn.disabled = false;
      btn.textContent = state.afterUrl ? '重新生成' : '生成改造后的我';
      paint();
    }
  });

  paint();
  return card('改造后的你', '', [compare, btn, note]);
}

export function shareCard(report, handlers) {
  const holder = h('div');
  const btn = h('button', { class: 'btn btn-primary btn-block', text: '生成我的评分卡片' });
  const note = h('p', { class: 'micro', text: '生成后可保存图片，或直接分享到微信' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '绘制中…';
    try {
      await handlers.onShare(holder);
      note.textContent = '长按图片可保存；已复制推荐文案的可直接粘贴发送';
    } catch (err) {
      note.textContent = err.message || '生成失败';
    } finally {
      btn.disabled = false;
      btn.textContent = '重新生成卡片';
    }
  });
  return card('晒出我的报告', '', [holder, btn, note]);
}

export function leadCard(handlers) {
  const name = h('input', { placeholder: '怎么称呼', maxlength: '20' });
  const phone = h('input', { placeholder: '手机或微信', inputmode: 'tel', maxlength: '40' });
  const expect = h('input', { placeholder: '期望到店时间（可选）', maxlength: '30' });
  const msg = h('p', { class: 'lead-msg' });
  const submit = h('button', { class: 'btn btn-primary btn-block', text: '预约到店实施改造' });

  submit.addEventListener('click', async () => {
    if (!name.value.trim() || !phone.value.trim()) {
      msg.textContent = '留下称呼和一个联系方式，我们才好约时间';
      return;
    }
    submit.disabled = true;
    submit.textContent = '提交中…';
    try {
      await handlers.onLead({ name: name.value, phone: phone.value, expect: expect.value });
      msg.textContent = '已收到，顾问会尽快联系你确认时间';
      submit.textContent = '已提交';
    } catch (err) {
      msg.textContent = err.message || '提交失败，请稍后重试';
      submit.disabled = false;
      submit.textContent = '预约到店实施改造';
    }
  });

  return card('把报告变成真的', BRAND.shop, [
    h('p', { class: 'roi-reason', text: '报告给的是方向，实施需要一双专业的手。留个联系方式，我们按你的报告准备方案。' }),
    h('div', { class: 'lead-grid' }, [name, phone]),
    expect,
    submit,
    msg,
  ]);
}

export function renderReport(report, state, handlers) {
  const root = h('div', {});

  root.appendChild(
    card('综合评分', '满分 100', [
      h('div', { class: 'score-block' }, [
        h('div', {}, [
          h('div', { class: 'score-now', text: String(report.score_total) }),
        ]),
        h('div', { class: 'score-side' }, [
          h('div', { class: 'score-label', text: '当前完成度' }),
          h('div', { class: 'score-label' }, [
            h('span', { text: '改造可达 ' }),
            h('strong', { class: 'score-after', text: `+${report.score_after - report.score_total}` }),
          ]),
          h('p', { class: 'score-line', text: report.one_line }),
        ]),
      ]),
    ])
  );

  root.appendChild(
    card('你的类型', '', [
      h('h3', { class: 'archetype-name', text: report.archetype.name }),
      h('p', { class: 'archetype-slogan', text: report.archetype.slogan }),
      h('div', { class: 'tags' }, report.archetype.keywords.map((k) => h('span', { class: 'tag', text: k }))),
    ])
  );

  root.appendChild(radarCard(report));
  root.appendChild(kvAsCard('面部诊断', [
    ['脸型', report.face.shape],
    ['比例', report.face.proportion],
    ['眉眼', report.face.brow_eye],
    ['肤色', report.face.skin_tone],
    ['发型现状', report.face.hair_now],
  ]));
  root.appendChild(kvAsCard('身材诊断', [
    ['BMI', String(report.body.bmi)],
    ['体型', report.body.build],
    ['比例', report.body.ratio],
    ['优先解决', report.body.focus],
  ]));
  root.appendChild(roiCard(report));
  root.appendChild(adviceCard(report));
  root.appendChild(transformCard(state, handlers));
  root.appendChild(planCard(report));
  root.appendChild(shareCard(report, handlers));
  root.appendChild(leadCard(handlers));
  root.appendChild(
    h('button', {
      class: 'btn btn-outline btn-block',
      text: '重新测一次',
      onclick: () => handlers.onReset(),
    })
  );

  let resizeBound = false;
  if (!resizeBound) {
    resizeBound = true;
    window.addEventListener('resize', () => {
      const c = document.querySelector('.radar-canvas');
      if (c) paint(c, report);
    });
  }

  return root;
}

function kvAsCard(title, pairs) {
  return card(title, '', [kv(pairs)]);
}
