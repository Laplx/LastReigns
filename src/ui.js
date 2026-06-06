// 渲染层。流程在 game.js，状态变动在 engine.js。

import { INDICATOR_META, leaderAge } from './state.js';
import { coreMood, decoLabel, decoColor } from './atmosphere.js';
import { loyaltySignal, competenceSignal } from './engine.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const I = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICONS = {
  army: I('<path d="M12 3l7 3v5c0 4-3 7-7 9-4-2-7-5-7-9V6z"/>'),
  elite: I('<path d="M4 8l4 3 4-6 4 6 4-3-2 10H6z"/>'),
  morale: I('<path d="M5 21v-2a4 4 0 014-4h6a4 4 0 014 4v2"/><circle cx="12" cy="7" r="3.2"/>'),
  intl: I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>'),
  finance: I('<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6M5 12v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6v-6"/>'),
  health: I('<path d="M3 12h4l2-5 3 9 2-5h5"/>'),
  health_care: I('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 7v10M7 12h10"/>'),
  education: I('<path d="M3 8l9-4 9 4-9 4z"/><path d="M7 10v5c0 1 2 2 5 2s5-1 5-2v-5"/>'),
  capital: I('<rect x="5" y="9" width="14" height="11"/><path d="M12 3l7 6H5zM9 20v-5h6v5"/>'),
  press: I('<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M7 9h6M7 12h6M7 15h4M16 9h2v6h-2z"/>'),
};
const DECO_ICON = { health_care: 'health_care', education: 'education', capital: 'capital', press: 'press' };

export function renderTopbar(state, summary = '') {
  $('nation').textContent = state.nation;
  $('leader-name').textContent = `${state.leader.name} · ${leaderAge(state)}岁`;
  $('year-label').textContent = `在位第 ${state.year} 年`;
  const km = Math.round(state.area).toLocaleString('en-US');
  const wealth = ((state.wealth?.domestic || 0) + (state.wealth?.overseas || 0)).toFixed(2);
  $('phase-label').textContent = `国土 ${km} km²${state.annexedRegions.length ? `（+${state.annexedRegions.length}）` : ''} · 私产 ${wealth} 亿`;
  const top = $('top-summary');
  if (top) {
    top.textContent = summary || '';
    top.classList.toggle('hidden', !summary);
  }
}
export function setNetStatus(status, title) { const n = $('net-status'); n.className = 'net ' + status; n.title = title || ''; }
export function showPanels() { $('status-panel').classList.remove('hidden'); }
export function hidePanels() { $('status-panel').classList.add('hidden'); }

// 两端危险型 'both'：中段绿；过偏黄；极端红。单向 'low'：高=绿，低=红。
function fillClass(meta, v) {
  if (meta.danger === 'both') return (v >= 31 && v <= 69) ? 'good' : (v >= 16 && v <= 84) ? 'mid' : 'bad';
  return v >= 36 ? 'good' : v >= 20 ? 'mid' : 'bad';
}
export function renderStatus(state, content, flashItems) {
  showPanels();
  const core = $('core-indicators'); core.className = 'core-row'; core.innerHTML = '';
  for (const meta of INDICATOR_META) {
    const v = state.ind[meta.key];
    const cind = el('div', 'cind'); cind.dataset.key = meta.key;
    cind.title = state.atmosphereOverride?.[meta.key] || coreMood(state, content, meta.key).text;
    cind.innerHTML = `<div class="ci-icon">${ICONS[meta.key] || ''}</div>
      <div class="vbar"><div class="fill ${fillClass(meta, v)}" style="height:${v}%"></div>${meta.danger === 'both' ? '<span class="sweet"></span>' : ''}</div>
      <div class="ci-name">${meta.name}</div>`;
    core.appendChild(cind);
  }
  const deco = $('decorative-indicators'); deco.className = 'deco-grid'; deco.innerHTML = '';
  for (const d of content.decorative) {
    const v = state.deco[d.key];
    const dind = el('div', `dind deco-${decoColor(d.key, v)}`);
    dind.innerHTML = `<span class="di-icon">${ICONS[DECO_ICON[d.key]] || ''}</span><span class="di-name">${d.name}</span><span class="di-label">${esc(decoLabel(content, d.key, v))}</span>`;
    deco.appendChild(dind);
  }
  if (flashItems) for (const it of flashItems) {
    const cind = core.querySelector(`.cind[data-key="${it.key}"]`); if (!cind) continue;
    const f = el('div', `delta-float ${it.delta > 0 ? 'up' : 'down'}`, `${it.delta > 0 ? '+' : ''}${it.delta}`);
    cind.appendChild(f);
  }
}

