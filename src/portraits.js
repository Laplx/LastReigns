const norm = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, '_');

const escAttr = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

function cleanList(value) {
  return Array.isArray(value) ? value.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
}

function normalizeDef(def) {
  return {
    id: norm(def.id),
    kind: def.kind === 'key' ? 'key' : 'generic',
    label: String(def.label || def.id || '人物').trim(),
    motif: norm(def.motif || def.id || 'citizen'),
    accent: String(def.accent || 'var(--gold)').trim(),
    aliases: cleanList(def.aliases),
    themes: cleanList(def.themes).map(norm),
    keywords: cleanList(def.keywords),
  };
}

export function preparePortraits(raw = {}) {
  const roles = [];
  const source = Array.isArray(raw?.roles) ? raw.roles : [];
  for (const def of source) if (def?.id) roles.push(normalizeDef(def));

  const byId = {};
  const aliases = {};
  const themes = {};
  for (const role of roles) {
    byId[role.id] = role;
    for (const alias of [role.id, role.label, ...role.aliases]) aliases[norm(alias)] = role.id;
    for (const theme of role.themes) themes[norm(theme)] = role.id;
  }
  const fallback = byId[norm(raw?.fallback)] ? norm(raw.fallback) : 'citizen';
  return { byId, aliases, themes, roles, fallback };
}

// 画像美术资源（open-peeps 半身像 + lucide 职业图标），由 registryFor 注入一次。
let ART = null;
function registryFor(content) {
  if (!content) return null;
  if (content.portraitArt && !ART) ART = content.portraitArt;
  if (!content._portraitRegistry) content._portraitRegistry = preparePortraits(content.portraits || {});
  return content._portraitRegistry;
}

function lookup(registry, value) {
  const key = norm(value);
  if (!key) return null;
  return registry.byId[key] ? key : registry.aliases[key] || null;
}

function lookupTheme(registry, value) {
  const key = norm(value);
  return key ? registry.themes[key] || lookup(registry, key) : null;
}

function lookupKeyword(registry, text) {
  const hay = String(text || '');
  if (!hay) return null;
  const key = norm(hay);
  if (registry.aliases[key]) return registry.aliases[key];
  for (const role of registry.roles) {
    if (role.keywords.some((kw) => hay.includes(kw))) return role.id;
    if (role.aliases.some((kw) => kw.length >= 2 && hay.includes(kw))) return role.id;
  }
  return null;
}

function warningRole(card) {
  const text = `${card?.id || ''} ${card?.title || ''} ${card?.narrative || ''}`;
  if (/army|军心|军方|兵变|枪口/.test(text)) return 'soldier';
  if (/elite|内阁|寡头|密谋|大人物/.test(text)) return 'business';
  if (/morale|街头|广场|民心|狂热/.test(text)) return 'citizen';
  if (/intl|使馆|外交|观察团|制裁|干预/.test(text)) return 'diplomat';
  if (/finance|国库|欠饷|财政/.test(text)) return 'finance';
  if (/health|病|医生|健康/.test(text)) return 'doctor';
  return null;
}

function personForSpeaker(state, speaker) {
  if (!speaker) return null;
  const text = String(speaker);
  return (state.people || []).find((p) => p.alive && [p.name, p.canonicalName, ...(p.aliases || [])]
    .filter(Boolean)
    .some((name) => text.includes(name) || String(name).includes(text)));
}

function inferRoleId(registry, card) {
  return lookup(registry, card?.portraitId)
    || lookupTheme(registry, card?.speakerRole)
    || lookupTheme(registry, card?.theme)
    || lookupTheme(registry, card?.kicker)
    || warningRole(card)
    || lookupKeyword(registry, [card?.speaker, card?.title, card?.kicker, card?.id].filter(Boolean).join(' '))
    || lookupKeyword(registry, card?.narrative);
}

