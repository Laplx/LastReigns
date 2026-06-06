// 入口 / 编排：连续卡片流、年份自然流逝、预算降频、链显式化、私信、结局。

import * as ui from './ui.js';
import { createInitialState, leaderAge } from './state.js';
import * as engine from './engine.js';
import * as events from './events.js';
import * as chains from './chains.js';
import * as llm from './llm.js';
import { resetAtmosphere } from './atmosphere.js';

let content, state, selectedPersonId = null;
let chainNarr = {}, _bgBusy = false;
function lvlCfg() { const l = llm.llmLevel(); return l === 'low' ? { specP: 0, topup: 0, pre: [0, 0], reskin: false } : l === 'high' ? { specP: 0.20, topup: 14, pre: [6, 4], reskin: true } : { specP: 0.12, topup: 8, pre: [5, 4], reskin: true }; }

async function loadContent() {
  const j = (p) => fetch(p).then((r) => r.json());
  const [eventsD, people, chainsD, atmosphere, decorative, world] = await Promise.all([
    j('./data/events.json'), j('./data/people.json'), j('./data/chains.json'),
    j('./data/atmosphere.json'), j('./data/decorative.json'), j('./data/world.json'),
  ]);
  return events.prepareContent({ events: eventsD, people, chains: chainsD, atmosphere, decorative, world });
}

async function boot() {
  try { content = await loadContent(); }
  catch { document.getElementById('boot-foot').textContent = '资源加载失败，请用 npm start 启动后访问 http://localhost:5173'; return; }
  const health = await llm.checkHealth();
  if (health.llm) { ui.setNetStatus('online', `叙事联网：${health.model}`); document.getElementById('boot-foot').textContent = `叙事联网已就绪（${health.model}）`; }
  else { ui.setNetStatus('offline', '离线模式'); document.getElementById('boot-foot').textContent = '离线模式：预设叙事（可玩，但私信顾问需联网）'; }
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
    await llm.checkHealth();
    const foot = document.getElementById('boot-foot');
    if (llm.isAvailable()) { ui.setNetStatus('online', '叙事联网：' + llm.modelName()); if (foot) foot.textContent = `叙事联网已就绪（${llm.modelName()}）`; }
    else { ui.setNetStatus('offline', '离线'); if (foot) foot.textContent = '离线模式：预设叙事（可玩，但体验会大打折扣）'; }
  });
}

function showBriefing() {
  resetAtmosphere();
  const seed = (Date.now() ^ Math.floor(performance.now() * 1000)) >>> 0;
  state = createInitialState(seed, content);
  document.getElementById('boot').classList.add('hidden');
  ui.renderBriefing(state, startGame);
}

function addToPool(evs) {
  const titles = new Set([...content.events.map((e) => e.title), ...state.llmPool.map((e) => e.title)]);
  for (const e of evs) if (e && e.title && !titles.has(e.title)) { state.llmPool.push(e); titles.add(e.title); }
}
async function startGame() {
  ui.renderTopbar(state);
  // 开局利用等待时间，并行预生成一批本局专属题入池（带进度条）；数量随 AI 参与度
  const [chunks, per] = lvlCfg().pre;
  if (llm.isAvailable() && chunks > 0) {
    const prog = ui.showLoadingProgress(LOADING.boot);
    let done = 0; prog.set(0.04);
    const results = await Promise.all(Array.from({ length: chunks }, () =>
      llm.pregenEvents(state, content, per).then((r) => { done++; prog.set(done / chunks); return r; }).catch(() => [])
    ));
    addToPool(results.flat());
    prog.done();
  }
  refreshPanels();
  gameLoop();
}

// 后台并行准备（不阻塞）：D1a 题池补充（参考历史/状态）+ D1b 事件链节点叙事改写
function countFreshNormals() {
  const seen = new Set(state.seenEventIds); let c = 0;
  for (const e of content.events) if (e.type !== 'notify' && !seen.has(e.id)) c++;
  for (const e of state.llmPool) if (!seen.has(e.id)) c++;
  return c;
}
function bgPrep() {
  if (!llm.isAvailable()) return;
  const cfg = lvlCfg();
  if (cfg.reskin) {
    for (const s of chains.getActiveSteps(state, content)) {
      if (chainNarr[s.key] !== undefined) continue;
      chainNarr[s.key] = null; // pending
      llm.reskinChainStep(state, content, s.def, s.step).then((t) => { if (t) chainNarr[s.key] = t; }).catch(() => {});
    }
  }
  if (cfg.topup > 0 && !_bgBusy && countFreshNormals() < cfg.topup) {
    _bgBusy = true;
    llm.pregenEvents(state, content, 4).then((ev) => addToPool(ev)).catch(() => {}).finally(() => { _bgBusy = false; });
  }
}

function coreItems(summary) { return (summary || []).filter((s) => s.type === 'core'); }
function refreshPanels(flashItems) { ui.renderTopbar(state); ui.renderStatus(state, content, flashItems || null); renderPeoplePanel(); }
function renderPeoplePanel() {
  if (!selectedPersonId || !state.people.find((p) => p.id === selectedPersonId && p.alive)) selectedPersonId = (state.people.find((p) => p.alive) || {}).id;
  const canEngage = llm.isAvailable() && state.lastDeepContactYear !== state.year;
  const engageReason = !llm.isAvailable() ? '离线模式下无法私下深谈（需联网）。' : (state.lastDeepContactYear === state.year ? '今年您已私下接触过一位了。' : '');
  ui.renderPeople(state, {
    selectedId: selectedPersonId, statusFor: buildPersonStatus, canEngage, engageReason,
    onSelect: (id) => { selectedPersonId = id; renderPeoplePanel(); },
    onEngage: (p) => engagePerson(p),
  });
}

