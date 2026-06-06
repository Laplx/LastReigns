// 入口 / 编排：连续卡片流、年份自然流逝、预算降频、链显式化、私信、结局。

import * as ui from './ui.js';
import { createInitialState, leaderAge, rngShuffle } from './state.js';
import * as engine from './engine.js';
import * as events from './events.js';
import * as chains from './chains.js';
import * as llm from './llm.js';
import { resetAtmosphere } from './atmosphere.js';

let content, state, selectedPersonId = null;
let chainNarr = {}, _poolBusy = false, _poolPromise = null, _specialBusy = false, _atmoBusy = false;
let _situationChainBusy = false, _crisisChainBusy = {};
let advisorPrefetchYear = 0, advisorPrefetch = {};
const MAX_GENERATED_CHAINS_PER_RUN = 30;
const THEMES = ['paper', 'slate', 'crimson', 'verdigris'];
function applyRandomTheme() { document.body.dataset.theme = THEMES[Math.floor(Math.random() * THEMES.length)]; }
function lvlCfg() {
  const l = llm.llmLevel();
  const base = { lowWater: 20, targetPool: 40, llmGroup: 2, llmConcurrency: 5 };
  if (l === 'low') return { ...base, specP: 0, reskin: false, bootStatic: 20, bootLlm: 0, topupStatic: 20, topupLlm: 0 };
  if (l === 'high') return { ...base, specP: 0.15, reskin: true, bootStatic: 20, bootLlm: 10, topupStatic: 10, topupLlm: 10 };
  return { ...base, specP: 0.08, reskin: true, bootStatic: 20, bootLlm: 10, topupStatic: 12, topupLlm: 8 };
}

async function loadContent() {
  const j = (p) => fetch(p).then((r) => r.json());
  const [eventsD, people, chainsD, atmosphere, decorative, world] = await Promise.all([
    j('./data/events.json'), j('./data/people.json'), j('./data/chains.json'),
    j('./data/atmosphere.json'), j('./data/decorative.json'), j('./data/world.json'),
  ]);
  return events.prepareContent({ events: eventsD, people, chains: chainsD, atmosphere, decorative, world });
}

function updateLlmStatusText() {
  const ready = llm.isAvailable();
  ui.setNetStatus(ready ? 'online' : 'offline', ready ? `叙事联网：${llm.modelName() || '已就绪'}` : '叙事联网未就绪');
  const foot = document.getElementById('boot-foot');
  if (foot) foot.innerHTML = `${ready ? '叙事联网已就绪' : '叙事联网未就绪：预设叙事可玩，私下接触将使用规则兜底'}<br><span class="version">v1.2.4</span>`;
}

async function boot() {
  try { content = await loadContent(); }
  catch { document.getElementById('boot-foot').textContent = '资源加载失败，请用 npm start 启动后访问 http://localhost:5173'; return; }
  await llm.refreshAvailability();
  updateLlmStatusText();
  document.getElementById('btn-start').addEventListener('click', onStartClick);
  document.getElementById('btn-settings').addEventListener('click', openSettingsFlow);
  document.getElementById('btn-archive').addEventListener('click', () => state && ui.openOverlay(ui.renderArchive(state)));
  document.getElementById('btn-manual').addEventListener('click', () => state && ui.openOverlay(ui.manualNode(state)));
  document.getElementById('overlay-close').addEventListener('click', ui.closeOverlay);
  document.getElementById('overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') ui.closeOverlay(); });
}

function onStartClick() {
  if (!llm.isAvailable()) {
    ui.confirmDialog('您还没有配置叙事 AI。游戏仍可进行，但事件叙事、私下接触、结局词条都会退化为预设内容，体验会大打折扣。', {
      yesLabel: '仍要开始', onYes: showBriefing, altLabel: '去配置', onAlt: openSettingsFlow,
    });
  } else showBriefing();
}
function openSettingsFlow() {
  ui.openSettings(llm.getSettings(), async (s) => {
    llm.saveSettings(s);
    const foot = document.getElementById('boot-foot');
    if (foot) foot.textContent = '正在检查叙事联网配置……';
    await llm.refreshAvailability();
    updateLlmStatusText();
  });
}

function showBriefing() {
  resetAtmosphere();
  advisorPrefetchYear = 0; advisorPrefetch = {};
  chainNarr = {};
  _situationChainBusy = false; _crisisChainBusy = {};
  const seed = (Date.now() ^ Math.floor(performance.now() * 1000)) >>> 0;
  state = createInitialState(seed, content);
  document.getElementById('boot').classList.add('hidden');
  ui.renderBriefing(state, startGame);
}

function queuePrioritySpecial(card) {
  if (!card || !card.title) return;
  const title = String(card.title).trim();
  const seen = new Set([
    ...content.events.map((e) => e.title),
    ...(state.normalPool || []).map((e) => e.title),
    ...(state.prioritySpecialQueue || []).map((e) => e.title),
    ...state.archive.map((a) => a.title),
  ].filter(Boolean).map((x) => String(x).trim()));
  if (seen.has(title)) return;
  state.prioritySpecialQueue.push(card);
  if (state.prioritySpecialQueue.length > 2) state.prioritySpecialQueue.splice(0, state.prioritySpecialQueue.length - 2);
}

