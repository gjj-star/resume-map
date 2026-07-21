// Resume Map · V2 轻后端（Node 内置模块，零依赖）
// 职责：托管静态文件 + /api/analyze（简历+岗位→评估）+ /api/compare（双引擎并跑）+ /api/jd-parse（JD→维度库）
// 安全红线：密钥只在后端，绝不进前端；无 Key / 模型失败 → 降级规则引擎，保证不空场。
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { analyze, ROLE_LIB, normalizeLib, HONESTY_KEY } = require('./ruleEngine');

// 本地开发时自动加载 .env（不进 git，已 gitignore），避免手动 export；生产环境以真实环境变量为准
const envPath = path.join(__dirname, '.env');
try {
  const envText = fs.readFileSync(envPath, 'utf8');
  envText.split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
} catch (e) { /* .env 不存在或不可读，忽略 */ }

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RM_BASE_URL || 'https://api.deepseek.com/v1/chat/completions';
const MODEL = process.env.RM_MODEL || 'deepseek-chat';
const MOCK = process.env.MOCK === '1' || process.env.MOCK === 'true';

const ROOT = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function clamp(n, lo, hi) { n = Number(n); if (!isFinite(n)) return lo; return Math.max(lo, Math.min(hi, Math.round(n))); }

// 请求日志：只记角色/引擎/降级原因，绝不记 key 与简历全文
const LOG_FILE = path.join(ROOT, 'server.log');
function logReq(role, engine, note) {
  const line = `[${new Date().toISOString()}] role=${role} engine=${engine}${note ? ' note=' + note : ''}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
}

/* ---------- LLM 调用（通用） ---------- */
function postLLM(apiKey, messages) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: MODEL,
      messages,
      response_format: { type: 'json_object' },
      temperature: 0.3
    });
    const url = new URL(BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        // 用 Buffer 累积后统一按 UTF-8 解码，避免分片切断多字节中文字符产生乱码（经典坑）
        const body = Buffer.concat(chunks).toString('utf-8');
        if (body.includes('\uFFFD')) console.warn('[Resume Map][WARN] LLM 原始响应含替换符，疑似分片截断乱码（已尝试完整解码仍损坏）');
        if (res.statusCode !== 200) return reject(new Error('LLM HTTP ' + res.statusCode + ' ' + body.slice(0, 200)));
        let resp;
        try { resp = JSON.parse(body); } catch (e) { return reject(new Error('LLM 响应非 JSON')); }
        const content = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
        if (!content) return reject(new Error('LLM 响应缺 choices/content：' + JSON.stringify(resp).slice(0, 200)));
        let inner = String(content).trim();
        if (inner.startsWith('```')) inner = inner.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        try { resolve(JSON.parse(inner)); } catch (e) { reject(new Error('LLM content 非 JSON：' + inner.slice(0, 200))); }
      });
    });
    req.on('error', e => reject(e));
    req.setTimeout(20000, () => req.destroy(new Error('LLM 超时')));
    req.write(payload);
    req.end();
  });
}

