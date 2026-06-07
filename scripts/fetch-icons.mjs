// 22 角色 → Lucide icon（ISC 许可，单色描边，染成暖金）
// 取景 A（原框）。icon 叠在人物头部左上方。
import { writeFile, mkdir, readFile } from 'node:fs/promises';

// 角色 → lucide icon 名（贴合职业）
const ICON = {
  general: 'swords',         // 将军：交叉双剑（更具军事意味）
  finance: 'landmark',       // 财长：国库/银行
  chief: 'tent-tree',        // 部族长老：部落营地
  firstlady: 'gem',          // 第一夫人：珠宝
  priest: 'church',          // 教会主席：教堂（明确宗教，非对称十字）
  chen: 'pickaxe',           // 矿业代表：矿镐
  dupont: 'briefcase',       // 掮客：公文包
  spy: 'eye',                // 安全局：监视之眼
  reformer: 'lightbulb',     // 改革司：新点子（与秘书处文件区分）
  uncle: 'gavel',            // 党元老：权槌（资历/权力）
  secretary: 'file-text',    // 秘书处：文件
  reporter: 'camera',        // 记者：相机
  doctor: 'stethoscope',     // 医生：听诊器
  soldier: 'shield-half',    // 军官：盾牌（与将军的交叉双剑区分）
  diplomat: 'globe',         // 外交：地球
  business: 'coins',         // 商人：钱币（比钞票更明显）
  cleric_generic: 'book-marked', // 教士：经书
  judge: 'scale',            // 法务：天平
  worker: 'wrench',          // 工人：扳手
  student: 'graduation-cap', // 学生：学位帽
  local_baron: 'stamp',            // 地方官：印章
  citizen: 'users',          // 市民：群众
};

const BASE = 'https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/';

await mkdir('data/icons', { recursive: true });
const missing = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(name, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { const res = await fetch(BASE + name + '.svg'); if (res.ok) return await res.text(); }
    catch { /* retry */ }
    await sleep(400 * (i + 1));
  }
  return null;
}
for (const [id, name] of Object.entries(ICON)) {
  const svg = await get(name);
  if (!svg) { missing.push(`${id}:${name}`); console.log('FAIL', id); continue; }
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
  await writeFile(`data/icons/${id}.svg`, inner);
  console.log('ok', id, '->', name);
  await sleep(150);
}
if (missing.length) console.log('MISSING:', missing.join(', '));
console.log('done');
