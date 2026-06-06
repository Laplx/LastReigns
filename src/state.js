// 全局状态、可注入种子的 RNG、存档导出。

export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function rngInt(state, lo, hi) { return lo + Math.floor(state.rng() * (hi - lo + 1)); }
export function rngPick(state, arr) { return arr[Math.floor(state.rng() * arr.length)]; }
export function rngChance(state, p) { return state.rng() < p; }
export function rngShuffle(state, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(state.rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// danger: 'both'=两端危险(甜区在中段) | 'low'=仅过低危险(高=好)
export const INDICATOR_META = [
  { key: 'army', name: '军队', danger: 'both' },
  { key: 'elite', name: '精英', danger: 'both' },
  { key: 'morale', name: '民心', danger: 'both' },   // 0=离心民怨 100=狂热造神 中=安稳
  { key: 'intl', name: '国际', danger: 'both' },     // 0=孤立/制裁/失认 100=干预/渗透/颜色革命 中=安稳
  { key: 'finance', name: '财政', danger: 'low' },   // 低=国库见底；高=仅机会成本
  { key: 'health', name: '健康', danger: 'low' },    // 低=死亡；高=仅招忌
];

function nationShort(name) {
  return name.replace(/(人民|民主|联邦)?共和国$/, '') || name;
}

export function createInitialState(seed, content) {
  const rng = makeRng(seed);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const nation = pick(content.world.nations);
  const leaderName = pick(content.world.leaders);

  const pool = content.people.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const chosen = pool.slice(0, 4).map((p) => ({
    id: p.id,
    name: pick(p.namePool || [p.id]),
    canonicalName: (p.namePool || [p.id])[0],
    aliases: p.namePool || [p.id],
    title: p.title, traits: p.traits || [], blurb: p.blurb || '', persona: p.persona || '',
    hiddenInterest: p.hiddenInterest || '',
    loyalty: p.initLoyalty ?? 55, competence: p.competence ?? 55,
    rivals: p.rivals || [], allies: p.allies || [],
    alive: true, defected: false, foreshadowCount: 0, contactedYear: 0, memory: [],
  }));

  return {
    seed, rng,
    year: 1, cardsThisYear: 0, yearLength: 3 + Math.floor(rng() * 3), maxYears: 60,
    over: false, ending: null,

    nation: nation.name, nationShort: nationShort(nation.name),
    leader: { name: leaderName, startAge: 52 },

    // 6 核心指标
    ind: { army: 50, elite: 50, morale: 50, intl: 50, finance: 55, health: 100 },

    hidden: { borderTension: 25, legacy: 40, historyNarrative: 50, heir: null },

    // 装饰指标(4)，纯文字三色
    deco: { health_care: 30, education: 35, capital: 40, press: 45 },

    wealth: { domestic: 0.0, overseas: 0.0 },

    baseArea: nation.area, area: nation.area, territory: 1.0, annexedRegions: [],
    worldRegions: content.world.regions.slice(),

    sanctioned: false,

    people: chosen,

    // 一次性资源：用完即止
    oneTime: { intlCredibility: 2, familyLegacy: 1, oldGuard: 1, kompromat: 1 },

    activeChains: [], completedChains: [], chainJustActivated: null,

    flags: {}, deferred: {}, biographyCommissioned: false,
    atmosphereOverride: {}, atmosphereOverrideYear: 0,

    advisorReshuffleUsedYear: 0, lastDeepContactYear: 0, budgetDueYear: 1,
    crisisNoticeYear: 0, prioritySpecialYear: 0,
    seenEventIds: [], seenEventKeys: [], uniqueSeen: [],

    llmPool: [],   // 本局 LLM 预生成的事件池
    prioritySpecialQueue: [],

    archive: [], achievements: [],
  };
}

export function syncTerritory(state) { state.territory = state.area / state.baseArea; }
export function exportSave(state) { return JSON.stringify(JSON.parse(JSON.stringify(state, (k, v) => (k === 'rng' ? undefined : v))), null, 2); }
export function leaderAge(state) { return state.leader.startAge + (state.year - 1); }
