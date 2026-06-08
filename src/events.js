// 抽卡、资格、效果落账、事与愿违、人物绑定、国名替换。

import { rngChance, rngPick } from './state.js?v=1.3.2';
import { applyEffects, adjustLoyalty } from './engine.js?v=1.3.2';
import { resolveCardPortrait } from './portraits.js?v=1.3.2';

const STAGES = new Set(['early', 'mid', 'late']);
const THEME_COOLDOWN = { notify: 2, chain: 6, special: 4, normal: 5 };

// 预处理：标注每张卡"涉及哪些具名人物"（_feat），用人名别名扫描。
export function prepareContent(content) {
  const canon = {}; // 人名别名 → roleId
  for (const p of content.people) for (const name of (p.namePool || [p.id])) canon[name] = p.id;
  content._canon = canon;
  for (const c of content.events) c._feat = featOf(c, canon);
  return content;
}
function featOf(card, canon) {
  const text = [card.speaker || '', card.narrative || '', ...(card.options || []).flatMap((o) => [o.text || '', o.result || ''])].join(' ');
  const feat = new Set();
  for (const [name, id] of Object.entries(canon)) if (text.includes(name)) feat.add(id);
  return [...feat];
}

// 国名与本局人物名替换。事件数据可继续写每个角色的规范名。
function substPeople(state, text) {
  let out = text;
  for (const p of state.people || []) {
    for (const alias of p.aliases || [p.canonicalName, p.name]) {
      if (alias && alias !== p.name) out = out.replaceAll(alias, p.name);
    }
  }
  return out;
}
export function subst(state, text) {
  return typeof text === 'string' ? substPeople(state, text.replace(/恩加拉/g, state.nationShort)) : text;
}
export function substCard(state, card, content = null) {
  const c = { ...card };
  c.portrait = resolveCardPortrait(state, content, card);
  c.narrative = subst(state, card.narrative);
  c.speaker = subst(state, card.speaker);
  c.options = (card.options || []).map((o) => ({ ...o, text: subst(state, o.text), result: subst(state, o.result) }));
  return c;
}

function latePressure(state) {
  const i = state.ind || {};
  return i.health <= 60 || i.morale <= 25 || i.elite <= 25 || i.army <= 25 ||
    i.finance <= 25 || i.intl <= 18 || i.intl >= 82 || (state.hidden?.borderTension || 0) >= 70;
}
function currentStages(state) {
  const y = state.year || 1;
  const stages = [];
  if (y <= 7) stages.push('early');
  if (y >= 4 && y <= 24) stages.push('mid');
  if (y >= 15 || latePressure(state)) stages.push('late');
  return stages;
}
function cardStages(card) {
  const raw = Array.isArray(card.stages) ? card.stages : (card.stage ? [card.stage] : []);
  return raw.filter((s) => STAGES.has(s));
}
function stageMatches(state, card) {
  const stages = cardStages(card);
  if (!stages.length) return true;
  const now = new Set(currentStages(state));
  return stages.some((s) => now.has(s));
}
function stagePool(state, cards) {
  const preferred = cards.filter((c) => stageMatches(state, c));
  const offStage = cards.filter((c) => !stageMatches(state, c));
  if (!preferred.length) return cards;
  if (offStage.length && rngChance(state, 0.12)) return offStage;
  return preferred;
}
function cardTheme(card) { return card?.theme || null; }
function isThemeCooling(state, card) {
  const theme = cardTheme(card);
  return !!(theme && state.themeCooldowns && state.themeCooldowns[theme] >= state.year);
}
function themeReadyPool(state, cards) {
  const ready = cards.filter((c) => !isThemeCooling(state, c));
  return ready.length ? ready : cards;
}
function markThemeCooldown(state, card) {
  const theme = cardTheme(card);
  if (!theme) return;
  if (!state.themeCooldowns) state.themeCooldowns = {};
  const span = card.themeCooldown ?? THEME_COOLDOWN[card.type] ?? 4;
  state.themeCooldowns[theme] = Math.max(state.themeCooldowns[theme] || 0, state.year + span);
}