export function resolveCardPortrait(state, content, card) {
  const registry = registryFor(content);
  if (!registry) return null;

  const person = personForSpeaker(state, card?.speaker);
  const explicit = lookup(registry, card?.portraitId);
  const roleId = explicit || (person && lookup(registry, person.portraitId || person.id)) || inferRoleId(registry, card) || registry.fallback;
  const def = registry.byId[roleId] || registry.byId[registry.fallback];
  if (!def) return null;

  return {
    id: def.id,
    kind: def.kind,
    motif: def.motif,
    label: def.label,
    accent: def.accent,
    personId: person?.id || null,
    name: person?.name || String(card?.speaker || def.label),
    title: person?.title || def.label,
  };
}

// 直接由关键人物对象取画像描述（供人物 tab / 详情 / 召见使用）
export function portraitForPerson(content, person) {
  const registry = registryFor(content);
  if (!registry || !person) return null;
  const roleId = lookup(registry, person.portraitId || person.id) || registry.fallback;
  const def = registry.byId[roleId] || registry.byId[registry.fallback];
  if (!def) return null;
  return {
    id: def.id, kind: def.kind, motif: def.motif, label: def.label, accent: def.accent,
    personId: person.id, name: person.name || def.label, title: person.title || def.label,
  };
}

// ---------------------------------------------------------------------------
// 具象半身像绘制
// 每个 motif 对应一组"零件"：发型/头部装束、面部细节、躯干服饰、随身标志物。
// 共用一个头—肩—胸的基底，叠加零件后即得到可辨识的人物。
// 坐标系 viewBox 0 0 180 230：头部中心约 (90,78)，肩线约 y=150。
// ---------------------------------------------------------------------------

// __ART_BODY__
// 共用基底：外衣（accent 填充）、颈+头+耳（肤色填充）、默认头发与五官。
// 头部中心 (90,79)，rx29 ry33 → 下巴 y≈112、头顶 y≈46；肩线 y≈135（抬高，缩短脖子）。
const BASE = {
  coat: '<path d="M24 222 C26 168 52 135 90 135 C128 135 154 168 156 222 Z"/>',
  neck: '<path d="M82 110 C82 124 98 124 98 110 L98 132 L82 132 Z"/>',
  head: '<ellipse cx="90" cy="79" rx="29" ry="33"/><ellipse cx="60" cy="82" rx="5" ry="7.5"/><ellipse cx="120" cy="82" rx="5" ry="7.5"/>',
  hair: '<path d="M60 82 C57 48 75 39 90 39 C105 39 123 48 120 82 C116 61 103 54 90 54 C77 54 64 61 60 82 Z"/>',
  eyes: '<circle cx="80" cy="80" r="2.7"/><circle cx="100" cy="80" r="2.7"/>',
  face: '<path d="M73 72 q7 -3 13 -1"/><path d="M94 71 q6 -2 13 1"/><path d="M90 84 v8 l-4 3"/><path d="M83 99 q7 4 14 0"/>',
  collar: '<path d="M90 135 l-14 22 M90 135 l14 22"/>',
};