async function gameLoop() { while (!state.over) await nextCard(); finishGame(); }

async function nextCard() {
  if (state.year >= state.budgetDueYear) {
    chains.tryActivateChain(state, content); // 财政年作为事件链编排节点
    bgPrep(); // 后台并行准备，不阻塞玩家
    await presentBudget();
    state.budgetDueYear = state.year + 3;
    return afterCard();
  }
  if (state.chainJustActivated) { const info = state.chainJustActivated; state.chainJustActivated = null; await presentCard(chains.makeChainAnnounceCard(info)); return afterCard(); }

  let card = null;
  if (state.rng() < 0.55) card = chains.drawChainCard(state, content, chainNarr);
  if (!card && llm.isAvailable() && state.rng() < lvlCfg().specP) { const stop = ui.showLoading(LOADING.special); try { card = await llm.generateSpecialEvent(state, content); } catch { card = null; } stop(); }
  if (!card) card = events.drawOne(state, content);
  if (!card) { engine.makeEnding(state, 'natural'); return; }
  await presentCard(card);
  afterCard();
}

function afterCard() {
  state.cardsThisYear++;
  if (state.cardsThisYear >= state.yearLength) yearTick();
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
  state.year++; state.cardsThisYear = 0; state.yearLength = 3 + Math.floor(state.rng() * 3);
  refreshPanels();
}

function presentCard(card) {
  return new Promise((resolve) => {
    const disp = events.substCard(state, card);
    ui.renderCard(disp, {
      onChoose: (i) => {
        const willTick = state.cardsThisYear + 1 >= state.yearLength;
        const { resultText, summary } = events.resolveOption(state, card, i);
        if (card.onResolve) card.onResolve(state, i);
        refreshPanels(coreItems(summary));
        ui.renderResult(resultText, summary, resolve, { nextYear: willTick });
      },
    });
  });
}
function presentBudget() {
  return new Promise((resolve) => {
    ui.renderBudget(state, (alloc) => {
      const willTick = state.cardsThisYear + 1 >= state.yearLength;
      const { summary } = engine.applyBudget(state, alloc);
      refreshPanels(coreItems(summary));
      ui.renderResult('预算已拨付，各方各取所需。', summary, resolve, { nextYear: willTick });
    });
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
  const rival = (person.rivals || []).map((id) => state.people.find((p) => p.id === id && present.has(id))).filter(Boolean)[0];
  if (rival) lines.push(`与${rival.name}素来不和。`);
  if (person.memory.length) lines.push(`您还记得：${person.memory[person.memory.length - 1].note}`);
  return lines;
}
async function engagePerson(person) {
  const stop = ui.showLoading(LOADING.advisor(person.name));
  let pack; try { pack = await llm.advisorOptions(state, content, person); } catch { pack = null; }
  stop();
  if (!pack) { ui.toast('叙事联网中断，没能谈成'); return; }
  renderAdvisorOptions(person, pack);
}
function renderAdvisorOptions(person, pack) {
  ui.openOverlay(ui.renderAdvisorOptions(person, pack, {
    canReshuffle: state.advisorReshuffleUsedYear !== state.year,
    onReshuffle: async () => { state.advisorReshuffleUsedYear = state.year; const stop = ui.showLoading(LOADING.advisor(person.name)); let p2; try { p2 = await llm.advisorOptions(state, content, person); } catch { p2 = null; } stop(); if (p2) renderAdvisorOptions(person, p2); else ui.toast('一时半会儿，问不出别的了'); },
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
    collapse: `众叛亲离、外援断绝，${who}的政权在孤立中悄然垮塌。`,
    mutiny: `欠饷的军队哗变了。第${yrs}年，${who}才明白，枪是要花钱喂的。`,
    tribunal: `第${yrs}年，${who}在海牙的法庭上听完了对自己的指控。`,
    arrested: `第${yrs}年，${who}沦为阶下囚，据说在牢中染病而终。`,
    exile: `第${yrs}年，${who}带着几只行李箱登上了流亡的专机。`,
    accident: `第${yrs}年，${who}死于一场谁也没料到的意外——历史有时荒诞得很。`,
    eliteCollapse: `众叛亲离之下，${who}于第${yrs}年仓促交出了权力。`,
  };
  const folk = `${fates[e.type] || ''}人们对其评价两极：有人记得通车的大道，也有人记得那些再没回家的人。${state.annexedRegions.length ? `在其治下，${state.nationShort}的版图扩大了。` : ''}历史学家们至今争论不休。`;
  const official = state.biographyCommissioned ? `伟大的${who}领导${state.nation}走过了${yrs}个光辉的年头。在其英明治理下，国家空前团结、繁荣、安定。人民永远怀念这位慈父般的领袖。` : null;
  return { folk, official, quote: '权力不会辜负懂得它的人。' };
}

const LOADING = {
  boot: ['幕僚们正在为新主子拟定卷宗……', '各方势力正在打探您的底细……', '官邸的钟摆，开始为您计时……'],
  budget: ['财政部正在核账……', '正在筹备本年政务……', '大人们都在等着分这块饼……'],
  special: ['一份新的卷宗送到了案头……', '消息正在层层上报……'],
  obituary: ['史官们正在落笔……', '官方与民间，正在争夺同一段历史……'],
  advisor: (name) => [`${name}正斟酌着措辞……`, `${name}也给自己留了个心眼……`, '茶续了一杯，话还没说到点上……'],
};

boot();