// 选项卡式：上排 tab(名字+忠诚条)，下方常驻当前选中者详情 + 私下接触
const LOY_TXT = { loyal: '高', ok: '中', uneasy: '动摇', danger: '危' };
const COMP_TXT = { high: '强', mid: '中', low: '弱' };
export function renderPeople(state, opts) {
  const tabs = $('people-tabs'); tabs.innerHTML = '';
  for (const p of state.people) {
    const loy = p.alive ? loyaltySignal(p.loyalty) : 'danger';
    const t = el('button', `ptab${p.id === opts.selectedId ? ' active' : ''}${p.alive ? '' : ' gone'}`);
    t.innerHTML = `<span class="pt-line"><span class="pt-name">${esc(p.name)}</span></span><span class="pt-meter"><span class="pt-mark">忠</span><span class="pt-loy" title="忠诚"><span class="loyfill loy-${loy}" style="width:${p.alive ? p.loyalty : 0}%"></span></span></span>`;
    t.addEventListener('click', () => opts.onSelect(p.id));
    tabs.appendChild(t);
  }
}

export function renderPersonProfile(person, statusLines = []) {
  const box = el('div', 'pd');
  box.innerHTML = `<div class="pd-head"><span class="pd-name">${esc(person.name)}</span><span class="pd-title">${esc(person.alive ? person.title : (person.defected ? '已叛离' : person.title))}</span></div>`;
  const tag = el('div', 'pd-tags');
  (person.traits || []).forEach((x) => tag.appendChild(el('span', 'pd-tag', esc(x))));
  const loy = loyaltySignal(person.loyalty), comp = competenceSignal(person.competence);
  tag.appendChild(el('span', `pd-tag pd-loy-${loy}`, `忠诚·${LOY_TXT[loy]}`));
  tag.appendChild(el('span', `pd-tag pd-comp-${comp}`, `能力·${COMP_TXT[comp]}`));
  box.appendChild(tag);
  if (person.blurb) box.appendChild(el('div', 'pd-blurb', esc(person.blurb)));
  const st = el('div', 'pd-status');
  (statusLines || []).forEach((l) => st.appendChild(el('p', '', esc(l))));
  box.appendChild(st);
  if (!person.alive) box.appendChild(el('div', 'pd-reason', '此人已不在牌桌上。'));
  return box;
}

function stage() { return $('stage-content'); }
export function renderCard(card, { onChoose }) {
  const s = stage(); s.innerHTML = '';
  const c = el('div', `card${card.chain || card.type === 'chain' ? ' chaincard' : ''}`);
  let narr = esc(card.narrative);
  if (card.speaker) narr = `<span class="speaker">${esc(card.speaker)}：</span>` + narr;
  c.innerHTML = `<div class="kicker">${esc(card.kicker || '事件')}</div><div class="title">${esc(card.title)}</div><div class="narrative">${narr}</div>`;
  const opts = el('div', 'options');
  card.options.forEach((opt, i) => { const b = el('button', 'option', esc(opt.text)); b.addEventListener('click', () => onChoose(i)); opts.appendChild(b); });
  c.appendChild(opts); s.appendChild(c);
}

