// 事件链系统（副本机制）：同时最多 2 条，独立进度，可相互干扰。
// 连续卡片流下：激活(年度tick)与浮现(逐卡)分离。
// "不作为的代价"：同一链连续 2 次选择拖延选项 → 强制升级到最坏节点。

import { rngChance, rngPick } from './state.js';

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

// 年度 tick：尝试激活一条新链（≤2 条），并记下"新的暗流"供通知
export function tryActivateChain(state, content) {
  if (state.activeChains.length >= 2) return null;
  const defs = content.chains || [];
  const avail = defs.filter(
    (d) => !state.activeChains.find((a) => a.id === d.id) &&
           !state.completedChains.includes(d.id) &&
           triggerMet(state, d)
  );
  if (!avail.length || !rngChance(state, 0.7)) return null;
  const d = rngPick(state, avail);
  state.activeChains.push({ id: d.id, step: 0, defers: 0, shownYear: 0 });
  state.chainJustActivated = { id: d.id, title: d.title };
  return d;
}

// 逐卡浮现：返回一张活跃链的事件卡（每条链一年至多浮现一次），否则 null
export function drawChainCard(state, content) {
  const candidates = state.activeChains.filter((ac) => ac.shownYear < state.year && defById(content, ac.id)?.steps[ac.step]);
  if (!candidates.length) return null;
  const ac = candidates[0];
  const def = defById(content, ac.id);
  ac.shownYear = state.year;
  return buildChainCard(state, def, ac);
}

function buildChainCard(state, def, ac) {
  const step = def.steps[ac.step];
  return {
    id: `chain_${def.id}_${ac.step}`,
    type: 'chain', chain: true,
    kicker: step.kicker || def.title,
    title: step.title,
    speaker: step.speaker,
    narrative: step.narrative,
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