async function runLimited(tasks, limit, onDone) {
  const results = [];
  let next = 0, running = 0, done = 0;
  return new Promise((resolve) => {
    const pump = () => {
      if (done >= tasks.length) return resolve(results);
      while (running < limit && next < tasks.length) {
        const index = next++;
        running++;
        tasks[index]().then((value) => { results[index] = value; }).catch(() => { results[index] = []; }).finally(() => {
          running--; done++; if (onDone) onDone(done, tasks.length); pump();
        });
      }
    };
    pump();
  });
}
async function generateLlmNormals(total, batch, onDone) {
  if (!llm.isAvailable() || total <= 0) return 0;
  const cfg = lvlCfg();
  const tasks = [];
  for (let left = total; left > 0; left -= cfg.llmGroup) {
    const n = Math.min(cfg.llmGroup, left);
    tasks.push(() => llm.pregenEvents(state, content, n).then((cards) => events.addNormalPoolCards(state, content, cards, 'llm', batch)));
  }
  const results = await runLimited(tasks, cfg.llmConcurrency, onDone);
  return results.reduce((sum, n) => sum + (Number(n) || 0), 0);
}
async function buildNormalPool({ boot = false, progress = null } = {}) {
  const cfg = lvlCfg();
  const batch = boot ? 'boot' : 'topup';
  const staticNeed = boot ? cfg.bootStatic : cfg.topupStatic;
  const llmNeed = boot ? cfg.bootLlm : cfg.topupLlm;
  events.fillStaticNormalPool(state, content, staticNeed, batch);
  if (llmNeed > 0) {
    const groups = Math.ceil(llmNeed / cfg.llmGroup);
    let completed = 0;
    const added = await generateLlmNormals(llmNeed, batch, (done) => {
      completed = done;
      if (progress) progress.set(Math.max(0.04, completed / groups));
    });
    if (added < llmNeed) events.fillStaticNormalPool(state, content, llmNeed - added, boot ? 'boot' : 'instant');
  }
}
function maybeTopupNormalPool(force = false) {
  const cfg = lvlCfg();
  const count = events.availableNormalCount(state, content);
  if (_poolBusy || (!force && count >= cfg.lowWater) || (force && count >= cfg.targetPool)) return;
  if (state.poolStats) state.poolStats.lowWater = (state.poolStats.lowWater || 0) + 1;
  _poolBusy = true;
  _poolPromise = buildNormalPool({ boot: false }).catch(() => {}).finally(() => { _poolBusy = false; _poolPromise = null; });
}
async function ensureNormalCardReady() {
  if (events.availableNormalCount(state, content) > 0) return;
  const cfg = lvlCfg();
  events.fillStaticNormalPool(state, content, Math.max(6, cfg.topupStatic), 'instant');
  if (events.availableNormalCount(state, content) > 0 || !_poolPromise) return;
  const stop = ui.showLoading(LOADING.budget);
  await Promise.race([_poolPromise, new Promise((resolve) => setTimeout(resolve, 1200))]);
  stop();
}
async function startGame() {
  ui.renderTopbar(state, simmeringSummary());
  const cfg = lvlCfg();
  if (llm.isAvailable() && cfg.bootLlm > 0) {
    const prog = ui.showLoadingProgress(LOADING.boot);
    prog.set(0.04);
    await buildNormalPool({ boot: true, progress: prog });
    prog.done();
  } else {
    await buildNormalPool({ boot: true });
  }
  refreshPanels();
  maybeTopupNormalPool(true);
  gameLoop();
}

// 后台并行准备（不阻塞）：D1a 题池补充（参考历史/状态）+ D1b 事件链节点叙事改写
function bgPrep() {
  const cfg = lvlCfg();
  chains.maintainGeneratedChains(state);
  maybeTopupNormalPool();
  if (!llm.isAvailable()) return;
  if (!_atmoBusy && state.atmosphereOverrideYear !== state.year) {
    _atmoBusy = true;
    llm.generateAtmosphereOverride(state, content).then((mood) => {
      if (mood && !state.over) {
        state.atmosphereOverride = mood;
        state.atmosphereOverrideYear = state.year;
        refreshPanels();
      }
    }).catch(() => {}).finally(() => { _atmoBusy = false; });
  }
  if (cfg.reskin) {
    for (const s of chains.getActiveSteps(state, content)) {
      if (chainNarr[s.key] !== undefined) continue;
      chainNarr[s.key] = null; // pending
      llm.reskinChainStep(state, content, s.def, s.step).then((t) => { if (t) chainNarr[s.key] = t; }).catch(() => {});
    }
  }
  if (cfg.specP > 0 && !_specialBusy && state.prioritySpecialYear !== state.year && !(state.prioritySpecialQueue || []).length && state.rng() < cfg.specP) {
    _specialBusy = true;
    llm.generateSpecialEvent(state, content).then((card) => queuePrioritySpecial(card)).catch(() => {}).finally(() => { _specialBusy = false; });
  }
}

function takePrioritySpecial() {
  if (state.prioritySpecialYear === state.year) return null;
  const q = state.prioritySpecialQueue || [];
  while (q.length) {
    const card = q.shift();
    if (!events.isEligible(state, card)) continue;
    state.prioritySpecialYear = state.year;
    return card;
  }
  return null;
}

