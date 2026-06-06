// 状态机核心：6 核心指标、两端危险、多样死法、效果落账、忠诚/关系、积分。
// applyEffects 返回 deltas/summary 供 UI。

import { rngInt, rngChance, rngPick, leaderAge, syncTerritory } from './state.js';

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
// 波动更大：让玩家多次逼近临界
const BANDS = { small: [5, 8], mid: [11, 16], big: [20, 27], huge: [30, 40] };
const CORE = ['army', 'elite', 'morale', 'intl', 'finance', 'health'];

function bandValue(state, token) {
  let sign = 1, name = token;
  if (token[0] === '+') name = token.slice(1);
  else if (token[0] === '-') { sign = -1; name = token.slice(1); }
  const range = BANDS[name] || BANDS.mid;
  return sign * rngInt(state, range[0], range[1]);
}
function resolve(state, v) { return typeof v === 'number' ? v : typeof v === 'string' ? bandValue(state, v) : 0; }

export function applyEffects(state, effects, opts = {}) {
  const deltas = {}, loy = {}, dec = {};
  let wealthDelta = 0, areaDelta = 0;
  if (!effects) return { changed: [], deltas, summary: [] };

  for (const key of CORE) if (key in effects) {
    const before = state.ind[key];
    state.ind[key] = clamp(before + resolve(state, effects[key]));
    const d = state.ind[key] - before; if (d) deltas[key] = (deltas[key] || 0) + d;
  }
  if ('wealth' in effects || 'wealthOverseas' in effects) {
    let amt = resolve(state, effects.wealth ?? effects.wealthOverseas);
    if (amt > 0 && state.sanctioned) amt *= 0.5;
    state.wealth.overseas = Math.max(0, state.wealth.overseas + amt); wealthDelta += amt;
  }
  if ('wealthDomestic' in effects) {
    let amt = resolve(state, effects.wealthDomestic);
    if (amt > 0 && state.sanctioned) amt *= 0.5;
    state.wealth.domestic = Math.max(0, state.wealth.domestic + amt); wealthDelta += amt;
  }
  if (effects.deco) for (const [k, tok] of Object.entries(effects.deco)) if (k in state.deco) {
    const before = state.deco[k]; state.deco[k] = clamp(before + resolve(state, tok));
    const d = state.deco[k] - before; if (d) dec[k] = (dec[k] || 0) + d;
  }
  if (effects.loyalty) for (const [pid, tok] of Object.entries(effects.loyalty)) applyLoyaltyWithRipple(state, pid, resolve(state, tok), loy);

  if ('borderTension' in effects) state.hidden.borderTension = clamp(state.hidden.borderTension + resolve(state, effects.borderTension));
  if ('legacy' in effects) state.hidden.legacy = clamp(state.hidden.legacy + resolve(state, effects.legacy));
  if ('history' in effects) state.hidden.historyNarrative = clamp(state.hidden.historyNarrative + resolve(state, effects.history));

  if (effects.annex) { const region = annexRegion(state); if (region) areaDelta += region.area; }
  if (typeof effects.territory === 'number') { const add = Math.round(effects.territory * state.baseArea); state.area += add; areaDelta += add; syncTerritory(state); }

  if (effects.flags) Object.assign(state.flags, effects.flags);
  if (effects.oneTime) for (const [k, d] of Object.entries(effects.oneTime)) if (k in state.oneTime) state.oneTime[k] = Math.max(0, state.oneTime[k] + d);

  return { changed: Object.keys(deltas), deltas, summary: buildSummary(deltas, loy, dec, wealthDelta, areaDelta, state) };
}

const MAX_ANNEX = 3;
function annexRegion(state) {
  if (state.annexedRegions.length >= MAX_ANNEX) return null;
  const avail = (state.worldRegions || []).filter((r) => !state.annexedRegions.includes(r.name));
  if (!avail.length) return null;
  const r = rngPick(state, avail);
  state.annexedRegions.push(r.name); state.area += r.area; syncTerritory(state);
  return r;
}

