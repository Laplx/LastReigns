// 给 index.html 入口引用与 src/*.js 的相对 import 统一打上 ?v=<package.version>，
// 破除浏览器对 ES 模块/样式的缓存。发版时（改完 package.json 版本号后）跑一次：
//   node scripts/stamp-version.mjs
import { readFile, writeFile, readdir } from 'node:fs/promises';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const v = pkg.version;
const stamp = (p) => `${p}?v=${v}`;
// 把 ./x.js 或 ./x.js?v=旧 统一替换为 ./x.js?v=新
const reJs = /(\.\/[A-Za-z0-9_-]+\.js)(\?v=[^'"]*)?/g;
const reCss = /(\.\/styles\.css)(\?v=[^'"]*)?/g;
const reGame = /(\.\/src\/game\.js)(\?v=[^'"]*)?/g;

let html = await readFile('index.html', 'utf8');
html = html.replace(reCss, (_, p) => stamp(p)).replace(reGame, (_, p) => stamp(p));
await writeFile('index.html', html);

const files = (await readdir('src')).filter((f) => f.endsWith('.js'));
for (const f of files) {
  const path = `src/${f}`;
  let src = await readFile(path, 'utf8');
  // 仅替换 import/export ... from './x.js' 中的相对模块路径
  src = src.replace(/(from\s+['"])(\.\/[A-Za-z0-9_-]+\.js)(\?v=[^'"]*)?(['"])/g, (_, a, p, _old, b) => `${a}${stamp(p)}${b}`);
  await writeFile(path, src);
}
console.log(`stamped ?v=${v} → index.html + ${files.length} src modules`);