function coreItems(summary) { return (summary || []).filter((s) => s.type === 'core'); }
function refreshPanels(flashItems) { ui.renderTopbar(state, simmeringSummary()); ui.renderStatus(state, content, flashItems || null); renderPeoplePanel(); }
function renderPeoplePanel() {
  if (!selectedPersonId || !state.people.find((p) => p.id === selectedPersonId && p.alive)) selectedPersonId = (state.people.find((p) => p.alive) || {}).id;
  ui.renderPeople(state, {
    selectedId: selectedPersonId,
    onSelect: (id) => {
      selectedPersonId = id;
      const p = state.people.find((x) => x.id === id);
      if (p) ui.openOverlay(ui.renderPersonProfile(p, buildPersonStatus(p)));
    },
  });
}

function simmeringSummary() {
  const titles = chains.activeChainTitles(state, content);
  if (titles.length >= 2) return `“${titles[0]}”与“${titles[1]}”同时压在桌面下。`;
  if (titles.length === 1) return `“${titles[0]}”还没有自行消失。`;
  const i = state.ind;
  if (i.finance < 24) return '财政部的回函越来越短，等钱的人越来越多。';
  if (i.army < 28 || i.army > 78) return '军营里的口径开始与官邸不太一致。';
  if (i.elite < 30 || i.elite > 78) return '几位大人物在等别人先说错话。';
  if (i.morale < 28 || i.morale > 80) return '街面上的声音比简报里写得更整齐。';
  if (i.intl < 22 || i.intl > 80) return '使馆区的灯和记者的镜头都不太寻常。';
  if (i.health < 55) return '秘书处开始微调您的公开行程。';
  if (state.year >= state.budgetDueYear - 1) return '下一轮分配临近，各方已经开始试探。';
  return '官邸暂时安静，文件夹仍在慢慢变厚。';
}

async function gameLoop() { while (!state.over) await nextCard(); finishGame(); }

async function nextCard() {
  bgPrep();
  if (state.year >= state.budgetDueYear) {
    chains.tryActivateChain(state, content); // 财政年作为事件链编排节点
    bgPrep(); // 后台并行准备，不阻塞玩家
    await presentBudget();
    state.budgetDueYear = state.year + 3;
    return afterCard();
  }
  if (state.chainJustActivated) { const info = state.chainJustActivated; state.chainJustActivated = null; await presentCard(chains.makeChainAnnounceCard(info)); return afterCard(); }
  const warnings = crisisWarningsForCard();
  if (warnings.length) { prefetchCrisisChains(warnings); await presentCard(crisisCard(warnings)); return afterCard(); }

  let card = null;
  card = chains.drawChainCard(state, content, chainNarr);
  if (!card) card = takePrioritySpecial();
  if (!card) { await ensureNormalCardReady(); card = events.drawOne(state, content); }
  if (!card) { engine.makeEnding(state, 'natural'); return; }
  await presentCard(card);
  await afterCard();
}

async function afterCard() {
  state.cardsThisYear++;
  if (state.cardsThisYear >= state.yearLength) {
    if (annualAdvisorDue()) await presentAnnualAdvisorCard();
    yearTick();
  }
}
function yearTick() {
  engine.annualHealthDecay(state);
  engine.annualDrift(state);
  chains.tryActivateChain(state, content);
  bgPrep();
  const ending = engine.checkCrises(state);
  refreshPanels();
  if (state.flags.somethingNoReturn) { ui.toast('有些事情，已经无法回头。'); state.flags.somethingNoReturn = false; }
  if (ending || state.over) return;
  if (state.year >= state.maxYears) { engine.makeEnding(state, 'natural'); return; }
  state.year++; state.cardsThisYear = 0; state.chainCardsThisYear = 0; state.yearLength = 3 + Math.floor(state.rng() * 3);
  advisorPrefetchYear = 0; advisorPrefetch = {};
  refreshPanels();
}

function annualAdvisorDue() {
  return state.lastDeepContactYear !== state.year && state.people.some((p) => p.alive);
}

function nextYearAfterThisCard() {
  return state.cardsThisYear + 1 >= state.yearLength && !annualAdvisorDue();
}