// ---- 资格 ----------------------------------------------------------------
export function isEligible(state, card) {
  if (card.unique && state.uniqueSeen.includes(card.id)) return false;
  if (card.minYear && state.year < card.minYear) return false;
  if (card.maxYear && state.year > card.maxYear) return false;
  if (card._feat && card._feat.length) { const present = new Set(state.people.filter((p) => p.alive).map((p) => p.id)); if (!card._feat.every((id) => present.has(id))) return false; }
  const r = card.requires; if (!r) return true;
  const i = state.ind;
  if (r.intlMin != null && i.intl < r.intlMin) return false;
  if (r.intlMax != null && i.intl > r.intlMax) return false;
  if (r.moraleMin != null && i.morale < r.moraleMin) return false;
  if (r.moraleMax != null && i.morale > r.moraleMax) return false;
  if (r.armyMin != null && i.army < r.armyMin) return false;
  if (r.armyMax != null && i.army > r.armyMax) return false;
  if (r.eliteMin != null && i.elite < r.eliteMin) return false;
  if (r.eliteMax != null && i.elite > r.eliteMax) return false;
  if (r.financeMin != null && i.finance < r.financeMin) return false;
  if (r.financeMax != null && i.finance > r.financeMax) return false;
  if (r.healthMax != null && i.health > r.healthMax) return false;
  if (r.healthMin != null && i.health < r.healthMin) return false;
  if (r.borderMin != null && state.hidden.borderTension < r.borderMin) return false;
  if (r.oneTime != null && (state.oneTime[r.oneTime] || 0) <= 0) return false;
  return true;
}

