// Resume Map · V1 轻后端（Node 内置模块，零依赖）
// 职责：托管静态文件 + POST /api/analyze（简历文本 + 岗位 → 调 LLM → 校验映射 → 返回前端 render 形状）
// 安全红线：密钥只在后端，绝不进前端；无 Key / 模型失败 → 降级规则引擎，保证不空场。
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { analyze, ROLE_LIB } = require('./ruleEngine');

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

/* ---------- LLM 调用 ---------- */
function buildPrompt(text, roleKey) {
  const lib = ROLE_LIB[roleKey];
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

function callLLM(apiKey, text, roleKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: MODEL,
      messages: buildPrompt(text, roleKey),
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
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('LLM HTTP ' + res.statusCode + ' ' + body.slice(0, 200)));
        let resp;
        try { resp = JSON.parse(body); } catch (e) { return reject(new Error('LLM 响应非 JSON')); }
        // 剥 OpenAI 兼容外壳：真正业务 JSON 在 choices[0].message.content（字符串，需再 parse）
        const content = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
        if (!content) return reject(new Error('LLM 响应缺 choices/content：' + JSON.stringify(resp).slice(0, 200)));
        let inner = String(content).trim();
        // 兜底：个别模型会用 ```json ... ``` 包裹
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

// 把 LLM 返回映射成前端 render() 需要的形状
function mapLLM(raw, roleKey) {
  if (!raw || !Array.isArray(raw.dims) || raw.dims.length === 0) throw new Error('LLM 缺 dims');
  const lib = ROLE_LIB[roleKey];
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
  return { dims, risks, match: clamp(raw.match, 0, 100), plan, engine: 'llm' };
}

/* ---------- Mock 模式（无 Key 也能测通全链路） ---------- */
function mockResponse(roleKey) {
  const lib = ROLE_LIB[roleKey];
  const sample = { '数据分析能力': 82, 'AI工具与落地': 84, '产品基本功': 76, '技术概念理解': 58, '业务理解': 64, '表达与诚实度': 70, '数据处理': 80, '统计建模': 78, 'SQL与数据库': 75, '可视化': 70, '框架能力': 72, '工程化': 60, '基础': 68, '协作': 66, '性能优化': 55 };
  const dims = lib.dims.map(d => ({
    key: d.key, weight: d.weight, score: sample[d.key] != null ? sample[d.key] : 60,
    matched: [], comment: '[Mock] ' + (d.desc || '评估维度')
  }));
  const risks = [{ level: '中', title: '精确数字缺口径', fix: '[Mock] 为简历中的 AUC / 倍数等数字准备计算口径说明。' }];
  const plan = [{ priority: 'P1', dim: lib.dims[3] ? lib.dims[3].key : '技术概念理解', action: '[Mock] 补强该维度', out: '[Mock] 产出物' }];
  let wsum = 0, w = 0; dims.forEach(d => { if (d.weight > 0) { wsum += d.score * d.weight; w += d.weight; } });
  return { dims, risks, match: Math.round(wsum / w), plan, engine: 'mock' };
}

/* ---------- 请求处理 ---------- */
function handleAnalyze(req, res) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { return send(res, 400, { error: '请求体非 JSON' }); }
    const text = (parsed.text || '').trim();
    const role = parsed.role || 'ai_pm';
    if (!text) return send(res, 400, { error: '缺少简历文本' });
    if (!ROLE_LIB[role]) return send(res, 400, { error: '未知岗位：' + role });

    const apiKey = parsed.apiKey || process.env.RM_API_KEY;
    try {
      if (MOCK) { logReq(role, 'mock', ''); return send(res, 200, mockResponse(role)); }
      if (!apiKey) { logReq(role, 'rule', '无 API Key，已降级规则引擎'); return send(res, 200, Object.assign(analyze(text, role), { note: '无 API Key，已降级规则引擎' })); }
      const raw = await callLLM(apiKey, text, role);
      try { const out = mapLLM(raw, role); logReq(role, 'llm', ''); return send(res, 200, out); }
      catch (mapErr) { logReq(role, 'rule', 'LLM 输出校验失败，已降级规则引擎'); return send(res, 200, Object.assign(analyze(text, role), { note: 'LLM 输出校验失败，已降级规则引擎' })); }
    } catch (e) {
      // 模型调用失败 → 规则引擎兜底
      logReq(role, 'rule', 'LLM 调用失败，已降级规则引擎：' + e.message);
      return send(res, 200, Object.assign(analyze(text, role), { note: 'LLM 调用失败，已降级规则引擎：' + e.message }));
    }
  });
}

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
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not Found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/api/analyze')) return handleAnalyze(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  res.writeHead(405); res.end('Method Not Allowed');
});

server.listen(PORT, () => {
  console.log(`[Resume Map] V1 服务已启动: http://localhost:${PORT}/  (${MOCK ? 'MOCK 模式' : 'DeepSeek 模式'})`);
});