function maybePrefetchAdvisorForYear() {
  if (state.cardsThisYear + 1 >= state.yearLength && annualAdvisorDue()) {
    prefetchAdvisorPacks();
    maybePrefetchSituationChain();
  }
}
function ensureGeneratedChainState() {
  if (!state.chainStats) state.chainStats = { preparedStarted: 0, generatedStarted: 0, generatedCalls: 0 };
  if (state.chainStats.generatedCalls == null) state.chainStats.generatedCalls = 0;
  if (!state.generatedChainPrefetch) state.generatedChainPrefetch = { situationYears: [], crisisYears: {} };
  if (!Array.isArray(state.generatedChainPrefetch.situationYears)) state.generatedChainPrefetch.situationYears = [];
  if (!state.generatedChainPrefetch.crisisYears) state.generatedChainPrefetch.crisisYears = {};
}
function canGenerateChain() {
  ensureGeneratedChainState();
  return llm.isAvailable() && !state.over && state.chainStats.generatedCalls < MAX_GENERATED_CHAINS_PER_RUN;
}
function reserveGeneratedChainCall() {
  ensureGeneratedChainState();
  state.chainStats.generatedCalls += 1;
}
function shouldPrefetchSituationChain() {
  return annualAdvisorDue() && state.year > 1 && state.year + 1 === state.budgetDueYear;
}
function maybePrefetchSituationChain() {
  if (!shouldPrefetchSituationChain() || _situationChainBusy || !canGenerateChain()) return;
  if (state.generatedChainPrefetch.situationYears.includes(state.year)) return;
  state.generatedChainPrefetch.situationYears.push(state.year);
  reserveGeneratedChainCall();
  _situationChainBusy = true;
  llm.generateEventChain(state, content, { kind: 'situation' })
    .then((chain) => { if (chain && !state.over) chains.registerGeneratedChain(state, chain); })
    .catch(() => {})
    .finally(() => { _situationChainBusy = false; });
}
function crisisTrigger(w) {
  const t = { minYear: state.year };
  const set = (key, suffix, value) => { t[`${key}${suffix}`] = value; };
  if (w.key === 'army') w.side === 'low' ? set('army', 'Max', 20) : set('army', 'Min', 84);
  else if (w.key === 'elite') w.side === 'low' ? set('elite', 'Max', 22) : set('elite', 'Min', 84);
  else if (w.key === 'morale') w.side === 'low' ? set('morale', 'Max', 18) : set('morale', 'Min', 85);
  else if (w.key === 'intl') w.side === 'low' ? set('intl', 'Max', 14) : set('intl', 'Min', 84);
  else if (w.key === 'finance' && w.side === 'low') set('finance', 'Max', 15);
  else return null;
  return t;
}
function prefetchCrisisChains(warnings) {
  if (!canGenerateChain()) return;
  ensureGeneratedChainState();
  for (const w of Array.isArray(warnings) ? warnings : [warnings]) {
    if (!canGenerateChain()) return;
    const key = `${w.key}:${w.side}`;
    const last = state.generatedChainPrefetch.crisisYears[key] || 0;
    if (_crisisChainBusy[key] || (last && state.year - last < 2)) continue;
    const trigger = crisisTrigger(w);
    if (!trigger) continue;
    state.generatedChainPrefetch.crisisYears[key] = state.year;
    reserveGeneratedChainCall();
    _crisisChainBusy[key] = true;
    llm.generateEventChain(state, content, { kind: 'crisis', warning: w, crisisKey: key, trigger })
      .then((chain) => { if (chain && !state.over) chains.registerGeneratedChain(state, chain); })
      .catch(() => {})
      .finally(() => { delete _crisisChainBusy[key]; });
  }
}

function crisisWarningsForCard() {
  if (state.crisisNoticeYear === state.year) return [];
  const all = engine.dangerWarnings(state);
  if (!all.length) return [];
  const finals = all.filter((w) => w.level === 'final');
  return finals.length ? finals : all;
}

function crisisLine(w) {
  const key = `${w.key}:${w.side}:${w.level}`;
  const lines = {
    'army:low:warn': '卫队长私下问，军营里的抱怨是不是还算抱怨。',
    'army:low:final': '换岗名单被人反复核对，几名军官开始绕开总统府接电话。',
    'army:high:warn': '将军们把作战会议排在内阁会议前面，秘书处没人敢提醒。',
    'army:high:final': '卫队请示命令时，先看参谋部的回函，再看您的批示。',
    'elite:low:warn': '一位部长带着家眷“短假”出境，秘书没有把返程日期写上。',
    'elite:low:final': '晚宴座次被临时改了三次，真正该来的人都说身体不适。',
    'elite:high:warn': '几位大人物在您到场前已经分完议程，只等您签字。',
    'elite:high:final': '财政、媒体和任命名单在同一张便笺上流转，便笺没有送进您的书房。',
    'morale:low:warn': '近侍说，市场里的沉默比口号更难听。',
    'morale:low:final': '街口的警察开始成对退后，人群却第一次朝同一个方向移动。',
    'morale:high:warn': '宣传部长承认，群众喊出的口号已经比命令更快。',
    'morale:high:final': '拥戴者在替您清点敌人，也在替您决定谁还配忠诚。',
    'intl:low:warn': '外交秘书递来的电报越来越短，边境电话却越来越久没人接。',
    'intl:low:final': '银行、码头和邻国使馆同时变冷，部长们开始问备用护照。',
    'intl:high:warn': '基金会、观察团和外国记者突然知道该敲哪一扇门。',
    'intl:high:final': '外宾的日程排在内阁前面，连反对派的声明都像提前校过稿。',
    'finance:low:warn': '财务秘书把欠款名单压在文件夹最底下，还是露出了军营的抬头。',
    'finance:low:final': '欠饷、欠薪和欠账在同一天催来，卫队听见了财政部的沉默。',
  };
  return lines[key] || w.text;
}

function crisisCard(warnings) {
  const list = Array.isArray(warnings) ? warnings : [warnings];
  const final = list.some((w) => w.level === 'final');
  const many = list.length > 1;
  return {
    id: `warning_${list.map((w) => w.token).join('_')}`,
    type: 'notify',
    kicker: final ? '危局' : '警讯',
    title: many ? (final ? '多线危机逼近' : '多处异样同时浮现') : list[0].title,
    narrative: list.map(crisisLine).join('\n') + (many
      ? `\n\n这些信号来自不同房间，却指向同一个结论：今年不能再把它们当作例行噪音。`
      : ''),
    options: [{
      text: final ? '让所有人立刻回报' : (many ? '让秘书处合并登记' : '让秘书处登记风险'),
      result: final ? '几份回报被锁进同一个抽屉。' : '风险被记入本年备忘。',
      effects: {},
    }],
    onResolve: (st) => {
      for (const w of list) {
        engine.markDangerWarning(st, `${w.key}:${w.side}:warn`);
        engine.markDangerWarning(st, `${w.key}:${w.side}:final`);
      }
      st.crisisNoticeYear = st.year;
    },
  };
}

