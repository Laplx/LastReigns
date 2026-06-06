// 事件链系统（副本机制）：同时最多 2 条，独立进度，可相互干扰。
// 连续卡片流下：激活(年度tick)与浮现(逐卡)分离。
// "不作为的代价"：同一链连续 2 次选择拖延选项 → 强制升级到最坏节点。

import { rngChance } from './state.js';

const MAX_ACTIVE_CHAINS = 2;
const DEFAULT_CHAIN_CARDS_PER_YEAR = 2;
const GENERATED_CHAIN_TTL = 10;
const GENERATED_CHAIN_SOFT_LIMIT = 16;
const CORE = ['army', 'elite', 'morale', 'intl', 'finance', 'health'];

function loyaltyGap(state) {
  const ls = state.people.filter((p) => p.alive).map((p) => p.loyalty);
  if (ls.length < 2) return 0;
  return Math.max(...ls) - Math.min(...ls);
}
function ensureChainStats(state) {
  if (!state.chainStats) state.chainStats = { preparedStarted: 0, generatedStarted: 0, generatedCalls: 0 };
  if (state.chainStats.preparedStarted == null) state.chainStats.preparedStarted = 0;
  if (state.chainStats.generatedStarted == null) state.chainStats.generatedStarted = 0;
  if (state.chainStats.generatedCalls == null) state.chainStats.generatedCalls = 0;
  return state.chainStats;
}
export function triggerMet(state, def) {
  const t = def.trigger || {};
  if (t.minYear != null && state.year < t.minYear) return false;
  for (const key of CORE) {
    const v = state.ind[key];
    if (t[`${key}Max`] != null && v > t[`${key}Max`]) return false;
    if (t[`${key}Min`] != null && v < t[`${key}Min`]) return false;
  }
  if (t.borderMin != null && state.hidden.borderTension < t.borderMin) return false;
  if (t.borderMax != null && state.hidden.borderTension > t.borderMax) return false;
  if (t.loyaltyGapMin != null && loyaltyGap(state) < t.loyaltyGapMin) return false;
  if (t.loyaltyGapMax != null && loyaltyGap(state) > t.loyaltyGapMax) return false;
  if (t.sanctioned != null && !!state.sanctioned !== !!t.sanctioned) return false;
  if (t.hasHeir != null && !!state.hidden.heir !== !!t.hasHeir) return false;
  return true;
}
function isGenerated(def) { return !!(def && (def.generated || def.source === 'llm')); }
function allDefs(state, content) { return [...(content.chains || []), ...(state.generatedChains || [])]; }
function defById(content, id, state) { return allDefs(state || {}, content).find((d) => d.id === id); }
function chainThemeCooling(state, def) {
  const theme = def?.theme;
  return !!(theme && state.themeCooldowns && state.themeCooldowns[theme] >= state.year);
}
function chainAge(state, ac) {
  return Math.max(0, state.year - (ac.activatedYear || state.year));
}
function chainShowsThisYear(state, ac) {
  if (ac.shownYear !== state.year) return 0;
  return ac.shownCount || 1;
}
function perChainCardLimit(state, def, ac) {
  let limit = 1;
  if ((ac.defers || 0) > 0) limit = 2;
  if (isGenerated(def) && def.llmKind === 'crisis' && triggerMet(state, def)) limit = 2;
  if (chainAge(state, ac) >= 3) limit = 2;
  return limit;
}
function chainDueScore(state, ac, def) {
  let score = !ac.shownYear ? 1000 : (state.year - ac.shownYear) * 10;
  if (ac.shownYear === state.year) score -= 4;
  score += (ac.defers || 0) * 8;
  const age = chainAge(state, ac);
  if (age >= 3) score += 35 + (age - 3) * 8;
  if (isGenerated(def) && def.llmKind === 'crisis' && triggerMet(state, def)) score += 16;
  return score;
}
function activeChainLimit(state) {
  const stats = ensureChainStats(state);
  const active = new Set((state.activeChains || []).map((a) => a.id));
  const completed = new Set(state.completedChains || []);
  const hasReadyGenerated = (state.generatedChains || []).some((d) => (
    !active.has(d.id) && !completed.has(d.id) && triggerMet(state, d)
  ));
  return stats.generatedStarted < 1 && state.year >= 8 && hasReadyGenerated ? 3 : MAX_ACTIVE_CHAINS;
}
function weightedPick(state, pool) {
  const items = pool.map((d) => ({ d, w: chainActivationWeight(state, d) }));
  const total = items.reduce((s, x) => s + x.w, 0);
  let r = state.rng() * total;
  for (const x of items) { r -= x.w; if (r <= 0) return x.d; }
  return items[items.length - 1]?.d || pool[0];
}
function chainActivationWeight(state, def) {
  const stats = ensureChainStats(state);
  let w = 1;
  if (!isGenerated(def) && stats.preparedStarted < 2) w *= 1.2;
  if (isGenerated(def)) {
    if (def.llmKind === 'crisis' && triggerMet(state, def)) w *= 1.6;
    if (stats.generatedStarted < 1 && state.year >= 8) w *= 1.8;
    if (typeof def.fit === 'number') w *= Math.max(0.75, Math.min(1.5, def.fit));
  }
  return w;
}
function chainCardLimit(state, content) {
  const active = state.activeChains || [];
  const activeDefs = active.map((ac) => defById(content, ac.id, state)).filter(Boolean);
  const activeCrisis = activeDefs.some((d) => isGenerated(d) && d.llmKind === 'crisis' && triggerMet(state, d));
  const stale = active.some((ac) => chainAge(state, ac) >= 3 || (ac.defers || 0) >= 2);
  if ((active.length >= 2 && activeCrisis) || stale) return 4;
  if (active.length >= 2 || activeCrisis) return 3;
  return DEFAULT_CHAIN_CARDS_PER_YEAR;
}

