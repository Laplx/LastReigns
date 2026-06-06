// LLM 接入层。铁律：LLM 只返回受约束结构，engine 校验+钳制后落账。
// 离线/出错/超时一律返回 null 或 []，调用方使用预设兜底。

import { INDICATOR_META, leaderAge } from './state.js';
import { coreMood, decoLabel } from './atmosphere.js';
import { loyaltySignal, competenceSignal, sanitizeEffects, allowedFidelities } from './engine.js';

let _available = false, _model = '';
let _settingsAvailable = false, _settingsModel = '';
// 前端可配置的 LLM 设置（localStorage）：覆盖服务端 .env.local
function loadSettings() { try { return JSON.parse(localStorage.getItem('lastreigns_llm') || '{}'); } catch { return {}; } }
let _settings = loadSettings();
export function getSettings() { return { ..._settings }; }
export function saveSettings(s) { _settings = s || {}; _settingsAvailable = false; _settingsModel = ''; try { localStorage.setItem('lastreigns_llm', JSON.stringify(_settings)); } catch {} }
export function llmLevel() { return _settings.level || 'mid'; }
export function hasClientSettings() { return !!(_settings && _settings.apiKey); }
function effective() {
  if (!_settings.apiKey) return null;
  const fmt = _settings.format === 'anthropic' ? 'anthropic' : 'openai';
  return {
    apiKey: _settings.apiKey, format: fmt,
    baseUrl: _settings.baseUrl || (fmt === 'anthropic' ? 'https://api.deepseek.com/anthropic' : 'https://api.deepseek.com'),
    model: _settings.model || 'deepseek-chat',
  };
}
export async function checkHealth() {
  try { const r = await fetch('/api/health'); const j = await r.json(); _available = !!j.llm; _model = _available ? (j.model || '') : ''; return j; }
  catch { _available = false; _model = ''; return { ok: false, llm: false }; }
}
export async function refreshAvailability() {
  const health = await checkHealth();
  if (hasClientSettings()) return probeSettings();
  return health;
}
export function isAvailable() { return hasClientSettings() ? _settingsAvailable : _available; }
export function modelName() { return hasClientSettings() ? _settingsModel : _model; }

async function call(messages, { json = false, temperature = 0.9, max_tokens = 1100, timeoutMs = 0 } = {}) {
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const body = { messages, temperature, max_tokens };
    if (json) body.response_format = { type: 'json_object' };
    const e = effective();
    if (e) { body.apiKey = e.apiKey; body.baseUrl = e.baseUrl; body.format = e.format; body.model = e.model; }
    const r = await fetch('/api/llm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `http_${r.status}`); }
    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('empty');
    return text;
  } finally { if (timer) clearTimeout(timer); }
}
async function callJSON(messages, opts) { const text = await call(messages, { ...opts, json: true }); const a = text.indexOf('{'), b = text.lastIndexOf('}'); return JSON.parse(a >= 0 && b > a ? text.slice(a, b + 1) : text); }

async function probeSettings() {
  const e = effective();
  _settingsAvailable = false;
  _settingsModel = '';
  if (!e) return { ok: false, llm: false, source: 'client' };
  try {
    await call([
      { role: 'system', content: '只回复 OK。' },
      { role: 'user', content: 'OK' },
    ], { temperature: 0, max_tokens: 8, timeoutMs: 8000 });
    _settingsAvailable = true;
    _settingsModel = e.model;
    return { ok: true, llm: true, model: e.model, format: e.format, source: 'client' };
  } catch {
    return { ok: false, llm: false, model: e.model, format: e.format, source: 'client' };
  }
}

const SYS = '你在为一款基于《独裁者手册》的讽刺向政治模拟游戏生成中文叙事。基调冷峻、克制、黑色幽默，绝不说教。偏事实/新闻/内部简报口吻，少用生硬比喻。绝不出现数字、百分比、指标名或箭头。中文引号一律用全角双引号""。';
const EFFECT_SPEC = `effects 键只能从下列中选，值为档位字符串("+small"/"-small"/"+mid"/"-mid"/"+big"/"-big"/"+huge"/"-huge")：
army(军队) elite(精英) morale(民心) intl(国际) finance(财政) health(健康)；可选 wealth(数字,-1~1)、wealthDomestic(数字)、deco{health_care,education,capital,press}(档位)。
注意：军队/精英/民心/国际四项"过高过低都危险"(中段才安全)——例如 morale 太高=狂热失控、太低=民怨；intl 太高=外部干预、颜色渗透、无法自主决策，太低=孤立、制裁、失去外部承认。finance 低=国库见底。多数选项应对 1~2 项产生较大影响(big/huge)，可再带小影响。`;