function presentCard(card) {
  return new Promise((resolve) => {
    events.rememberShown(state, card);
    const disp = events.substCard(state, card);
    ui.renderCard(disp, {
      onChoose: (i) => {
        const willTick = nextYearAfterThisCard();
        const { resultText, summary } = events.resolveOption(state, card, i);
        if (card.onResolve) card.onResolve(state, i);
        refreshPanels(coreItems(summary));
        maybePrefetchAdvisorForYear();
        ui.renderResult(resultText, summary, resolve, { nextYear: willTick });
      },
    });
  });
}
function presentBudget() {
  return new Promise((resolve) => {
    ui.renderBudget(state, (alloc) => {
      const willTick = nextYearAfterThisCard();
      const { summary } = engine.applyBudget(state, alloc);
      refreshPanels(coreItems(summary));
      maybePrefetchAdvisorForYear();
      ui.renderResult('预算已拨付，各方各取所需。', summary, resolve, { nextYear: willTick });
    });
  });
}

function presentAnnualAdvisorCard() {
  return new Promise((resolve) => {
    const alive = state.people.filter((p) => p.alive);
    if (!alive.length) { state.lastDeepContactYear = state.year; resolve(); return; }
    if (!selectedPersonId || !alive.find((p) => p.id === selectedPersonId)) selectedPersonId = alive[0].id;
    prefetchAdvisorPacks();
    maybePrefetchSituationChain();

    const showSummon = () => {
      ui.renderAdvisorSummonCard(state, {
        selectedId: selectedPersonId,
        statusFor: buildPersonStatus,
        onSelect: (id) => { selectedPersonId = id; showSummon(); },
        onEngage: async (person) => {
          const pack = await advisorPackFor(person);
          showAdvisorOptions(person, pack, resolve);
        },
      });
    };
    showSummon();
  });
}

function prefetchAdvisorPacks() {
  if (!llm.isAvailable() || !state || state.over) return;
  if (advisorPrefetchYear !== state.year) { advisorPrefetchYear = state.year; advisorPrefetch = {}; }
  for (const person of state.people.filter((p) => p.alive)) {
    if (advisorPrefetch[person.id]) continue;
    const entry = { done: false, pack: null, promise: null };
    entry.promise = llm.advisorOptions(state, content, person)
      .then((pack) => pack || offlineAdvisorOptions(person))
      .catch(() => offlineAdvisorOptions(person))
      .then((pack) => { entry.pack = pack; return pack; })
      .finally(() => { entry.done = true; });
    advisorPrefetch[person.id] = entry;
  }
}

async function advisorPackFor(person) {
  if (advisorPrefetchYear !== state.year) { advisorPrefetchYear = state.year; advisorPrefetch = {}; }
  const entry = advisorPrefetch[person.id];
  if (!entry) return loadAdvisorPack(person);
  if (entry.done) return entry.pack || offlineAdvisorOptions(person);
  const stop = ui.showLoading(LOADING.advisor(person.name));
  try { return (await entry.promise) || offlineAdvisorOptions(person); }
  finally { stop(); }
}

async function loadAdvisorPack(person) {
  let pack = null;
  if (llm.isAvailable()) {
    const stop = ui.showLoading(LOADING.advisor(person.name));
    try { pack = await llm.advisorOptions(state, content, person); } catch { pack = null; }
    stop();
    if (!pack) ui.toast('叙事联网中断，改用规则兜底');
  }
  return pack || offlineAdvisorOptions(person);
}

function showAdvisorOptions(person, pack, resolveYear) {
  ui.renderAdvisorActionCard(person, pack, {
    canReshuffle: state.advisorReshuffleUsedYear !== state.year,
    onReshuffle: async () => {
      state.advisorReshuffleUsedYear = state.year;
      const nextPack = await loadAdvisorPack(person);
      showAdvisorOptions(person, nextPack, resolveYear);
    },
    onChoose: (opt) => {
      state.lastDeepContactYear = state.year;
      const { narrative, clue, summary } = engine.applyAdvisorCommand(state, person, opt);
      state.archive.push({ year: state.year, title: `私下接触 · ${person.name}`, result: opt.label || opt.kind || '密谈' });
      refreshPanels(coreItems(summary));
      ui.renderAdvisorCardResult(person, { reveal: opt.reveal, narrative, clue, summary }, resolveYear);
    },
  });
}

// ---- 关键人物 ------------------------------------------------------------
function buildPersonStatus(person) {
  const sig = engine.loyaltySignal(person.loyalty), csig = engine.competenceSignal(person.competence);
  const lines = [
    { loyal: '近来对您言听计从，公开场合言必称颂。', ok: '公事公办，态度无可挑剔，也无从深究。', uneasy: '近来推诿渐多，有几次会议称病未到。', danger: '与一些您不愿他接触的人，往来频繁。' }[sig],
    { high: '手腕老练，交办之事总能办成——无论用什么手段。', mid: '能力中规中矩，交办的事大抵办得下来。', low: '办事拖沓，时常误事。' }[csig],
  ];
  const present = new Set(state.people.filter((p) => p.alive).map((p) => p.id));
  const ally = (person.allies || []).map((id) => state.people.find((p) => p.id === id && present.has(id))).filter(Boolean)[0];
  const rival = (person.rivals || []).map((id) => state.people.find((p) => p.id === id && present.has(id))).filter(Boolean)[0];
  if (ally) lines.push(`与${ally.name}走得很近。`);
  if (rival) lines.push(`与${rival.name}素来不和。`);
  if (person.memory.length) lines.push(`您还记得：${person.memory[person.memory.length - 1].note}`);
  return lines;
}