// 红绿直接跟正负挂钩（+绿 −红）；比例条本身另按"位置"着色
function chipFor(s) {
  const sign = s.delta > 0 ? '+' : '';
  let txt;
  if (s.type === 'wealth') txt = `${s.label} ${sign}${s.delta.toFixed(2)}${s.unit}`;
  else if (s.type === 'area') txt = `${s.label} ${sign}${Math.round(s.delta).toLocaleString('en-US')} ${s.unit}`;
  else txt = `${s.label} ${sign}${s.delta}`;
  const cls = s.delta === 0 ? 'neutral' : s.delta > 0 ? 'up' : 'down';
  return el('span', `chip ${cls}`, esc(txt) + (s.delta === 0 ? '' : s.delta > 0 ? ' ↑' : ' ↓'));
}

export function renderResult(text, summary, onContinue, opts = {}) {
  const s = stage(); s.innerHTML = '';
  const c = el('div', 'card');
  if (text) c.appendChild(el('div', 'result-text', esc(text)));
  if (summary && summary.length) { const chips = el('div', 'summary-chips'); summary.forEach((x) => chips.appendChild(chipFor(x))); c.appendChild(chips); }
  const b = el('button', 'primary continue', opts.nextYear ? '迈入新的一年 ▸' : '继续');
  b.addEventListener('click', onContinue);
  c.appendChild(b); s.appendChild(c);
}

export function renderAdvisorSummonCard(state, { selectedId, statusFor, onSelect, onEngage }) {
  const s = stage(); s.innerHTML = '';
  const c = el('div', 'card advisor-card');
  c.innerHTML = `<div class="kicker">密谈</div><div class="title">年终召见</div><div class="narrative">一年将尽，账本、军令和传闻都被压进同一只文件夹。您只能把一位重臣叫到灯下；他会给出答复，也会给自己留下余地。</div>`;
  const row = el('div', 'summon-tabs');
  for (const p of state.people) {
    const loy = p.alive ? loyaltySignal(p.loyalty) : 'danger';
    const b = el('button', `summon-person${p.id === selectedId ? ' active' : ''}${p.alive ? '' : ' gone'}`);
    b.innerHTML = `<span class="sp-main"><span class="sp-name">${esc(p.name)}</span><span class="sp-title">${esc(p.alive ? p.title : (p.defected ? '已叛离' : p.title))}</span></span><span class="pt-dot loy-${loy}"></span>`;
    b.addEventListener('click', () => onSelect(p.id));
    row.appendChild(b);
  }
  c.appendChild(row);
  const p = state.people.find((x) => x.id === selectedId) || state.people.find((x) => x.alive);
  if (p) {
    c.appendChild(renderPersonProfile(p, statusFor(p)));
    const actions = el('div', 'pd-actions advisor-actions');
    const btn = el('button', 'primary pd-engage', p.alive ? '私下接触' : '此人已离席');
    btn.disabled = !p.alive;
    if (p.alive) btn.addEventListener('click', () => onEngage(p));
    actions.appendChild(btn);
    c.appendChild(actions);
  }
  s.appendChild(c);
}

export function renderAdvisorActionCard(person, pack, { canReshuffle, onReshuffle, onChoose }) {
  const s = stage(); s.innerHTML = '';
  const c = el('div', 'card advisor-card');
  c.innerHTML = `<div class="kicker">密谈</div><div class="title">私下接触 · ${esc(person.name)}</div><div class="narrative">${esc(pack.intro || '他坐在灯下，等您先开口。')}</div>`;
  const opts = el('div', 'options advisor-options');
  (pack.options || []).forEach((opt) => {
    const b = el('button', 'option advisor-option');
    b.innerHTML = `<span class="ao-kind">${esc(opt.kind || '行动')}</span>${esc(opt.label || '')}`;
    b.addEventListener('click', () => onChoose(opt));
    opts.appendChild(b);
  });
  c.appendChild(opts);
  const re = el('button', 'ghost advisor-reshuffle', '换一批');
  re.disabled = !canReshuffle;
  if (canReshuffle) re.addEventListener('click', onReshuffle);
  c.appendChild(re);
  s.appendChild(c);
}

