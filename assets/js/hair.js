/* 发型参考图库：通用模特图，按门店「脸型—发型模板」的款式名匹配视觉族 */
const BASE = 'assets/hair/';

export const HAIR_REFS = [
  // 碎盖 / 纹理 / 烫发族
  { file: 'hair-suigai.jpg', label: '碎盖纹理', tags: ['微分碎盖', '碎盖', '摩根碎盖', '气垫烫', '锡纸烫', '纹理短发', '胎毛刘海', '纹理', '烫'] },
  // 中分 / 轻薄刘海族
  { file: 'hair-zhongfen.jpg', label: '中分刘海', tags: ['韩式中分', '法式刘海', '中分', '长发', '刘海'] },
  // 侧分族
  { file: 'hair-cefen.jpg', label: '侧分纹理', tags: ['侧分短发', '三七分', '侧分', '分线', '油头', '背头'] },
  // 短碎 / 露额族
  { file: 'hair-qici.jpg', label: '短碎前刺', tags: ['美式前刺', '前刺', '寸头', '短发', '短碎'] },
  // 逗号刘海族
  { file: 'hair-douhao.jpg', label: '逗号刘海', tags: ['逗号', '韩式'] },
  // 鲻鱼头 / 层次微卷族
  { file: 'hair-mullet.jpg', label: '层次微卷', tags: ['鲻鱼头', '微卷短发', '慵懒卷发', '层次感碎发', '微卷', '卷发', '层次'] },
];

/** 按推荐发型名挑参考图路径。同一视觉族的款式可共用一张参考图——图文相符优先于凑满不同图 */
export function pickHairRefFiles(names) {
  let fb = 0;
  return names.map((name) => {
    const n = String(name || '');
    const hit = HAIR_REFS.find((r) => r.tags.some((t) => n.includes(t)));
    if (hit) return BASE + hit.file;
    const f = HAIR_REFS[fb % HAIR_REFS.length];
    fb += 1;
    return BASE + f.file;
  });
}