/* ---------- 简历评估 LLM ---------- */
function buildPrompt(text, lib) {
  const dimsLine = lib.dims.map(d => `- ${d.key}（权重 ${d.weight}）：${d.desc || ''}`).join('\n');
  const schema = {
    dims: [{ key: '维度名', score: 80, level: '强', comment: '基于简历具体证据的点评', evidence: '引用简历中的具体事实，可短句' }],
    risks: [{ level: '高', title: '风险点', fix: '修改建议', evidence: '触发该风险点的简历原话或缺失点' }],
    match: 75,
    plan: [{ priority: 'P0', dim: '维度名', action: '补强动作', out: '预期产出' }]
  };
  const system = '你是一名资深 HR 与 AI 产品经理双背景的简历能力评估专家。' +
    '任务：根据用户提供的目标岗位能力维度定义，评估一份简历，输出严格的 JSON。' +
    '规则：1) 每个维度给 0-100 的 score、等级 level（强/中/弱）、基于简历具体证据的点评 comment 与 evidence（evidence 必须引用简历中的真实事实原文或高度概括，comment 是基于 evidence 的专业判断，绝不编造或夸大）；' +
    '2) 识别面试风险点 risks（如强词无证据、精确数字无口径、核心维度薄弱、项目角色与成果不成比例），每条给 level（高/中/低）、title、fix 修改建议、evidence 触发依据；' +
    '3) 基于维度加权计算整体匹配度 match（0-100 整数）；' +
    '4) 给出补强计划 plan（按优先级 P0/P1/P2，针对薄弱维度，含 action 与预期产出 out，action 要具体可执行）。' +
    '只输出 JSON，不要任何额外文字。';
  const user = `目标岗位：${lib.name}\n能力维度（含权重）：\n${dimsLine}\n\n简历文本：\n${text}\n\n请严格按以下 JSON 结构输出：\n${JSON.stringify(schema)}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function callLLM(apiKey, text, lib) {
  return postLLM(apiKey, buildPrompt(text, lib));
}

// 把 LLM 返回映射成前端 render() 需要的形状
function mapLLM(raw, lib) {
  if (!raw || !Array.isArray(raw.dims) || raw.dims.length === 0) throw new Error('LLM 缺 dims');
  const weightOf = k => { const d = lib.dims.find(x => x.key === k); return d ? d.weight : 0; };
  const dims = raw.dims.map(d => ({
    key: String(d.key), weight: weightOf(d.key),
    score: clamp(d.score, 0, 100),
    matched: Array.isArray(d.evidence) ? d.evidence.map(String) : (d.evidence ? [String(d.evidence)] : []),
    comment: String(d.comment || (d.level ? '等级：' + d.level : '无点评'))
  }));
  const risks = Array.isArray(raw.risks) ? raw.risks.map(r => ({
    level: String(r.level || '中'), title: String(r.title || '风险点'), fix: String(r.fix || ''), evidence: String(r.evidence || '')
  })) : [];
  const plan = Array.isArray(raw.plan) ? raw.plan.map(p => ({
    priority: String(p.priority || 'P1'), dim: String(p.dim || ''), action: String(p.action || ''), out: String(p.out || '')
  })) : [];
  // ── 诚实度后校验：若 LLM 自己检测到 AI 生成 / 疑似生成类风险，
  //    却仍给了高分 → 强制扣分，防止"判作弊但给满分"的矛盾 ──
  const AI_GEN_PAT = /(?:AI\s*生成|生成内容|疑似.*生成|GPT|ChatGPT|AI.*撰写|LLM.*生成|机器.*生成|由\s*AI|AI.*补全|可能为.*生成)/i;
  const hasAIRisk = risks.some(r => AI_GEN_PAT.test(r.title) || AI_GEN_PAT.test(r.fix));
  if (hasAIRisk) {
    const honestyDim = dims.find(d => d.key === HONESTY_KEY);
    if (honestyDim && honestyDim.score > 55) {
      honestyDim.score = Math.max(40, honestyDim.score - 45);
      honestyDim.comment = '[后校验] 检测到 AI 生成风险，已自动降分：' + honestyDim.comment;
    }
    const rawMatch = clamp(raw.match, 0, 100);
    const cappedMatch = Math.min(rawMatch, 88);
    if (cappedMatch < rawMatch) {
      dims.push({ key: '[校验]AI生成降权', weight: 0, score: 0, matched: [], comment: '因检测到 AI/生成类风险，总分已从 ' + rawMatch + ' 降至 ' + cappedMatch });
    }
    return { dims, risks, match: cappedMatch, plan, engine: 'llm' };
  }
  return { dims, risks, match: clamp(raw.match, 0, 100), plan, engine: 'llm' };
}

/* ---------- JD 解析：JD 文本 → 维度库 lib ---------- */
// 分类法：无 API Key 时，按 JD 命中的技能关键词归类成维度（本地启发式兜底）
const JD_TAXONOMY = {
  '数据分析': ['python', 'pandas', 'numpy', 'sql', 'mysql', 'excel', 'etl', '建模', '机器学习', '统计', '可视化', 'tableau', '报表', '指标', '回归', '分类', '聚类', '算法', '数仓'],
  'AI/大模型': ['ai', 'llm', '大模型', 'prompt', 'rag', '微调', '智能体', 'agent', 'gpt', 'claude', '千问', '通义', '部署', '问答', 'embedding', '向量库'],
  '产品能力': ['产品', 'prd', '需求', '原型', '墨刀', '交互', '用户故事', '竞品', 'axure', '设计', '功能', '调研', 'b端', 'c端', '闭环'],
  '前端开发': ['vue', 'react', 'javascript', 'typescript', 'html', 'css', '小程序', '组件', 'angular', 'vite', 'webpack', '前端'],
  '后端开发': ['后端', 'java', 'go', 'node', 'api', '接口', '数据库', '架构', '微服务', 'redis', 'spring', '服务端'],
  '业务与运营': ['业务', '运营', '增长', '商业化', '用户', '行业', '场景', '流程', '痛点', '渠道', '转化', '留存']
};

function heuristicParseJD(jd) {
  const lower = jd.toLowerCase();
  const dims = [];
  for (const [cat, kws] of Object.entries(JD_TAXONOMY)) {
    const hits = kws.filter(k => lower.includes(k.toLowerCase()));
    if (hits.length) {
      dims.push({ key: cat, weight: Math.min(30, 10 + hits.length * 4), desc: cat + '相关能力', kws: hits });
    }
  }
  if (!dims.length) {
    dims.push({ key: '通用能力', weight: 20, desc: 'JD 未识别出明确维度，按通用能力评估', kws: ['能力', '经验', '负责', '项目', '团队'] });
  }
  return { name: '自定义岗位（JD 解析）', dims };
}

function buildJDPrompt(jd) {
  const system = '你是资深招聘 JD 解析专家。任务：把一份招聘 JD 解析成「简历能力评估维度库」JSON。' +
    '规则：1) 输出 4-6 个能力维度，覆盖该岗位最核心的能力要求；' +
    '2) 每个维度含 key(维度名，简洁中文)、weight(相对重要度整数，建议所有维度 weight 之和约 100)、desc(一句话说明评估什么)、kws(该维度在简历中最该命中的 8-15 个关键词/技能/动词短语，中英文皆可，如 python、sql、prd、ab测试、用户增长、大模型)；' +
    '3) 不要包含名为「表达与诚实度」的维度（系统会自动补充）。' +
    '只输出 JSON，不要任何额外文字。';
  const schema = { name: '职位名', dims: [{ key: '维度名', weight: 20, desc: '评估什么', kws: ['关键词1', '关键词2'] }] };
  const user = `招聘 JD：\n${jd}\n\n请严格按以下 JSON 结构输出：\n${JSON.stringify(schema)}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function callJDLLM(apiKey, jd) {
  return postLLM(apiKey, buildJDPrompt(jd));
}

// LLM 原始输出 → 内容维度库（诚实度维度由 normalizeLib 统一补）
function buildLibFromJD(raw, jd) {
  const name = (raw && raw.name) ? String(raw.name) : '自定义岗位';
  const dims = Array.isArray(raw && raw.dims) ? raw.dims.map(d => ({
    key: String(d.key || '维度'),
    weight: Number(d.weight) || 10,
    desc: d.desc || '',
    kws: Array.isArray(d.kws) ? d.kws.map(String) : []
  })) : [];
  if (!dims.length) return heuristicParseJD(jd); // LLM 没给维度，降级启发式
  return { name, dims };
}

// JD 文本 → 缓存 key（同 JD 不重复解析）
function jdCacheKey(jd) {
  let h = 5381;
  for (let i = 0; i < jd.length; i++) h = ((h << 5) + h + jd.charCodeAt(i)) | 0;
  return 'jd_' + (h >>> 0);
}
const jdCache = new Map();

async function runJdParse(parsed) {
  const jd = (parsed.jd || '').trim();
  if (!jd) return { code: 400, obj: { error: '缺少 JD 文本' } };
  const apiKey = parsed.apiKey || process.env.RM_API_KEY;
  const key = jdCacheKey(jd);
  if (jdCache.has(key)) { logReq('jd-parse', 'cache', ''); return { code: 200, obj: { lib: jdCache.get(key), cached: true } }; }
  let lib;
  if (!apiKey) {
    lib = normalizeLib(heuristicParseJD(jd));
    logReq('jd-parse', 'heuristic', '无 Key，本地启发式解析');
  } else {
    try {
      const raw = await callJDLLM(apiKey, jd);
      lib = normalizeLib(buildLibFromJD(raw, jd));
      logReq('jd-parse', 'llm', '');
    } catch (e) {
      lib = normalizeLib(heuristicParseJD(jd));
      logReq('jd-parse', 'heuristic', 'LLM 解析失败，降级启发式：' + e.message);
    }
  }
  jdCache.set(key, lib);
  return { code: 200, obj: { lib, cached: false } };
}

/* ---------- Mock 模式（无 Key 也能测通全链路） ---------- */
function mockResponse(lib) {
  const sample = { '数据分析能力': 82, 'AI工具与落地': 84, '产品基本功': 76, '技术概念理解': 58, '业务理解': 64, '表达与诚实度': 70, '数据处理': 80, '统计建模': 78, 'SQL与数据库': 75, '可视化': 70, '框架能力': 72, '工程化': 60, '基础': 68, '协作': 66, '性能优化': 55 };
  const dims = lib.dims.map(d => ({
    key: d.key, weight: d.weight, score: d.special ? 70 : (sample[d.key] != null ? sample[d.key] : 60),
    matched: d.special ? [] : (d.kws && d.kws.length ? [d.kws[0]] : []),
    comment: '[Mock] ' + (d.desc || '评估维度')
  }));
  const risks = [{ level: '中', title: '精确数字缺口径', fix: '[Mock] 为简历中的 AUC / 倍数等数字准备计算口径说明。' }];
  const plan = [{ priority: 'P1', dim: lib.dims[3] ? lib.dims[3].key : '技术概念理解', action: '[Mock] 补强该维度', out: '[Mock] 产出物' }];
  let wsum = 0, w = 0; dims.forEach(d => { if (d.weight > 0) { wsum += d.score * d.weight; w += d.weight; } });
  return { dims, risks, match: w ? Math.round(wsum / w) : 0, plan, engine: 'mock' };
}

/* ---------- 归一化入口：customLib 优先，否则按 role 查固定库 ---------- */
function resolveActiveLib(parsed) {
  if (parsed.customLib) return normalizeLib(parsed.customLib);
  const role = parsed.role || 'ai_pm';
  if (!ROLE_LIB[role]) return null;
  return normalizeLib(ROLE_LIB[role]);
}

/* ---------- 核心分析（平台无关，本地/云函数共用） ---------- */
async function runAnalyze(parsed) {
  const text = (parsed.text || '').trim();
  if (!text) return { code: 400, obj: { error: '缺少简历文本' } };
  const lib = resolveActiveLib(parsed);
  if (!lib) return { code: 400, obj: { error: '未知岗位：' + parsed.role } };
  const roleName = lib.name;

  const apiKey = parsed.apiKey || process.env.RM_API_KEY;
  const forceEngine = parsed.forceEngine;
  try {
    if (MOCK) { logReq(roleName, 'mock', ''); return { code: 200, obj: Object.assign(mockResponse(lib), { roleName }) }; }
    if (forceEngine === 'rule') {
      logReq(roleName, 'rule', '强制规则引擎(对比)');
      return { code: 200, obj: Object.assign(analyze(text, lib), { engine: 'rule', note: '已按请求强制使用规则引擎（对比用，无 AI）', roleName }) };
    }
    if (!apiKey) { logReq(roleName, 'rule', '无 API Key，已降级规则引擎'); return { code: 200, obj: Object.assign(analyze(text, lib), { engine: 'rule', note: '无 API Key，已降级规则引擎', roleName }) }; }
    const raw = await callLLM(apiKey, text, lib);
    try { const out = mapLLM(raw, lib); out.roleName = roleName; logReq(roleName, 'llm', ''); return { code: 200, obj: out }; }
    catch (mapErr) { logReq(roleName, 'rule', 'LLM 输出校验失败，已降级规则引擎'); return { code: 200, obj: Object.assign(analyze(text, lib), { note: 'LLM 输出校验失败，已降级规则引擎', roleName }) }; }
  } catch (e) {
    logReq(roleName, 'rule', 'LLM 调用失败，已降级规则引擎：' + e.message);
    return { code: 200, obj: Object.assign(analyze(text, lib), { note: 'LLM 调用失败，已降级规则引擎：' + e.message, roleName }) };
  }
}

/* ---------- 对比模式（同一份简历，双引擎并跑） ---------- */
async function runCompare(parsed) {
  const text = (parsed.text || '').trim();
  if (!text) return { code: 400, obj: { error: '缺少简历文本' } };
  const lib = resolveActiveLib(parsed);
  if (!lib) return { code: 400, obj: { error: '未知岗位：' + parsed.role } };
  const roleName = lib.name;
  const apiKey = parsed.apiKey || process.env.RM_API_KEY;

  const rule = Object.assign(analyze(text, lib), { engine: 'rule' });

  let llm = null, llmErr = null;
  if (MOCK) {
    llm = mockResponse(lib);
  } else if (apiKey) {
    try { const raw = await callLLM(apiKey, text, lib); llm = mapLLM(raw, lib); }
    catch (e) { llmErr = e.message; }
  }

  const obj = {
    compare: true,
    rule,
    llm,
    ruleMatch: rule.match,
    llmMatch: llm ? llm.match : null,
    llmAvailable: !!llm,
    roleName,
    note: llmErr ? ('LLM 调用失败，仅展示规则引擎结果：' + llmErr)
                 : (llm ? '双引擎对比完成（真 LLM vs 规则引擎，同一份简历）'
                        : '未配置 API Key，仅规则引擎结果可对比')
  };
  logReq(roleName, llm ? 'llm+rule' : 'rule-only', llmErr ? 'compare LLM失败' : 'compare');
  return { code: 200, obj };
}

/* ---------- 本地 HTTP 请求处理 ---------- */
function handleAnalyze(req, res) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { return send(res, 400, { error: '请求体非 JSON' }); }
    const r = await runAnalyze(parsed);
    send(res, r.code, r.obj);
  });
}