// __PARTS_TABLE__
// 每个 motif 给出可辨识的零件覆盖：
//   hair  —— 替换默认发型/头部装束（墨色填充）
//   over  —— 叠加在脸上的墨线细节（眼镜/胡须/制服线条）
//   acc   —— accent 色随身标志物（肩章、账本、十字、相机……）
//   coatOver —— 外衣上的墨线细节（翻领、绶带）
const PARTS = {
  // 将军：大檐军帽 + 肩章五星 + 制服翻领
  military: {
    hair: '<path d="M56 56 q34 -30 68 0 l3 8 h-74 Z"/><rect x="52" y="62" width="76" height="7"/><path d="M55 70 q35 11 70 0"/>',
    coatOver: '<path d="M90 135 l-16 16 -6 30 M90 135 l16 16 6 30"/>',
    acc: '<rect x="40" y="156" width="22" height="9" rx="2"/><rect x="118" y="156" width="22" height="9" rx="2"/><path d="M48 160 l3 0 M125 160 l3 0"/>',
  },
  // 财长：整齐分头 + 圆框眼镜 + 账本
  ledger: {
    hair: '<path d="M61 80 C59 52 74 42 90 42 C106 42 121 52 119 80 C112 60 100 56 86 58 C78 59 69 65 61 80 Z"/>',
    over: '<circle cx="80" cy="79" r="8.5" fill="none" stroke-width="2.4"/><circle cx="100" cy="79" r="8.5" fill="none" stroke-width="2.4"/><path d="M88.5 79 h3"/><path d="M71.5 79 l-8 -3"/>',
    acc: '<path d="M66 188 l24 -7 24 7 v20 l-24 7 -24 -7 Z"/><path d="M90 181 v27" stroke="#fff" stroke-width="2" fill="none"/>',
  },
  // 部族长老：缠头巾 + 长须
  elder: {
    hair: '<path d="M56 66 q34 -34 68 0 q4 8 -4 12 q-30 -14 -60 0 q-8 -4 -4 -12 Z"/>',
    over: '<path d="M70 96 q20 30 40 0 q-4 26 -20 30 q-16 -4 -20 -30 Z" fill="currentColor" stroke="none" opacity=".85"/>',
    acc: '<path d="M90 135 l-10 18 h20 Z"/>',
  },
  // 第一夫人：高盘发 + 耳环 + 项链
  family: {
    hair: '<path d="M60 80 C56 46 76 36 90 36 C104 36 124 46 120 80 C128 68 126 50 116 44 C122 40 112 30 96 34 C92 26 78 28 78 36 C66 38 60 52 64 64 C58 66 56 74 60 80 Z"/>',
    over: '<circle cx="61" cy="92" r="3" fill="currentColor" stroke="none"/><circle cx="119" cy="92" r="3" fill="currentColor" stroke="none"/>',
    acc: '<path d="M74 150 q16 16 32 0"/><circle cx="90" cy="166" r="4"/>',
  },
  // 教会主席：神职立领 + 胸前十字
  cleric: {
    hair: '<path d="M62 80 C60 54 75 44 90 44 C105 44 120 54 118 80 C112 62 100 58 90 58 C80 58 68 62 62 80 Z"/>',
    coatOver: '<path d="M78 135 v54 M102 135 v54"/>',
    acc: '<path d="M90 168 v34 M78 180 h24"/>',
  },
  // 矿业代表：安全帽 + 合同/方框
  mining: {
    hair: '<path d="M58 70 q32 -32 64 0 Z"/><path d="M52 70 h76 v6 h-76 Z"/><path d="M90 44 v-8"/>',
    over: '<path d="M73 78 q7 -2 12 0 M95 78 q7 -2 12 0"/>',
    acc: '<rect x="66" y="182" width="48" height="26" rx="2"/><path d="M74 192 h32 M74 200 h22"/>',
  },
  // 宗主国掮客：油头 + 小胡子 + 领结
  broker: {
    hair: '<path d="M61 78 C60 52 73 42 90 42 C107 42 120 52 119 78 C116 58 104 54 90 56 C78 57 66 60 61 78 Z"/>',
    over: '<path d="M82 92 q8 4 16 0" stroke-width="3"/>',
    acc: '<path d="M90 156 l-12 8 12 5 12 -5 Z"/><path d="M90 156 v-4"/>',
    coatOver: '<path d="M90 169 l-14 35 M90 169 l14 35"/>',
  },
  // 安全局局长：制式帽 + 墨镜
  security: {
    hair: '<path d="M57 58 q33 -28 66 0 l3 7 h-72 Z"/><rect x="53" y="64" width="74" height="6"/><path d="M56 70 q34 10 68 0"/>',
    over: '<path d="M68 78 h20 v8 h-20 Z" fill="currentColor" stroke="none"/><path d="M92 78 h20 v8 h-20 Z" fill="currentColor" stroke="none"/><path d="M88 80 h4"/>',
    coatOver: '<path d="M90 135 l-15 18 M90 135 l15 18"/>',
  },
  // 改革司司长：年轻短发 + 方框眼镜 + 衬衫领带
  reform: {
    hair: '<path d="M62 78 C61 54 74 44 90 44 C106 44 119 54 118 78 C113 60 101 57 90 57 C80 57 69 61 62 78 Z"/>',
    over: '<rect x="71" y="72" width="17" height="13" rx="3" fill="none" stroke-width="2.4"/><rect x="92" y="72" width="17" height="13" rx="3" fill="none" stroke-width="2.4"/><path d="M88 78 h4"/>',
    coatOver: '<path d="M90 135 l-13 16 M90 135 l13 16"/>',
    acc: '<path d="M90 162 l-5 10 5 26 5 -26 Z"/>',
  },
  // 执政党元老：秃顶 + 络腮胡 + 党徽
  oldguard: {
    hair: '<path d="M64 76 q4 -16 26 -16 q22 0 26 16 q-6 -6 -26 -6 q-20 0 -26 6 Z"/>',
    over: '<path d="M66 86 q4 28 24 32 q20 -4 24 -32 q-8 14 -24 14 q-16 0 -24 -14 Z" fill="currentColor" stroke="none" opacity=".8"/>',
    acc: '<circle cx="68" cy="172" r="9"/><path d="M68 166 v12 M62 172 h12"/>',
  },

  // __GENERIC_PARTS__
  // 秘书处：齐整短发 + 文件夹
  secretary: {
    acc: '<rect x="64" y="184" width="52" height="24" rx="2"/><path d="M72 192 h36 M72 200 h28"/>',
    coatOver: '<path d="M90 135 l-12 14 M90 135 l12 14"/>',
  },
  // 记者：相机 + 工牌
  reporter: {
    acc: '<rect x="70" y="180" width="40" height="26" rx="3"/><circle cx="90" cy="193" r="9"/><path d="M104 176 h8 v6"/>',
    coatOver: '<path d="M78 137 v13 h-6"/>',
  },
  // 医生：白大褂 + 听诊器
  doctor: {
    hair: '<path d="M62 80 C60 54 75 44 90 44 C105 44 120 54 118 80 C112 62 100 58 90 58 C80 58 68 62 62 80 Z"/>',
    coatOver: '<path d="M90 135 l-15 20 -2 49 M90 135 l15 20 2 49"/><path d="M90 135 v8"/>',
    acc: '<path d="M80 140 q-8 26 0 46 q4 10 12 8 M80 140 q8 -2 8 8" fill="none"/><circle cx="92" cy="198" r="6"/>',
  },
  // 军官：船形帽 + 制服
  soldier: {
    hair: '<path d="M58 62 q32 -22 64 0 q-6 10 -32 10 q-26 0 -32 -10 Z"/>',
    coatOver: '<path d="M90 135 l-14 16 M90 135 l14 16"/><circle cx="79" cy="172" r="2.5"/><circle cx="79" cy="184" r="2.5"/>',
  },
  // 外交人员：地球绶带（西装 + 徽章）
  diplomat: {
    coatOver: '<path d="M90 135 l-15 20 M90 135 l15 20"/>',
    acc: '<circle cx="108" cy="176" r="11"/><path d="M97 176 h22 M108 165 q7 11 0 22 M108 165 q-7 11 0 22"/>',
  },
  // 商人：西装领带 + 公文包提手
  business: {
    coatOver: '<path d="M90 135 l-14 17 M90 135 l14 17"/><path d="M90 162 l-5 9 5 22 5 -22 Z"/>',
    acc: '<rect x="62" y="186" width="26" height="20" rx="2"/><path d="M70 186 v-4 h10 v4"/>',
  },
  // 教士：与 cleric 同款立领十字
  cleric_generic: {
    hair: '<path d="M62 80 C60 54 75 44 90 44 C105 44 120 54 118 80 C112 62 100 58 90 58 C80 58 68 62 62 80 Z"/>',
    coatOver: '<path d="M78 135 v54 M102 135 v54"/>',
    acc: '<path d="M90 168 v34 M78 180 h24"/>',
  },
  // 法务：天平
  judge: {
    acc: '<path d="M90 178 v28 M76 206 h28 M70 170 h40 M90 170 v-6"/><path d="M70 170 l-7 12 h14 Z M110 170 l-7 12 h14 Z"/>',
    coatOver: '<path d="M90 135 l-12 14 M90 135 l12 14"/>',
  },
  // 工人：鸭舌帽 + 扳手
  worker: {
    hair: '<path d="M58 68 q32 -26 64 0 Z"/><path d="M118 70 q12 0 16 6 l-18 2 Z"/><path d="M54 70 h70 v5 h-70 Z"/>',
    acc: '<path d="M70 206 l30 -34 q6 -8 14 -6 q6 6 -2 12 q-6 -2 -10 2 l-26 32 Z"/>',
  },
  // 学生：学位帽 + 书本
  student: {
    hair: '<path d="M90 38 l32 12 -32 12 -32 -12 Z"/><path d="M64 56 v10 q26 12 52 0 v-10"/><path d="M122 50 v18 l3 8 h-6 Z"/>',
    acc: '<path d="M66 188 l24 -6 24 6 v18 l-24 6 -24 -6 Z"/><path d="M90 182 v24" stroke="#fff" stroke-width="1.6" fill="none"/>',
  },
  // 地方官：宽边帽 + 地契/印章
  local: {
    hair: '<path d="M50 72 q40 -16 80 0 q-10 -8 -40 -8 q-30 0 -40 8 Z"/><path d="M60 58 q30 -18 60 0 q-6 12 -30 12 q-24 0 -30 -12 Z"/>',
    acc: '<rect x="68" y="184" width="44" height="24" rx="2"/><circle cx="100" cy="196" r="6"/><path d="M74 192 h14 M74 200 h12"/>',
  },
  // 市民：普通短发，无标志物
  citizen: {},
};

