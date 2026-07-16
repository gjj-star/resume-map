# -*- coding: utf-8 -*-
# 生成一份中文示例简历 PDF，用于验证 Resume Map 的 PDF 上传直连链路
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

# 注册系统中文粗体/常规字体（Windows 自带微软雅黑）
pdfmetrics.registerFont(TTFont('msyh', 'C:/Windows/Fonts/msyh.ttc', subfontIndex=0))
pdfmetrics.registerFont(TTFont('msyhbd', 'C:/Windows/Fonts/msyhbd.ttc', subfontIndex=0))

styles = getSampleStyleSheet()
H = ParagraphStyle('H', parent=styles['Normal'], fontName='msyhbd', fontSize=18, spaceAfter=6)
S = ParagraphStyle('S', parent=styles['Normal'], fontName='msyh', fontSize=10.5, leading=16, spaceAfter=4)
L = ParagraphStyle('L', parent=styles['Normal'], fontName='msyh', fontSize=10.5, leading=16, leftIndent=12, spaceAfter=2)

doc = SimpleDocTemplate('sample-resume.pdf', pagesize=A4,
                        leftMargin=20*mm, rightMargin=20*mm, topMargin=18*mm, bottomMargin=18*mm)
f = []
f.append(Paragraph('候选人', H))
f.append(Paragraph('求职意向：AI 产品经理 ｜ 电话：138xxxx ｜ 邮箱：gjj@example.com', S))
f.append(Paragraph('教育背景：某双一流高校 某专业 2023-2027（双一流）', S))
f.append(Paragraph('技能：Python、SQL、Excel、Axure、墨刀、ChatGPT、Claude', S))
f.append(Spacer(1, 6))
f.append(Paragraph('项目经历', H))
f.append(Paragraph('1. 复购预测模型：用 Python 建立用户复购预测模型，AUC 达到 0.8959，帮助提升业绩。', L))
f.append(Paragraph('2. 某游戏 Wiki：独立开发 Vue3 游戏中文 Wiki 站，负责前端与数据，共 7 个页面、85KB 卡牌数据。', L))
f.append(Paragraph('3. 校园活动：组织过多次社团活动，提升了团队协作能力，获得同学好评。', L))
f.append(Spacer(1, 6))
f.append(Paragraph('自我评价', H))
f.append(Paragraph('熟悉 AI 工具，了解 RAG、Prompt，热爱产品，学习能力强，能快速上手新工具。', S))
doc.build(f)
print('written sample-resume.pdf')
