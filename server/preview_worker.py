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
        else:
            # 本脚本不支持的类型（如 .ai/.cdr/.eps），交给外部工具
            return 3

        # 超尺寸缩放，避免预览图过大拖慢前端加载
        w, h = img.size
        max_dim = 2400
        if max(w, h) > max_dim:
            scale = max_dim / float(max(w, h))
            img = img.resize((int(w * scale), int(h * scale)))

        img.save(out_path, "PNG")
        return 0
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("preview_worker error: %s\n" % e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