function weightedPick(state, pool) {
  const total = pool.reduce((s, c) => s + (c.weight || 1), 0);
  let r = state.rng() * total;
  for (const c of pool) { r -= c.weight || 1; if (r <= 0) return c; }
  return pool[pool.length - 1];
}
function allNormals(state) { return state.normalPool || []; }
function normalizeKey(text) {
  return String(text || '')
    .replace(/[“”"‘’'「」『』（）()《》<>，。、“”！？!?：:；;·\s]/g, '')
    .trim()
    .slice(0, 180);
}
export function cardKey(c) {
  const text = [c?.title || '', c?.narrative || ''].filter(Boolean).join('|');
  return normalizeKey(text || c?.id || '');
}
function appendRecent(arr, value, limit) {
  if (!value) return;
  const i = arr.indexOf(value);
  if (i >= 0) arr.splice(i, 1);
  arr.push(value);
  if (arr.length > limit) arr.splice(0, arr.length - limit);
}
function archiveKeys(state) {
  return new Set((state.archive || []).flatMap((a) => [a.eventKey, a.title, a.result]).filter(Boolean).map(normalizeKey));
}
export function rememberShown(state, card) {
  if (!state || !card) return;
  if (!state.seenEventIds) state.seenEventIds = [];
  if (!state.seenEventKeys) state.seenEventKeys = [];
  appendRecent(state.seenEventIds, card.id, 220);
  appendRecent(state.seenEventKeys, cardKey(card), 220);
  markThemeCooldown(state, card);
}

function bumpPoolStat(state, key, delta = 1) {
  if (!state.poolStats) state.poolStats = {};
  state.poolStats[key] = (state.poolStats[key] || 0) + delta;
}
function poolBatchKey(source, batch) {
  if (batch === 'boot') return source === 'llm' ? 'bootLlm' : 'bootStatic';
  if (batch === 'instant') return 'instantStatic';
  return source === 'llm' ? 'topupLlm' : 'topupStatic';
}
function poolDedupSets(state) {
  const pool = state.normalPool || [];
  const ids = new Set([...(state.seenEventIds || []), ...pool.map((c) => c.id)].filter(Boolean));
  const keys = new Set([
    ...(state.seenEventKeys || []),
    ...archiveKeys(state),
    ...pool.map(cardKey),
    ...(state.prioritySpecialQueue || []).map(cardKey),
  ].filter(Boolean));
  return { ids, keys };
}
function canEnterPool(state, card, source, opts = {}) {
  if (!card || card.type !== 'normal') return false;
  if (!isEligible(state, card) || (!opts.relaxStage && !stageMatches(state, card)) || (!opts.relaxTheme && isThemeCooling(state, card))) return false;
  const { ids, keys } = poolDedupSets(state);
  return source === 'static' ? !ids.has(card.id) && !keys.has(cardKey(card)) : !keys.has(cardKey(card));
}
function poolCard(card, source, batch) {
  return { ...card, poolSource: source, poolBatch: batch };
}
function drawWeightedUnique(state, candidates, count) {
  const pool = candidates.slice();
  const out = [];
  while (pool.length && out.length < count) {
    const picked = weightedPick(state, pool);
    out.push(picked);
    pool.splice(pool.indexOf(picked), 1);
  }
  return out;
}
export function addNormalPoolCards(state, content, cards, source = 'llm', batch = 'topup', opts = {}) {
  if (!state.normalPool) state.normalPool = [];
  let added = 0;
  for (const raw of cards || []) {
    const card = poolCard({ ...raw, type: 'normal' }, source, batch);
    if (!canEnterPool(state, card, source, opts)) continue;
    state.normalPool.push(card);
    added += 1;
    bumpPoolStat(state, poolBatchKey(source, batch));
  }
  return added;
}
export function fillStaticNormalPool(state, content, count, batch = 'topup') {
  if (!count || count < 1) return 0;
  const all = (content.events || []).filter((c) => c.type === 'normal');
  const staged = stagePool(state, all);
  const ready = themeReadyPool(state, staged);
  let relaxed = false;
  let candidates = freshByMemory(state, ready, 24, 18).filter((c) => canEnterPool(state, c, 'static'));
  if (!candidates.length) candidates = freshByMemory(state, staged, 24, 18).filter((c) => canEnterPool(state, c, 'static'));
  if (!candidates.length && staged.length !== all.length) candidates = freshByMemory(state, all, 24, 18).filter((c) => canEnterPool(state, c, 'static'));
  if (!candidates.length) { relaxed = true; candidates = freshByMemory(state, staged, 24, 18).filter((c) => canEnterPool(state, c, 'static', { relaxTheme: true })); }
  if (!candidates.length) { relaxed = true; candidates = freshByMemory(state, all, 24, 18).filter((c) => canEnterPool(state, c, 'static', { relaxTheme: true, relaxStage: true })); }
  return addNormalPoolCards(state, content, drawWeightedUnique(state, candidates, count), 'static', batch, relaxed ? { relaxTheme: true, relaxStage: true } : {});
}
function freshByMemory(state, all, primaryWindow, fallbackWindow) {
  const archived = archiveKeys(state);
  const seenIds = new Set(state.seenEventIds || []);
  const seenKeys = new Set(state.seenEventKeys || []);
  let fresh = all.filter((c) => !seenIds.has(c.id) && !seenKeys.has(cardKey(c)) && !archived.has(cardKey(c)));
  if (!fresh.length) {
    const recent = new Set((state.seenEventIds || []).slice(-primaryWindow));
    const recentKeys = new Set((state.seenEventKeys || []).slice(-primaryWindow));
    fresh = all.filter((c) => !recent.has(c.id) && !recentKeys.has(cardKey(c)) && !archived.has(cardKey(c)));
  }
  if (!fresh.length) {
    const recent = new Set((state.seenEventIds || []).slice(-fallbackWindow));
    const recentKeys = new Set((state.seenEventKeys || []).slice(-fallbackWindow));
    fresh = all.filter((c) => !recent.has(c.id) && !recentKeys.has(cardKey(c)));
  }
  return fresh;
}
function freshNormals(state, content) {
  const all = allNormals(state).filter((c) => isEligible(state, c));
  const staged = stagePool(state, all);
  let fresh = freshByMemory(state, themeReadyPool(state, staged), 24, 18);
  if (!fresh.length) fresh = freshByMemory(state, staged, 24, 18);
  if (!fresh.length && staged.length !== all.length) fresh = freshByMemory(state, themeReadyPool(state, all), 24, 18);
  return fresh;
}
export function availableNormalCount(state, content) {
  return freshNormals(state, content).length;
}
function removeFromNormalPool(state, card) {
  const pool = state.normalPool || [];
  const key = cardKey(card);
  const idx = pool.findIndex((c) => c === card || c.id === card.id || cardKey(c) === key);
  if (idx >= 0) pool.splice(idx, 1);
  if (card.poolSource === 'llm') bumpPoolStat(state, 'drawnLlm');
  else if (card.poolSource === 'static') bumpPoolStat(state, 'drawnStatic');
}
function freshNotifies(state, content) {
  const all = content.events.filter((c) => c.type === 'notify' && isEligible(state, c));
  const staged = stagePool(state, all);
  let fresh = freshByMemory(state, themeReadyPool(state, staged), 10, 8);
  if (!fresh.length) fresh = freshByMemory(state, staged, 10, 8);
  if (!fresh.length && staged.length !== all.length) fresh = freshByMemory(state, themeReadyPool(state, all), 10, 8);
  return fresh;
}

export function drawOne(state, content) {
  const normals = freshNormals(state, content), notifies = freshNotifies(state, content);
  const wantNotify = (notifies.length && rngChance(state, 0.22)) || normals.length === 0;
  let pool = wantNotify ? notifies : normals;
  if (!pool.length) pool = normals.length ? normals : notifies;
  if (!pool.length) return null;
  const card = weightedPick(state, pool);
  if (card.type === 'normal') removeFromNormalPool(state, card);
  return card;
}

// ---- 事与愿违 ------------------------------------------------------------
function personByName(state, name) {
  if (!name) return null;
  return state.people.find((p) => p.alive && [p.name, p.canonicalName, ...(p.aliases || [])].filter(Boolean).some((n) => name.includes(n) || n.includes(name)));
}
function pickTwistTarget(state, card, option) {
  const ids = new Set();
  if (option.effects && option.effects.loyalty) Object.keys(option.effects.loyalty).forEach((k) => ids.add(k));
  const sp = personByName(state, card.speaker); if (sp) ids.add(sp.id);
  return [...ids].map((id) => state.people.find((p) => p.id === id)).filter((p) => p && p.alive && !p.defected && p.loyalty < 62).sort((a, b) => a.loyalty - b.loyalty)[0] || null;
}
function maybeTwist(state, card, option) {
  if (!option.twistable) return null;
  const t = pickTwistTarget(state, card, option);
  if (!t) return null;
  const p = t.loyalty < 25 ? 0.5 : t.loyalty < 45 ? 0.32 : 0.16;
  if (!rngChance(state, p)) { if (t.loyalty < 38) t.foreshadowCount += 1; return null; }
  if (t.loyalty >= 45) { applyEffects(state, { [rngPick(state, ['elite', 'army', 'finance'])]: '-small' }); return { clue: `（事后您隐约觉得，${t.name}当时掌握的情况，似乎并不那么准确。）` }; }
  if (t.loyalty >= 25 || t.foreshadowCount < 2) { applyEffects(state, { finance: '-small' }); adjustLoyalty(state, t.id, 4); t.foreshadowCount += 1; return { clue: `（${t.name}事后轻描淡写地提到，他的一位亲戚“最近找到了不错的差事”。）` }; }
  applyEffects(state, { elite: '-mid', intl: '+small' }); adjustLoyalty(state, t.id, -6);
  return { clue: `（几周后您才发现，您的对手似乎早就知道了这件事——是从谁那里？）` };
}

function effectSign(value) {
  if (typeof value === 'number') return Math.sign(value);
  const t = String(value || '').trim();
  if (t.startsWith('+')) return 1;
  if (t.startsWith('-')) return -1;
  return 0;
}
function firstLiving(state, ids) {
  return (ids || []).map((id) => state.people.find((p) => p.id === id && p.alive)).filter(Boolean)[0] || null;
}
function relationEcho(state, effects) {
  if (!effects?.loyalty) return '';
  const lines = [];
  for (const [pid, token] of Object.entries(effects.loyalty)) {
    const p = state.people.find((x) => x.id === pid && x.alive);
    const sign = effectSign(token);
    if (!p || !sign) continue;
    const ally = firstLiving(state, p.allies);
    const rival = firstLiving(state, p.rivals);
    if (sign < 0) {
      if (ally) lines.push(`与${p.name}走得近的${ally.name}也安静了许多。`);
      if (rival) lines.push(`与${p.name}素来不和的${rival.name}，很快递来几页新材料。`);
    } else {
      if (ally) lines.push(`${ally.name}把您对${p.name}的示好看成了新的风向。`);
      if (rival) lines.push(`${rival.name}在会后沉默很久，像是重新盘算了位置。`);
    }
    if (lines.length >= 2) break;
  }
  return lines.slice(0, 2).join('\n');
}

// ---- 解析玩家选择 --------------------------------------------------------
export function resolveOption(state, card, optionIndex) {
  const option = card.options[optionIndex];
  if (option.cost && option.cost.oneTime) state.oneTime[option.cost.oneTime] = Math.max(0, (state.oneTime[option.cost.oneTime] || 0) - 1);
  const { changed, deltas, summary } = applyEffects(state, option.effects, { source: card.id });
  if (option.commissionBiography) state.biographyCommissioned = true;
  const twist = maybeTwist(state, card, option);

  rememberShown(state, card);
  if (card.unique) state.uniqueSeen.push(card.id);

  let resultText = subst(state, option.result || '');
  if (twist) resultText += `\n\n${twist.clue}`;
  const relation = relationEcho(state, option.effects);
  if (relation) resultText += `\n\n${relation}`;
  state.archive.push({ year: state.year, title: subst(state, card.title), result: subst(state, option.text), eventId: card.id, eventKey: cardKey(card), poolSource: card.poolSource, poolBatch: card.poolBatch });
  return { resultText, changed, deltas, summary, twist };
}