const IND_LABEL = { army: '军队', elite: '精英', morale: '民心', intl: '国际', finance: '财政', health: '健康' };
const IND_DANGER = { army: 'both', elite: 'both', morale: 'both', intl: 'both', finance: 'low', health: 'low' };
// 变动是"好"还是"坏"：两端危险型→靠近中段(50)为好；单向(高=好)→上升为好
function isGoodChange(key, after, delta) {
  if (IND_DANGER[key] === 'low') return delta > 0;
  return Math.abs(after - 50) < Math.abs((after - delta) - 50);
}
function buildSummary(deltas, loy, dec, wealthDelta, areaDelta, state) {
  const s = [];
  for (const k of CORE) if (deltas[k]) s.push({ type: 'core', key: k, label: IND_LABEL[k], delta: deltas[k], good: isGoodChange(k, state.ind[k], deltas[k]) });
  if (Math.abs(wealthDelta) >= 0.01) s.push({ type: 'wealth', label: '私产', delta: wealthDelta, unit: '亿' });
  if (areaDelta) s.push({ type: 'area', label: '领土', delta: areaDelta, unit: 'km²' });
  for (const [pid, d] of Object.entries(loy)) if (d) { const p = state.people.find((x) => x.id === pid); if (p) s.push({ type: 'loyalty', key: pid, label: p.name, delta: d }); }
  return s;
}

function applyLoyaltyWithRipple(state, pid, d, acc) {
  const p = state.people.find((x) => x.id === pid);
  if (!p || !p.alive) return;
  const before = p.loyalty; p.loyalty = clamp(p.loyalty + d); acc[pid] = (acc[pid] || 0) + (p.loyalty - before);
  const r = Math.round(d * 0.3); if (!r) return;
  for (const aid of p.allies || []) rippleOne(state, aid, r, acc);
  for (const rid of p.rivals || []) rippleOne(state, rid, -r, acc);
}
function rippleOne(state, id, d, acc) {
  const q = state.people.find((x) => x.id === id);
  if (!q || !q.alive) return;
  const before = q.loyalty; q.loyalty = clamp(q.loyalty + d); acc[id] = (acc[id] || 0) + (q.loyalty - before);
}
export function adjustLoyalty(state, personId, delta) { const p = state.people.find((x) => x.id === personId); if (p && p.alive) p.loyalty = clamp(p.loyalty + delta); }

export function loyaltySignal(l) { return l >= 70 ? 'loyal' : l >= 45 ? 'ok' : l >= 25 ? 'uneasy' : 'danger'; }
export function competenceSignal(c) { return c >= 72 ? 'high' : c >= 48 ? 'mid' : 'low'; }

