// 规则引擎（Node 模块，无 DOM）—— 供 server 在模型失败 / 无 Key 时降级兜底，保证不空场。
// 与前端 resume-map-mvp.html 内联的 scoreResume 逻辑一致，但剥离了 DOM 依赖。
const ROLE_LIB = require('./roleLib.json');

function scoreResume(text, roleKey) {
  const lib = ROLE_LIB[roleKey];
  if (!lib) return null;
  const lower = text.toLowerCase();
  const dims = [];
  lib.dims.forEach(d => {
    if (d.special) return;
    const hits = [];
    d.kws.forEach(k => { if (lower.includes(k.toLowerCase())) hits.push(k); });
    const matched = [...new Set(hits)];
    const score = matched.length === 0 ? 18 : Math.min(100, 20 + matched.length * 15);
    dims.push({
      key: d.key, weight: d.weight, score, matched,
      comment: matched.length ? '命中证据：' + matched.slice(0, 8).join('、') : '未检测到相关证据关键词'
    });
  });
  const risks = detectRisks(text, dims, lib);
  const honest = Math.max(35, 100 - risks.length * 16);
  dims.push({ key: '表达与诚实度', weight: 10, score: honest, matched: [], comment: '识别到 ' + risks.length + ' 个风险点，诚实度评分 ' + honest });
  let wsum = 0, w = 0;
  dims.forEach(d => { if (d.weight > 0) { wsum += d.score * d.weight; w += d.weight; } });
  const match = Math.round(wsum / w);
  return { dims, risks, match };
}

function detectRisks(text, dims, lib) {
  const risks = [];
  const avg = Math.round(dims.reduce((s, d) => s + d.score, 0) / dims.length);
  if (/(熟悉|精通|深度|主导|资深|专家)/.test(text) && avg < 62) {
    risks.push({ level: '高', title: '强词与能力不匹配', fix: '简历使用"熟悉/精通/主导"等强词，但整体能力评分偏低，易被面试官追问露馅。改为有证据的表述（如"用 X 完成 Y，效果 Z"）。' });
  }
  if (/(\d+(\.\d+)?\s?%|\d+\s?\+|\d+\s?倍|auc\s?\d|0\.\d{2,})/i.test(text)) {
    risks.push({ level: '中', title: '精确数字缺口径', fix: '简历含精确数字/比率（如 AUC、百分比、倍数），面试必被问"怎么算的"。为每个数字准备一句计算口径说明。' });
  }
  dims.forEach(d => {
    if (d.weight >= 15 && d.score < 45 && !d.matched.length) {
      risks.push({ level: '高', title: '核心维度「' + d.key + '」薄弱', fix: '该维度是' + lib.name + '的重点项，当前未检到证据。优先补强或调整简历表述，避免被判定"不匹配"。' });
    }
  });
  return risks;
}

function buildPlan(dims, lib) {
  const weak = dims.filter(d => d.key !== '表达与诚实度' && d.weight > 0 && d.score < 85)
    .sort((a, b) => a.score - b.score).slice(0, 3);
  const plan = [];
  weak.forEach(d => {
    const pm = lib.planMap[d.key]; if (!pm) return;
    const p = d.score < 45 ? 'P0' : (d.score < 66 ? 'P1' : 'P2');
    plan.push({ priority: p, dim: d.key, action: pm.action, out: pm.out });
  });
  if (!plan.some(p => p.priority === 'P0')) {
    plan.unshift({ priority: 'P0', dim: 'AI 产品评测', action: '把"用过 AI"变成"用 AI 做出过什么"，沉淀 1 个可展示的 AI 落地/评测案例', out: 'AI 案例文档（可直接写进简历）' });
  }
  return plan;
}

// 对外统一入口：返回前端 render() 需要的完整形状
function analyze(text, roleKey) {
  const r = scoreResume(text, roleKey);
  if (!r) return null;
  const lib = ROLE_LIB[roleKey];
  const plan = buildPlan(r.dims, lib);
  return { dims: r.dims, risks: r.risks, match: r.match, plan, engine: 'rule' };
}

module.exports = { analyze, scoreResume, detectRisks, buildPlan, ROLE_LIB };
