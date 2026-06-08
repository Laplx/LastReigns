// 区间 → 氛围词。池 + 防重复。联网时 llm.js 可用即兴句覆盖本模块输出。

import { rngInt } from './state.js?v=1.3.2';

const recent = {};
function pickFromPool(state, key, pool) {
  if (!pool || !pool.length) return '';
  if (pool.length === 1) return pool[0];
  const used = recent[key]; let idx, guard = 0;
  do { idx = rngInt(state, 0, pool.length - 1); } while (idx === used && guard++ < 6);
  recent[key] = idx; return pool[idx];
}

// { text, cls } —— cls ∈ '', 'tier-good', 'tier-warn', 'tier-crit'
export function coreMood(state, content, key) {
  const val = state.ind[key];
  const tiers = content.atmosphere.core[key];
  let tier = tiers[tiers.length - 1];
  for (const t of tiers) { const lo = t.min ?? 0, hi = t.max ?? 100; if (val >= lo && val <= hi) { tier = t; break; } }
  const clsMap = { good: 'tier-good', warn: 'tier-warn', crit: 'tier-crit', '': '' };
  return { text: pickFromPool(state, key, tier.pool), cls: clsMap[tier.cls] ?? '' };
}

// 装饰指标 3 档标签
export function decoLabel(content, key, value) {
  const def = content.atmosphere.deco[key];
  if (!def) return '';
  const v = key === 'press' ? 100 - value : value; // 媒体自由反向
  return v >= 60 ? def.labels[0] : v >= 35 ? def.labels[1] : def.labels[2];
}
// 装饰指标三色：good / mid / bad（独裁者视角，press 已反向）
export function decoColor(key, value) {
  const v = key === 'press' ? 100 - value : value;
  return v >= 60 ? 'good' : v >= 35 ? 'mid' : 'bad';
}

export function resetAtmosphere() { for (const k of Object.keys(recent)) delete recent[k]; }
