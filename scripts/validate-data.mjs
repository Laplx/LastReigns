import { readFile } from 'node:fs/promises';

const CORE = new Set(['army', 'elite', 'morale', 'intl', 'finance', 'health']);
const HIDDEN = new Set(['borderTension', 'legacy', 'history']);
const DECO = new Set(['health_care', 'education', 'capital', 'press']);
const BANDS = new Set(['+small', '-small', '+mid', '-mid', '+big', '-big', '+huge', '-huge']);
const STAGES = new Set(['early', 'mid', 'late']);
const EFFECT_KEYS = new Set([...CORE, ...HIDDEN, 'wealth', 'wealthOverseas', 'wealthDomestic', 'deco', 'loyalty', 'flags', 'oneTime', 'annex', 'territory']);

const errors = [];
const themes = new Set();

async function json(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    errors.push(`${path}: JSON 读取失败：${err.message}`);
    return null;
  }
}

function at(path, msg) {
  errors.push(`${path}: ${msg}`);
}

function isBand(v) {
  return typeof v === 'string' && BANDS.has(v.trim());
}
function validateTheme(obj, path) {
  if (typeof obj.theme !== 'string' || !obj.theme.trim()) return at(path, '缺少 theme');
  themes.add(obj.theme.trim());
}
function validateStages(obj, path) {
  if (!Array.isArray(obj.stages) || !obj.stages.length) return at(path, 'stages 必须是非空数组');
  for (const s of obj.stages) if (!STAGES.has(s)) at(path, `未知 stage：${s}`);
}
function hasCoreEffect(effects) {
  return !!effects && typeof effects === 'object' && Object.keys(effects).some((key) => CORE.has(key));
}

function validateEffects(effects, path) {
  if (!effects || typeof effects !== 'object' || Array.isArray(effects)) {
    at(path, 'effects 必须是对象');
    return;
  }
  for (const [key, value] of Object.entries(effects)) {
    if (!EFFECT_KEYS.has(key)) at(path, `未知 effects key：${key}`);
    if (CORE.has(key) || HIDDEN.has(key)) {
      if (!isBand(value) && typeof value !== 'number') at(path, `${key} 必须是档位 token 或数字`);
    } else if (key === 'deco') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) at(path, 'deco 必须是对象');
      else for (const [k, v] of Object.entries(value)) {
        if (!DECO.has(k)) at(path, `未知 deco key：${k}`);
        if (!isBand(v) && typeof v !== 'number') at(path, `deco.${k} 必须是档位 token 或数字`);
      }
    } else if (key === 'loyalty') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) at(path, 'loyalty 必须是对象');
      else for (const [pid, v] of Object.entries(value)) {
        if (!pid) at(path, 'loyalty key 不能为空');
        if (!isBand(v) && typeof v !== 'number') at(path, `loyalty.${pid} 必须是档位 token 或数字`);
      }
    } else if (key === 'flags') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) at(path, 'flags 必须是对象');
      else for (const [k, v] of Object.entries(value)) if (!k || typeof v !== 'boolean') at(path, `flags.${k} 必须是布尔值`);
    } else if (key === 'oneTime') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) at(path, 'oneTime 必须是对象');
      else for (const [k, v] of Object.entries(value)) if (!k || typeof v !== 'number') at(path, `oneTime.${k} 必须是数字`);
    } else if (['wealth', 'wealthOverseas', 'wealthDomestic', 'territory'].includes(key)) {
      if (typeof value !== 'number') at(path, `${key} 必须是数字`);
    } else if (key === 'annex' && value !== true) {
      at(path, 'annex 只能为 true');
    }
  }
}

function validateOptions(options, path, ctx = {}) {
  if (!Array.isArray(options) || options.length < 1) {
    at(path, 'options 至少需要 1 项');
    return;
  }
  options.forEach((opt, i) => {
    const p = `${path}.options[${i}]`;
    if (!opt || typeof opt !== 'object') return at(p, 'option 必须是对象');
    if (!opt.text) at(p, '缺少 text');
    if (!('effects' in opt)) at(p, '缺少 effects');
    else {
      validateEffects(opt.effects, p);
      if (ctx.notify && hasCoreEffect(opt.effects)) at(p, 'notify 不能直接改核心指标');
    }
    if (ctx.chain && !('goto' in opt)) at(p, '链选项必须显式写 goto');
    if ('cost' in opt && (!opt.cost || typeof opt.cost !== 'object')) at(p, 'cost 必须是对象');
  });
}

