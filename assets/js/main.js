import { $ } from './dom.js';
import { BRAND } from './config.js';
import { prepareForAnalyze, idbSet, idbGet, idbClear, loadImage } from './image.js';
import * as api from './api.js';
import { renderReport } from './report.js';
import { buildShareCard, publishCanvas } from './sharecard.js';
import { buildPoster } from './poster.js';
import { pickHairRefFiles } from './hair.js';

const STEPS = ['step-hero', 'step-upload', 'step-loading', 'step-report'];

const state = {
  file: null,
  analyze: null, // { blob, dataUrl }
  photoUrl: '', // objectURL（用于预览与分享卡）
  report: null,
};

function go(id) {
  STEPS.forEach((s) => $('#' + s).classList.toggle('is-active', s === id));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------------- 上传步骤 ---------------- */

const fileInput = $('#file-input');
const preview = $('#preview');
const consent = $('#f-consent');
const analyzeBtn = $('#btn-analyze');
const hint = $('#upload-hint');

$('#btn-start').addEventListener('click', () => {
  api.track('cta_start');
  go('step-upload');
});

document.querySelectorAll('[data-back]').forEach((btn) =>
  btn.addEventListener('click', () => go(btn.dataset.back))
);

fileInput.addEventListener('change', async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  hint.textContent = '正在处理照片…';
  try {
    const prepared = await prepareForAnalyze(file);
    state.file = file;
    state.analyze = prepared;
    if (state.photoUrl) URL.revokeObjectURL(state.photoUrl);
    state.photoUrl = URL.createObjectURL(prepared.blob);
    preview.src = state.photoUrl;
    preview.hidden = false;
    $('.uploader-empty').hidden = true;
    hint.textContent = `已就绪（${Math.round(prepared.bytes / 1024)}KB · ${prepared.width}×${prepared.height}）`;
    updateAnalyzeBtn();
  } catch (err) {
    hint.textContent = err.message || '照片处理失败，换一张试试';
  }
});

consent.addEventListener('change', updateAnalyzeBtn);

function updateAnalyzeBtn() {
  const ready = Boolean(state.analyze) && consent.checked;
  analyzeBtn.disabled = !ready;
  if (ready) hint.textContent = '可以开始了';
}

/* ---------------- 分析 ---------------- */

const LOADING_STEPS = [
  '正在读取照片与身体数据…',
  '正在识别脸型、骨相与五官量感…',
  '正在判断肤色冷暖与皮肤质感…',
  '正在由身高体重推导身材框架…',
  '正在计算改造优先级与执行清单…',
];

analyzeBtn.addEventListener('click', async () => {
  if (!state.analyze || !consent.checked) return;
  const profile = {
    gender: $('#f-gender').value,
    height: Number($('#f-height').value) || 0,
    weight: Number($('#f-weight').value) || 0,
    age: $('#f-age').value,
    scene: $('#f-scene').value,
    shot: '自拍/半身',
  };
  if (!profile.height || !profile.weight) {
    hint.textContent = '身高体重是判断身材框架的关键，请填一下';
    return;
  }

  go('step-loading');
  api.track('analyze_start');
  startProgress();

  try {
    const { report } = await api.analyze(state.analyze.dataUrl, profile);
    state.report = report;
    await idbSet('photo', state.analyze.blob);
    localStorage.setItem('report', JSON.stringify(report));
    api.track('analyze_ok', { score: report.score_total });
    showReport();
  } catch (err) {
    api.track('analyze_fail', { message: String(err.message) });
    hint.textContent = err.message || '分析失败，请重试';
    go('step-upload');
  }
});

let progressTimer = null;

function startProgress() {
  const stepText = $('#loader-step');
  const fill = $('#loader-fill');
  let i = 0;
  const total = LOADING_STEPS.length;
  clearInterval(progressTimer);
  stepText.textContent = LOADING_STEPS[0];
  fill.style.width = '6%';
  progressTimer = setInterval(() => {
    i = Math.min(total - 1, i + 1);
    stepText.textContent = LOADING_STEPS[i];
    fill.style.width = `${Math.min(92, 12 + (i / total) * 72)}%`;
  }, 4200);
}

function stopProgress() {
  clearInterval(progressTimer);
  const fill = $('#loader-fill');
  if (fill) fill.style.width = '100%';
}

/* ---------------- 报告 ---------------- */

function buildHandlers() {
  return {
    async onPoster(holder, setStage) {
      const r = state.report;
      setStage?.('正在绘制报告海报…');
      const photo = await loadImage(state.photoUrl);
      // 发型推荐直接使用本地参考图库（不做人脸合成，无割裂感、零等待）
      const files = pickHairRefFiles(r.hair_recs.map((x) => x.name));
      const hairImages = await Promise.all(files.map((f) => loadImage(f).catch(() => null)));
      const canvas = await buildPoster({
        report: r,
        photo,
        hairImages,
        brandName: BRAND.name,
      });
      await publishCanvas(canvas, r, holder);
      api.track('poster_ok');
    },

    async onShare(holder) {
      if (!state.photoUrl) throw new Error('缺少照片');
      const qrImage = BRAND.qr ? await loadImage(BRAND.qr).catch(() => null) : null;
      const canvas = await buildShareCard({
        report: state.report,
        photoUrl: state.photoUrl,
        afterUrl: null,
        qrImage,
      });
      await publishCanvas(canvas, state.report, holder);
      api.track('share_card');
    },

    async onLead(payload) {
      const r = state.report;
      await api.submitLead({
        name: payload.name,
        phone: payload.phone,
        wechat: payload.phone,
        expect_time: payload.expect,
        summary: `${r.score_total}→${r.score_after} 分｜${r.archetype.name}｜优先做${r.roi[0].item}`,
      });
      api.track('lead_submit');
    },

    onReset() {
      localStorage.removeItem('report');
      localStorage.removeItem('plan:progress');
      idbClear().then(() => location.reload());
    },
  };
}

function showReport() {
  stopProgress();
  const root = $('#report-root');
  root.innerHTML = '';
  root.appendChild(renderReport(state.report, state, buildHandlers()));
  go('step-report');
}

/* ---------------- 恢复上次报告 ---------------- */

async function restore() {
  const cached = localStorage.getItem('report');
  if (!cached) return;
  try {
    state.report = JSON.parse(cached);
    if (!state.report || !state.report.celebrity || !state.report.face_rule) {
      // 旧版本报告（未套用脸型发型模板），直接作废重测
      localStorage.removeItem('report');
      return;
    }
    const photo = await idbGet('photo');
    if (!photo) return;
    state.photoUrl = URL.createObjectURL(photo);
    showReport();
  } catch {
    localStorage.removeItem('report');
  }
}

$('#btn-clear').addEventListener('click', async () => {
  localStorage.removeItem('report');
  localStorage.removeItem('plan:progress');
  await idbClear();
  location.reload();
});

restore();