// ---- 效果消毒（LLM） -----------------------------------------------------
const ALLOWED_HIDDEN = ['borderTension', 'legacy', 'history'];
const ALLOWED_FLAGS = ['stagedElection', 'realElection', 'currencyNamed'];
const ALLOWED_DECO = ['health_care', 'education', 'capital', 'press'];
const BAND_ALIAS = { tiny: 'small', slight: 'small', minor: 'small', little: 'small', low: 'small', small: 'small', medium: 'mid', med: 'mid', moderate: 'mid', mid: 'mid', middle: 'mid', big: 'big', large: 'big', major: 'big', high: 'big', huge: 'huge', severe: 'big', strong: 'big' };
function normBand(tok) { if (typeof tok !== 'string') return null; const m = tok.trim().match(/^([+-]?)\s*(\w+)$/); if (!m) return null; const n = BAND_ALIAS[m[2].toLowerCase()]; return n ? (m[1] === '-' ? '-' : '+') + n : null; }
function coerceEffect(v, cap = 24) { const b = normBand(v); if (b) return b; if (typeof v === 'number' && isFinite(v)) { const n = Math.max(-cap, Math.min(cap, Math.round(v))); return n || null; } return null; }
export function sanitizeEffects(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of [...CORE, ...ALLOWED_HIDDEN]) { const e = coerceEffect(raw[k]); if (e != null) out[k] = e; }
  if (typeof raw.wealth === 'number' && isFinite(raw.wealth)) out.wealth = Math.max(-1.5, Math.min(1.5, raw.wealth));
  if (typeof raw.wealthDomestic === 'number' && isFinite(raw.wealthDomestic)) out.wealthDomestic = Math.max(-1.5, Math.min(1.5, raw.wealthDomestic));
  if (raw.deco && typeof raw.deco === 'object') { out.deco = {}; for (const [k, v] of Object.entries(raw.deco)) { const e = coerceEffect(v); if (e != null && ALLOWED_DECO.includes(k)) out.deco[k] = e; } if (!Object.keys(out.deco).length) delete out.deco; }
  if (raw.loyalty && typeof raw.loyalty === 'object') { out.loyalty = {}; for (const [k, v] of Object.entries(raw.loyalty)) { const e = coerceEffect(v, 24); if (e != null) out.loyalty[k] = e; } if (!Object.keys(out.loyalty).length) delete out.loyalty; }
  if (raw.flags && typeof raw.flags === 'object') { out.flags = {}; for (const k of ALLOWED_FLAGS) if (k in raw.flags) out.flags[k] = !!raw.flags[k]; if (!Object.keys(out.flags).length) delete out.flags; }
  return out;
}
export function allowedFidelities(person) {
  const l = person.loyalty;
  if (l >= 70) return ['faithful', 'discounted'];
  if (l >= 45) return ['faithful', 'discounted', 'feigned'];
  if (l >= 25) return ['discounted', 'feigned'];
  return person.foreshadowCount >= 2 ? ['feigned', 'betrayal'] : ['feigned'];
}
export function applyAdvisorCommand(state, person, result) {
  const allowed = allowedFidelities(person);
  let fidelity = result.fidelity; if (!allowed.includes(fidelity)) fidelity = allowed[0];
  const proposed = sanitizeEffects(result.proposed_effects), hidden = sanitizeEffects(result.hidden_effects);
  if (fidelity === 'discounted' || fidelity === 'feigned') { const keys = Object.keys(proposed).filter((k) => CORE.includes(k)); if (keys.length) delete proposed[keys[keys.length - 1]]; }
  const sum = [];
  sum.push(...applyEffects(state, proposed).summary);
  if (fidelity === 'feigned' || fidelity === 'betrayal') { sum.push(...applyEffects(state, hidden).summary); person.foreshadowCount += 1; }
  if (fidelity === 'betrayal') sum.push(...applyEffects(state, { elite: '-small', intl: '+small' }).summary);
  if (person.competence >= 72) {
    if (fidelity === 'faithful' || fidelity === 'discounted') {
      const main = Object.keys(proposed).find((k) => CORE.includes(k));
      if (main) { const neg = typeof proposed[main] === 'string' ? proposed[main][0] === '-' : proposed[main] < 0; sum.push(...applyEffects(state, { [main]: (neg ? '-' : '+') + 'small' }).summary); }
    } else sum.push(...applyEffects(state, { elite: '-small' }).summary);
  }
  adjustLoyalty(state, person.id, fidelity === 'faithful' ? 2 : fidelity === 'betrayal' ? -4 : 0);
  if (result.memory_note) person.memory.push({ year: state.year, note: String(result.memory_note).slice(0, 120) });
  let clue = '';
  if (fidelity !== 'faithful') clue = (result.foreshadow_clue && String(result.foreshadow_clue).trim()) || '（您总觉得，事情和您交代的，似乎有那么一点不一样。）';
  return { fidelity, narrative: String(result.public_narrative || '').trim(), clue, summary: sum };
}

