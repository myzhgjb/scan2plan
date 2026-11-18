# -*- coding: utf-8 -*-
"""生成室内点云（两室一厅 12×9m），用于验证「点云 -> 户型图」算法
墙面按 0.06m、地面/天花按 0.08m 采样，含门洞、窗洞、家具
输出 data.bin（pos/颜色/强度/强度占位）与 meta.json
"""
import json, math, os, random, struct

random.seed(1118)
W, D, H = 12.0, 9.0, 2.7      # 宽、深、层高
T = 0.20                       # 墙厚
WSTEP, FSTEP = 0.06, 0.08

# 墙段: (x1,z1,x2,z2, openings)  openings: (t0,t1,y0,y1) 沿墙长度方向
WALLS = [
    (0, 0, W, 0, [(9.0, 10.0, 0, 2.1)]),          # 下外墙（入户门）
    (W, 0, W, D, [(1.0, 2.5, 0.9, 2.2)]),          # 右外墙（厨房窗）
    (W, D, 0, D, []),                              # 上外墙
    (0, D, 0, 0, [(1.5, 3.0, 0.9, 2.2)]),          # 左外墙（主卧窗）
    (4.2, 0, 4.2, 4.5, []),                        # 主卧 / 次卧
    (0, 4.5, 4.2, 4.5, [(3.0, 3.9, 0, 2.1)]),      # 主卧 / 客厅（门）
    (8.0, 0, 8.0, 6.2, [(1.2, 2.1, 0, 2.1), (4.6, 5.5, 0, 2.1)]),  # 厨房/卫生间 与 客厅
    (4.2, 3.6, 8.0, 3.6, [(5.5, 6.4, 0, 2.1)]),    # 次卧 / 客厅（门）
    (8.0, 3.6, W, 3.6, []),                        # 厨房 / 卫生间
    (8.0, 6.2, W, 6.2, []),                        # 卫生间 / 客厅
]

# 家具（轴对齐包围盒）
FURN = [
    ("沙发", 1.0, 6.1, 3.2, 6.9, 0.8, (108, 96, 84)),
    ("茶几", 1.6, 7.3, 2.6, 7.9, 0.45, (92, 78, 66)),
    ("床", 0.4, 0.3, 2.2, 2.3, 0.5, (120, 128, 140)),
    ("衣柜", 3.3, 0.2, 4.0, 2.0, 2.0, (104, 92, 80)),
    ("餐桌", 6.0, 7.0, 7.4, 8.0, 0.75, (110, 96, 82)),
    ("橱柜", 8.2, 0.15, 11.8, 0.75, 0.9, (96, 100, 106)),
    ("洗手台", 8.3, 3.75, 9.2, 4.15, 0.85, (150, 152, 156)),
]

pts = []


def add(x, y, z, c, itn):
    pts.append((x, y, z, c[0], c[1], c[2], itn))


def seg_len(x1, z1, x2, z2):
    return math.hypot(x2 - x1, z2 - z1)


def in_open(t, y, ops):
    for a, b, y0, y1 in ops:
        if a <= t <= b and y0 <= y <= y1:
            return True
    return False


# ---- 墙：两侧面 + 顶面 ----
for x1, z1, x2, z2, ops in WALLS:
    L = seg_len(x1, z1, x2, z2)
    ux, uz = (x2 - x1) / L, (z2 - z1) / L
    nx, nz = -uz, ux
    n = int(L / WSTEP)
    m = int(H / WSTEP)
    for i in range(n + 1):
        t = i * WSTEP
        px, pz = x1 + ux * t, z1 + uz * t
        for j in range(m + 1):
            y = j * WSTEP + random.uniform(-0.007, 0.007)
            if in_open(t, y, ops):
                continue
            for s in (-1, 1):
                ox = px + nx * s * T / 2
                oz = pz + nz * s * T / 2
                v = random.gauss(0, 7)
                add(ox + random.uniform(-0.008, 0.008), y, oz + random.uniform(-0.008, 0.008),
                    (max(0, min(255, 176 + v)), max(0, min(255, 174 + v)), max(0, min(255, 168 + v))),
                    int(max(50, min(210, 140 + random.gauss(0, 9)))))
        # 墙顶
        for s in (-1, 1):
            add(px + nx * s * T / 4, H + random.uniform(-0.006, 0.006), pz + nz * s * T / 4,
                (168, 166, 160), 132)

# ---- 地面 ----
for i in range(int(W / FSTEP) + 1):
    for j in range(int(D / FSTEP) + 1):
        add(i * FSTEP + random.uniform(-0.02, 0.02), random.uniform(-0.006, 0.006),
            j * FSTEP + random.uniform(-0.02, 0.02),
            (112, 108, 104), int(max(40, min(160, 100 + random.gauss(0, 8)))))

# ---- 天花 ----
for i in range(int(W / 0.10) + 1):
    for j in range(int(D / 0.10) + 1):
        add(i * 0.10 + random.uniform(-0.02, 0.02), H + random.uniform(-0.01, 0.01),
            j * 0.10 + random.uniform(-0.02, 0.02),
            (158, 156, 152), int(max(60, min(190, 128 + random.gauss(0, 8)))))

# ---- 家具：五个面 ----
for name, x0, z0, x1, z1, h, col in FURN:
    nx = max(2, int((x1 - x0) / 0.07))
    nz = max(2, int((z1 - z0) / 0.07))
    ny = max(2, int(h / 0.07))
    for i in range(nx + 1):
        for j in range(ny + 1):
            y = h * j / ny
            add(x0 + (x1 - x0) * i / nx, y + random.uniform(-0.006, 0.006), z0,
                col, int(max(40, min(200, 120 + random.gauss(0, 12)))))
            add(x0 + (x1 - x0) * i / nx, y + random.uniform(-0.006, 0.006), z1,
                col, int(max(40, min(200, 120 + random.gauss(0, 12)))))
    for j in range(nz + 1):
        for k in range(ny + 1):
            y = h * k / ny
            add(x0, y + random.uniform(-0.004, 0.004), z0 + (z1 - z0) * j / nz,
                col, int(max(40, min(200, 118 + random.gauss(0, 12)))))
            add(x1, y + random.uniform(-0.004, 0.004), z0 + (z1 - z0) * j / nz,
                col, int(max(40, min(200, 118 + random.gauss(0, 12)))))
    for i in range(nx + 1):
        for j in range(nz + 1):
            add(x0 + (x1 - x0) * i / nx, h + random.uniform(-0.005, 0.005),
                z0 + (z1 - z0) * j / nz, col, int(max(40, min(200, 128 + random.gauss(0, 10)))))

N = len(pts)
buf = bytearray()
buf += struct.pack("<%df" % (N * 3), *[v for p in pts for v in (p[0], p[1], p[2])])
buf += bytes([v for p in pts for v in (int(p[3]), int(p[4]), int(p[5]))])
buf += bytes([int(p[6]) for p in pts])
buf += bytes([0] * N)

here = os.path.dirname(__file__)
open(os.path.join(here, "data.bin"), "wb").write(buf)

meta = dict(
    count=N, width=W, depth=D, height=H,
    bounds=[0, 0, 0, W, H, D],
    rooms=[
        dict(name="主卧", area=18.9), dict(name="次卧", area=13.68),
        dict(name="厨房", area=14.4), dict(name="卫生间", area=10.4),
        dict(name="客餐厅", area=50.62)
    ],
    total=108.0
)
json.dump(meta, open(os.path.join(here, "meta.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("points", N, "bytes", len(buf))