// 年度 tick：尝试激活一条新链（≤2 条），并记下"新的暗流"供通知
// 保证每局早期至少明显出现一条链（force-seed）。
export function tryActivateChain(state, content) {
  maintainGeneratedChains(state);
  if (state.activeChains.length >= activeChainLimit(state)) return null;
  const defs = allDefs(state, content);
  const taken = (d) => state.activeChains.find((a) => a.id === d.id) || state.completedChains.includes(d.id);
  let pool = defs.filter((d) => !taken(d) && triggerMet(state, d) && !chainThemeCooling(state, d));
  if (!pool.length) pool = defs.filter((d) => !taken(d) && triggerMet(state, d));

  const forceSeed = state.activeChains.length === 0 && state.completedChains.length === 0 && state.year >= 4;
  if (forceSeed && ensureChainStats(state).preparedStarted === 0) {
    const forcePool = (content.chains || []).filter((d) => d.forceSeed && !taken(d) && ((d.trigger || {}).minYear == null || state.year >= d.trigger.minYear));
    if (forcePool.length) pool = forcePool;
  } else if (!pool.length && forceSeed) {
    // 强制开局只允许低语境依赖的链兜底，避免无条件触发叛乱/边境/外部压力。
    pool = (content.chains || []).filter((d) => d.forceSeed && !taken(d) && ((d.trigger || {}).minYear == null || state.year >= d.trigger.minYear));
  }
  if (!pool.length) return null;
  if (!forceSeed && state.lastChainActivatedYear && state.year - state.lastChainActivatedYear < 2) return null;
  if (!forceSeed && !rngChance(state, 0.58)) return null;

  const d = weightedPick(state, pool);
  const generated = isGenerated(d);
  state.activeChains.push({ id: d.id, step: 0, defers: 0, shownYear: 0, activatedYear: state.year, source: generated ? 'llm' : 'static', llmKind: d.llmKind || null });
  state.chainJustActivated = { id: d.id, title: d.title };
  state.lastChainActivatedYear = state.year;
  const stats = ensureChainStats(state);
  if (generated) stats.generatedStarted += 1;
  else stats.preparedStarted += 1;
  return d;
}