// ---- 预算（含财政） ------------------------------------------------------
export function applyBudget(state, alloc) {
  const total = (alloc.army + alloc.elite + alloc.welfare + alloc.self) || 1;
  const n = (x) => x / total;
  const deltas = {};
  const adj = (key, share, scale) => { const before = state.ind[key]; state.ind[key] = clamp(before + Math.round((share - 0.25) * scale)); const d = state.ind[key] - before; if (d) deltas[key] = d; };
  adj('army', n(alloc.army), 46);
  adj('elite', n(alloc.elite), 44);
  adj('morale', n(alloc.welfare), 42); // 民生→民心掌控
  // 个人账户：自肥，掏空国库
  const skim = n(alloc.self) * (1.4 + state.territory * 0.3);
  let gain = skim * 1.2; if (gain > 0 && state.sanctioned) gain *= 0.5;
  state.wealth.overseas += gain;
  // 财政：税收入账 - 治理开销 - 自肥抽走。节俭(少skim)能回血，贪婪则掏空。
  const finBefore = state.ind.finance;
  state.ind.finance = clamp(state.ind.finance + 14 - 6 - Math.round(n(alloc.self) * 26));
  if (state.ind.finance !== finBefore) deltas.finance = state.ind.finance - finBefore;
  state.deco.health_care = clamp(state.deco.health_care + Math.round((n(alloc.welfare) - 0.25) * 14));
  state.deco.education = clamp(state.deco.education + Math.round((n(alloc.welfare) - 0.25) * 14));
  return { changed: Object.keys(deltas), deltas, summary: buildSummary(deltas, {}, {}, gain, 0, state) };
}

// ---- 年度漂移：财政开销 + 低财政惩罚 + 边境紧张（几乎不回血，留死亡螺旋） ----
export function annualDrift(state) {
  // 熵：不主动经营，一切都会慢慢滑向危险——忠诚褪色、民怨滋生、世界渐渐盯上你
  state.ind.army = clamp(state.ind.army - 1);
  state.ind.elite = clamp(state.ind.elite - 1);
  state.ind.morale = clamp(state.ind.morale - 1);
  state.ind.intl = clamp(state.ind.intl + 1);
  state.ind.finance = clamp(state.ind.finance - 2); // 治理常态开销
  if (state.ind.finance < 20) { state.ind.army = clamp(state.ind.army - 3); state.ind.elite = clamp(state.ind.elite - 3); } // 发不出钱
  // 装饰长期垫底→拖累历史评价与民心
  if (state.deco.health_care < 20 || state.deco.education < 20) { state.hidden.historyNarrative = clamp(state.hidden.historyNarrative - 1); if (state.year % 2 === 0) state.ind.morale = clamp(state.ind.morale - 2); }
  if (state.year % 2 === 0) state.hidden.borderTension = Math.min(100, state.hidden.borderTension + 1 + Math.floor(state.rng() * 2));
}

export function annualHealthDecay(state) {
  const age = leaderAge(state);
  let decay = rngInt(state, 2, 3);
  if (age > 64) decay += 1; if (age > 72) decay += 1; if (age > 80) decay += 2;
  if (state.ind.morale > 80 || state.ind.intl > 80) decay += 1;
  if (state.wealth.overseas > 3 && rngChance(state, 0.6)) decay -= 2;
  if (state.wealth.overseas > 6 && rngChance(state, 0.5)) decay -= 1;
  state.ind.health = clamp(state.ind.health - Math.max(1, decay));
  return decay;
}