function advisorFocus(person) {
  return ({
    general: 'army', finance: 'finance', chief: 'elite', firstlady: 'elite', priest: 'morale',
    chen: 'finance', dupont: 'intl', spy: 'elite', reformer: 'morale', uncle: 'elite',
  })[person.id] || 'elite';
}

function advisorReveal(person, focus, fidelity) {
  const warped = fidelity === 'feigned' || fidelity === 'betrayal';
  const truthful = {
    army: '军营里真正不满的不是口号，而是补给、军衔和谁能分到下一批进口车。',
    elite: '几位大人物最近互相试探得很频繁，没人愿意第一个公开站错队。',
    morale: '街头的怨气还没有统一旗号，但菜价、警察和宣传口径正在把它们拧到一起。',
    intl: '外部压力不是一股绳：有人要制裁，有人要交易，也有人只想找一个听话的中间人。',
    finance: '账面还能遮掩，真正危险的是欠款名单开始同时出现在军营和部委。',
    health: '御医说得很含糊，但秘书处已经开始调整您的公开行程。',
  }[focus] || '他递来的消息看似琐碎，却能拼出几个人的真实站位。';
  const crooked = {
    army: '他声称军中只有小小牢骚，却刻意漏掉了几个正在串门的营长。',
    elite: '他把矛头指向一个方便牺牲的人，真正写支票的人却没有出现在纸上。',
    morale: '他把街头说成一场误会，报告里却避开了市场和教堂附近的传言。',
    intl: '他只递上对您有利的外国剪报，没提那些闭门会议的名单。',
    finance: '他把亏空说成技术问题，却对几笔亲友公司的款项轻描淡写。',
    health: '他把医生的话修饰得很体面，像是在替所有人争取时间。',
  }[focus] || '他说得很顺，但顺得像是早就排练过。';
  return warped ? crooked : truthful;
}

function pickAdvisorFidelity(person, pressure = 0) {
  const allowed = engine.allowedFidelities(person);
  if (allowed.includes('betrayal') && state.rng() < 0.32 + pressure) return 'betrayal';
  if (allowed.includes('feigned') && state.rng() < 0.38 + pressure) return 'feigned';
  if (allowed.includes('discounted') && state.rng() < 0.26 + pressure) return 'discounted';
  return allowed[0] || 'faithful';
}