export function renderAdvisorCardResult(person, { reveal, narrative, clue, summary }, onContinue) {
  const s = stage(); s.innerHTML = '';
  const c = el('div', 'card');
  c.innerHTML = `<div class="kicker">密谈结果</div><div class="title">${esc(person.name)}退下之后</div>`;
  const parts = [narrative, reveal, clue].filter(Boolean).map(esc);
  if (parts.length) c.appendChild(el('div', 'result-text', parts.join('\n\n')));
  if (summary && summary.length) {
    const chips = el('div', 'summary-chips');
    summary.forEach((x) => chips.appendChild(chipFor(x)));
    c.appendChild(chips);
  }
  const b = el('button', 'primary continue', '迈入新的一年');
  b.addEventListener('click', onContinue);
  c.appendChild(b);
  s.appendChild(c);
}

export function renderBudget(state, onConfirm) {
  const s = stage(); s.innerHTML = '';
  const fields = [
    { key: 'army', label: '军队', desc: '同心之始，分化之机' },
    { key: 'elite', label: '精英福利', desc: '分给自己人，抑或喂大寡头' },
    { key: 'welfare', label: '民生基建', desc: '安抚民心，还是造神？' },
    { key: 'self', label: '个人账户', desc: '中饱私囊，但会掏空国库' },
  ];
  const vals = { army: 25, elite: 25, welfare: 25, self: 25 };
  const c = el('div', 'card');
  c.innerHTML = `<div class="kicker">财政年度</div><div class="title">这几年的钱，怎么分？</div><div class="total-note">国库有限，开销照旧。多给了谁，就是亏待了谁——给太多，也会出事。</div>`;
  const wrap = el('div', 'budget');
  function refresh() { const total = Object.values(vals).reduce((a, b) => a + b, 0) || 1; fields.forEach((f) => { c.querySelector(`#pct-${f.key}`).textContent = `${Math.round((vals[f.key] / total) * 100)}%`; }); }
  fields.forEach((f) => {
    const a = el('div', 'alloc');
    a.innerHTML = `<div class="alloc-head"><span>${f.label}</span><span class="pct" id="pct-${f.key}">25%</span></div><div class="desc">${f.desc}</div>`;
    const input = el('input'); input.type = 'range'; input.min = '0'; input.max = '100'; input.value = '25';
    input.addEventListener('input', () => { vals[f.key] = Number(input.value); refresh(); });
    a.appendChild(input); wrap.appendChild(a);
  });
  const btn = el('button', 'primary continue', '拍板'); btn.addEventListener('click', () => onConfirm({ ...vals }));
  wrap.appendChild(btn); c.appendChild(wrap); s.appendChild(c); refresh();
}

export function openOverlay(node) { const box = $('overlay-content'); box.innerHTML = ''; if (typeof node === 'string') box.innerHTML = node; else box.appendChild(node); $('overlay').classList.remove('hidden'); }
export function closeOverlay() { $('overlay').classList.add('hidden'); }

export function renderArchive(state) {
  const box = el('div');
  box.innerHTML = `<h3>档案室</h3><p class="muted" style="font-size:.85em">过往的决断。历史不会忘记，尽管您可能希望它忘记。</p>`;
  if (!state.archive.length) box.appendChild(el('p', 'muted', '（还没有什么值得记录的。）'));
  [...state.archive].reverse().forEach((a) => { const e = el('div', 'archive-entry'); e.innerHTML = `<div class="ay">第 ${a.year} 年</div><div class="at">${esc(a.title)}</div><div class="ar">您的选择：${esc(a.result)}</div>`; box.appendChild(e); });
  return box;
}