// ---- 危机判定：两端危险、多样死法、带随机 --------------------------------
function roll(state, key, lowT, lowP, lowDeath, highT, highP, highDeath) {
  const v = state.ind[key];
  const warned = state.flags.crisisWarnings || {};
  if (lowT != null && v < lowT && (warned[`${key}:low:final`] || warned[`${key}:low:warn`])) { const sev = (lowT - v) / Math.max(1, lowT); if (rngChance(state, lowP * (0.55 + sev * 0.9))) return lowDeath; }
  if (highT != null && v > highT && (warned[`${key}:high:final`] || warned[`${key}:high:warn`])) { const sev = (v - highT) / Math.max(1, 100 - highT); if (rngChance(state, highP * (0.55 + sev * 0.9))) return highDeath; }
  return null;
}
export function dangerWarnings(state) {
  const out = [];
  const seen = state.flags.crisisWarnings || {};
  const acknowledged = (key, side) => seen[`${key}:${side}:warn`] || seen[`${key}:${side}:final`];
  const addDirectional = (key, side, warnActive, finalActive, warnTitle, warnText, finalTitle, finalText) => {
    if (acknowledged(key, side)) return;
    if (finalActive) out.push({ key, side, level: 'final', token: `${key}:${side}:final`, title: finalTitle, text: finalText });
    else if (warnActive) out.push({ key, side, level: 'warn', token: `${key}:${side}:warn`, title: warnTitle, text: warnText });
  };
  const i = state.ind;
  addDirectional('army', 'low', i.army < 20, i.army < 8, '军心异动', '总参谋部的门关得比往常更紧。再往下，枪口迟早会自己寻找方向。', '兵变在即', '卫队换岗时不再看向官邸，参谋部的电话也接得越来越慢。再拖下去，命令会在枪栓声里失效。');
  addDirectional('army', 'high', i.army > 84, i.army > 92, '军方坐大', '将军们开始替您决定什么叫国家利益。再放任下去，官邸会变成军营的附属建筑。', '军权压顶', '军方已经不满足于接受赏赐，他们开始分配忠诚。再往前一步，您会被请去主持自己的退场。');
  addDirectional('elite', 'low', i.elite < 22, i.elite < 8, '内阁离心', '几位大人的笑容越来越短，家眷却越来越频繁地出国。再往下，酒杯和文件都会变得危险。', '密谋成形', '宴会的座次开始绕开您，账本和护照在同一晚被取走。再拖下去，忠诚会被写成遗书。');
  addDirectional('elite', 'high', i.elite > 84, i.elite > 92, '寡头成势', '分赃的桌子还在官邸，菜单却已由别人拟好。再放任下去，您会只剩签字的权力。', '傀儡边缘', '几位大人物已能决定媒体、银行和部长名单。您的命令还会被盖章，但先要经过他们的手。');
  addDirectional('morale', 'low', i.morale < 18, i.morale < 8, '街头起火', '街角的传单和菜市场的喊声连成一片。再往下，广场会比官邸更有号召力。', '广场失控', '罢市、传单和人群开始彼此认出同一个口号。再拖下去，首都不会再等您的广播。');
  addDirectional('morale', 'high', i.morale > 85, i.morale > 94, '崇拜失控', '口号喊得太响，开始盖过命令本身。再往上，狂热会替您审判所有人。', '狂热噬主', '拥戴者开始替您寻找敌人，也替您定义忠诚。再往前，连您本人都未必符合神像的要求。');
  addDirectional('intl', 'low', i.intl < 14, i.intl < 6, '承认流失', '使馆区的灯一盏盏熄灭，制裁名单却一页页加厚。再往下，连您的邻国都可能不再接电话。', '孤立断线', '外交电报像石头一样沉下去，银行、码头和邻国边境同时变得冷淡。再拖下去，政权会被世界遗忘。');
  addDirectional('intl', 'high', i.intl > 84, i.intl > 94, '外部渗透', 'NGO、记者、基金会和观察团挤满首都，反对派突然学会了同一种话术。再往上，选票和街头都会有人替您安排。', '干预临门', '观察团、基金会和外国记者已经能决定议程。再往前一步，您的主权会被写进别人的声明。');
  addDirectional('finance', 'low', i.finance < 15, i.finance < 7, '国库见底', '欠薪的名单已经排到军营门口。再往下，忠诚会按欠条折价。', '欠饷逼宫', '军营、警局和部委同时在等钱。再拖下去，忠诚不再问您是谁，只问谁先付账。');
  return out;
}