function offlineAdvisorOptions(person) {
  const focus = advisorFocus(person);
  const sig = engine.loyaltySignal(person.loyalty);
  const comp = engine.competenceSignal(person.competence);
  const posture = { loyal: '他来得很快，连随从都没带。', ok: '他坐下时很平静，话说得滴水不漏。', uneasy: '他先看了看门，又看了看窗。', danger: '他答应得很客气，眼神却一直避开您。' }[sig];
  const probeF = pickAdvisorFidelity(person, 0.04);
  const buyF = pickAdvisorFidelity(person, -0.06);
  const pressF = pickAdvisorFidelity(person, 0.08);
  const trustF = pickAdvisorFidelity(person, -0.02);
  const auditF = pickAdvisorFidelity(person, 0.03);
  const testF = pickAdvisorFidelity(person, 0.06);
  const options = [
    {
      kind: '探听', label: '让他递一份实话', fidelity: probeF,
      reveal: advisorReveal(person, focus, probeF),
      public_narrative: '他低声汇报了几件“还不宜写进文件”的小事。',
      foreshadow_clue: probeF === 'faithful' ? '' : '（他离开前，把随身记事本中间几页撕得很干净。）',
      proposed_effects: comp === 'high' ? { [focus]: '+small' } : {},
      hidden_effects: { elite: '-small' },
      memory_note: `${person.name}递过一份私下消息，真假还有待回看。`,
    },
    {
      kind: '拉拢', label: '给他一点甜头', fidelity: buyF,
      reveal: '', public_narrative: '他收下您的暗示，承诺会把该稳住的人稳住。',
      foreshadow_clue: buyF === 'faithful' ? '' : '（他感谢得太快，像是早就知道您会开这个价。）',
      proposed_effects: { loyalty: { [person.id]: '+mid' }, wealth: -0.25 },
      hidden_effects: { finance: '-small' },
      memory_note: `${person.name}接受过一次私下安抚。`,
    },
    {
      kind: '敲打', label: '逼他立刻办事', fidelity: pressF,
      reveal: '', public_narrative: '他当场点头，把责任接了过去。',
      foreshadow_clue: pressF === 'faithful' ? '' : '（他出门时对秘书说了一句很轻的话，秘书没有记进会议纪要。）',
      proposed_effects: { [focus]: '+mid', loyalty: { [person.id]: '-small' } },
      hidden_effects: { elite: '-small', finance: '-small' },
      memory_note: `${person.name}被您当面敲打过。`,
    },
    {
      kind: '委任', label: '把一件大事交给他', fidelity: trustF,
      reveal: '', public_narrative: '他沉默片刻，像是在估量这份信任的重量。',
      foreshadow_clue: trustF === 'faithful' ? '' : '（他没有立刻问目标，却先问了预算和人事名单。）',
      proposed_effects: { [focus]: '+big', loyalty: { [person.id]: '+small' } },
      hidden_effects: { elite: '-small', finance: '-small' },
      memory_note: `${person.name}被委以一件足以扩张影响的大事。`,
    },
    {
      kind: '暗查', label: '让人查他的账', fidelity: auditF,
      reveal: advisorReveal(person, focus, auditF),
      public_narrative: '安全局递来的材料不算厚，却足够让几个人睡不好。',
      foreshadow_clue: auditF === 'faithful' ? '' : '（材料的装订线很新，像是有人临时换过几页。）',
      proposed_effects: { elite: '+small', loyalty: { [person.id]: '-small' } },
      hidden_effects: { intl: '+small' },
      memory_note: `${person.name}曾被您暗中查过账。`,
    },
    {
      kind: '试探', label: '给他一件半真差事', fidelity: testF,
      reveal: advisorReveal(person, focus, testF),
      public_narrative: '他答应得恰到好处，既不热切，也不推辞。',
      foreshadow_clue: testF === 'faithful' ? '' : '（那件半真半假的差事，第二天就出现在了不该出现的谈话里。）',
      proposed_effects: { [focus]: '+small' },
      hidden_effects: { elite: '-small' },
      memory_note: `${person.name}被您用一件半真差事试探过。`,
    },
  ];
  return {
    intro: `${posture}（规则兜底）`,
    options: rngShuffle(state, options).slice(0, 3),
  };
}
async function engagePerson(person) {
  let pack = null;
  if (llm.isAvailable()) {
    const stop = ui.showLoading(LOADING.advisor(person.name));
    try { pack = await llm.advisorOptions(state, content, person); } catch { pack = null; }
    stop();
    if (!pack) ui.toast('叙事联网中断，改用规则兜底');
  }
  if (!pack) pack = offlineAdvisorOptions(person);
  renderAdvisorOptions(person, pack);
}
function renderAdvisorOptions(person, pack) {
  ui.openOverlay(ui.renderAdvisorOptions(person, pack, {
    canReshuffle: state.advisorReshuffleUsedYear !== state.year,
    onReshuffle: async () => {
      state.advisorReshuffleUsedYear = state.year;
      let p2 = null;
      if (llm.isAvailable()) {
        const stop = ui.showLoading(LOADING.advisor(person.name));
        try { p2 = await llm.advisorOptions(state, content, person); } catch { p2 = null; }
        stop();
      }
      renderAdvisorOptions(person, p2 || offlineAdvisorOptions(person));
    },
    onChoose: (opt) => {
      state.lastDeepContactYear = state.year; // 选定动作才消耗当年机会
      const { narrative, clue, summary } = engine.applyAdvisorCommand(state, person, opt);
      state.archive.push({ year: state.year, title: `私下接触 · ${person.name}`, result: opt.label || opt.kind || '密谈' });
      refreshPanels(coreItems(summary));
      ui.renderAdvisorOutcome(person, { reveal: opt.reveal, narrative, clue, summary });
    },
  }));
}

