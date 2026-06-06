// Minimal zero-dependency dev server for 《最后的统治者》.
//
//   - Serves the static front-end (so ES modules + JSON fetch work over http://).
//   - Proxies POST /api/llm -> DeepSeek (OpenAI-compatible), injecting the API key
//     from .env.local so the key never reaches the browser.
//
// Run:  node server.js   (or: npm start)
//
// This is intentionally tiny. To turn it into the "sharing backend" later, add
// rate-limiting / auth around the /api/llm handler and deploy as-is.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- tiny .env.local loader (no dependency) ------------------------------
function loadEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}
const env = { ...loadEnv(path.join(__dirname, '.env.local')), ...process.env };

const PORT = Number(env.PORT) || 5173;
const LLM_API_KEY = env.LLM_API_KEY || '';
const LLM_BASE_URL = (env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const LLM_MODEL = env.LLM_MODEL || 'deepseek-chat';
const LLM_FORMAT = (env.LLM_FORMAT || 'openai').toLowerCase(); // openai | anthropic

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-cache', ...headers });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// ---- LLM proxy -----------------------------------------------------------
// Front-end posts { messages, temperature?, max_tokens?, response_format?, model? }.
// We forward to the OpenAI-compatible /chat/completions endpoint.
// 双格式适配：前端可在请求体里传 apiKey/baseUrl/format/model，覆盖 .env.local 默认。
async function handleLLM(req, res) {
  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch { return send(res, 400, JSON.stringify({ error: 'bad_json' }), { 'Content-Type': 'application/json' }); }

  const apiKey = payload.apiKey || LLM_API_KEY;
  const baseUrl = (payload.baseUrl || LLM_BASE_URL).replace(/\/$/, '');
  const format = (payload.format || LLM_FORMAT).toLowerCase();
  const model = payload.model || LLM_MODEL;
  if (!apiKey) return send(res, 503, JSON.stringify({ error: 'no_api_key' }), { 'Content-Type': 'application/json' });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const out = format === 'anthropic'
      ? await callAnthropic(baseUrl, apiKey, model, payload, controller.signal)
      : await callOpenAI(baseUrl, apiKey, model, payload, controller.signal);
    send(res, out.status, out.body, { 'Content-Type': 'application/json' });
  } catch (err) {
    const code = err.name === 'AbortError' ? 'timeout' : 'upstream_unreachable';
    send(res, 502, JSON.stringify({ error: code, detail: String(err.message || err) }), { 'Content-Type': 'application/json' });
  } finally { clearTimeout(timeout); }
}

async function callOpenAI(baseUrl, apiKey, model, payload, signal) {
  const upstream = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, messages: payload.messages,
      temperature: payload.temperature ?? 0.9, max_tokens: payload.max_tokens ?? 1200,
      ...(payload.response_format ? { response_format: payload.response_format } : {}), stream: false,
    }),
    signal,
  });
  return { status: upstream.status, body: await upstream.text() };
}

// Anthropic Messages API：system 顶层、合并同角色、JSON 用 assistant 预填 '{'，再整形回 OpenAI 形状。
async function callAnthropic(baseUrl, apiKey, model, payload, signal) {
  const sys = (payload.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const msgs = [];
  for (const m of (payload.messages || []).filter((m) => m.role !== 'system')) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (msgs.length && msgs[msgs.length - 1].role === role) msgs[msgs.length - 1].content += '\n\n' + m.content;
    else msgs.push({ role, content: m.content });
  }
  const wantJson = payload.response_format && payload.response_format.type === 'json_object';
  if (wantJson) msgs.push({ role: 'assistant', content: '{' });
  const upstream = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, system: sys, messages: msgs, max_tokens: payload.max_tokens ?? 1200, temperature: payload.temperature ?? 0.9 }),
    signal,
  });
  if (!upstream.ok) return { status: upstream.status, body: await upstream.text() };
  const data = await upstream.json();
  let text = (data.content || []).map((b) => b.text || '').join('');
  if (wantJson && !text.trimStart().startsWith('{')) text = '{' + text;
  return { status: 200, body: JSON.stringify({ choices: [{ message: { content: text } }] }) };
}

// ---- static files --------------------------------------------------------
async function handleStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  // prevent path traversal
  const full = path.normalize(path.join(__dirname, rel));
  if (!full.startsWith(__dirname)) return send(res, 403, 'Forbidden');
  try {
    const s = await stat(full);
    if (s.isDirectory()) return send(res, 403, 'Forbidden');
    const data = await readFile(full);
    send(res, 200, data, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  } catch {
    send(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/llm') return handleLLM(req, res);
  if (req.method === 'GET' && req.url === '/api/health') {
    return send(res, 200, JSON.stringify({ ok: true, llm: !!LLM_API_KEY, model: LLM_MODEL, format: LLM_FORMAT }), {
      'Content-Type': 'application/json',
    });
  }
  if (req.method === 'GET') return handleStatic(req, res, req.url);
  send(res, 405, 'Method not allowed');
});

server.listen(PORT, () => {
  console.log(`\n  《最后的统治者》dev server`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  LLM: ${LLM_API_KEY ? `${LLM_MODEL} via ${LLM_BASE_URL}` : 'DISABLED (no key) — game runs in offline/fallback mode'}\n`);
});
