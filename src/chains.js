// 事件链系统（副本机制）：同时最多 2 条，独立进度，可相互干扰。
// 连续卡片流下：激活(年度tick)与浮现(逐卡)分离。
// "不作为的代价"：同一链连续 2 次选择拖延选项 → 强制升级到最坏节点。

import { rngChance, rngPick } from './state.js';

const MAX_ACTIVE_CHAINS = 2;
const MAX_CHAIN_CARDS_PER_YEAR = 2;

function loyaltyGap(state) {
  const ls = state.people.filter((p) => p.alive).map((p) => p.loyalty);
  if (ls.length < 2) return 0;
  return Math.max(...ls) - Math.min(...ls);
}
function triggerMet(state, def) {
  const t = def.trigger || {};
  if (t.minYear != null && state.year < t.minYear) return false;
  if (t.healthMax != null && state.ind.health > t.healthMax) return false;
  if (t.moraleMax != null && state.ind.morale > t.moraleMax) return false;
  if (t.moraleMin != null && state.ind.morale < t.moraleMin) return false;
  if (t.intlMin != null && state.ind.intl < t.intlMin) return false;
  if (t.intlMax != null && state.ind.intl > t.intlMax) return false;
  if (t.financeMax != null && state.ind.finance > t.financeMax) return false;
  if (t.borderMin != null && state.hidden.borderTension < t.borderMin) return false;
  if (t.loyaltyGapMin != null && loyaltyGap(state) < t.loyaltyGapMin) return false;
  return true;
}
function defById(content, id) { return content.chains.find((d) => d.id === id); }
function chainThemeCooling(state, def) {
  const theme = def?.theme;
  return !!(theme && state.themeCooldowns && state.themeCooldowns[theme] >= state.year);
}
function chainDueScore(state, ac) {
  if (!ac.shownYear) return 1000;
  return (state.year - ac.shownYear) * 10 + (ac.defers || 0);
}

// 年度 tick：尝试激活一条新链（≤2 条），并记下"新的暗流"供通知
// 保证每局早期至少明显出现一条链（force-seed）。
export function tryActivateChain(state, content) {
  if (state.activeChains.length >= MAX_ACTIVE_CHAINS) return null;
  const defs = content.chains || [];
  const taken = (d) => state.activeChains.find((a) => a.id === d.id) || state.completedChains.includes(d.id);
  let pool = defs.filter((d) => !taken(d) && triggerMet(state, d) && !chainThemeCooling(state, d));
  if (!pool.length) pool = defs.filter((d) => !taken(d) && triggerMet(state, d));

  const forceSeed = state.activeChains.length === 0 && state.completedChains.length === 0 && state.year >= 4;
  if (!pool.length && forceSeed) {
    // 强制开局只允许低语境依赖的链兜底，避免无条件触发叛乱/边境/外部压力。
    pool = defs.filter((d) => d.forceSeed && !taken(d) && ((d.trigger || {}).minYear == null || state.year >= d.trigger.minYear));
  }
  if (!pool.length) return null;
  if (!forceSeed && state.lastChainActivatedYear && state.year - state.lastChainActivatedYear < 2) return null;
  if (!forceSeed && !rngChance(state, 0.58)) return null;

  const d = rngPick(state, pool);
  state.activeChains.push({ id: d.id, step: 0, defers: 0, shownYear: 0, activatedYear: state.year });
  state.chainJustActivated = { id: d.id, title: d.title };
  state.lastChainActivatedYear = state.year;
  return d;
}

// 逐卡浮现：返回一张活跃链的事件卡（每条链一年至多浮现一次），否则 null
export function drawChainCard(state, content, narrCache) {
  if ((state.chainCardsThisYear || 0) >= MAX_CHAIN_CARDS_PER_YEAR) return null;
  const candidates = state.activeChains
    .filter((ac) => ac.shownYear < state.year && defById(content, ac.id)?.steps[ac.step])
    .sort((a, b) => chainDueScore(state, b) - chainDueScore(state, a));
  if (!candidates.length) return null;
  const ac = candidates[0];
  const def = defById(content, ac.id);
  ac.shownYear = state.year;
  state.chainCardsThisYear = (state.chainCardsThisYear || 0) + 1;
  return buildChainCard(state, def, ac, narrCache);
}

// 当前活跃链待显示的节点（供 game.js 后台改写叙事）
export function getActiveSteps(state, content) {
  return state.activeChains.map((ac) => { const def = defById(content, ac.id); return def && def.steps[ac.step] ? { def, step: ac.step, key: `${def.id}_${ac.step}` } : null; }).filter(Boolean);
}

function buildChainCard(state, def, ac, narrCache) {
  const step = def.steps[ac.step];
  const deferred = (ac.defers || 0) > 0;
  const stepTitle = deferred ? `${step.title} · 续报` : step.title;
  const title = `${def.title} · ${stepTitle}`;
  const baseNarrative = (narrCache && narrCache[`${def.id}_${ac.step}`]) || step.narrative;
  const narrative = deferred
    ? `这件事被搁置后，并没有自行消失。相同的人、相同的账本、相同的外国记者，又以更糟的姿态回到桌上。\n\n${baseNarrative}`
    : baseNarrative;
  return {
    id: `chain_${def.id}_${ac.step}_${ac.defers || 0}`,
    type: 'chain', chain: true,
    theme: step.theme || def.theme,
    stages: def.stages,
    kicker: step.kicker || def.title,
    title,
    speaker: step.speaker,
    narrative,
    options: step.options.map((o) => ({ text: o.text, hint: o.hint, effects: o.effects, result: o.result })),
    onResolve: (st, i) => advanceChain(st, def, ac, i),
  };
}

function advanceChain(state, def, ac, optionIndex) {
  const step = def.steps[ac.step];
  const opt = step.options[optionIndex];
  if (opt.setHeir) state.hidden.heir = opt.setHeir;
  if (opt.defer) ac.defers = (ac.defers || 0) + 1; else ac.defers = 0;

  let goto = opt.goto;
  if (ac.defers >= 2 && step.escalateTo != null) { goto = step.escalateTo; state.flags.somethingNoReturn = true; }

  if (goto == null || goto < 0) {
    state.completedChains.push(def.id);
    state.activeChains = state.activeChains.filter((a) => a !== ac);
  } else {
    ac.step = goto;
  }
}

// 当前活跃链标题（UI"进行中的事态" + LLM 摘要）
export function activeChainTitles(state, content) {
  return state.activeChains.map((a) => (defById(content, a.id) || {}).title).filter(Boolean);
}

// "新的暗流"通知卡
export function makeChainAnnounceCard(info) {
  return {
    id: `announce_${info.id}`, type: 'notify',
    kicker: '暗流', title: '一桩新的事态',
    narrative: `首都的空气里，有什么东西正在悄悄改变。一条新的暗流开始涌动——「${info.title}」。它不会立刻爆发，但从此，它会在背景里慢慢生长，直到有一天，您不得不正视它。`,
    options: [
      { text: '记下了，静观其变', effects: {}, result: '您把它记在了心里。有些事，急不得，也躲不掉。' },
      { text: '吩咐安全局留意', effects: { loyalty: { spy: '+small' } }, result: '您让人盯着点。情报，总是越早越好。' },
    ],
  };
}
