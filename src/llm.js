// LLM 接入层。铁律：LLM 只返回受约束结构，engine 校验+钳制后落账。
// 离线/出错/超时一律返回 null 或 []，调用方使用预设兜底。

import { INDICATOR_META, leaderAge } from './state.js';
import { coreMood, decoLabel } from './atmosphere.js';
import { loyaltySignal, competenceSignal, sanitizeEffects, allowedFidelities } from './engine.js';

let _available = false, _model = '';
export async function checkHealth() {
  try { const r = await fetch('/api/health'); const j = await r.json(); _available = !!j.llm; _model = j.model || ''; return j; }
  catch { _available = false; return { ok: false, llm: false }; }
}
export function isAvailable() { return _available; }
export function modelName() { return _model; }

async function call(messages, { json = false, temperature = 0.9, max_tokens = 1100, timeoutMs = 0 } = {}) {
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const body = { messages, temperature, max_tokens };
    if (json) body.response_format = { type: 'json_object' };
    const r = await fetch('/api/llm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `http_${r.status}`); }
    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('empty');
    return text;
  } finally { if (timer) clearTimeout(timer); }
}
async function callJSON(messages, opts) { const text = await call(messages, { ...opts, json: true }); const a = text.indexOf('{'), b = text.lastIndexOf('}'); return JSON.parse(a >= 0 && b > a ? text.slice(a, b + 1) : text); }

const SYS = '你在为一款基于《独裁者手册》的讽刺向政治模拟游戏生成中文叙事。基调冷峻、克制、黑色幽默，绝不说教。偏事实/新闻/内部简报口吻，少用生硬比喻。绝不出现数字、百分比、指标名或箭头。中文引号一律用全角双引号""。';
const EFFECT_SPEC = `effects 键只能从下列中选，值为档位字符串("+small"/"-small"/"+mid"/"-mid"/"+big"/"-big"/"+huge"/"-huge")：
army(军队) elite(精英) morale(民心) intl(国际) finance(财政) health(健康)；可选 wealth(数字,-1~1)、wealthDomestic(数字)、deco{health_care,education,capital,press}(档位)。
注意：军队/精英/民心/国际四项"过高过低都危险"(中段才安全)——例如 morale 太高=狂热失控、太低=民怨；intl 太高=制裁干预、太低=孤立。finance 低=国库见底。多数选项应对 1~2 项产生较大影响(big/huge)，可再带小影响。`;

function summarize(state, content) {
  const moods = INDICATOR_META.map((m) => `${m.name}：${coreMood(state, content, m.key).text}`).join('；');
  const deco = content.decorative.map((d) => `${d.name}(${decoLabel(content, d.key, state.deco[d.key])})`).join('、');
  const people = state.people.filter((p) => p.alive).map((p) => `${p.name}(${p.title}，${{ loyal: '忠心', ok: '尚可', uneasy: '心思浮动', danger: '离心离德' }[loyaltySignal(p.loyalty)]}，${{ high: '能力强', mid: '能力中', low: '能力弱' }[competenceSignal(p.competence)]})`).join('；');
  const chains = state.activeChains.map((a) => (content.chains.find((d) => d.id === a.id) || {}).title).filter(Boolean).join('、');
  const recent = state.archive.slice(-4).map((a) => a.title).join('、');
  return `背景：中非小国${state.nation}，独裁者${state.leader.name}。第${state.year}年，元首${leaderAge(state)}岁，国土约${Math.round(state.area)}平方公里${state.annexedRegions.length ? `（含新并入的${state.annexedRegions.join('、')}）` : ''}。
当前氛围——${moods}。表面：${deco}。${state.sanctioned ? '正受国际制裁。' : ''}
身边重臣：${people || '已无人可用'}。正在发酵：${chains || '暂无'}。最近：${recent || '无'}。`;
}

function toCard(state, o, idx, tag) {
  if (!o || !o.title || !Array.isArray(o.options) || o.options.length < 2) return null;
  return {
    id: `${tag}_${state.year}_${idx}_${Math.floor(state.rng() * 1e6)}`, type: 'normal', weight: 2,
    kicker: String(o.kicker || '政务').slice(0, 6), title: String(o.title).slice(0, 30),
    speaker: o.speaker ? String(o.speaker).slice(0, 12) : undefined,
    narrative: String(o.narrative || '').slice(0, 400),
    options: o.options.slice(0, 3).map((x) => ({ text: String(x.text || '……').slice(0, 60), effects: sanitizeEffects(x.effects), result: String(x.result || '').slice(0, 160) })),
  };
}

