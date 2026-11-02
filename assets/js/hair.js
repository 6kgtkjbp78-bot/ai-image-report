/* 发型参考图库：通用模特图，按推荐发型名关键词匹配 */
const BASE = 'assets/hair/';

export const HAIR_REFS = [
  { file: 'hair-suigai.jpg', label: '碎盖纹理', tags: ['碎盖', '微分', '纹理', '摩根', '盖'] },
  { file: 'hair-douhao.jpg', label: '逗号刘海', tags: ['逗号', '韩式', '空气刘海', '刘海'] },
  { file: 'hair-cefen.jpg', label: '侧分纹理', tags: ['侧分', '三七', '二八', '分线', '油头', '背头', '侧梳'] },
  { file: 'hair-qici.jpg', label: '短碎前刺', tags: ['前刺', '短碎', '飞机头', '寸头', '刺', '短'] },
];

/** 按推荐发型名挑参考图路径；3 款尽量配不同图 */
export function pickHairRefFiles(names) {
  const used = new Set();
  return names.map((name, i) => {
    const n = String(name || '');
    let hit = HAIR_REFS.find((r) => !used.has(r.file) && r.tags.some((t) => n.includes(t)));
    if (!hit) hit = HAIR_REFS.find((r) => !used.has(r.file)) || HAIR_REFS[i % HAIR_REFS.length];
    used.add(hit.file);
    return BASE + hit.file;
  });
}