function partsFor(motif) {
  return PARTS[motif] || PARTS.citizen;
}

// 兜底：美术资源缺失时用自绘墨金半身像（保证离线/异常下仍有人像）。
function fallbackSvg(portrait) {
  const motif = norm(portrait?.motif || 'citizen');
  const accent = escAttr(portrait?.accent || 'var(--gold)');
  const label = escAttr(portrait?.title || portrait?.label || portrait?.name || '人物');
  const p = partsFor(motif);
  return `<svg class="portrait-svg" viewBox="0 0 180 230" xmlns="http://www.w3.org/2000/svg" aria-label="${label}" role="img">
    <g stroke="var(--ink)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round">
      <g class="pt-coat" fill="${accent}">${BASE.coat}</g>
      <g class="pt-skin" fill="var(--paper)">${BASE.neck}${BASE.head}</g>
      <g class="pt-hair" fill="var(--ink)" stroke="none">${p.hair || BASE.hair}</g>
      <g class="pt-face" fill="var(--ink)" stroke-width="1.8">${BASE.eyes}<g fill="none">${BASE.face}</g>${p.over || ''}</g>
      <g class="pt-coatline" fill="none" stroke-width="2.2">${p.coatOver || BASE.collar}</g>
      <g class="pt-acc" fill="${accent}" stroke-width="2.2">${p.acc || ''}</g>
    </g>
  </svg>`;
}