function handleCompare(req, res) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { return send(res, 400, { error: '请求体非 JSON' }); }
    const r = await runCompare(parsed);
    send(res, r.code, r.obj);
  });
}

function handleJdParse(req, res) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { return send(res, 400, { error: '请求体非 JSON' }); }
    const r = await runJdParse(parsed);
    send(res, r.code, r.obj);
  });
}

/* ---------- 云函数入口（CloudBase / SCF Web 函数形态；被 require 时不启动 server） ---------- */
exports.main = async (event, context) => {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
  if (event && event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: Object.assign({}, headers, { 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }), body: '' };
  }
  let parsed;
  try {
    const raw = typeof event.body === 'string' ? event.body : (event.body ? JSON.stringify(event.body) : '{}');
    parsed = JSON.parse(raw);
  } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: '请求体非 JSON' }) }; }
  let r;
  if (parsed.action === 'jd-parse' || (parsed.jd && !parsed.text)) r = await runJdParse(parsed);
  else if (parsed.compare) r = await runCompare(parsed);
  else r = await runAnalyze(parsed);
  return { statusCode: r.code, headers, body: JSON.stringify(r.obj) };
};
exports.runAnalyze = runAnalyze;
exports.runJdParse = runJdParse;

function send(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(s);
}

/* ---------- 静态文件托管（避免 file:// 的 CORS 问题） ---------- */
function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/') pathname = '/resume-map-mvp.html';
  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }

  // HTML 文件：把占位符 {{ROLE_LIB_JSON}} 替换为后端 roleLib.json，保证前后端单一数据源（前端不再内联副本）
  if (path.extname(filePath).toLowerCase() === '.html') {
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not Found'); }
      const injected = data.replace(/\{\{ROLE_LIB_JSON\}\}/g, JSON.stringify(ROLE_LIB).replace(/</g, '\\u003c'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(injected);
    });
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not Found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/api/jd-parse')) return handleJdParse(req, res);
  if (req.method === 'POST' && req.url.startsWith('/api/compare')) return handleCompare(req, res);
  if (req.method === 'POST' && req.url.startsWith('/api/analyze')) return handleAnalyze(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  res.writeHead(405); res.end('Method Not Allowed');
});

// 仅本地直接运行（node server.js）或云托管（平台执行 node server.js）时启动 HTTP 服务；
// 被云函数 require 时不启动，由 exports.main 处理请求。
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[Resume Map] V2 服务已启动: http://localhost:${PORT}/  (${MOCK ? 'MOCK 模式' : 'DeepSeek 模式'})`);
  });
}
