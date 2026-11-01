/**
 * 图片处理：EXIF 方向修正 → 缩放压缩 → JPEG 数据
 * 顺带剥离 EXIF（含 GPS 与设备信息），属于低成本的隐私加分项
 */

const MAX_ANALYZE_EDGE = 1024; // 视觉分析：够用且省 token
const MAX_EDIT_EDGE = 1536; // 图像编辑：百炼要求 384-3072px

async function toBitmap(file) {
  if (self.createImageBitmap) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* 降级到 <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // 兜底：<img> 在现代浏览器已自动应用 EXIF 方向
    return img;
  } finally {
    // 保留 objectURL 直到 bitmap 用完（Chrome 的 ImageBitmap 不需要，Image 需要）
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

async function render(source, maxEdge, quality) {
  const w0 = source.width, h0 = source.height;
  const scale = Math.min(1, maxEdge / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  const dataUrl = await blobToDataURL(blob);
  if (source.close) source.close();
  return { blob, dataUrl, width: w, height: h, bytes: blob.size };
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

export async function prepareForAnalyze(file) {
  if (/heic|heif/i.test(file.type)) {
    throw new Error('HEIC 格式暂不支持，请在相册里先转成 JPG 再上传');
  }
  const bitmap = await toBitmap(file);
  return render(bitmap, MAX_ANALYZE_EDGE, 0.82);
}

export async function prepareForEdit(file) {
  const bitmap = await toBitmap(file);
  return render(bitmap, MAX_EDIT_EDGE, 0.9);
}

/** 以 blob URL 形式拿到网图（避免跨域污染 canvas，导致分享卡无法导出） */
export async function blobUrlFrom(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('图片下载失败');
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

/* ---------------- IndexedDB：存原图与改造图（localStorage 放不下） ---------------- */

const DB_NAME = 'image-report';
const STORE = 'assets';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbSet(key, value) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* 忽略隐私模式下的存储失败 */
  }
}

export async function idbGet(key) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

export async function idbClear() {
  try {
    const db = await openDB();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = resolve;
    });
  } catch {
    /* noop */
  }
}