// 《独裁者手册》腔的玩法说明，开局与"手册"按钮共用
function briefingBody(state) {
  const c = el('div', 'briefing');
  c.appendChild(el('div', 'narrative', `一场深夜政变后，您成了${esc(state.nation)}的新主人。前任的体温还没凉透，您的椅子已经有人在惦记了。目标只有一个：活得久、捞得多、死在自己的床上。`));
  const guide = el('div', 'bf-guide');
  guide.innerHTML = `<div class="kicker" style="margin-bottom:6px">怎么玩</div>
    <ul>
      <li>六个核心指标：<b>军队、精英、民心、国际，中庸是保命，不是美德</b>。财政别见底，健康别归零。</li>
      <li>事件卡的每个选择都会牵动这些指标——没有标准答案，全是取舍。</li>
      <li>四位重臣可点击查看，每年可私下接触一人——但他未必照您说的办。忠诚的好用，有本事却不忠的或许更好用。</li>
      <li>分数到结局才揭晓：在位越久×地盘越大、私产越多、有人接班都加分。而史书怎么写您，会放大或抹平这一切。</li>
    </ul>`;
  c.appendChild(guide);
  return c;
}
export function manualNode(state) {
  const box = el('div');
  box.appendChild(el('h3', null, '独裁者手册 · 节选'));
  box.appendChild(briefingBody(state));
  return box;
}

// ---- 设置：自定义 LLM key / 格式 / 参与度 -------------------------------
export function openSettings(cur, onSave) {
  const ov = el('div', 'settings-ov');
  const box = el('div', 'settings-box');
  const field = (label, node) => { const w = el('div', 'set-field'); w.appendChild(el('label', 'set-label', label)); w.appendChild(node); return w; };
  const inp = (val, type, ph) => { const i = el('input', 'set-input'); i.type = type || 'text'; i.value = val || ''; if (ph) i.placeholder = ph; return i; };
  const fmt = el('select', 'set-input'); fmt.innerHTML = `<option value="openai">OpenAI 格式</option><option value="anthropic">Anthropic 格式</option>`; fmt.value = cur.format || 'openai';
  const key = inp(cur.apiKey, 'password', 'sk-...'); const base = inp(cur.baseUrl, 'text', '留空用默认'); const model = inp(cur.model, 'text', '留空用默认');
  const lvl = el('select', 'set-input'); lvl.innerHTML = `<option value="low">低（少打扰、少等待）</option><option value="mid">中（推荐）</option><option value="high">高（叙事最丰富）</option>`; lvl.value = cur.level || 'mid';
  box.appendChild(el('h3', null, '设置 · 叙事 AI'));
  box.appendChild(el('p', 'muted', '配置你自己的 LLM；留空则用服务端预置（若有）。无 AI 也能玩，但叙事与私信体验会大打折扣。'));
  box.appendChild(field('接口格式', fmt));
  box.appendChild(field('API Key', key));
  box.appendChild(field('Base URL', base));
  box.appendChild(field('模型', model));
  box.appendChild(field('AI 参与程度', lvl));
  const row = el('div', 'set-actions');
  const save = el('button', 'primary', '保存'); const cancel = el('button', 'ghost', '取消');
  save.addEventListener('click', () => { document.body.removeChild(ov); onSave({ format: fmt.value, apiKey: key.value.trim(), baseUrl: base.value.trim(), model: model.value.trim(), level: lvl.value }); });
  cancel.addEventListener('click', () => document.body.removeChild(ov));
  row.append(save, cancel); box.appendChild(row); ov.appendChild(box);
  ov.addEventListener('click', (e) => { if (e.target === ov) document.body.removeChild(ov); });
  document.body.appendChild(ov);
}

export function confirmDialog(msg, { yesLabel, onYes, altLabel, onAlt }) {
  const ov = el('div', 'settings-ov'); const box = el('div', 'settings-box');
  box.appendChild(el('p', '', esc(msg)));
  const row = el('div', 'set-actions');
  const y = el('button', 'primary', yesLabel || '确定'); y.addEventListener('click', () => { document.body.removeChild(ov); onYes && onYes(); });
  row.appendChild(y);
  if (altLabel) { const a = el('button', 'ghost', altLabel); a.addEventListener('click', () => { document.body.removeChild(ov); onAlt && onAlt(); }); row.appendChild(a); }
  box.appendChild(row); ov.appendChild(box); document.body.appendChild(ov);
}

