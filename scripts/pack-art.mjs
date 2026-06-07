// 把 data/portraits-op/*.svg（open-peeps 半身像）与 data/icons/*.svg（lucide 职业图标 inner）
// 打包成单个 data/portraits-art.json，供运行时一次性加载（离线可用，不再逐个 fetch）。
import { readFile, writeFile, readdir } from 'node:fs/promises';

const ROLES = ['general','finance','chief','firstlady','priest','chen','dupont','spy','reformer','uncle','secretary','reporter','doctor','soldier','diplomat','business','cleric_generic','judge','worker','student','local_baron','citizen'];

const peeps = {};
const icons = {};
for (const id of ROLES) {
  // open-peeps：去掉 metadata 块（含署名注释，体积大且无需运行时）但保留 CC0 来源一行注释
  let op = await readFile(`data/portraits-op/${id}.svg`, 'utf8');
  op = op.replace(/<metadata[\s\S]*?<\/metadata>/, '');
  peeps[id] = op.trim();
  icons[id] = (await readFile(`data/icons/${id}.svg`, 'utf8')).trim();
}

const out = {
  _license: 'Portraits: Open Peeps by Pablo Stanley (CC0) via DiceBear. Icons: Lucide (ISC).',
  peeps,
  icons,
};
await writeFile('data/portraits-art.json', JSON.stringify(out));
console.log('wrote data/portraits-art.json', Object.keys(peeps).length, 'peeps,', Object.keys(icons).length, 'icons');
