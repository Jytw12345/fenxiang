# 安全分享服务 - 生产镜像
FROM node:22-alpine

WORKDIR /app

# 先装依赖（利用层缓存）
COPY package*.json ./
RUN npm install --omit=dev

# 拷贝源码
COPY . .

# 运行时会由 db.js / storage.js 自动创建
RUN mkdir -p /app/data /app/uploads

# 持久化数据卷
VOLUME ["/app/data", "/app/uploads"]

EXPOSE 3000
ENV PORT=3000 \
    DATA_DIR=/app/data \
    UPLOAD_DIR=/app/uploads

CMD ["node", "server/index.js"]
