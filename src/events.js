// 抽卡、资格、效果落账、事与愿违、人物绑定、国名替换。

import { rngChance, rngPick } from './state.js';
import { applyEffects, adjustLoyalty } from './engine.js';

// 预处理：标注每张卡"涉及哪些具名人物"（_feat），用规范名扫描。
export function prepareContent(content) {
  const canon = {}; // 规范名 → roleId
  for (const p of content.people) canon[(p.namePool || [p.id])[0]] = p.id;
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

// 国名替换（人名用规范名，已与事件文本一致，无需替换）
export function subst(state, text) { return typeof text === 'string' ? text.replace(/恩加拉/g, state.nationShort) : text; }
export function substCard(state, card) {
  const c = { ...card };
  c.narrative = subst(state, card.narrative);
  c.speaker = subst(state, card.speaker);
  c.options = (card.options || []).map((o) => ({ ...o, text: subst(state, o.text), result: subst(state, o.result) }));
  return c;
}

// ---- 资格 ----------------------------------------------------------------
export function isEligible(state, card) {
  if (card.unique && state.uniqueSeen.includes(card.id)) return false;
  if (card.minYear && state.year < card.minYear) return false;
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
function allNormals(state, content) { return [...content.events.filter((c) => c.type !== 'notify'), ...(state.llmPool || [])]; }
function freshNormals(state, content) {
  const all = allNormals(state, content).filter((c) => isEligible(state, c));
  let fresh = all.filter((c) => !state.seenEventIds.includes(c.id));
  if (!fresh.length) { const recent = new Set(state.seenEventIds.slice(-15)); fresh = all.filter((c) => !recent.has(c.id)); }
  return fresh;
}
function freshNotifies(state, content) {
  const all = content.events.filter((c) => c.type === 'notify' && isEligible(state, c));
  let fresh = all.filter((c) => !state.seenEventIds.includes(c.id));
  if (!fresh.length) { const recent = new Set(state.seenEventIds.slice(-6)); fresh = all.filter((c) => !recent.has(c.id)); }
  return fresh;
}

export function drawOne(state, content) {
  const normals = freshNormals(state, content), notifies = freshNotifies(state, content);
  const wantNotify = (notifies.length && rngChance(state, 0.22)) || normals.length === 0;
  let pool = wantNotify ? notifies : normals;
  if (!pool.length) pool = normals.length ? normals : notifies;
  return pool.length ? weightedPick(state, pool) : null;
}

// ---- 事与愿违 ------------------------------------------------------------
function personByName(state, name) {
  if (!name) return null;
  return state.people.find((p) => p.alive && (name.includes(p.name) || p.name.includes(name)));
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

// ---- 解析玩家选择 --------------------------------------------------------
export function resolveOption(state, card, optionIndex) {
  const option = card.options[optionIndex];
  if (option.cost && option.cost.oneTime) state.oneTime[option.cost.oneTime] = Math.max(0, (state.oneTime[option.cost.oneTime] || 0) - 1);
  const { changed, deltas, summary } = applyEffects(state, option.effects, { source: card.id });
  if (option.commissionBiography) state.biographyCommissioned = true;
  const twist = maybeTwist(state, card, option);

  if (card.id) state.seenEventIds.push(card.id);
  if (card.unique) state.uniqueSeen.push(card.id);

  let resultText = subst(state, option.result || '');
  if (twist) resultText += `\n\n${twist.clue}`;
  state.archive.push({ year: state.year, title: subst(state, card.title), result: subst(state, option.text) });
  return { resultText, changed, deltas, summary, twist };
}