// 职业 icon 圆徽（lucide inner，染暖金，公文纸底），叠在 open-peeps 头部左上。
function iconBadge(roleId) {
  const inner = ART?.icons?.[roleId];
  if (!inner) return '';
  const cx = 150, cy = 150, r = 92;
  const t = `translate(${cx - 60} ${cy - 60}) scale(5)`;
  return `<g class="pt-badge">`
    + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--paper)" stroke="var(--gold)" stroke-width="6"/>`
    + `<g transform="${t}" fill="none" stroke="var(--gold)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`
    + `</g>`;
}

// 主渲染。opts.icon=true 时叠加职业 icon 徽章（召见/详情用）；事件卡水印传 false。
export function renderPortraitSvg(portrait, opts = {}) {
  const roleId = portrait?.id;
  const peep = ART?.peeps?.[roleId];
  if (!peep) return fallbackSvg(portrait);
  const label = escAttr(portrait?.title || portrait?.label || portrait?.name || '人物');
  let svg = peep.replace('<svg ', `<svg class="portrait-svg" role="img" aria-label="${label}" `);
  if (opts.icon) svg = svg.replace('</svg>', iconBadge(roleId) + '</svg>');
  return svg;
}

// 仅渲染职业 icon（状态栏迷你标识用），无人像。
export function renderRoleIcon(portrait) {
  const inner = ART?.icons?.[portrait?.id];
  if (!inner) return '';
  return `<svg class="role-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}