// 逐卡浮现：返回一张活跃链的事件卡；积压/危机/拖延链同年可推进第二次。
export function drawChainCard(state, content, narrCache) {
  if ((state.chainCardsThisYear || 0) >= chainCardLimit(state, content)) return null;
  const candidates = state.activeChains
    .map((ac) => ({ ac, def: defById(content, ac.id, state) }))
    .filter(({ ac, def }) => def?.steps[ac.step] && chainShowsThisYear(state, ac) < perChainCardLimit(state, def, ac))
    .sort((a, b) => chainDueScore(state, b.ac, b.def) - chainDueScore(state, a.ac, a.def));
  if (!candidates.length) return null;
  const { ac, def } = candidates[0];
  const shown = chainShowsThisYear(state, ac);
  ac.shownYear = state.year;
  ac.shownCount = shown + 1;
  state.chainCardsThisYear = (state.chainCardsThisYear || 0) + 1;
  return buildChainCard(state, def, ac, narrCache);
}

// 当前活跃链待显示的节点（供 game.js 后台改写叙事）
export function getActiveSteps(state, content) {
  return state.activeChains.map((ac) => {
    const def = defById(content, ac.id, state);
    return def && !isGenerated(def) && def.steps[ac.step] ? { def, step: ac.step, key: `${def.id}_${ac.step}` } : null;
  }).filter(Boolean);
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
  return state.activeChains.map((a) => (defById(content, a.id, state) || {}).title).filter(Boolean);
}

export function registerGeneratedChain(state, chain) {
  if (!chain || !chain.id || !chain.title || !Array.isArray(chain.steps) || chain.steps.length < 3) return false;
  if (!state.generatedChains) state.generatedChains = [];
  const ids = new Set([
    ...state.generatedChains.map((d) => d.id),
    ...(state.activeChains || []).map((d) => d.id),
    ...(state.completedChains || []),
  ]);
  if (ids.has(chain.id)) return false;
  const titles = new Set(state.generatedChains.map((d) => String(d.title || '').trim()).filter(Boolean));
  if (titles.has(String(chain.title || '').trim())) return false;
  chain.generated = true;
  chain.source = 'llm';
  chain.createdYear = chain.createdYear || state.year;
  chain.expiresYear = chain.expiresYear || (state.year + GENERATED_CHAIN_TTL);
  if (triggerMet(state, chain)) chain.lastFitYear = state.year;
  state.generatedChains.push(chain);
  maintainGeneratedChains(state);
  return true;
}

export function maintainGeneratedChains(state) {
  if (!state.generatedChains) state.generatedChains = [];
  const active = new Set((state.activeChains || []).map((a) => a.id));
  const completed = new Set(state.completedChains || []);
  const themeCounts = {};
  for (const d of state.generatedChains) themeCounts[d.theme || ''] = (themeCounts[d.theme || ''] || 0) + 1;

  state.generatedChains = state.generatedChains.filter((d) => {
    if (!d || !d.id || completed.has(d.id)) return false;
    if (triggerMet(state, d)) d.lastFitYear = state.year;
    if (active.has(d.id)) return true;
    return (d.expiresYear || state.year) >= state.year;
  });

  const activeDefs = state.generatedChains.filter((d) => active.has(d.id));
  const idle = state.generatedChains.filter((d) => !active.has(d.id));
  if (idle.length <= GENERATED_CHAIN_SOFT_LIMIT) return;

  const keepScore = (d) => {
    const age = state.year - (d.createdYear || state.year);
    const fit = typeof d.fit === 'number' ? d.fit : 1;
    let s = triggerMet(state, d) ? 100 : 0;
    if (d.llmKind === 'crisis') {
      s += triggerMet(state, d) ? 20 : -30;
      if (d.lastFitYear && state.year - d.lastFitYear >= 2) s -= 35;
    }
    if ((themeCounts[d.theme || ''] || 0) > 1) s -= 10;
    s += fit * 12;
    s -= age * 3;
    return s;
  };
  idle.sort((a, b) => keepScore(b) - keepScore(a));
  state.generatedChains = [...activeDefs, ...idle.slice(0, GENERATED_CHAIN_SOFT_LIMIT)];
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
