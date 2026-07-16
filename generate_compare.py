# -*- coding: utf-8 -*-
# 生成 Resume Map「AI vs 规则引擎」同简历对比文档（自包含静态 HTML）
import json, html

LLM = json.load(open('llm.json', encoding='utf-8'))
RULE = json.load(open('rule.json', encoding='utf-8'))

SAMPLE = """候选人
求职意向：AI 产品经理
电话：138xxxx 邮箱：gjj@example.com
教育背景：某双一流高校 某专业 2023-2027（双一流）
技能：Python、SQL、Excel、Axure、墨刀、ChatGPT、Claude
项目经历：
1. 复购预测模型：用 Python 建立用户复购预测模型，AUC 达到 0.8959，帮助提升业绩。
2. 某游戏 Wiki：独立开发 Vue3 游戏中文 Wiki 站，负责前端与数据，共 7 个页面、85KB 卡牌数据。
3. 校园活动：组织过多次社团活动，提升了团队协作能力，获得同学好评。
自我评价：熟悉 AI 工具，了解 RAG、Prompt，热爱产品，学习能力强，能快速上手新工具。"""

def cls(s):
    return 'hi' if s >= 70 else ('mid' if s >= 50 else 'lo')
def bar(s):
    c = {'hi':'#2e9e5b','mid':'#e8a33d','lo':'#d9504e'}[cls(s)]
    return f'<div class="bar"><i style="width:{s}%;background:{c}"></i></div><b style="color:{c}">{s}</b>'

# 按 key 对齐两份维度
rule_by_key = {d['key']: d for d in RULE['dims']}
dim_rows = ''
for d in LLM['dims']:
    k = d['key']
    r = rule_by_key.get(k, {})
    llm_ev = '；'.join(d.get('matched', [])) or '（无）'
    rule_ev = '；'.join(r.get('matched', [])) or '（无）'
    dim_rows += f'''<tr>
      <td class="k">{html.escape(k)}</td>
      <td class="ai"><div class="sc">{bar(d['score'])}</div><div class="cm">{html.escape(d.get('comment',''))}</div><div class="ev">证据：{html.escape(llm_ev)}</div></td>
      <td class="rg"><div class="sc">{bar(r.get('score',0))}</div><div class="cm">{html.escape(r.get('comment',''))}</div><div class="ev">命中：{html.escape(rule_ev)}</div></td>
    </tr>'''

risk_ai = ''.join(
    f'<div class="rk lo"><span class="pill lo">{html.escape(x["level"])}</span> {html.escape(x["title"])}'
    f'<div class="rf">建议：{html.escape(x["fix"])}</div><div class="ev">依据：{html.escape(x.get("evidence",""))}</div></div>'
    for x in LLM.get('risks', [])) or '<div class="muted">无</div>'
risk_rg = ''.join(
    f'<div class="rk mid"><span class="pill mid">{html.escape(x["level"])}</span> {html.escape(x["title"])}'
    f'<div class="rf">建议：{html.escape(x["fix"])}</div></div>'
    for x in RULE.get('risks', [])) or '<div class="muted">无</div>'

def plan_html(lst):
    if not lst: return '<div class="muted">无</div>'
    return ''.join(
        f'<div class="pl"><span class="pill {html.escape(p["priority"].lower())}">{html.escape(p["priority"])}</span>'
        f'<b>{html.escape(p.get("dim",""))}</b>：{html.escape(p.get("action",""))}<div class="ev">产出：{html.escape(p.get("out",""))}</div></div>'
        for p in lst)
plan_ai = plan_html(LLM.get('plan', []))
plan_rg = plan_html(RULE.get('plan', []))

lm, rm = LLM['match'], RULE['match']