function summarize(state, content) {
  const moods = INDICATOR_META.map((m) => `${m.name}：${coreMood(state, content, m.key).text}`).join('；');
  const deco = content.decorative.map((d) => `${d.name}(${decoLabel(content, d.key, state.deco[d.key])})`).join('、');
  const people = state.people.filter((p) => p.alive).map((p) => `${p.name}(${p.title}，${{ loyal: '忠心', ok: '尚可', uneasy: '心思浮动', danger: '离心离德' }[loyaltySignal(p.loyalty)]}，${{ high: '能力强', mid: '能力中', low: '能力弱' }[competenceSignal(p.competence)]})`).join('；');
  const chainDefs = [...(content.chains || []), ...(state.generatedChains || [])];
  const chains = state.activeChains.map((a) => (chainDefs.find((d) => d.id === a.id) || {}).title).filter(Boolean).join('、');
  const recent = state.archive.slice(-4).map((a) => a.title).join('、');
  return `背景：中非小国${state.nation}，独裁者${state.leader.name}。第${state.year}年，元首${leaderAge(state)}岁，国土约${Math.round(state.area)}平方公里${state.annexedRegions.length ? `（含新并入的${state.annexedRegions.join('、')}）` : ''}。
当前氛围——${moods}。表面：${deco}。${state.sanctioned ? '因孤立与失认承受制裁。' : ''}
身边重臣：${people || '已无人可用'}。正在发酵：${chains || '暂无'}。最近：${recent || '无'}。`;
}
function recentThemeHint(state) {
  const themes = Object.entries(state.themeCooldowns || {})
    .filter(([, until]) => until >= state.year)
    .map(([theme]) => theme)
    .slice(-10);
  return themes.length ? `近期已出现或正在冷却的主题：${themes.join('、')}。不要主动复用这些主题。` : '近期无明确主题冷却。';
}

