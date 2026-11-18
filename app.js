/* Scan2Plan —— 从室内点云自动提取户型平面图
 *
 * 流程：
 *   1. 高度切片        取 0.3–1.6 m 的水平带，避开地面、天花与大部分家具顶面
 *   2. 主方向估计      粗粒度 Hough 变换，找出墙体的主朝向，把点云旋正
 *   3. 占据栅格        投影到水平面，按分辨率累计，去孤立噪点
 *   4. 投影峰值        沿 u / v 两个方向做直方图，峰值即墙线所在位置
 *   5. 游程提取        沿墙线扫描占据情况，允许 ≤1.15 m 的缺口（门洞/窗洞）桥接
 *   6. 房间分割        墙线回填成掩膜，自由空间做连通域，面积 = 格子数 × 分辨率²
 *
 * 依赖：three.js（仅用于左侧 3D 预览，算法本身是纯 JS）
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var view = { pos: null, N: 0, meta: null };
  var result = null;

  // ============ 载入数据 ============
  function load() {
    return Promise.all([
      fetch('meta.json').then(function (r) { return r.json(); }),
      fetch('data.bin').then(function (r) { return r.arrayBuffer(); })
    ]).then(function (res) {
      view.meta = res[0];
      var buf = res[1], N = view.meta.count;
      view.pos = new Float32Array(buf, 0, N * 3);
      view.N = N;
      $('mPts').textContent = N.toLocaleString();
      var tag = $('ptTag'); if (tag) tag.textContent = (N / 1000).toFixed(0) + 'k 点';
      buildThree();
      run();
    });
  }

  // ============ 3D 预览 ============
  var renderer, scene, camera, cloud, geo, sliceBox, cam = { tx: 6, ty: 1.0, tz: 4.5, r: 20, th: 0.80, ph: 0.92 };

  function buildThree() {
    renderer = new THREE.WebGLRenderer({ canvas: $('gl'), antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x0b0f14, 1);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);

    var N = view.N, p = view.pos;
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    var col = new Float32Array(N * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeBoundingSphere();

    cloud = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.058, vertexColors: true, sizeAttenuation: true
    }));
    cloud.frustumCulled = false;
    scene.add(cloud);

    // 地面网格，提供空间参照
    var grid = new THREE.GridHelper(24, 24, 0x2a3b4f, 0x16212d);
    grid.position.set(6, -0.02, 4.5);
    scene.add(grid);

    // 切片范围线框
    sliceBox = new THREE.Group();
    var bg = new THREE.BoxGeometry(1, 1, 1);
    var edges = new THREE.LineSegments(new THREE.EdgesGeometry(bg),
      new THREE.LineBasicMaterial({ color: 0xffa53d, transparent: true, opacity: 0.55 }));
    var face = new THREE.Mesh(bg, new THREE.MeshBasicMaterial({
      color: 0xffa53d, transparent: true, opacity: 0.035, side: THREE.DoubleSide, depthWrite: false
    }));
    sliceBox.add(face); sliceBox.add(edges);
    scene.add(sliceBox);

    applyCam(); resize();
  }

  function applyCam() {
    camera.position.set(
      cam.tx + cam.r * Math.sin(cam.ph) * Math.cos(cam.th),
      cam.ty + cam.r * Math.cos(cam.ph),
      cam.tz + cam.r * Math.sin(cam.ph) * Math.sin(cam.th)
    );
    camera.lookAt(cam.tx, cam.ty, cam.tz);
  }

  function resize() {
    var w = $('gl').clientWidth, h = $('gl').clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  (function bind() {
    var drag = null;
    var c = $('gl');
    c.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, y: e.clientY }; });
    window.addEventListener('pointerup', function () { drag = null; });
    window.addEventListener('pointermove', function (e) {
      if (!drag) return;
      cam.th -= (e.clientX - drag.x) * 0.007;
      cam.ph = Math.max(0.12, Math.min(Math.PI / 2 + 0.4, cam.ph - (e.clientY - drag.y) * 0.006));
      drag = { x: e.clientX, y: e.clientY };
      applyCam();
    });
    c.addEventListener('wheel', function (e) {
      e.preventDefault();
      cam.r = Math.max(4, Math.min(60, cam.r * Math.exp(e.deltaY * 0.0012)));
      applyCam();
    }, { passive: false });
    window.addEventListener('resize', function () { resize(); drawPlan(); });
  })();

  // 切片内的点高亮，其余压暗
  function paintSlice(y0, y1) {
    var col = geo.getAttribute('color').array, p = view.pos, N = view.N;
    var H = (view.meta && view.meta.height) || 2.7;
    for (var i = 0; i < N; i++) {
      var y = p[i * 3 + 1];
      if (y >= y0 && y <= y1) {
        col[i * 3] = 1.0; col[i * 3 + 1] = 0.64; col[i * 3 + 2] = 0.26;
      } else {
        var t = Math.pow(Math.max(0, Math.min(1, y / H)), 0.6);
        col[i * 3] = 0.18 + t * 0.28;
        col[i * 3 + 1] = 0.26 + t * 0.32;
        col[i * 3 + 2] = 0.38 + t * 0.34;
      }
    }
    geo.getAttribute('color').needsUpdate = true;

    // 同步切片线框
    if (sliceBox) {
      var W = view.meta.width, D = view.meta.depth, hgt = Math.max(0.06, y1 - y0);
      sliceBox.scale.set(W, hgt, D);
      sliceBox.position.set(W / 2, (y0 + y1) / 2, D / 2);
    }
    // 切片内点数过少时提示
    var cnt = 0;
    for (var k = 0; k < N; k++) { var yy = p[k * 3 + 1]; if (yy >= y0 && yy <= y1) cnt++; }
    var tip = $('sliceTip');
    if (tip) {
      if (cnt < 6000) { tip.textContent = '当前切片只有 ' + cnt.toLocaleString() + ' 个点，墙面结构不明显，建议把切片拉回 0.3–1.6 m'; tip.style.display = 'block'; }
      else tip.style.display = 'none';
    }
  }

  // ============ 核心算法 ============
  function extract(y0, y1, res) {
    var t0 = performance.now();
    var p = view.pos, N = view.N;

    // --- 1. 切片 ---
    var cap = 0;
    for (var i = 0; i < N; i++) {
      var y = p[i * 3 + 1];
      if (y >= y0 && y <= y1) { cap++; }
    }
    var X = new Float32Array(cap), Z = new Float32Array(cap);
    var k = 0;
    for (var j = 0; j < N; j++) {
      var yy = p[j * 3 + 1];
      if (yy >= y0 && yy <= y1) { X[k] = p[j * 3]; Z[k] = p[j * 3 + 2]; k++; }
    }

    // --- 2. 主方向：粗 Hough ---
    var step = Math.max(1, Math.floor(cap / 20000));
    var maxR = 20, binR = 0.05, nR = Math.ceil(maxR * 2 / binR);
    var best = { th: 0, v: -1 };
    for (var deg = 0; deg < 90; deg += 2) {
      var ct = Math.cos(deg * Math.PI / 180), st = Math.sin(deg * Math.PI / 180);
      var acc = new Uint16Array(nR);
      for (var q = 0; q < cap; q += step) {
        var rho = X[q] * ct + Z[q] * st;
        var b = Math.floor((rho + maxR) / binR);
        if (b >= 0 && b < nR) acc[b]++;
      }
      var mx = 0;
      for (var b2 = 0; b2 < nR; b2++) if (acc[b2] > mx) mx = acc[b2];
      if (mx > best.v) best = { th: deg * Math.PI / 180, v: mx };
    }
    var th = best.th;

    // --- 3. 旋正 + 占据栅格 ---
    var ct2 = Math.cos(-th), st2 = Math.sin(-th);
    var U = new Float32Array(cap), V = new Float32Array(cap);
    var uMin = 1e9, uMax = -1e9, vMin = 1e9, vMax = -1e9;
    for (var m = 0; m < cap; m++) {
      var u = X[m] * ct2 - Z[m] * st2;
      var v = X[m] * st2 + Z[m] * ct2;
      U[m] = u; V[m] = v;
      if (u < uMin) uMin = u; if (u > uMax) uMax = u;
      if (v < vMin) vMin = v; if (v > vMax) vMax = v;
    }
    var gu = Math.ceil((uMax - uMin) / res) + 3;
    var gv = Math.ceil((vMax - vMin) / res) + 3;
    var cnt = new Uint16Array(gu * gv);
    for (var n = 0; n < cap; n++) {
      var iu = Math.floor((U[n] - uMin) / res) + 1;
      var iv = Math.floor((V[n] - vMin) / res) + 1;
      if (iu >= 0 && iu < gu && iv >= 0 && iv < gv) cnt[iv * gu + iu]++;
    }
    // 占据 + 去孤立点
    var occ = new Uint8Array(gu * gv);
    for (var a = 1; a < gv - 1; a++) {
      for (var b3 = 1; b3 < gu - 1; b3++) {
        if (cnt[a * gu + b3] >= 2) {
          var nb = 0;
          for (var da = -1; da <= 1; da++)
            for (var db = -1; db <= 1; db++)
              if (cnt[(a + da) * gu + (b3 + db)] > 0) nb++;
          if (nb >= 2) occ[a * gu + b3] = 1;
        }
      }
    }

    // --- 4. 投影直方图 + 峰值 ---
    var histU = new Int32Array(gu), histV = new Int32Array(gv);
    for (var r2 = 0; r2 < gv; r2++) {
      for (var c2 = 0; c2 < gu; c2++) {
        if (occ[r2 * gu + c2]) { histU[c2]++; histV[r2]++; }
      }
    }
    var peaksU = findPeaks(histU, Math.max(4, 0.16 * maxOf(histU)), Math.round(0.28 / res));
    var peaksV = findPeaks(histV, Math.max(4, 0.16 * maxOf(histV)), Math.round(0.28 / res));

    // --- 5. 沿墙线提取游程（允许门洞缺口桥接） ---
    var gapMax = Math.round(1.15 / res);
    var walls = [], doors = [];

    peaksU.forEach(function (gu0) {
      runsAlong(gu0, true).forEach(function (run) { walls.push(run); });
    });
    peaksV.forEach(function (gv0) {
      runsAlong(gv0, false).forEach(function (run) { walls.push(run); });
    });

    function runsAlong(line, isU) {
      var out = [], len = isU ? gv : gu;
      var gap = 0, start = -1, last = -1, gapsInRun = [];
      for (var t = 0; t < len; t++) {
        var hit = false;
        if (isU) {
          for (var d = -1; d <= 1; d++) if (occ[t * gu + line + d]) { hit = true; break; }
        } else {
          for (var d2 = -1; d2 <= 1; d2++) if (occ[(line + d2) * gu + t]) { hit = true; break; }
        }
        if (hit) {
          if (start < 0) { start = t; }
          else if (gap > 0) { gapsInRun.push([last + 1, t - 1]); }
          last = t; gap = 0;
        } else {
          if (start >= 0) {
            gap++;
            if (gap > gapMax) {
              emit(start, last, gapsInRun);
              start = -1; gap = 0; gapsInRun = [];
            }
          }
        }
      }
      if (start >= 0) emit(start, last, gapsInRun);
      return out;

      function emit(s, e, gaps) {
        var ln = (e - s + 1) * res;
        if (ln < 0.6) return;
        var seg = isU
          ? { x1: uMin + line * res, z1: vMin + s * res, x2: uMin + line * res, z2: vMin + e * res }
          : { x1: uMin + s * res, z1: vMin + line * res, x2: uMin + e * res, z2: vMin + line * res };
        out.push(seg);
        gaps.forEach(function (g) {
          if (g[1] - g[0] < 1) return;
          var gw = (g[1] - g[0] + 1) * res;
          if (gw < 0.6 || gw > 1.4) return;
          doors.push(isU
            ? { x: uMin + line * res, z: vMin + (g[0] + g[1]) / 2 * res, w: gw, dir: 'v' }
            : { x: uMin + (g[0] + g[1]) / 2 * res, z: vMin + line * res, w: gw, dir: 'h' });
        });
      }
    }

    // --- 6. 转回世界坐标 ---
    var ct3 = Math.cos(th), st3 = Math.sin(th);

    function mapSeg(s) {
      var p1 = rot(s.x1, s.z1), p2 = rot(s.x2, s.z2);
      return { x1: p1.x, z1: p1.z, x2: p2.x, z2: p2.z };
    }
    function rot(u, v) { return { x: u * ct3 - v * st3, z: u * st3 + v * ct3 }; }

    walls = walls.map(mapSeg);
    doors = doors.map(function (d) {
      var q = rot(d.x, d.z);
      return { x: q.x, z: q.z, w: d.w, dir: d.dir };
    });

    // --- 7. 房间分割：墙线回填掩膜 + 连通域 ---
    var W = view.meta.width, D = view.meta.depth;
    var rg = Math.max(0.03, res), ngx = Math.ceil(W / rg) + 2, ngz = Math.ceil(D / rg) + 2;
    var wallMask = new Uint8Array(ngx * ngz);
    walls.forEach(function (s) {
      var dx = s.x2 - s.x1, dz = s.z2 - s.z1, L = Math.hypot(dx, dz);
      var steps = Math.max(1, Math.ceil(L / (rg * 0.5)));
      for (var t = 0; t <= steps; t++) {
        var x = s.x1 + dx * t / steps, z = s.z1 + dz * t / steps;
        for (var ox = -0.07; ox <= 0.07; ox += rg * 0.5) {
          for (var oz = -0.07; oz <= 0.07; oz += rg * 0.5) {
            var gx = Math.floor((x + ox) / rg), gz = Math.floor((z + oz) / rg);
            if (gx >= 0 && gx < ngx && gz >= 0 && gz < ngz) wallMask[gz * ngx + gx] = 1;
          }
        }
      }
    });

    var seen = new Uint8Array(ngx * ngz), rooms = [];
    var cellArea = rg * rg;
    for (var z0 = 0; z0 < ngz; z0++) {
      for (var x0 = 0; x0 < ngx; x0++) {
        var id0 = z0 * ngx + x0;
        if (wallMask[id0] || seen[id0]) continue;
        // BFS
        var stack = [id0], cells = [], area = 0, sx2 = 0, sz2 = 0;
        seen[id0] = 1;
        while (stack.length) {
          var cur = stack.pop();
          var cx = cur % ngx, cz = (cur - cx) / ngx;
          cells.push(cur);
          area += cellArea; sx2 += cx; sz2 += cz;
          var nx4 = [cx - 1, cx + 1, cx, cx], nz4 = [cz, cz, cz - 1, cz + 1];
          for (var d3 = 0; d3 < 4; d3++) {
            var na = nz4[d3], nb2 = nx4[d3];
            if (na < 0 || nb2 < 0 || na >= ngz || nb2 >= ngx) continue;
            var nid = na * ngx + nb2;
            if (!wallMask[nid] && !seen[nid]) { seen[nid] = 1; stack.push(nid); }
          }
        }
        if (area >= 2.5 && area <= 0.85 * W * D) {
          rooms.push({
            area: area,
            cx: (sx2 / cells.length + 0.5) * rg,
            cz: (sz2 / cells.length + 0.5) * rg,
            cells: cells
          });
        }
      }
    }
    rooms.sort(function (a, b) { return b.area - a.area; });
    rooms.forEach(function (r, i) { r.name = '空间 ' + (i + 1); });

    var wallLen = walls.reduce(function (s, w) { return s + Math.hypot(w.x2 - w.x1, w.z2 - w.z1); }, 0);
    var totalArea = rooms.reduce(function (s, r) { return s + r.area; }, 0);

    return {
      walls: walls, doors: doors, rooms: rooms,
      theta: th * 180 / Math.PI, res: res, y0: y0, y1: y1,
      wallLen: wallLen, totalArea: totalArea,
      ms: performance.now() - t0,
      occ: { grid: occ, gu: gu, gv: gv, res: res, uMin: uMin, vMin: vMin, th: th }
    };
  }

  function maxOf(arr) { var m = 0; for (var i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i]; return m; }

  // 峰值检测：局部极大 + 阈值 + 最小间距（墙的两个面会被合并成一条中心线）
  function findPeaks(hist, thr, minDist) {
    var idx = [];
    for (var i = 1; i < hist.length - 1; i++) {
      if (hist[i] >= thr && hist[i] >= hist[i - 1] && hist[i] >= hist[i + 1]) idx.push(i);
    }
    idx.sort(function (a, b) { return hist[b] - hist[a]; });
    var out = [];
    idx.forEach(function (p) {
      for (var k = 0; k < out.length; k++) if (Math.abs(out[k] - p) < minDist) return;
      out.push(p);
    });
    return out.sort(function (a, b) { return a - b; });
  }

  // ============ 2D 平面图绘制 ============
  var cv = $('plan'), ctx = cv.getContext('2d');

  function drawPlan() {
    if (!result || !view.pos) return;
    var W = view.meta.width, D = view.meta.depth;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var cw = cv.clientWidth, ch = cv.clientHeight;
    cv.width = cw * dpr; cv.height = ch * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    var pad = 26, sc = Math.min((cw - pad * 2) / W, (ch - pad * 2) / D);
    var ox = (cw - W * sc) / 2, oz = (ch - D * sc) / 2;
    function TX(x) { return ox + x * sc; }
    function TZ(z) { return oz + z * sc; }

    // 底色
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(TX(0), TZ(0), W * sc, D * sc);
    ctx.strokeStyle = '#eef1f5'; ctx.lineWidth = 1;
    for (var gx = 0; gx <= W; gx++) { ctx.beginPath(); ctx.moveTo(TX(gx), TZ(0)); ctx.lineTo(TX(gx), TZ(D)); ctx.stroke(); }
    for (var gz = 0; gz <= D; gz++) { ctx.beginPath(); ctx.moveTo(TX(0), TZ(gz)); ctx.lineTo(TX(W), TZ(gz)); ctx.stroke(); }

    // 房间填充
    if ($('lyRoom').checked) {
      ctx.fillStyle = 'rgba(37,99,235,.07)';
      result.rooms.forEach(function (r) {
        ctx.beginPath();
        r.cells.forEach(function (c) {
          var w = result.area_rg, ngx = result.area_ngx;
          var cx = c % ngx, cz = (c - cx) / ngx;
          ctx.rect(TX(cx * w), TZ(cz * w), w * sc + 0.6, w * sc + 0.6);
        });
        ctx.fill();
      });
    }

    // 点云投影
    if ($('lyPts').checked) {
      var p = view.pos, N = view.N;
      ctx.fillStyle = 'rgba(120,132,150,.30)';
      for (var i = 0; i < N; i += 2) {
        var y = p[i * 3 + 1];
        if (y < 0.25 || y > 1.7) continue;
        ctx.fillRect(TX(p[i * 3]) - 0.6, TZ(p[i * 3 + 2]) - 0.6, 1.2, 1.2);
      }
    }

    // 栅格层
    if ($('lyGrid').checked && result.occ) {
      var o = result.occ, ct = Math.cos(o.th), st = Math.sin(o.th);
      ctx.fillStyle = 'rgba(14,165,233,.35)';
      for (var v = 0; v < o.gv; v++) {
        for (var u = 0; u < o.gu; u++) {
          if (!o.grid[v * o.gu + u]) continue;
          var uu = (u + o.uMin) * o.res, vv = (v + o.vMin) * o.res;
          var wx = uu * ct - vv * st, wz = uu * st + vv * ct;
          ctx.fillRect(TX(wx) - 0.7, TZ(wz) - 0.7, 1.4, 1.4);
        }
      }
    }

    // 墙体：按真实墙厚画双线 + 填充
    var hw = 0.09;
    ctx.fillStyle = '#cfe0ff';
    result.walls.forEach(function (s) {
      var dx = s.x2 - s.x1, dz = s.z2 - s.z1, L = Math.hypot(dx, dz) || 1;
      var nx = -dz / L * hw, nz = dx / L * hw;
      ctx.beginPath();
      ctx.moveTo(TX(s.x1 + nx), TZ(s.z1 + nz));
      ctx.lineTo(TX(s.x2 + nx), TZ(s.z2 + nz));
      ctx.lineTo(TX(s.x2 - nx), TZ(s.z2 - nz));
      ctx.lineTo(TX(s.x1 - nx), TZ(s.z1 - nz));
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(TX(s.x1), TZ(s.z1), hw * sc, 0, 6.2832);
      ctx.arc(TX(s.x2), TZ(s.z2), hw * sc, 0, 6.2832);
      ctx.fill();
    });
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    result.walls.forEach(function (s) {
      var dx = s.x2 - s.x1, dz = s.z2 - s.z1, L = Math.hypot(dx, dz) || 1;
      var nx = -dz / L * hw, nz = dx / L * hw;
      ctx.beginPath();
      ctx.moveTo(TX(s.x1 + nx), TZ(s.z1 + nz));
      ctx.lineTo(TX(s.x2 + nx), TZ(s.z2 + nz));
      ctx.moveTo(TX(s.x1 - nx), TZ(s.z1 - nz));
      ctx.lineTo(TX(s.x2 - nx), TZ(s.z2 - nz));
      ctx.stroke();
    });

    // 门洞标记
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2.5;
    result.doors.forEach(function (d) {
      var h = 0.28;
      ctx.beginPath();
      if (d.dir === 'v') { ctx.moveTo(TX(d.x), TZ(d.z - h)); ctx.lineTo(TX(d.x), TZ(d.z + h)); }
      else { ctx.moveTo(TX(d.x - h), TZ(d.z)); ctx.lineTo(TX(d.x + h), TZ(d.z)); }
      ctx.stroke();
    });

    // 房间标注
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    result.rooms.forEach(function (r) {
      ctx.fillStyle = 'rgba(26,29,35,.78)';
      ctx.font = '600 12px -apple-system,"PingFang SC",sans-serif';
      ctx.fillText(r.name, TX(r.cx), TZ(r.cz) - 7);
      ctx.fillStyle = 'rgba(91,100,114,.9)';
      ctx.font = '11px -apple-system,"PingFang SC",sans-serif';
      ctx.fillText(r.area.toFixed(1) + ' ㎡', TX(r.cx), TZ(r.cz) + 8);
    });

    // 比例尺
    var scLen = 2, px = scLen * sc;
    ctx.strokeStyle = '#8b93a1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cw - 24 - px, ch - 18); ctx.lineTo(cw - 24, ch - 18);
    ctx.moveTo(cw - 24 - px, ch - 22); ctx.lineTo(cw - 24 - px, ch - 14);
    ctx.moveTo(cw - 24, ch - 22); ctx.lineTo(cw - 24, ch - 14);
    ctx.stroke();
    ctx.fillStyle = '#8b93a1'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('2 m', cw - 24 - px / 2, ch - 6);
  }

  // ============ 主流程 ============
  function run() {
    var y0 = +$('y0').value, y1 = +$('y1').value, res = +$('res').value;
    if (y1 - y0 < 0.2) return;
    $('busy').classList.add('on');
    setTimeout(function () {
      result = extract(y0, y1, res);

      // 房间栅格参数（供绘制使用）
      result.area_rg = Math.max(0.03, res);
      result.area_ngx = Math.ceil(view.meta.width / result.area_rg) + 2;
      $('lyGrid').checked = false;

      paintSlice(y0, y1);
      drawPlan();

      $('mWalls').textContent = result.walls.length;
      $('mRooms').textContent = result.rooms.length;
      $('mMs').textContent = Math.round(result.ms) + ' ms';
      $('sRooms').textContent = result.rooms.length;
      $('sArea').textContent = result.totalArea.toFixed(1) + ' ㎡';
      $('sLen').textContent = result.wallLen.toFixed(1) + ' m';
      $('sWalls').textContent = result.walls.length;
      $('sMs').textContent = Math.round(result.ms) + ' ms';
      if (view.meta.total) {
        $('sTruth').textContent = view.meta.total.toFixed(1) + ' ㎡';
        var err = (result.totalArea - view.meta.total) / view.meta.total * 100;
        $('sErr').textContent = (err > 0 ? '+' : '') + err.toFixed(1) + '%';
        $('sErr').style.color = Math.abs(err) < 10 ? '#10b981' : '#ef4444';
      }
      $('dirTxt').textContent = '主方向 ' + result.theta.toFixed(0) + '°　切片 ' + y0.toFixed(2) + '–' + y1.toFixed(2) + ' m';
      $('busy').classList.remove('on');
    }, 30);
  }

  // ============ 导出 ============
  function download(name, text, mime) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain;charset=utf-8' }));
    a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  $('btnSvg').addEventListener('click', function () {
    if (!result) return;
    var W = view.meta.width, D = view.meta.depth, S = 100;
    var s = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + (W * S) + '" height="' + (D * S) + '" viewBox="0 0 ' + (W * S) + ' ' + (D * S) + '">'];
    s.push('<rect width="100%" height="100%" fill="#fff"/>');
    result.rooms.forEach(function (r) {
      s.push('<circle cx="' + (r.cx * S) + '" cy="' + (r.cz * S) + '" r="1" fill="none"/>');
      s.push('<text x="' + (r.cx * S) + '" y="' + (r.cz * S) + '" font-size="26" text-anchor="middle" fill="#1a1d23">' + r.name + '</text>');
      s.push('<text x="' + (r.cx * S) + '" y="' + (r.cz * S + 30) + '" font-size="22" text-anchor="middle" fill="#5b6472">' + r.area.toFixed(1) + ' ㎡</text>');
    });
    result.walls.forEach(function (w) {
      s.push('<line x1="' + (w.x1 * S) + '" y1="' + (w.z1 * S) + '" x2="' + (w.x2 * S) + '" y2="' + (w.z2 * S) + '" stroke="#2563eb" stroke-width="16" stroke-linecap="round"/>');
    });
    s.push('</svg>');
    download('floorplan.svg', s.join('\n'), 'image/svg+xml');
  });

  $('btnJson').addEventListener('click', function () {
    if (!result) return;
    var out = {
      slice: { y0: result.y0, y1: result.y1 },
      resolution: result.res,
      dominantAngleDeg: +result.theta.toFixed(2),
      walls: result.walls.map(function (w) {
        return { x1: +w.x1.toFixed(3), z1: +w.z1.toFixed(3), x2: +w.x2.toFixed(3), z2: +w.z2.toFixed(3) };
      }),
      doors: result.doors.map(function (d) { return { x: +d.x.toFixed(3), z: +d.z.toFixed(3), width: +d.w.toFixed(2) }; }),
      rooms: result.rooms.map(function (r) { return { name: r.name, areaSqm: +r.area.toFixed(2), center: [+r.cx.toFixed(2), +r.cz.toFixed(2)] }; }),
      totalAreaSqm: +result.totalArea.toFixed(2),
      wallLengthM: +result.wallLen.toFixed(2),
      elapsedMs: +result.ms.toFixed(1)
    };
    download('floorplan.json', JSON.stringify(out, null, 2), 'application/json');
  });

  // ============ 交互 ============
  $('y0').addEventListener('input', function () { $('y0v').textContent = (+this.value).toFixed(2); });
  $('y1').addEventListener('input', function () { $('y1v').textContent = (+this.value).toFixed(2); });
  ['y0', 'y1', 'res'].forEach(function (id) {
    $(id).addEventListener('change', run);
  });
  ['lyPts', 'lyGrid', 'lyRoom'].forEach(function (id) {
    $(id).addEventListener('change', drawPlan);
  });
  $('btnRun').addEventListener('click', run);

  // ============ 渲染循环（3D） ============
  function loop() {
    requestAnimationFrame(loop);
    if (renderer && scene) renderer.render(scene, camera);
  }

  (function readParams() {
    var q = new URLSearchParams(location.search);
    if (q.has('y0')) { $('y0').value = q.get('y0'); $('y0v').textContent = (+$('y0').value).toFixed(2); }
    if (q.has('y1')) { $('y1').value = q.get('y1'); $('y1v').textContent = (+$('y1').value).toFixed(2); }
    if (q.has('res')) { $('res').value = q.get('res'); }
  })();

  load().then(function () { requestAnimationFrame(loop); });
  window.__s2p = { get result() { return result; }, run: run };
})();
