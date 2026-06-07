// 22 个角色 → open-peeps 部件映射（职业贴合 + 本作墨金配色）
// 颜色：clothing=暖金 b9a05a/8a6c22；skin=公文纸暖肤 ecdcbf;头发对比=深墨 2c1b18
// 用法：node fetch-peeps.mjs  → 拉取 22 个 SVG 到 data/portraits-op/<id>.svg
import { writeFile, mkdir } from 'node:fs/promises';

const COMMON = {
  backgroundColor: 'transparent',
  clothingColor: 'b9a05a',          // 暖金外衣，贴合 --gold-dim
  skinColor: 'ecdcbf',              // 公文纸暖肤
  // headContrastColor 控制部分发型的对比色，给深墨
  headContrastColor: '2c1b18',
};

// face：尽量用沉稳表情（serious/calm/solemn/suspicious/old），契合严肃政治讽刺
const ROLES = [
  // 关键人物 10
  { id: 'general',   head: 'hatHip',      face: 'serious',    facialHair: 'moustache7', accessories: '' },           // 将军：军帽+小胡
  { id: 'finance',   head: 'short1',      face: 'suspicious', accessories: 'glasses2', acc: 100 },                   // 财长：分头+眼镜
  { id: 'chief',     head: 'grayMedium',  face: 'old',        facialHair: 'full3', fh: 100 },                        // 长老：花白+络腮胡
  { id: 'firstlady', head: 'bun',         face: 'calm' },                                                            // 第一夫人：盘发
  { id: 'priest',    head: 'grayShort',   face: 'solemn' },                                                          // 教会主席：花白短发
  { id: 'chen',      head: 'short3',      face: 'serious' },                                                         // 矿业代表：利落短发
  { id: 'dupont',    head: 'pomp',        face: 'cheeky',     facialHair: 'moustache3', fh: 100 },                   // 掮客：油头背+小胡
  { id: 'spy',       head: 'short2',      face: 'serious',    accessories: 'sunglasses', acc: 100 },                 // 安全局：墨镜
  { id: 'reformer',  head: 'mediumBangs', face: 'driven',     accessories: 'glasses', acc: 100 },                    // 改革司：年轻+方框镜
  { id: 'uncle',     head: 'noHair2',     face: 'old',        facialHair: 'full', fh: 100 },                         // 党元老：秃顶+络腮胡
  // 普通职位 12
  { id: 'secretary', head: 'bun2',        face: 'blank' },                                                           // 秘书处
  { id: 'reporter',  head: 'short4',      face: 'explaining' },                                                      // 记者
  { id: 'doctor',    head: 'short5',      face: 'calm',       mask: 'medicalMask', mk: 100 },                        // 医生：口罩
  { id: 'soldier',   head: 'hatBeanie',   face: 'serious' },                                                         // 军官：船形帽近似
  { id: 'diplomat',  head: 'medium1',     face: 'contempt' },                                                        // 外交人员
  { id: 'business',  head: 'short1',      face: 'serious' },                                                         // 商人
  { id: 'cleric_generic', head: 'grayShort', face: 'calm' },                                                         // 教士
  { id: 'judge',     head: 'grayMedium',  face: 'serious' },                                                         // 法务
  { id: 'worker',    head: 'hatHip',      face: 'tired' },                                                           // 工人：鸭舌帽近似
  { id: 'student',   head: 'mediumBangs2',face: 'cute' },                                                            // 学生
  { id: 'local_baron',     head: 'short2',      face: 'suspicious', facialHair: 'goatee1', fh: 100 },                      // 地方官：山羊胡
  { id: 'citizen',   head: 'medium2',     face: 'blank' },                                                           // 市民
];

function url(r) {
  const q = new URLSearchParams();
  q.set('seed', r.id);
  for (const [k, v] of Object.entries(COMMON)) q.set(k, v);
  q.set('head', r.head);
  q.set('face', r.face);
  // 概率：默认关掉随机部件，只保留显式指定的
  q.set('accessoriesProbability', String(r.accessories ? (r.acc ?? 100) : 0));
  q.set('facialHairProbability', String(r.facialHair ? (r.fh ?? 100) : 0));
  q.set('maskProbability', String(r.mask ? (r.mk ?? 100) : 0));
  if (r.accessories) q.set('accessories', r.accessories);
  if (r.facialHair) q.set('facialHair', r.facialHair);
  if (r.mask) q.set('mask', r.mask);
  return `https://api.dicebear.com/9.x/open-peeps/svg?${q.toString()}`;
}

await mkdir('data/portraits-op', { recursive: true });
for (const r of ROLES) {
  const u = url(r);
  const res = await fetch(u);
  if (!res.ok) { console.error('FAIL', r.id, res.status); continue; }
  const svg = await res.text();
  await writeFile(`data/portraits-op/${r.id}.svg`, svg);
  console.log('ok', r.id, svg.length, 'bytes');
}
console.log('done', ROLES.length);