function toCard(state, o, idx, tag) {
  if (!o || !o.title || !Array.isArray(o.options) || o.options.length < 2) return null;
  return {
    id: `${tag}_${state.year}_${idx}_${Math.floor(state.rng() * 1e6)}`, type: 'normal', weight: 2,
    theme: typeof o.theme === 'string' ? o.theme.trim().slice(0, 40) : 'llm_local',
    stages: Array.isArray(o.stages) ? o.stages.filter((s) => ['early', 'mid', 'late'].includes(s)) : undefined,
    kicker: String(o.kicker || '政务').slice(0, 6), title: String(o.title).slice(0, 30),
    speaker: o.speaker ? String(o.speaker).slice(0, 12) : undefined,
    narrative: String(o.narrative || '').slice(0, 400),
    options: o.options.slice(0, 3).map((x) => ({ text: String(x.text || '……').slice(0, 60), effects: sanitizeEffects(x.effects), result: String(x.result || '').slice(0, 160) })),
  };
}
function clampNum(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
function loyaltyGap(state) {
  const ls = state.people.filter((p) => p.alive).map((p) => p.loyalty);
  return ls.length < 2 ? 0 : Math.max(...ls) - Math.min(...ls);
}
function relaxTriggerToNow(state, trigger) {
  const t = { ...trigger };
  const keys = INDICATOR_META.map((m) => m.key);
  for (const key of keys) {
    const v = state.ind[key];
    const maxKey = `${key}Max`, minKey = `${key}Min`;
    if (t[maxKey] != null && v > t[maxKey]) t[maxKey] = Math.min(100, v + 4);
    if (t[minKey] != null && v < t[minKey]) t[minKey] = Math.max(0, v - 4);
  }
  if (t.borderMax != null && state.hidden.borderTension > t.borderMax) t.borderMax = Math.min(100, state.hidden.borderTension + 4);
  if (t.borderMin != null && state.hidden.borderTension < t.borderMin) t.borderMin = Math.max(0, state.hidden.borderTension - 4);
  const gap = loyaltyGap(state);
  if (t.loyaltyGapMax != null && gap > t.loyaltyGapMax) t.loyaltyGapMax = Math.min(100, gap + 4);
  if (t.loyaltyGapMin != null && gap < t.loyaltyGapMin) t.loyaltyGapMin = Math.max(0, gap - 4);
  if (t.minYear == null) t.minYear = state.year;
  if (t.minYear > state.year + 1) t.minYear = state.year + 1;
  return t;
}
function sanitizeTrigger(raw, state, forced = null) {
  const src = forced || raw || {};
  const out = {};
  if (src.minYear != null) out.minYear = clampNum(src.minYear, 1, state.maxYears || 60);
  for (const key of INDICATOR_META.map((m) => m.key)) {
    const maxKey = `${key}Max`, minKey = `${key}Min`;
    if (src[maxKey] != null) out[maxKey] = clampNum(src[maxKey], 0, 100);
    if (src[minKey] != null) out[minKey] = clampNum(src[minKey], 0, 100);
  }
  if (src.borderMin != null) out.borderMin = clampNum(src.borderMin, 0, 100);
  if (src.borderMax != null) out.borderMax = clampNum(src.borderMax, 0, 100);
  if (src.loyaltyGapMin != null) out.loyaltyGapMin = clampNum(src.loyaltyGapMin, 0, 100);
  if (src.loyaltyGapMax != null) out.loyaltyGapMax = clampNum(src.loyaltyGapMax, 0, 100);
  if (src.sanctioned != null) out.sanctioned = !!src.sanctioned;
  if (src.hasHeir != null) out.hasHeir = !!src.hasHeir;
  return forced ? out : relaxTriggerToNow(state, out);
}
function normalizeGoto(v, fallback, count) {
  if (v == null || v === '') return fallback;
  if (typeof v === 'string' && /end|finish|完成|结束/i.test(v)) return -1;
  const n = clampNum(v, -1, count - 1);
  return n == null ? fallback : n;
}
function cleanTheme(s) {
  const t = String(s || 'llm_chain').trim().slice(0, 48).replace(/[^a-zA-Z0-9_:-]/g, '_');
  return t || 'llm_chain';
}
function toGeneratedChain(state, obj, ctx) {
  const rawSteps = Array.isArray(obj?.steps) ? obj.steps : Array.isArray(obj?.chain?.steps) ? obj.chain.steps : [];
  if (!obj || !obj.title || rawSteps.length < 3) return null;
  const count = Math.min(6, rawSteps.length);
  const steps = rawSteps.slice(0, count).map((s, i) => {
    const rawOptions = Array.isArray(s.options) ? s.options : [];
    if (rawOptions.length < 2) return null;
    const hasDefer = rawOptions.some((o) => o.defer);
    const fallbackGoto = i < count - 1 ? i + 1 : -1;
    const rawEscalate = normalizeGoto(s.escalateTo, null, count);
    const step = {
      kicker: String(s.kicker || obj.kicker || '暗流').slice(0, 8),
      title: String(s.title || `节点${i + 1}`).replace(/[0-9０-９]/g, '').slice(0, 36),
      narrative: String(s.narrative || '').slice(0, 360),
      options: rawOptions.slice(0, 3).map((o) => ({
        text: String(o.text || '暂且按下').replace(/[0-9０-９%％→←+\-]/g, '').slice(0, 64),
        hint: o.hint ? String(o.hint).slice(0, 80) : undefined,
        effects: sanitizeEffects(o.effects),
        result: String(o.result || '').slice(0, 180),
        goto: normalizeGoto(o.goto, o.defer ? i : fallbackGoto, count),
        defer: !!o.defer,
      })),
    };
    if (hasDefer || rawEscalate != null) step.escalateTo = rawEscalate == null ? fallbackGoto : rawEscalate;
    return step.narrative && step.options.length >= 2 ? step : null;
  }).filter(Boolean);
  if (steps.length < 3) return null;
  const trigger = sanitizeTrigger(obj.trigger || obj.chain?.trigger, state, ctx?.trigger || null);
  return {
    id: `llm_chain_${ctx?.kind || 'situation'}_${state.year}_${Math.floor(state.rng() * 1e6)}`,
    generated: true,
    source: 'llm',
    llmKind: ctx?.kind === 'crisis' ? 'crisis' : 'situation',
    crisisKey: ctx?.crisisKey || null,
    title: String(obj.title).replace(/[0-9０-９]/g, '').slice(0, 36),
    theme: cleanTheme(obj.theme),
    stages: Array.isArray(obj.stages) ? obj.stages.filter((s) => ['early', 'mid', 'late'].includes(s)) : ['mid'],
    trigger,
    fit: Math.max(0.75, Math.min(1.5, Number(obj.fit) || (ctx?.kind === 'crisis' ? 1.25 : 1))),
    createdYear: state.year,
    expiresYear: state.year + 10,
    steps,
  };
}

// 开局/财政年：预生成一批本局专属事件
export async function pregenEvents(state, content, n) {
  if (!isAvailable()) return [];
  const names = state.people.filter((p) => p.alive).map((p) => `${p.name}(${p.title})`).join('、');
  try {
    const obj = await callJSON([
      { role: 'system', content: SYS },
      { role: 'user', content: `${summarize(state, content)}

${recentThemeHint(state)}
为本局生成 ${n} 个"互不相同"的事件卡，尽量围绕本局这四位重臣展开：${names}；也可涉及国名"${state.nationShort}"、课税/财政、边境、外交、民生、腐败、宫廷阴谋等。情节各异、不要雷同、不要与最近发生的重复。每卡≤180字叙事 + 2~3 个有取舍的选项(选项文字不得出现数字)。每卡必须给 theme(英文短标签) 与 stages(early/mid/late 数组，可多选)。
${EFFECT_SPEC}
每个选项给出 result(≤80字)。严格输出 JSON：{"events":[{"theme":"tax","stages":["early","mid"],"kicker":"二字","title":"...","speaker":"可空","narrative":"...","options":[{"text":"...","effects":{...},"result":"..."}]}]}` },
    ], { temperature: 1.05, max_tokens: 520 + n * 300, timeoutMs: 10000 + n * 3500 });
    const arr = Array.isArray(obj.events) ? obj.events : [];
    return arr.map((o, i) => toCard(state, o, i, 'pre')).filter(Boolean);
  } catch { return []; }
}

export async function generateSpecialEvent(state, content) {
  if (!isAvailable()) return null;
  try {
    const obj = await callJSON([
      { role: 'system', content: SYS },
      { role: 'user', content: `${summarize(state, content)}\n\n${recentThemeHint(state)}\n基于当前局势生成一个特殊事件卡：≤200字叙事 + 2~3 个选项。必须给 theme(英文短标签) 与 stages(early/mid/late 数组，可多选)。\n${EFFECT_SPEC}\n每选项给 result(≤80字)。严格输出 JSON：{"theme":"palace_intrigue","stages":["mid"],"kicker":"二字","title":"...","speaker":"可空","narrative":"...","options":[{"text":"...","effects":{...},"result":"..."}]}` },
    ], { temperature: 1.0, max_tokens: 900, timeoutMs: 16000 });
    const c = toCard(state, obj, 0, 'special'); if (c) c.type = 'special'; return c;
  } catch { return null; }
}

export async function generateEventChain(state, content, ctx = {}) {
  if (!isAvailable()) return null;
  const recent = state.archive.slice(-8).map((a) => `第${a.year}年「${a.title}」选择了「${a.result}」`).join('；') || '暂无';
  const chainDefs = [...(content.chains || []), ...(state.generatedChains || [])];
  const active = state.activeChains.map((a) => (chainDefs.find((d) => d.id === a.id) || a).title || a.id).join('、') || '暂无';
  const crisis = ctx.kind === 'crisis' && ctx.warning
    ? `这是一条危机链，源自当前警讯：「${ctx.warning.title}」。危机方向：${ctx.warning.key}/${ctx.warning.side}。只要该压力仍处在警告阈值附近，就应该容易触发。`
    : '这是一条局势链，必须贴着当前历史、财政周期、身边人物和最近选择来写。触发条件要当前已经满足，或只差很小变化即可满足。';
  try {
    const obj = await callJSON([
      { role: 'system', content: SYS },
      { role: 'user', content: `${summarize(state, content)}

最近档案：${recent}。活跃事件链：${active}。
${recentThemeHint(state)}
${crisis}

请生成一条完整事件链，至少 3 个节点，最多 6 个节点。节点之间要有递进和后果，不要像互不相关的普通事件。
trigger 只允许：minYear；army/elite/morale/intl/finance/health 的 Min/Max；borderMin/borderMax；loyaltyGapMin/Max；sanctioned；hasHeir。触发条件必须贴近当前状态，不能写遥远条件。
每个节点 2~3 个选项；每个选项必须给 effects、result、goto。可少量使用 defer；使用 defer 的节点应给 escalateTo。goto 用节点序号，从 0 开始；-1 表示链结束。不得直接写结局、不得直接杀人、不得越权改状态。
${EFFECT_SPEC}
严格输出 JSON：{"title":"...","theme":"english_tag","stages":["early","mid"],"fit":1.2,"trigger":{"minYear":${state.year}},"steps":[{"kicker":"二字","title":"...","narrative":"...","escalateTo":1,"options":[{"text":"...","effects":{...},"result":"...","goto":1,"defer":false}]}]}` },
    ], { temperature: 1.02, max_tokens: 2600, timeoutMs: 38000 });
    return toGeneratedChain(state, obj, ctx);
  } catch { return null; }
}

export async function generateAtmosphereOverride(state, content) {
  if (!isAvailable()) return null;
  try {
    const obj = await callJSON([
      { role: 'system', content: SYS },
      { role: 'user', content: `${summarize(state, content)}\n\n请为六个核心态势各写一句当前氛围短语，用于鼠标提示。每句 8~18 个汉字，像近侍、秘书、卫队、部长或身边人听来的异常反馈；不要出现数字、百分比、箭头、指标名，不要解释规则。严格输出 JSON：{"army":"...","elite":"...","morale":"...","intl":"...","finance":"...","health":"..."}` },
    ], { temperature: 0.9, max_tokens: 360, timeoutMs: 9000 });
    const out = {};
    for (const key of INDICATOR_META.map((m) => m.key)) {
      const text = String(obj[key] || obj.moods?.[key] || '').replace(/[0-9０-９%％→←+\-]/g, '').trim();
      if (text) out[key] = text.slice(0, 36);
    }
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

export async function advisorOptions(state, content, person) {
  if (!isAvailable()) return null;
  const allowed = allowedFidelities(person);
  const sig = { loyal: '忠心', ok: '尚可', uneasy: '心思浮动', danger: '离心离德' }[loyaltySignal(person.loyalty)];
  const comp = { high: '能力出众、手腕老练', mid: '能力中等', low: '能力平庸、常误事' }[competenceSignal(person.competence)];
  try {
    const obj = await callJSON([
      { role: 'system', content: SYS },
      { role: 'user', content: `${summarize(state, content)}

元首私下接触「${person.name}」（${person.title}）。性格：${person.traits.join('、')}；私心：${person.hiddenInterest}；当前对元首：${sig}；${comp}。
生成恰好 3 个动作选项，kind 各不相同(从探听/拉拢/敲打/委以重任/暗查/试探中选3)。每项自洽、直接给结果，文字简练。
- fidelity 只能取：${allowed.join(' / ')}。faithful 忠实；discounted 打折；feigned 阳奉阴违(表面顺从、暗里谋私)；betrayal 背刺(把意图透露给对元首不利方)。
- 该人若离心或私心重，"探听"给的情报可片面甚至误导(写进 reveal)，但不点破。
- fidelity 非 faithful 时，foreshadow_clue 必填(事后可察觉、当下不点破的线索)。
- proposed_effects=表面达成；hidden_effects=阳奉阴违/背刺的隐性不利后果。拉拢可含 loyalty{"${person.id}":"+mid"}。
${EFFECT_SPEC}
reveal=选后所见情报(≤90字,可空)；public_narrative=当面的话(≤70字)。
严格输出 JSON：{"intro":"他此刻神态(≤40字)","options":[{"kind":"探听","label":"动作(≤16字)","fidelity":"...","reveal":"...","public_narrative":"...","foreshadow_clue":"...","proposed_effects":{...},"hidden_effects":{...},"memory_note":"一句供日后引用"}]}` },
    ], { temperature: 0.95, max_tokens: 1050, timeoutMs: 14000 });
    if (!Array.isArray(obj.options) || !obj.options.length) return null;
    return {
      intro: String(obj.intro || '').slice(0, 80),
      options: obj.options.slice(0, 3).map((o) => ({
        kind: String(o.kind || '行动').slice(0, 6), label: String(o.label || '……').slice(0, 24), fidelity: o.fidelity,
        reveal: o.reveal ? String(o.reveal).slice(0, 200) : '', public_narrative: String(o.public_narrative || '').slice(0, 160),
        foreshadow_clue: o.foreshadow_clue ? String(o.foreshadow_clue).slice(0, 160) : '',
        proposed_effects: o.proposed_effects || {}, hidden_effects: o.hidden_effects || {}, memory_note: o.memory_note ? String(o.memory_note).slice(0, 120) : '',
      })),
    };
  } catch { return null; }
}

// D1b：把手写事件链节点的"叙事"结合当前局势/人物在后台改写，保持结构不变。
export async function reskinChainStep(state, content, def, stepIndex) {
  if (!isAvailable()) return null;
  const step = (def.steps || [])[stepIndex]; if (!step) return null;
  try {
    const text = await call([
      { role: 'system', content: SYS },
      { role: 'user', content: `${summarize(state, content)}\n\n${recentThemeHint(state)}\n正在发酵的事态「${def.title}」走到一个节点，原始情境是：\n「${step.narrative}」\n只允许改写当前节点 narrative：保持同一件事、同样抉择压力和同一主题，不得改标题、kicker、speaker、选项文字、效果、goto、escalateTo，也不得新增会改变判断的信息。可以点名相关重臣，但不要主动复用近期冷却主题。只输出≤160字的叙事正文，别的都不要。` },
    ], { temperature: 1.0, max_tokens: 460, timeoutMs: 13000 });
    const t = (text || '').trim();
    return t.length > 8 ? t.slice(0, 340) : null;
  } catch { return null; }
}

export async function generateObituary(state, content, scoreCtx) {
  if (!isAvailable()) return null;
  const endingDesc = { natural: '在位多年后于官邸自然死亡', coup: '被军队政变推翻并死于非命', assassination: '在宴会后被毒杀', junta: '被坐大的军方架空、退居二线', puppet: '晚年沦为寡头的傀儡', uprising: '死于民众起义', frenzy: '被自己点燃的狂热吞噬', collapse: '政权在孤立、制裁与失去承认中垮塌', mutiny: '死于欠饷军队的哗变', tribunal: '在外部干预与国际司法压力下被押上海牙法庭', arrested: '沦为阶下囚并在狱中病故', exile: '流亡海外', accident: '死于离奇意外', eliteCollapse: '众叛亲离、被迫交权' }[state.ending.type] || '结束了统治';
  const histHint = state.hidden.historyNarrative >= 70 ? '后世多将其神化' : state.hidden.historyNarrative <= 25 ? '后世多将其钉上耻辱柱' : '后世评价两极';
  const achNames = (state.achievements || []).map((a) => a.name).join('、');
  try {
    const obj = await callJSON([
      { role: 'system', content: SYS },
      { role: 'user', content: `${summarize(state, content)}\n\n${state.leader.name}的统治结束：${endingDesc}，终年${leaderAge(state)}岁，在位${state.year}年。${histHint}。${achNames ? `标签：${achNames}。` : ''}\n请生成：1) folk：约300字"维基百科式"身后条目(中立带讽刺，提及在位时间、标志性事件、国际评价、历史地位定性)；2) quote：一句后人常引用的"他的名言"。${state.biographyCommissioned ? '3) official：约200字"官方认可版"颂词(他生前设立的传记委员会所写，极尽溢美，与维基版讽刺反差)。' : ''}\n严格输出 JSON：{"folk":"...","quote":"..."${state.biographyCommissioned ? ',"official":"..."' : ''}}` },
    ], { temperature: 1.0, max_tokens: 1200, timeoutMs: 22000 });
    return { folk: String(obj.folk || '').slice(0, 900), official: obj.official ? String(obj.official).slice(0, 700) : null, quote: obj.quote ? String(obj.quote).slice(0, 120) : '' };
  } catch { return null; }
}

// 旧自由文本对话（v1 停用，保留接口）
export async function advisorTalk() { return null; }
export async function advisorCommand() { return null; }
