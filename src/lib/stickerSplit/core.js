/* StickerSplit core — 通用贴纸/头像切图核心算法(零依赖、无 DOM)
 * 浏览器: <script src="core.js"></script> → window.StickerSplit
 * Node:   const { analyze } = require('./core.js')
 *
 * 管线: 前景掩码(alpha/颜色键) → OR池化降采样 → 去噪 → 8连通域
 *       → 分组(沟道网格 / 肘部邻近 / 不合并 / 自动) → 阅读顺序 → 原分辨率裁剪框
 * 原则: 检测用降采样图(≤maxAnalyzeDim), 裁剪坐标始终映射回原始分辨率。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StickerSplit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var defaults = {
    source: 'auto',      // 'auto' | 'alpha' | 'color'
    threshold: 128,      // alpha 模式前景阈值
    bgTolerance: 30,     // color 模式与背景色的切比雪夫距离容差
    bg: null,            // color 模式显式背景色 [r,g,b]; null=四边中位数
    minSize: 'auto',     // 连通域最小面积(原始px); auto=max(16, 图面积*0.05%)
    group: 'auto',       // 'auto' | 'grid' | 'prox' | 'none'
    gap: 'auto',         // prox 合并间隙(原始px); auto=肘部估计
    padding: 'auto',     // 裁剪外扩(原始px); auto=max(4, 最大边*1%)
    maxAnalyzeDim: 1000, // 分析图最大边
  };

  // 两包围盒的切比雪夫间隙(负数视为 0)
  function boxGap(a, b) {
    var dx = Math.max(a.x0 - b.x1, b.x0 - a.x1, 0);
    var dy = Math.max(a.y0 - b.y1, b.y0 - a.y1, 0);
    return Math.max(dx, dy);
  }

  function borderMedian(data, W, H) {
    var rs = [], gs = [], bs = [];
    var step = Math.max(1, Math.floor(Math.max(W, H) / 200));
    for (var x = 0; x < W; x += step) {
      collect(x, 0); collect(x, H - 1);
    }
    for (var y = 0; y < H; y += step) {
      collect(0, y); collect(W - 1, y);
    }
    function collect(x, y) {
      var i = (y * W + x) * 4;
      rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
    }
    function med(a) { a.sort(function (p, q) { return p - q; }); return a[a.length >> 1]; }
    return [med(rs), med(gs), med(bs)];
  }

  // 轴向分带: 内部空带(不触边且宽≥3px)视为沟道, 返回沟道中心数组
  function guttersOf(fill) {
    var n = fill.length, out = [], runStart = -1;
    for (var i = 0; i <= n; i++) {
      var empty = i < n && !fill[i];
      if (empty && runStart < 0) runStart = i;
      if ((!empty || i === n) && runStart >= 0) {
        if (runStart > 0 && i - 1 < n - 1 && i - runStart >= 3) out.push(((runStart + i - 1) / 2) | 0);
        runStart = -1;
      }
    }
    return out;
  }

  function analyze(imageData, opts) {
    var t0 = Date.now();
    var o = {};
    for (var k in defaults) o[k] = defaults[k];
    if (opts) for (var k2 in opts) o[k2] = opts[k2];
    var W = imageData.width, H = imageData.height, data = imageData.data;

    // ---- 1. 来源判定: 存在半透明像素(采样) → alpha, 否则 color ----
    var source = o.source;
    if (source === 'auto') {
      var translucent = 0, sampled = 0;
      var step = Math.max(1, Math.floor(Math.sqrt(W * H / 20000)));
      for (var sy = 0; sy < H; sy += step)
        for (var sx = 0; sx < W; sx += step) {
          sampled++;
          if (data[(sy * W + sx) * 4 + 3] < 250) translucent++;
        }
      source = translucent > sampled * 0.001 ? 'alpha' : 'color';
    }
    var bg = o.bg ? o.bg : (source === 'color' ? borderMedian(data, W, H) : null);

    // ---- 2. OR池化降采样掩码: 单元格内任一原始像素为前景即置位(细线不丢) ----
    var scale = Math.max(1, Math.ceil(Math.max(W, H) / o.maxAnalyzeDim));
    var w2 = Math.max(1, Math.floor(W / scale)), h2 = Math.max(1, Math.floor(H / scale));
    var mask = new Uint8Array(w2 * h2);
    var thr = o.threshold, tol = o.bgTolerance;
    for (var y = 0; y < H; y++) {
      var row = ((y / scale) | 0) * w2;
      for (var x = 0; x < W; x++) {
        var i = (y * W + x) * 4, fg;
        if (source === 'alpha') fg = data[i + 3] >= thr;
        else fg = Math.max(Math.abs(data[i] - bg[0]), Math.abs(data[i + 1] - bg[1]), Math.abs(data[i + 2] - bg[2])) > tol;
        if (fg) mask[row + ((x / scale) | 0)] = 1;
      }
    }

    // ---- 3. 8连通域(迭代栈泛洪); id 显式分配, 与数组下标解耦 ----
    var label = new Int32Array(w2 * h2);
    var comps = [], nextId = 1;
    var stack = new Int32Array(w2 * h2), sp = 0;
    for (var s = 0; s < mask.length; s++) {
      if (!mask[s] || label[s]) continue;
      var id = nextId++;
      label[s] = id; stack[sp++] = s;
      var x0 = w2, y0 = h2, x1 = 0, y1 = 0, area = 0;
      while (sp) {
        var p = stack[--sp];
        var px = p % w2, py = (p - px) / w2;
        area++;
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
        for (var dy = -1; dy <= 1; dy++) {
          var qy = py + dy;
          if (qy < 0 || qy >= h2) continue;
          for (var dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            var qx = px + dx;
            if (qx < 0 || qx >= w2) continue;
            var q = qy * w2 + qx;
            if (mask[q] && !label[q]) { label[q] = id; stack[sp++] = q; }
          }
        }
      }
      comps.push({ id: id, x0: x0, y0: y0, x1: x1, y1: y1, area: area, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
    }

    // ---- 3b. 拆分"桥接链"(距离变换标记 + 测地最近重分配):
    // 相邻贴纸的光晕在阈值之上相连时, 连通域会把多张贴纸并成一条链。
    // 窄颈处"到背景的距离"小, 身体处大 → 腐蚀距离扫描, 链先断开成多个标记,
    // 再把整块像素按测地最近分给各标记(标记分水岭)。凸形单体贴纸不会被误拆。
    (function splitBridged() {
      var maxRounds = 8;
      for (var round = 0; round < maxRounds; round++) {
        if (comps.length < 1) return;
        var areas = comps.map(function (c) { return c.area; }).sort(function (a, b) { return a - b; });
        var med = areas[areas.length >> 1];
        var splitAt = -1, newParts = null;
        for (var ci = 0; ci < comps.length; ci++) {
          var c = comps[ci];
          if (c.area < 400) continue;                       // 太小不值得拆
          var bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
          var aspect = bw / bh; if (aspect < 1) aspect = 1 / aspect;
          var worth = (comps.length >= 2 && c.area > med * 1.6) || aspect > 2.5;
          if (!worth) continue;
          var parts = trySplit(c);
          if (parts && parts.length >= 2) { splitAt = ci; newParts = parts; break; }
        }
        if (splitAt < 0) return;
        comps.splice.apply(comps, [splitAt, 1].concat(newParts));
      }

      function trySplit(c) {
        var bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
        var cap = Math.floor(Math.min(bw, bh) / 3);
        if (cap < 2) return null;
        // 距离变换(本域内, 到域边界的 chamfer 距离)
        var INF = 1e9;
        var dt = new Float32Array(bw * bh);
        for (var yy = 0; yy < bh; yy++)
          for (var xx = 0; xx < bw; xx++)
            dt[yy * bw + xx] = label[(yy + c.y0) * w2 + xx + c.x0] === c.id ? INF : 0;
        var D1 = 1, D2 = 1.4142;
        for (var y1p = 0; y1p < bh; y1p++)
          for (var x1p = 0; x1p < bw; x1p++) {
            var i1 = y1p * bw + x1p; if (dt[i1] === 0) continue;
            var v = dt[i1];
            if (x1p > 0 && dt[i1 - 1] + D1 < v) v = dt[i1 - 1] + D1;
            if (y1p > 0 && dt[i1 - bw] + D1 < v) v = dt[i1 - bw] + D1;
            if (x1p > 0 && y1p > 0 && dt[i1 - bw - 1] + D2 < v) v = dt[i1 - bw - 1] + D2;
            if (x1p < bw - 1 && y1p > 0 && dt[i1 - bw + 1] + D2 < v) v = dt[i1 - bw + 1] + D2;
            dt[i1] = v;
          }
        for (var y2p = bh - 1; y2p >= 0; y2p--)
          for (var x2p = bw - 1; x2p >= 0; x2p--) {
            var i2 = y2p * bw + x2p; if (dt[i2] === 0) continue;
            var v2 = dt[i2];
            if (x2p < bw - 1 && dt[i2 + 1] + D1 < v2) v2 = dt[i2 + 1] + D1;
            if (y2p < bh - 1 && dt[i2 + bw] + D1 < v2) v2 = dt[i2 + bw] + D1;
            if (x2p < bw - 1 && y2p < bh - 1 && dt[i2 + bw + 1] + D2 < v2) v2 = dt[i2 + bw + 1] + D2;
            if (x2p > 0 && y2p < bh - 1 && dt[i2 + bw - 1] + D2 < v2) v2 = dt[i2 + bw - 1] + D2;
            dt[i2] = v2;
          }
        // 腐蚀距离扫描(几何步长): 首次断成 ≥2 个够大的标记即采纳
        var partFloor = Math.max(30, Math.round(c.area * 0.06));
        var ts = [];
        for (var t = 2; t <= cap; t = Math.max(t + 1, Math.round(t * 1.35))) ts.push(t);
        for (var ti = 0; ti < ts.length; ti++) {
          var t = ts[ti];
          var seen = new Int32Array(bw * bh);
          var marks = [];
          var q2 = new Int32Array(bw * bh), qh2 = 0, qt2 = 0;
          for (var sy3 = 0; sy3 < bh; sy3++)
            for (var sx3 = 0; sx3 < bw; sx3++) {
              var i3 = sy3 * bw + sx3;
              if (seen[i3] || dt[i3] < t) continue;
              var mk = marks.length + 1;
              seen[i3] = mk; q2[qt2++] = i3;
              var mArea = 0;
              while (qh2 < qt2) {
                var p3 = q2[qh2++]; mArea++;
                var p3x = p3 % bw, p3y = (p3 - p3x) / bw;
                if (p3x > 0 && !seen[p3 - 1] && dt[p3 - 1] >= t) { seen[p3 - 1] = mk; q2[qt2++] = p3 - 1; }
                if (p3x < bw - 1 && !seen[p3 + 1] && dt[p3 + 1] >= t) { seen[p3 + 1] = mk; q2[qt2++] = p3 + 1; }
                if (p3y > 0 && !seen[p3 - bw] && dt[p3 - bw] >= t) { seen[p3 - bw] = mk; q2[qt2++] = p3 - bw; }
                if (p3y < bh - 1 && !seen[p3 + bw] && dt[p3 + bw] >= t) { seen[p3 + bw] = mk; q2[qt2++] = p3 + bw; }
              }
              marks.push({ cells: mArea });
            }
          var big = marks.filter(function (m) { return m.cells >= partFloor; });
          if (big.length >= 2) return reassign(c, dt, seen, t);
        }
        return null;
      }

      // 把整块像素按测地最近分给 ≥t 的标记(BFS), 生成新连通域
      function reassign(c, dt, seen, t) {
        var bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
        // 重新编号有效标记
        var mkIds = {}, mkCount = 0;
        for (var i4 = 0; i4 < seen.length; i4++) {
          var m = seen[i4];
          if (m && dt[i4] >= t && mkIds[m] === undefined) mkIds[m] = ++mkCount;
        }
        if (mkCount < 2) return null;
        var part = new Int32Array(bw * bh);   // 0=未分配, 1..mkCount
        var q3 = new Int32Array(bw * bh), qh3 = 0, qt3 = 0;
        for (var i5 = 0; i5 < seen.length; i5++) {
          if (seen[i5] && dt[i5] >= t) {
            part[i5] = mkIds[seen[i5]];
            q3[qt3++] = i5;
          }
        }
        while (qh3 < qt3) {
          var p4 = q3[qh3++];
          var p4x = p4 % bw, p4y = (p4 - p4x) / bw, l4 = part[p4];
          var nbs = [p4x > 0 ? p4 - 1 : -1, p4x < bw - 1 ? p4 + 1 : -1, p4y > 0 ? p4 - bw : -1, p4y < bh - 1 ? p4 + bw : -1];
          for (var ni = 0; ni < 4; ni++) {
            var n = nbs[ni];
            if (n < 0 || part[n]) continue;
            if (dt[n] === 0) continue;        // 只在本域像素内传播
            part[n] = l4; q3[qt3++] = n;
          }
        }
        var out = [];
        for (var mk2 = 1; mk2 <= mkCount; mk2++) {
          var X0 = bw, Y0 = bh, X1 = 0, Y1 = 0, A = 0;
          for (var yy2 = 0; yy2 < bh; yy2++)
            for (var xx2 = 0; xx2 < bw; xx2++) {
              var i6 = yy2 * bw + xx2;
              if (part[i6] !== mk2) continue;
              A++;
              if (xx2 < X0) X0 = xx2; if (xx2 > X1) X1 = xx2;
              if (yy2 < Y0) Y0 = yy2; if (yy2 > Y1) Y1 = yy2;
              label[(yy2 + c.y0) * w2 + xx2 + c.x0] = nextId;
            }
          if (A >= 30) out.push({ id: nextId++, x0: X0 + c.x0, y0: Y0 + c.y0, x1: X1 + c.x0, y1: Y1 + c.y0, area: A, cx: (X0 + X1) / 2 + c.x0, cy: (Y0 + Y1) / 2 + c.y0 });
        }
        return out.length >= 2 ? out : null;
      }
    })();

    // ---- 4. 去噪 ----
    var minSizePx = o.minSize === 'auto' ? Math.max(16, Math.round(W * H * 0.0005)) : Math.max(0, +o.minSize);
    var kept = [], keepIdx = [];
    for (var ki = 0; ki < comps.length; ki++)
      if (comps[ki].area * scale * scale >= minSizePx) { kept.push(comps[ki]); keepIdx.push(ki); }

    var emptyResult = function (mode, sg) {
      return {
        width: W, height: H, source: source, bg: bg, scale: scale, mode: mode,
        components: kept, boxes: [], suggestGap: sg,
        stats: { ms: Date.now() - t0, componentsRaw: comps.length, components: kept.length, groups: 0 },
      };
    };
    if (!kept.length) return emptyResult('none', 0);

    // ---- 5. 分组 ----
    var capA = 0.08 * Math.max(W, H) / scale; // 自动 gap 上限(分析px), 防灾难合并
    // 5a. prox: 两两间隙单链接聚类 + 肘部切割
    var n = kept.length;
    var pairs = [];
    for (var a = 0; a < n; a++)
      for (var b = a + 1; b < n; b++) pairs.push([boxGap(kept[a], kept[b]), a, b]);
    pairs.sort(function (u, v) { return u[0] - v[0]; });
    function clusterWith(cut) {
      var uf = new Int32Array(n);
      for (var i = 0; i < n; i++) uf[i] = i;
      function find(x) { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; }
      for (var i2 = 0; i2 < pairs.length; i2++) {
        var pr = pairs[i2];
        if (pr[0] > cut) break;
        var ra = find(pr[1]), rb = find(pr[2]);
        if (ra !== rb) uf[ra] = rb;
      }
      var map = {}, clusters = [];
      for (var i3 = 0; i3 < n; i3++) {
        var r = find(i3);
        if (map[r] === undefined) { map[r] = clusters.length; clusters.push([]); }
        clusters[map[r]].push(i3);
      }
      return clusters;
    }
    // 肘部: 合并距离序列首次出现 ≥2 倍跳变处切割
    var mergeDists = [];
    (function () {
      var uf = new Int32Array(n);
      for (var i = 0; i < n; i++) uf[i] = i;
      function find(x) { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; }
      for (var i2 = 0; i2 < pairs.length; i2++) {
        var pr = pairs[i2];
        var ra = find(pr[1]), rb = find(pr[2]);
        if (ra !== rb) { uf[ra] = rb; mergeDists.push(pr[0]); }
      }
    })();
    var elbowCut = 0;
    for (var m = 1; m < mergeDists.length; m++) {
      if (mergeDists[m] >= 2 * Math.max(1, mergeDists[m - 1])) { elbowCut = mergeDists[m - 1]; break; }
    }
    var sortedD = mergeDists.slice().sort(function (u, v) { return u - v; });
    var medianD = sortedD.length ? sortedD[(sortedD.length - 1) >> 1] : 0;
    var suggestGapA = Math.min(elbowCut > 0 ? elbowCut : medianD, capA);
    var useCut = o.gap !== 'auto' ? Math.max(0, +o.gap / scale) : Math.min(elbowCut, capA);

    // 5b. grid: 沟道分带, 组件中心归入 (列带, 行带) 单元
    var fillX = new Uint8Array(w2), fillY = new Uint8Array(h2);
    for (var c2 = 0; c2 < n; c2++) {
      var cc = kept[c2];
      for (var fx = cc.x0; fx <= cc.x1; fx++) fillX[fx] = 1;
      for (var fy = cc.y0; fy <= cc.y1; fy++) fillY[fy] = 1;
    }
    var gx = guttersOf(fillX), gy = guttersOf(fillY);
    function bandIdx(gutters, v) {
      var k = 0;
      while (k < gutters.length && gutters[k] <= v) k++;
      return k;
    }
    var mode;
    var clusters;
    if (o.group === 'none') {
      mode = 'none';
      clusters = kept.map(function (_, idx) { return [idx]; });
    } else if (o.group === 'grid') {
      mode = 'grid';
      // 同格 ∪ 间隙≤useCut 双关系联合: 亚沟道(卫星与主体间的窄空隙)不该切开对象
      var uf2 = new Int32Array(n);
      for (var i4 = 0; i4 < n; i4++) uf2[i4] = i4;
      function find2(x) { while (uf2[x] !== x) { uf2[x] = uf2[uf2[x]]; x = uf2[x]; } return x; }
      var cellRoot = {};
      for (var c4 = 0; c4 < n; c4++) {
        var key2 = bandIdx(gx, kept[c4].cx) * 1000003 + bandIdx(gy, kept[c4].cy);
        if (cellRoot[key2] === undefined) cellRoot[key2] = c4;
        var ra0 = find2(c4), rb0 = find2(cellRoot[key2]);
        if (ra0 !== rb0) uf2[ra0] = rb0;
      }
      for (var i5 = 0; i5 < pairs.length; i5++) {
        if (pairs[i5][0] > useCut) break;
        var ra2 = find2(pairs[i5][1]), rb2 = find2(pairs[i5][2]);
        if (ra2 !== rb2) uf2[ra2] = rb2;
      }
      var gmap = {}, gcells = [];
      for (var i6 = 0; i6 < n; i6++) {
        var r6 = find2(i6);
        if (gmap[r6] === undefined) { gmap[r6] = gcells.length; gcells.push([]); }
        gcells[gmap[r6]].push(i6);
      }
      clusters = gcells;
    } else if (o.group === 'prox') {
      mode = 'prox';
      clusters = clusterWith(useCut);
    } else {
      // auto(默认): 尺寸断崖识别主贴纸簇, 崖下的连通域(装饰/碎片)挂到最近的贴纸。
      // 贴纸拼图里贴纸尺寸相近而装饰物小一个量级 —— 按面积降序找第一个 ≥2.5× 的
      // 相对断崖(且崖下远小于最大贴纸), 崖上=贴纸本纸, 崖下=装饰。无断崖则全部是贴纸。
      mode = 'auto';
      var attachCap = o.gap !== 'auto' ? Math.max(0, +o.gap / scale)
        : 0.15 * Math.max(W, H) / scale; // 装饰挂靠距离上限
      var byDesc = kept.map(function (c, i) { return i; })
        .sort(function (a, b) { return kept[b].area - kept[a].area; });
      var cutIdx = byDesc.length;              // 无断崖: 全是贴纸
      for (var gi = 0; gi < byDesc.length - 1; gi++) {
        var aBig = kept[byDesc[gi]].area, aSmall = kept[byDesc[gi + 1]].area;
        if (aBig >= aSmall * 2.5 && aSmall < kept[byDesc[0]].area * 0.35) { cutIdx = gi + 1; break; }
      }
      var majorSet = {};
      for (var gj = 0; gj < cutIdx; gj++) majorSet[byDesc[gj]] = 1;
      var uf3 = new Int32Array(n);
      for (var i7 = 0; i7 < n; i7++) uf3[i7] = i7;
      function find3(x) { while (uf3[x] !== x) { uf3[x] = uf3[uf3[x]]; x = uf3[x]; } return x; }
      for (var i9 = 0; i9 < n; i9++) {
        if (majorSet[i9]) continue;
        var best = -1, bestGap = Infinity;
        for (var mj in majorSet) {
          var g2 = boxGap(kept[i9], kept[+mj]);
          if (g2 < bestGap) { bestGap = g2; best = +mj; }
        }
        if (best >= 0 && bestGap <= attachCap) {
          var ra3 = find3(i9), rb3 = find3(best);
          if (ra3 !== rb3) uf3[ra3] = rb3;
        }
      }
      var amap = {}, acells = [];
      for (var i10 = 0; i10 < n; i10++) {
        var r10 = find3(i10);
        if (amap[r10] === undefined) { amap[r10] = acells.length; acells.push([]); }
        acells[amap[r10]].push(i10);
      }
      clusters = acells;
    }

    // ---- 6. 组几何 + 阅读顺序(先行后列, 行带宽=组高中位数/2) ----
    var groups = clusters.map(function (idxs) {
      var X0 = w2, Y0 = h2, X1 = 0, Y1 = 0, area2 = 0;
      var compIds = idxs.map(function (idx) { return kept[idx].id; });
      idxs.forEach(function (idx) {
        var c = kept[idx];
        if (c.x0 < X0) X0 = c.x0; if (c.x1 > X1) X1 = c.x1;
        if (c.y0 < Y0) Y0 = c.y0; if (c.y1 > Y1) Y1 = c.y1;
        area2 += c.area;
      });
      return { x0: X0, y0: Y0, x1: X1, y1: Y1, area: area2, cx: (X0 + X1) / 2, cy: (Y0 + Y1) / 2, comps: compIds };
    });
    var hs = groups.map(function (g) { return g.y1 - g.y0 + 1; }).sort(function (u, v) { return u - v; });
    var rowTol = Math.max(2, (hs[hs.length >> 1] || 1) / 2);
    groups.sort(function (u, v) { return u.cy - v.cy; });
    var ordered = [], band = [], bandCy = 0;
    groups.forEach(function (g) {
      if (!band.length) { band = [g]; bandCy = g.cy; return; }
      if (Math.abs(g.cy - bandCy) > rowTol) {
        band.sort(function (u, v) { return u.cx - v.cx; });
        ordered = ordered.concat(band);
        band = [g]; bandCy = g.cy;
      } else { band.push(g); bandCy = (bandCy * (band.length - 1) + g.cy) / band.length; }
    });
    band.sort(function (u, v) { return u.cx - v.cx; });
    ordered = ordered.concat(band);

    // ---- 7. 裁剪框: 映射回原始分辨率 + padding + clamp(粗框, 精确裁剪见 extract) ----
    var pad = o.padding === 'auto' ? Math.max(4, Math.round(Math.max(W, H) * 0.01)) : Math.max(0, +o.padding);
    var boxes = ordered.map(function (g, idx) {
      var X0 = Math.max(0, g.x0 * scale - pad);
      var Y0 = Math.max(0, g.y0 * scale - pad);
      var X1 = Math.min(W - 1, (g.x1 + 1) * scale - 1 + pad);
      var Y1 = Math.min(H - 1, (g.y1 + 1) * scale - 1 + pad);
      return { x: X0, y: Y0, w: X1 - X0 + 1, h: Y1 - Y0 + 1, area: g.area * scale * scale, index: idx + 1, comps: g.comps };
    });

    return {
      width: W, height: H, source: source, bg: bg, scale: scale, mode: mode,
      components: kept, boxes: boxes, suggestGap: Math.round(suggestGapA * scale),
      _labels: label, _fg: { source: source, threshold: o.threshold, bg: bg, tolerance: o.bgTolerance, scale: scale, w2: w2, h2: h2 },
      stats: { ms: Date.now() - t0, componentsRaw: comps.length, components: kept.length, groups: boxes.length },
    };
  }

  /* extract() — 像素级精确提取(标记分水岭):
   * 实心像素(≥阈值)按构造精确归属唯一贴纸(OR池化+连通域保证);
   * 贴纸之间的软边/光晕(0<α<阈值)按测地最近分给两侧(双源 BFS 分水岭);
   * 导出擦除邻居像素, 包围盒贴真实边缘收回。比粗框+统一外扩精准一个量级。
   * 返回 {x, y, w, h, data: Uint8ClampedArray} (原始分辨率 RGBA) */
  function extract(imageData, result, i) {
    var box = result.boxes[i];
    var W = result.width, H = result.height, data = imageData.data;
    var fg = result._fg, labels = result._labels;
    var scale = fg.scale, w2 = fg.w2;
    var thr = fg.threshold, bg = fg.bg, tol = fg.tolerance;
    var isAlpha = fg.source === 'alpha';

    function solid(px) {
      if (isAlpha) return data[px + 3] >= thr;
      return Math.max(Math.abs(data[px] - bg[0]), Math.abs(data[px + 1] - bg[1]), Math.abs(data[px + 2] - bg[2])) > tol;
    }
    function open(px) {
      if (isAlpha) return data[px + 3] > 0;   // 光晕可被分水岭穿越
      return solid(px);                        // 颜色键模式: 只在实体内传播
    }

    var margin = Math.max(6, Math.round(Math.max(W, H) * 0.004));
    var rx = Math.max(0, box.x - margin), ry = Math.max(0, box.y - margin);
    var rx1 = Math.min(W - 1, box.x + box.w - 1 + margin), ry1 = Math.min(H - 1, box.y + box.h - 1 + margin);
    var rw = rx1 - rx + 1, rh = ry1 - ry + 1;

    var ownSet = {};
    for (var ci = 0; ci < box.comps.length; ci++) ownSet[box.comps[ci]] = 1;

    // 种子: 实心像素 → 其分析格的连通域 ∈ 本组=自己(1), 否则=邻居(2, 含被滤掉的噪点格)
    var lab = new Uint8Array(rw * rh);
    var queue = new Int32Array(rw * rh), qt = 0;
    for (var y = ry; y <= ry1; y++) {
      var rowCell = Math.min(fg.h2 - 1, (y / scale) | 0) * w2;
      var rrow = (y - ry) * rw;
      for (var x = rx; x <= rx1; x++) {
        var p = (y * W + x) * 4;
        if (!solid(p)) continue;
        var comp = labels[rowCell + Math.min(w2 - 1, (x / scale) | 0)];
        var l = ownSet[comp] ? 1 : 2;
        lab[rrow + x - rx] = l;
        queue[qt++] = rrow + x - rx;
      }
    }
    // 双源 BFS(4连通, 先入队者赢 → 自己先入队, 平局归自己)
    var qh = 0;
    while (qh < qt) {
      var q = queue[qh++];
      var l = lab[q];
      var qx = q % rw, qy = (q - qx) / rw;
      if (qx > 0 && !lab[q - 1] && open(((qy + ry) * W + qx - 1 + rx) * 4)) { lab[q - 1] = l; queue[qt++] = q - 1; }
      if (qx < rw - 1 && !lab[q + 1] && open(((qy + ry) * W + qx + 1 + rx) * 4)) { lab[q + 1] = l; queue[qt++] = q + 1; }
      if (qy > 0 && !lab[q - rw] && open(((qy - 1 + ry) * W + qx + rx) * 4)) { lab[q - rw] = l; queue[qt++] = q - rw; }
      if (qy < rh - 1 && !lab[q + rw] && open(((qy + 1 + ry) * W + qx + rx) * 4)) { lab[q + rw] = l; queue[qt++] = q + rw; }
    }

    // 自己流域的紧包围盒(实心+光晕)
    var bx0 = rw, by0 = rh, bx1 = -1, by1 = -1;
    for (var yy = 0; yy < rh; yy++) {
      var r2 = yy * rw;
      for (var xx = 0; xx < rw; xx++)
        if (lab[r2 + xx] === 1) {
          if (xx < bx0) bx0 = xx; if (xx > bx1) bx1 = xx;
          if (yy < by0) by0 = yy; if (yy > by1) by1 = yy;
        }
    }
    if (bx1 < 0) { // 兜底: 没找到自己的像素就用粗框
      bx0 = box.x - rx; by0 = box.y - ry; bx1 = bx0 + box.w - 1; by1 = by0 + box.h - 1;
    }
    var pad2 = 2;
    // 只在 ROI 内外扩: 越过 ROI 的像素没有标签, 会把邻居内容原样带出
    var fx = Math.max(rx, rx + bx0 - pad2), fy = Math.max(ry, ry + by0 - pad2);
    var fx1 = Math.min(rx1, rx + bx1 + pad2), fy1 = Math.min(ry1, ry + by1 + pad2);
    var fw = fx1 - fx + 1, fh = fy1 - fy + 1;

    var out = new Uint8ClampedArray(fw * fh * 4);
    for (var sy2 = 0; sy2 < fh; sy2++) {
      var lrow = (sy2 + fy - ry) * rw + (fx - rx);
      var orow = sy2 * fw * 4, srow = ((sy2 + fy) * W + fx) * 4;
      for (var sx2 = 0; sx2 < fw; sx2++) {
        if (lab[lrow + sx2] === 2) continue;   // 邻居像素擦除
        var so = srow + sx2 * 4, oo = orow + sx2 * 4;
        out[oo] = data[so]; out[oo + 1] = data[so + 1]; out[oo + 2] = data[so + 2]; out[oo + 3] = data[so + 3];
      }
    }
    return { x: fx, y: fy, w: fw, h: fh, data: out, index: box.index };
  }

  /* toSquare() — 居中放入正方形透明画布(1:1 输出用) */
  function toSquare(ex) {
    var S = Math.max(ex.w, ex.h);
    var out = new Uint8ClampedArray(S * S * 4);
    var ox = (S - ex.w) >> 1, oy = (S - ex.h) >> 1;
    for (var y = 0; y < ex.h; y++) {
      var src = y * ex.w * 4;
      out.set(ex.data.subarray(src, src + ex.w * 4), ((y + oy) * S + ox) * 4);
    }
    return { x: ex.x - ox, y: ex.y - oy, w: S, h: S, data: out, index: ex.index };
  }

  /* autoSquare() — 方形贴纸图判定(中位数规则):
   * 多数贴纸接近方形即开启; 个别天生宽/长的贴纸居中放进方形画布, 不否决全图。
   * 强长条内容(如横幅)中位数远离 1:1 → 关闭。 */
  function autoSquare(extracts) {
    var n = extracts.length;
    if (!n) return false;
    var aspects = extracts.map(function (e) { return e.w / e.h; }).sort(function (a, b) { return a - b; });
    var median = aspects[n >> 1];
    var inRange = 0;
    for (var i = 0; i < n; i++) if (aspects[i] >= 0.7 && aspects[i] <= 1.4) inRange++;
    return median >= 0.75 && median <= 1.33 && inRange >= n * 0.6;
  }

  return { analyze: analyze, extract: extract, toSquare: toSquare, autoSquare: autoSquare, defaults: defaults, version: '1.1.0' };
});