function validateEvents(events) {
  if (!Array.isArray(events)) return at('data/events.json', '根节点必须是数组');
  const ids = new Set();
  const counts = { normal: 0, notify: 0 };
  events.forEach((card, i) => {
    const p = `data/events.json[${i}]`;
    if (!card || typeof card !== 'object') return at(p, '事件必须是对象');
    if (!card.id) at(p, '缺少 id');
    else if (ids.has(card.id)) at(p, `重复 id：${card.id}`);
    else ids.add(card.id);
    if (!['normal', 'notify', 'special', 'chain'].includes(card.type)) at(p, `未知 type：${card.type}`);
    if (!card.title) at(p, '缺少 title');
    if (card.type === 'normal' || card.type === 'notify') {
      counts[card.type] += 1;
      if (!card.category) at(p, '缺少 category');
      validateTheme(card, p);
      validateStages(card, p);
    }
    if (card.minYear != null && typeof card.minYear !== 'number') at(p, 'minYear 必须是数字');
    if (card.maxYear != null && typeof card.maxYear !== 'number') at(p, 'maxYear 必须是数字');
    validateOptions(card.options, p, { notify: card.type === 'notify' });
  });
  if (counts.normal < 120) at('data/events.json', `normal 数量不足：${counts.normal} < 120`);
  if (counts.notify < 25 || counts.notify > 35) at('data/events.json', `notify 数量应为 25-35：当前 ${counts.notify}`);
  return ids;
}

function validateChains(chains) {
  if (!Array.isArray(chains)) return at('data/chains.json', '根节点必须是数组');
  const ids = new Set();
  if (chains.length < 20) at('data/chains.json', `事件链数量不足：${chains.length} < 20`);
  chains.forEach((chain, ci) => {
    const p = `data/chains.json[${ci}]`;
    if (!chain.id) at(p, '缺少 id');
    else if (ids.has(chain.id)) at(p, `重复 id：${chain.id}`);
    else ids.add(chain.id);
    validateTheme(chain, p);
    validateStages(chain, p);
    if (!Array.isArray(chain.steps) || !chain.steps.length) return at(p, 'steps 不能为空');
    if (chain.steps.length < 4 || chain.steps.length > 8) at(p, `steps 深度应为 4-8：当前 ${chain.steps.length}`);
    chain.steps.forEach((step, si) => {
      const sp = `${p}.steps[${si}]`;
      if (!step.title) at(sp, '缺少 title');
      if (step.escalateTo != null && (step.escalateTo < 0 || step.escalateTo >= chain.steps.length || step.escalateTo === si)) at(sp, `escalateTo 非法：${step.escalateTo}`);
      validateOptions(step.options, sp, { chain: true });
      (step.options || []).forEach((opt, oi) => {
        if (opt.goto != null && (opt.goto < -1 || opt.goto >= chain.steps.length)) at(`${sp}.options[${oi}]`, `goto 越界：${opt.goto}`);
        if (opt.defer && step.escalateTo == null) at(`${sp}.options[${oi}]`, 'defer 选项所在节点必须提供 escalateTo');
      });
    });
    const reachable = new Set([0]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const si of [...reachable]) {
        const step = chain.steps[si];
        for (const opt of step.options || []) {
          if (opt.goto != null && opt.goto >= 0 && !reachable.has(opt.goto)) { reachable.add(opt.goto); changed = true; }
        }
        if (step.escalateTo != null && !reachable.has(step.escalateTo)) { reachable.add(step.escalateTo); changed = true; }
      }
    }
    chain.steps.forEach((_, si) => { if (!reachable.has(si)) at(`${p}.steps[${si}]`, '节点从 step 0 不可达'); });
  });
  return ids;
}

function validatePeople(people) {
  if (!Array.isArray(people)) return at('data/people.json', '根节点必须是数组');
  const ids = new Set();
  people.forEach((p, i) => {
    const path = `data/people.json[${i}]`;
    if (!p.id) at(path, '缺少 id');
    else if (ids.has(p.id)) at(path, `重复 id：${p.id}`);
    else ids.add(p.id);
    if (!p.title) at(path, '缺少 title');
    if (!Array.isArray(p.namePool) || !p.namePool.length) at(path, 'namePool 不能为空');
  });
}

function validateWorld(world) {
  if (!world || typeof world !== 'object') return at('data/world.json', '根节点必须是对象');
  for (const key of ['nations', 'leaders', 'regions']) {
    if (!Array.isArray(world[key]) || !world[key].length) at('data/world.json', `${key} 不能为空`);
  }
}

const [events, chains, people, world] = await Promise.all([
  json('data/events.json'),
  json('data/chains.json'),
  json('data/people.json'),
  json('data/world.json'),
]);

const eventIds = events ? validateEvents(events) : new Set();
const chainIds = chains ? validateChains(chains) : new Set();
if (people) validatePeople(people);
if (world) validateWorld(world);
for (const id of chainIds || []) if (eventIds?.has(id)) at('data/chains.json', `chain id 与 event id 冲突：${id}`);
if (themes.size < 15) at('data', `theme 数量不足：${themes.size} < 15`);

if (errors.length) {
  console.error(`数据校验失败：${errors.length} 个问题`);
  for (const err of errors) console.error(`- ${err}`);
  process.exit(1);
}

console.log('数据校验通过');