doc = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Resume Map · AI vs 规则引擎 同简历对比</title>
<style>
*{{box-sizing:border-box}}
body{{margin:0;font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#1f2329;line-height:1.6}}
.wrap{{max-width:980px;margin:0 auto;padding:32px 20px 64px}}
h1{{font-size:24px;margin:0 0 6px}}
.sub{{color:#6b7280;font-size:14px;margin-bottom:24px}}
.hero{{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:28px}}
.card{{background:#fff;border:1px solid #e6e8eb;border-radius:14px;padding:20px}}
.card .t{{font-size:13px;color:#6b7280}}
.card .n{{font-size:46px;font-weight:700;line-height:1.1}}
.card.ai .n{{color:#2e6bff}}
.card.rg .n{{color:#d9504e}}
.card .d{{font-size:12px;color:#9aa0a6;margin-top:4px}}
section{{background:#fff;border:1px solid #e6e8eb;border-radius:14px;padding:20px 22px;margin-bottom:22px}}
section h2{{font-size:17px;margin:0 0 14px;display:flex;align-items:center;gap:8px}}
.tag{{font-size:11px;padding:2px 8px;border-radius:20px;background:#eef2ff;color:#2e6bff}}
table{{width:100%;border-collapse:collapse}}
th,td{{text-align:left;vertical-align:top;padding:12px 10px;border-bottom:1px solid #f0f1f3;font-size:13px}}
th{{font-size:12px;color:#6b7280;font-weight:600}}
td.k{{font-weight:600;width:140px;color:#374151}}
td.ai{{width:42%}}
td.rg{{width:42%}}
.sc{{display:flex;align-items:center;gap:8px;margin-bottom:4px}}
.bar{{flex:1;height:8px;background:#eef0f2;border-radius:6px;overflow:hidden}}
.bar i{{display:block;height:100%}}
.sc b{{font-size:14px;min-width:28px;text-align:right}}
.cm{{color:#374151;margin:2px 0}}
.ev{{color:#2e6bff;font-size:12px;background:#f3f7ff;border-radius:8px;padding:4px 8px;margin-top:4px}}
.rk{{border-left:3px solid #e6e8eb;padding:8px 12px;margin-bottom:10px;background:#fafbfc;border-radius:0 8px 8px 0}}
.rk.lo{{border-color:#d9504e}}.rk.mid{{border-color:#e8a33d}}
.rf{{color:#374151;font-size:13px;margin-top:3px}}
.pill{{font-size:11px;padding:1px 8px;border-radius:20px;color:#fff;margin-right:6px}}
.pill.lo{{background:#d9504e}}.pill.mid{{background:#e8a33d}}.pill.hi{{background:#2e9e5b}}
.pill.p0{{background:#d9504e}}.pill.p1{{background:#e8a33d}}.pill.p2{{background:#5b8def}}
.pl{{border:1px solid #eef0f2;border-radius:10px;padding:10px 12px;margin-bottom:10px}}
.muted{{color:#9aa0a6;font-size:13px}}
.note{{background:#fff8e6;border:1px solid #ffe2a8;border-radius:10px;padding:14px 16px;font-size:14px;color:#7a5b00}}
.note b{{color:#a35c00}}
details{{margin-top:6px}}
summary{{cursor:pointer;color:#2e6bff;font-size:13px}}
pre{{white-space:pre-wrap;background:#f7f8fa;border-radius:10px;padding:14px;font-size:12px;color:#374151;max-height:240px;overflow:auto}}
.cmp2{{display:grid;grid-template-columns:1fr 1fr;gap:16px}}
.cmp2>div{{background:#fafbfc;border:1px solid #eef0f2;border-radius:10px;padding:14px}}
.cmp2 h3{{margin:0 0 10px;font-size:14px}}
.cmp2 h3.a{{color:#2e6bff}}.cmp2 h3.b{{color:#d9504e}}
</style></head><body><div class="wrap">
<h1>Resume Map · AI 与规则引擎 同简历对比</h1>
<div class="sub">同一份简历，分别走「真 LLM（DeepSeek）」与「纯规则引擎（关键词兜底）」，结果并排呈现。</div>

<div class="hero">
  <div class="card ai"><div class="t">真 LLM 评估 · 整体匹配度</div><div class="n">{lm}</div><div class="d">引用证据、识别风险、判断保守真实</div></div>
  <div class="card rg"><div class="t">规则引擎评估 · 整体匹配度</div><div class="n">{rm}</div><div class="d">关键词命中即高分，虚高且泛化</div></div>
</div>

<section><h2>逐维度对比 <span class="tag">同一份简历</span></h2>
<table>
<thead><tr><th>能力维度</th><th>真 LLM（引用证据）</th><th>规则引擎（关键词命中）</th></tr></thead>
<tbody>{dim_rows}</tbody>
</table></section>

<section><h2>风险点识别对比</h2>
<div class="cmp2">
  <div><h3 class="a">真 LLM · {len(LLM.get('risks',[]))} 个风险点（带依据）</h3>{risk_ai}</div>
  <div><h3 class="b">规则引擎 · {len(RULE.get('risks',[]))} 个风险点（泛化）</h3>{risk_rg}</div>
</div></section>

<section><h2>补强计划对比</h2>
<div class="cmp2">
  <div><h3 class="a">真 LLM · 具体到动作与产出</h3>{plan_ai}</div>
  <div><h3 class="b">规则引擎 · 模板化套话</h3>{plan_rg}</div>
</div></section>

<section><h2>结论：为什么这个产品非用 AI 不可</h2>
<div class="note">
规则引擎把「数据分析能力」直接打到 <b>100</b> 分，仅仅因为简历出现了 python / sql 关键词；整体给出 <b>75</b> 分的虚假安全感。
而真 LLM 给出 <b>42</b> 分，并点出「AUC 0.8959 缺乏数据量与业务口径」「RAG/Prompt 仅停留在了解层、无落地」「产品基本功薄弱、缺 PRD/原型」等真实短板。<br><br>
<b>差距本质</b>：规则引擎做的是「有没有提到」的关键词匹配；LLM 做的是「做得怎么样、差在哪、怎么补」的专业判断。前者给分数，后者给成长路径——这正是 Resume Map 作为「能力教练」而非「打分器」的产品价值。
</div></section>

<details><summary>查看用于对比的简历原文（脱敏样例）</summary><pre>{html.escape(SAMPLE)}</pre></details>
</div></body></html>'''

open('resume-map-ai-vs-rule.html', 'w', encoding='utf-8').write(doc)
print('written resume-map-ai-vs-rule.html  bytes=', len(doc))