// 开局/财政年：预生成一批本局专属事件
export async function pregenEvents(state, content, n) {
  if (!_available) return [];
  const names = state.people.filter((p) => p.alive).map((p) => `${p.name}(${p.title})`).join('、');
  try {
    const obj = await callJSON([
      { role: 'system', content: SYS },
      { role: 'user', content: `${summarize(state, content)}

为本局生成 ${n} 个"互不相同"的事件卡，尽量围绕本局这四位重臣展开：${names}；也可涉及国名"${state.nationShort}"、课税/财政、边境、外交、民生、腐败、宫廷阴谋等。情节各异、不要雷同、不要与最近发生的重复。每卡≤180字叙事 + 2~3 个有取舍的选项(选项文字不得出现数字)。
${EFFECT_SPEC}
每个选项给出 result(≤80字)。严格输出 JSON：{"events":[{"kicker":"二字","title":"...","speaker":"可空","narrative":"...","options":[{"text":"...","effects":{...},"result":"..."}]}]}` },
    ], { temperature: 1.05, max_tokens: 2600, timeoutMs: 14000 });
    const arr = Array.isArray(obj.events) ? obj.events : [];
    return arr.map((o, i) => toCard(state, o, i, 'pre')).filter(Boolean);
  } catch { return []; }
}

export async function generateSpecialEvent(state, content) {
  if (!_available) return null;
  try {
    const obj = await callJSON([
      { role: 'system', content: SYS },
      { role: 'user', content: `${summarize(state, content)}\n\n基于当前局势生成一个特殊事件卡：≤200字叙事 + 2~3 个选项。\n${EFFECT_SPEC}\n每选项给 result(≤80字)。严格输出 JSON：{"kicker":"二字","title":"...","speaker":"可空","narrative":"...","options":[{"text":"...","effects":{...},"result":"..."}]}` },
    ], { temperature: 1.0, max_tokens: 900, timeoutMs: 16000 });
    const c = toCard(state, obj, 0, 'special'); if (c) c.type = 'special'; return c;
  } catch { return null; }
}

export async function advisorOptions(state, content, person) {
  if (!_available) return null;
  const allowed = allowedFidelities(person);
  const sig = { loyal: '忠心', ok: '尚可', uneasy: '心思浮动', danger: '离心离德' }[loyaltySignal(person.loyalty)];
  const comp = { high: '能力出众、手腕老练', mid: '能力中等', low: '能力平庸、常误事' }[competenceSignal(person.competence)];
  try {
    const obj = await callJSON([
      { role: 'system', content: SYS },
      { role: 'user', content: `${summarize(state, content)}

元首私下接触「${person.name}」（${person.title}）。性格：${person.traits.join('、')}；私心：${person.hiddenInterest}；当前对元首：${sig}；${comp}。
生成 3~4 个动作选项，覆盖不同 kind：探听/拉拢/敲打/委以重任/暗查。每项自洽、直接给结果。
- fidelity 只能取：${allowed.join(' / ')}。faithful 忠实；discounted 打折；feigned 阳奉阴违(表面顺从、暗里谋私)；betrayal 背刺(把意图透露给对元首不利方)。
- 该人若离心或私心重，"探听"给的情报可片面甚至误导(写进 reveal)，但不点破。
- fidelity 非 faithful 时，foreshadow_clue 必填(事后可察觉、当下不点破的线索)。
- proposed_effects=表面达成；hidden_effects=阳奉阴违/背刺的隐性不利后果。拉拢可含 loyalty{"${person.id}":"+mid"}。
${EFFECT_SPEC}
reveal=选后所见情报(≤90字,可空)；public_narrative=当面的话(≤70字)。
严格输出 JSON：{"intro":"他此刻神态(≤40字)","options":[{"kind":"探听","label":"动作(≤16字)","fidelity":"...","reveal":"...","public_narrative":"...","foreshadow_clue":"...","proposed_effects":{...},"hidden_effects":{...},"memory_note":"一句供日后引用"}]}` },
    ], { temperature: 0.98, max_tokens: 1500, timeoutMs: 18000 });
    if (!Array.isArray(obj.options) || !obj.options.length) return null;
    return {
      intro: String(obj.intro || '').slice(0, 80),
      options: obj.options.slice(0, 4).map((o) => ({
        kind: String(o.kind || '行动').slice(0, 6), label: String(o.label || '……').slice(0, 24), fidelity: o.fidelity,
        reveal: o.reveal ? String(o.reveal).slice(0, 200) : '', public_narrative: String(o.public_narrative || '').slice(0, 160),
        foreshadow_clue: o.foreshadow_clue ? String(o.foreshadow_clue).slice(0, 160) : '',
        proposed_effects: o.proposed_effects || {}, hidden_effects: o.hidden_effects || {}, memory_note: o.memory_note ? String(o.memory_note).slice(0, 120) : '',
      })),
    };
  } catch { return null; }
}

export async function generateObituary(state, content, scoreCtx) {
  if (!_available) return null;
  const endingDesc = { natural: '在位多年后于官邸自然死亡', coup: '被军队政变推翻并死于非命', assassination: '在宴会后被毒杀', junta: '被坐大的军方架空、退居二线', puppet: '晚年沦为寡头的傀儡', uprising: '死于民众起义', frenzy: '被自己点燃的狂热吞噬', collapse: '政权在孤立中垮塌', mutiny: '死于欠饷军队的哗变', tribunal: '被押上海牙法庭', arrested: '沦为阶下囚并在狱中病故', exile: '流亡海外', accident: '死于离奇意外', eliteCollapse: '众叛亲离、被迫交权' }[state.ending.type] || '结束了统治';
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