export function renderAdvisorOptions(person, pack, { canReshuffle, onReshuffle, onChoose }) {
  const box = el('div');
  box.innerHTML = `<h3>${esc(person.name)}</h3>`;
  if (pack.intro) box.appendChild(el('div', 'adv-reveal', esc(pack.intro)));
  (pack.options || []).forEach((opt) => { const b = el('button', 'adv-opt'); b.innerHTML = `<span class="ao-kind">${esc(opt.kind || '行动')}</span>${esc(opt.label || '')}`; b.addEventListener('click', () => onChoose(opt)); box.appendChild(b); });
  const re = el('button', 'ghost', '换一批'); re.disabled = !canReshuffle; if (canReshuffle) re.addEventListener('click', onReshuffle);
  box.appendChild(re); return box;
}
export function renderAdvisorOutcome(person, { reveal, narrative, clue, summary }) {
  const box = el('div'); box.innerHTML = `<h3>${esc(person.name)}</h3>`;
  if (narrative) box.appendChild(el('div', 'adv-reveal', esc(narrative)));
  if (reveal) box.appendChild(el('div', 'adv-reveal', esc(reveal)));
  if (summary && summary.length) { const chips = el('div', 'summary-chips'); summary.forEach((x) => chips.appendChild(chipFor(x))); box.appendChild(chips); }
  if (clue) box.appendChild(el('div', 'adv-clue', esc(clue)));
  const b = el('button', 'primary', '退下'); b.style.marginTop = '14px'; b.addEventListener('click', closeOverlay); box.appendChild(b);
  openOverlay(box);
}

let loadingTimer;
export function showLoading(lines) {
  const box = $('loading'), line = $('loading-line');
  const arr = Array.isArray(lines) ? lines : [lines || '稍候……'];
  let i = 0; line.textContent = arr[0]; box.classList.remove('hidden');
  clearInterval(loadingTimer); loadingTimer = setInterval(() => { i = (i + 1) % arr.length; line.textContent = arr[i]; }, 1700);
  return function stop() { clearInterval(loadingTimer); box.classList.add('hidden'); };
}
export function showLoadingProgress(lines) {
  const stop = showLoading(lines);
  const wrap = $('loading-progress'), bar = $('loading-bar');
  wrap.classList.remove('hidden'); bar.style.width = '4%';
  return {
    set(frac) { bar.style.width = Math.max(4, Math.min(100, Math.round(frac * 100))) + '%'; },
    done() { bar.style.width = '100%'; setTimeout(() => { wrap.classList.add('hidden'); stop(); }, 220); },
  };
}

export function renderBriefing(state, onStart) {
  hidePanels();
  const s = stage(); s.innerHTML = '';
  const c = el('div', 'card');
  c.appendChild(el('div', 'kicker', '就任'));
  c.appendChild(el('div', 'title', `您是${esc(state.leader.name)}，${esc(state.nation)}的新主人`));
  c.appendChild(briefingBody(state));
  const btn = el('button', 'primary', '入主官邸'); btn.addEventListener('click', onStart);
  c.appendChild(btn); s.appendChild(c);
}

