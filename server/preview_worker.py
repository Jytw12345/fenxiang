#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
设计源文件栅格化 worker（由 server/preview.js 以子进程方式调用）。
职责：把 PSD/PSB/TIFF 等栅格/位图源文件合成并导出为 PNG，
供网页内预览使用。向量源（AI/CDR/EPS）交给外部工具（Inkscape/ImageMagick/Ghostscript），
本脚本仅处理能由 psd_tools / PIL 直接处理的类型。

返回值：
  0  成功，已写出 PNG
  1  运行时错误
  2  参数错误
  3  该扩展名本脚本不支持（应由其他后端处理）
"""
import os
import sys

# 服务器端受信处理自家用户上传的文件，解除 PIL 的解压炸弹保护
# （超大印刷图/展板长图动辄 2~3 亿像素，默认 1.79 亿上限会直接拒绝；有上传大小限制与转换超时兜底）
try:
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
except Exception:
    pass


def main():
    if len(sys.argv) < 3:
        sys.stderr.write("usage: preview_worker.py <input> <output.png>\n")
        return 2

    in_path, out_path = sys.argv[1], sys.argv[2]
    ext = os.path.splitext(in_path)[1].lower()

    try:
        if ext in (".psd", ".psb"):
            from psd_tools import PSDImage
            psd = PSDImage.open(in_path)
            img = psd.composite()  # 合并所有可见图层
            if img.mode in ("RGBA", "LA", "P"):
                img = img.convert("RGBA")
            else:
                img = img.convert("RGB")
        elif ext in (".tif", ".tiff"):
            from PIL import Image
            img = Image.open(in_path)
            img = img.convert("RGB")
        elif ext in (".jpg", ".jpeg", ".png", ".webp", ".bmp"):
            # 普通图片降采样（超大图移动端 GPU 纹理会裁剪，需换小图预览）
            from PIL import Image, ImageOps
            img = Image.open(in_path)
            # JPEG 支持解码期降采样：超大图先按 1/2^d 粗降（内存峰值降几十倍），再精确缩放
            if getattr(img, "format", "") == "JPEG" and img.size:
                w0, h0 = img.size
                md = int(os.environ.get("PREVIEW_MAX_DIM") or 2400)
                factor = max(w0, h0) / float(md)
                if factor > 1:
                    dd = 1
                    while dd * 2 <= factor:
                        dd *= 2
                    img.draft("RGB", (max(1, w0 // dd), max(1, h0 // dd)))
            img = ImageOps.exif_transpose(img)  # 手机照片按 EXIF 方向转正
            if img.mode in ("RGBA", "LA", "P"):
                img = img.convert("RGBA")
            else:
                img = img.convert("RGB")
        else:
            # 本脚本不支持的类型（如 .ai/.cdr/.eps），交给外部工具
            return 3

        # 超尺寸缩放，避免预览图过大拖慢前端加载
        w, h = img.size
        max_dim = int(os.environ.get("PREVIEW_MAX_DIM") or 2400)
        if max(w, h) > max_dim:
            scale = max_dim / float(max(w, h))
            img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))))

        # 按输出扩展名选择格式：.jpg 用有损压缩（照片体积小），其余 PNG
        if out_path.lower().endswith((".jpg", ".jpeg")):
            img.save(out_path, "JPEG", quality=88)
        else:
            img.save(out_path, "PNG")
        return 0
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("preview_worker error: %s\n" % e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