export function markDangerWarning(state, token) {
  if (!state.flags.crisisWarnings) state.flags.crisisWarnings = {};
  state.flags.crisisWarnings[token] = true;
}

export function checkCrises(state) {
  if (state.ind.health <= 0) return makeEnding(state, 'natural');
  if (state.people.filter((p) => p.defected).length >= 2) return makeEnding(state, 'eliteCollapse');

  const rolls = [
    roll(state, 'army', 8, 0.18, 'coup', 92, 0.13, 'junta'),
    roll(state, 'elite', 8, 0.17, 'assassination', 92, 0.12, 'puppet'),
    roll(state, 'morale', 8, 0.18, 'uprising', 94, 0.13, 'frenzy'),
    roll(state, 'intl', 6, 0.16, 'collapse', 94, 0.14, 'tribunal'),
    roll(state, 'finance', 7, 0.18, 'mutiny', null, 0, null),
    rngChance(state, 0.006) ? 'accident' : null, // 略荒诞的意外
  ].filter(Boolean);
  if (rolls.length) return makeEnding(state, rolls[Math.floor(state.rng() * rolls.length)]);

  // 单人叛逃（精英偏低时）
  if (state.ind.elite < 26 && rngChance(state, 0.12)) triggerDefection(state);
  state.sanctioned = state.ind.intl <= 20;
  return null;
}
export function triggerDefection(state) {
  const cand = state.people.filter((p) => p.alive && !p.defected).sort((a, b) => a.loyalty - b.loyalty)[0];
  if (!cand) return null;
  cand.defected = true; cand.alive = false;
  state.ind.elite = clamp(state.ind.elite - 12);
  if (/总司令|将军|军/.test(cand.title)) state.ind.army = clamp(state.ind.army - 16);
  return cand;
}

// 被推翻类给保底系数：多年统治与私产仍折算少量分，不至于归零
const ENDING_COEF = { natural: 2.0, exile: 0.5, puppet: 0.4, accident: 0.4, tribunal: 0.25, arrested: 0.2, junta: 0.18, coup: 0.15, assassination: 0.15, uprising: 0.15, frenzy: 0.15, collapse: 0.15, mutiny: 0.15, eliteCollapse: 0.15 };
export function makeEnding(state, type) {
  state.over = true;
  const e = { type, year: state.year, age: leaderAge(state), coef: ENDING_COEF[type] ?? 0, naturalPeaceful: type === 'natural' && state.hidden.heir != null && state.hidden.legacy >= 50 };
  if (type === 'natural') e.coef = e.naturalPeaceful ? 2.5 : 1.8;
  state.ending = e; return e;
}

export function computeScore(state) {
  const e = state.ending;
  const base = Math.round(state.year * state.territory * 10);
  let domestic = state.wealth.domestic; if (state.sanctioned) domestic *= 0.3;
  const wealthScore = Math.round((state.wealth.overseas * 1.5 + domestic) * 80);
  let dynasty = 0; if (state.flags.heirSucceeded) dynasty += 500; if (state.flags.civilWar) dynasty -= 200;
  const subtotal = base + wealthScore + dynasty;
  const coef = e ? e.coef : 0;
  // 历史轴：赢得当下 vs 赢得历史。historyNarrative 50=中性
  const historyMult = 0.6 + (state.hidden.historyNarrative / 100) * 0.8; // 0.6 ~ 1.4
  const achScore = (state.achievements || []).reduce((s, a) => s + (a.points || 0), 0);
  const total = Math.round(subtotal * coef * historyMult + achScore);
  return { base, wealthScore, dynasty, subtotal, coef, historyMult: Number(historyMult.toFixed(2)), achScore, total };
}