const ENDING_TITLE = {
  natural: '寿终正寝', coup: '政变之夜', assassination: '一杯毒酒', junta: '军政府上台', puppet: '沦为傀儡',
  uprising: '揭竿而起', frenzy: '狂热反噬', collapse: '政权崩溃', mutiny: '欠饷哗变', tribunal: '海牙的审判',
  arrested: '阶下之囚', exile: '仓皇出逃', accident: '离奇的意外', eliteCollapse: '众叛亲离',
  guardDefection: '卫队倒戈', warlordBreakaway: '军区割据', commanderRegency: '总司令摄政', barracksArrest: '军营软禁',
  palaceCoup: '宫廷政变', cabinetUltimatum: '内阁逼宫', oligarchRegency: '寡头摄政', corporateTakeover: '财团接管', rubberStamp: '签字机器',
  capitalSiege: '首都围城', provisionalArrest: '临时政府逮捕', squareTrial: '广场审判', loyaltyPurge: '忠诚清洗', idolBacklash: '神像反噬',
  borderClosure: '边境封锁', sanctionStrangle: '制裁窒息', foreignProtectorate: '外部托管', observerTakeover: '观察团接管',
  bankruptcy: '国库破产', creditorTakeover: '债主接管', blackMarketTurn: '黑市倒戈', financeMinisterFlight: '财长跑路',
  militaryBankruptcy: '军饷破产', foreignBackedCouncil: '外援委员会', oligarchDefault: '寡头违约',
};
export function renderEnding(state, score, obituary) {
  hidePanels();
  const s = stage(); s.innerHTML = '';
  const e = state.ending;
  const c = el('div', 'card ending');
  c.innerHTML = `<div class="verdict-tag">第 ${state.year} 年 · ${leaderAge(state)}岁</div><h2>${ENDING_TITLE[e.type] || '终局'}</h2>`;
  const ob = el('div');
  ob.appendChild(el('div', 'obituary wiki', `【维基百科】\n${esc(obituary.folk || obituary.text || '')}`));
  if (obituary.official) ob.appendChild(el('div', 'obituary official', `【官方认可版】\n${esc(obituary.official)}`));
  if (obituary.quote) { const q = String(obituary.quote).replace(/^[\s"'“”‘’「『]+|[\s"'“”‘’」』]+$/g, ''); ob.appendChild(el('p', 'ob-quote', `<em>“${esc(q)}”</em>`)); }
  c.appendChild(ob);
  if (state.achievements && state.achievements.length) { const ach = el('div', 'achievements'); state.achievements.forEach((a) => ach.appendChild(el('span', 'ach', `${esc(a.name)} +${a.points}`))); c.appendChild(ach); }
  const t = el('table', 'score-table');
  t.innerHTML = `
    <tr><td>在位 ${state.year} 年 × 领土 ${state.territory.toFixed(2)}</td><td>${score.base}</td></tr>
    <tr><td>财富（海外 ${state.wealth.overseas.toFixed(2)} / 国内 ${state.wealth.domestic.toFixed(2)} 亿）</td><td>${score.wealthScore}</td></tr>
    <tr><td>王朝</td><td>${score.dynasty}</td></tr>
    <tr><td>结局系数</td><td>×${score.coef}</td></tr>
    <tr><td>历史评价</td><td>×${score.historyMult}</td></tr>
    <tr><td>身后成就</td><td>+${score.achScore}</td></tr>
    <tr class="total"><td>最终得分</td><td>${score.total}</td></tr>`;
  c.appendChild(t);
  const seed = el('div', 'seed-row ending-seed');
  seed.appendChild(el('span', 'seed-label', '本局种子'));
  seed.appendChild(el('span', 'seed-code', esc(String(state.seed))));
  const copy = el('button', 'ghost seed-copy', '复制');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(String(state.seed)); toast('本局种子已复制'); }
    catch { toast(`本局种子：${state.seed}`, 4200); }
  });
  seed.appendChild(copy);
  c.appendChild(seed);
  const again = el('button', 'primary', '再来一局'); again.addEventListener('click', () => location.reload()); c.appendChild(again);
  const exp = el('button', 'ghost', '导出存档'); exp.style.marginLeft = '10px'; exp.addEventListener('click', () => downloadSave(state)); c.appendChild(exp);
  s.appendChild(c);
}
function downloadSave(state) { import('./state.js').then(({ exportSave }) => { const blob = new Blob([exportSave(state)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${state.nation}-第${state.year}年.json`; a.click(); }); }

let toastEl, toastTimer;
export function toast(msg, ms = 2600) { if (!toastEl) { toastEl = el('div'); toastEl.id = 'toast'; document.body.appendChild(toastEl); } toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms); }
