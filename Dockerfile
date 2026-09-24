# 安全分享服务 - 生产镜像（含源文件 / Office 在线预览转换）
FROM node:22-slim

WORKDIR /app

# 系统级预览依赖：
#  - LibreOffice Impress / Draw：pptx 转 PDF、AI/CDR/EPS 栅格化
#  - Inkscape / ImageMagick / Ghostscript：矢量与 PostScript 兜底
#  - Python3 + psd_tools + Pillow：PSD/PSB/TIFF 栅格化
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-dev \
    libreoffice-impress libreoffice-draw \
    inkscape imagemagick ghostscript \
    libxml2 libxslt1.1 \
  && rm -rf /var/lib/apt/lists/*

# 安装 Python 预览 worker 依赖
# （Debian 12 的 pip 默认禁止改系统环境，需 --break-system-packages）
RUN python3 -m pip install --no-cache-dir --break-system-packages psd_tools Pillow

# 中文字体：LibreOffice 转 PDF / 栅格化时必需，否则中文全部渲染成空白方块（tofu）。
# 刻意放在 pip 层之后：字体与上面的 apt 层无依赖关系，这样改它不会让 LibreOffice（845MB）
# 和 psd_tools（编译 24 分钟）两层缓存失效，重建只需 1~2 分钟。
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/* \
  && fc-cache -f >/dev/null 2>&1 || true

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
    UPLOAD_DIR=/app/uploads \
    PYTHON_PATH=/usr/bin/python3

CMD ["node", "server/index.js"]
