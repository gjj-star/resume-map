FROM node:18-alpine
WORKDIR /app
# 仅拷贝运行所需文件；roleLib.json 为前后端唯一数据源（前端由 server.js 注入，不另存副本）
COPY server.js ruleEngine.js roleLib.json package.json resume-map-mvp.html ./
EXPOSE 3000
CMD ["node", "server.js"]