// ---- 结局 ----------------------------------------------------------------
async function finishGame() {
  if (state.ending && state.ending.type === 'natural') {
    if (state.hidden.heir && state.hidden.legacy >= 50) state.flags.heirSucceeded = true;
    else if (!state.hidden.heir && state.hidden.legacy < 40) state.flags.civilWar = true;
  }
  detectAchievements(state);
  let obituary = null;
  if (llm.isAvailable()) { const stop = ui.showLoading(LOADING.obituary); try { obituary = await llm.generateObituary(state, content, engine.computeScore(state)); } catch {} stop(); }
  if (!obituary) obituary = buildObituaryFallback();
  ui.renderEnding(state, engine.computeScore(state), obituary);
}
function detectAchievements(state) {
  const add = (k, n, p) => { if (!state.achievements.find((a) => a.key === k)) state.achievements.push({ key: k, name: n, points: p }); };
  if (state.year >= 15) add('long15', '执政超过十五年', 100);
  if (state.year >= 25) add('long25', '统治长达四分之一世纪', 180);
  if (state.flags.currencyNamed) add('currency', '货币以您命名', 150);
  if (!state.flags.stagedElection && !state.flags.realElection) add('noelection', '从未举行过一场选举', 80);
  if (state.flags.heirSucceeded) add('dynasty', '子孙继续执政', 300);
  if (state.ind.intl >= 70 || state.sanctioned) add('amnesty', '国际特赦组织专题报告的主角', 50);
  if (state.wealth.overseas >= 5) add('swiss', '苏黎世银行的终身贵宾', 80);
  if (state.annexedRegions.length >= 2) add('expansion', '开疆拓土的征服者', 120);
  if (state.hidden.historyNarrative >= 75) add('legend', '被后世神化的传奇', 150);
  if (state.hidden.historyNarrative <= 20) add('infamy', '被钉上历史耻辱柱', 0);
  if (state.ending && state.ending.naturalPeaceful) add('peaceful', '死在自己的床上', 120);
}
function buildObituaryFallback() {
  const e = state.ending, yrs = state.year, who = state.leader.name;
  const fates = {
    natural: `${who}在位${yrs}年后于官邸辞世，享年${leaderAge(state)}岁。`,
    coup: `${who}的统治在第${yrs}年的一个夜晚结束——坦克开进了首都。`,
    assassination: `第${yrs}年，${who}在一场私人宴会后猝然离世，死因从未公布。`,
    junta: `第${yrs}年，坐大的军方"请"${who}退居二线，从此再没出现在公开场合。`,
    puppet: `${who}的晚年只剩一个头衔，真正拍板的，是那几位富可敌国的大人。`,
    uprising: `第${yrs}年，愤怒的人群涌进了官邸，${who}没能走到直升机旁。`,
    frenzy: `${who}亲手点燃的狂热，最终把他自己也吞了进去。`,
    collapse: `承认一项项撤回，制裁一层层加码，${who}的政权在孤立中悄然垮塌。`,
    mutiny: `欠饷的军队哗变了。第${yrs}年，${who}才明白，枪是要花钱喂的。`,
    tribunal: `第${yrs}年，外部观察团、基金会和街头运动把局势推到临界点，${who}最终在海牙的法庭上听完了对自己的指控。`,
    arrested: `第${yrs}年，${who}沦为阶下囚，据说在牢中染病而终。`,
    exile: `第${yrs}年，${who}带着几只行李箱登上了流亡的专机。`,
    accident: `第${yrs}年，${who}死于一场谁也没料到的意外——历史有时荒诞得很。`,
    eliteCollapse: `众叛亲离之下，${who}于第${yrs}年仓促交出了权力。`,
    guardDefection: `第${yrs}年，官邸卫队换岗后没有再听命于${who}。大门从里面打开了。`,
    warlordBreakaway: `几个军区同时宣布“暂行自治”。${who}的命令传出首都后，已没人负责执行。`,
    commanderRegency: `总司令以稳定为名接管国政，${who}被请到主席台中央，也只剩坐着的职责。`,
    barracksArrest: `第${yrs}年，${who}被带往城外军营休养。休养期没有结束日期。`,
    palaceCoup: `宫门在夜里换了锁。第二天，${who}的名字仍在新闻里，却不再出现在命令末尾。`,
    cabinetUltimatum: `内阁带着辞呈和保证书走进官邸。${who}签下的最后一份文件，是自己的退场。`,
    oligarchRegency: `几位大人物成立了“国家稳定委员会”，${who}的印章被留在他们桌上。`,
    corporateTakeover: `银行、矿业和媒体同时换了口径。${who}没有被废黜，只是再也没有预算。`,
    rubberStamp: `${who}继续签字，文件继续生效。区别在于，文件从此不再由他起草。`,
    capitalSiege: `首都被围了三天三夜。第${yrs}年，官邸的灯先于人群熄灭。`,
    provisionalArrest: `临时政府接管广播后宣布逮捕${who}。这一次，播音员没有念错名字。`,
    squareTrial: `广场临时搭起审判台。${who}听完判词时，官邸的旗已经被换下。`,
    loyaltyPurge: `拥戴者开始替${who}清洗不够忠诚的人，最后连他本人也未能通过审查。`,
    idolBacklash: `画像、口号和誓词把${who}举得太高。神像倒下时，没有人敢伸手接。`,
    borderClosure: `邻国关闭边境，港口停止放行。${who}的政权没有爆炸，只是慢慢缺氧。`,
    sanctionStrangle: `制裁名单越拉越长，银行账户一个个失声。第${yrs}年，政权在账面上先死了一次。`,
    foreignProtectorate: `外部调停团进驻首都，宣布“临时托管”。${who}被要求配合历史安排。`,
    observerTakeover: `观察团从旁听席走到主席台，${who}才明白，监督有时只是接管的礼貌说法。`,
    bankruptcy: `国库正式破产。第${yrs}年，${who}发现国家机器也会因为付不起账单而停转。`,
    creditorTakeover: `债主们带着合同进宫，接管关税、矿权和广播。${who}被留下负责微笑。`,
    blackMarketTurn: `黑市商人停止给官邸供货，转而资助另一批人。忠诚换了结算方式。`,
    financeMinisterFlight: `财政部长先一步消失，账本也一起不见。${who}直到最后才知道国库早已空了。`,
    militaryBankruptcy: `军饷、燃油和口粮同时断供。第${yrs}年，军队不是造反，而是来讨账。`,
    foreignBackedCouncil: `街头、基金会和观察团共同推举过渡委员会，${who}被请去见证自己的缺席。`,
    oligarchDefault: `寡头们拒绝再替官邸垫钱。${who}的统治在一串坏账里到期。`,
  };
  const folk = `${fates[e.type] || ''}人们对其评价两极：有人记得通车的大道，也有人记得那些再没回家的人。${state.annexedRegions.length ? `在其治下，${state.nationShort}的版图扩大了。` : ''}历史学家们至今争论不休。`;
  const official = state.biographyCommissioned ? `伟大的${who}领导${state.nation}走过了${yrs}个光辉的年头。在其英明治理下，国家空前团结、繁荣、安定。人民永远怀念这位慈父般的领袖。` : null;
  return { folk, official, quote: '权力不会辜负懂得它的人。' };
}

const LOADING = {
  boot: ['幕僚们正在为新主子拟定卷宗……', '各方势力正在打探您的底细……', '官邸的钟摆，计时还是倒计时……', '稍等片刻，有人将呈上第一份密报……'],
  budget: ['财政部正在核账……', '正在筹备本年政务……', '大人们都在等着分这块饼……'],
  obituary: ['史官们正在落笔……', '官方与民间，正在争夺同一段历史……'],
  advisor: (name) => [`${name}正斟酌着措辞……`, `${name}也给自己留了个心眼……`, '茶续了一杯，话还没说到点上……'],
};

applyRandomTheme();
boot();
