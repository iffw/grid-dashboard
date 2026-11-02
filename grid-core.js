/* ============================================================
 * 网格看板 · 计算核心 grid-core.js
 * 纯函数：不在内部拉数据、不碰 DOM。浏览器和 Node 都可加载。
 * 所有口径写死在这里，页面上也会标注：
 *   振幅 = (最高 - 最低) / 最低
 *   强平价为逐仓简化估算，以交易所实际为准。
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 基础工具 ---------- */

  // 线性分位数（closes 求 p5/p95 用）
  function percentile(sortedArr, p) {
    if (!sortedArr.length) return NaN;
    var idx = (sortedArr.length - 1) * p;
    var lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sortedArr[lo];
    return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
  }

  function mean(arr) {
    if (!arr.length) return NaN;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  /* ---------- M1 振幅统计 ----------
   * candles: [{ts(秒), o, h, l, c, volQuote(成交额,USDT)}]，按时间升序
   */
  function amplitudeStats(candles) {
    var n = candles.length;
    var amps = [], highs = [], lows = [], closes = [];
    var periodHigh = -Infinity, periodLow = Infinity;
    var buckets = { '0-1': 0, '1-2': 0, '2-3': 0, '3+': 0 };
    var i, cd, amp;
    for (i = 0; i < n; i++) {
      cd = candles[i];
      amp = (cd.h - cd.l) / cd.l * 100;
      amps.push(amp);
      highs.push(cd.h); lows.push(cd.l); closes.push(cd.c);
      if (cd.h > periodHigh) periodHigh = cd.h;
      if (cd.l < periodLow) periodLow = cd.l;
      if (amp < 1) buckets['0-1']++;
      else if (amp < 2) buckets['1-2']++;
      else if (amp < 3) buckets['2-3']++;
      else buckets['3+']++;
    }
    // 按 UTC 日聚合：日振幅、日成交额
    var days = {};
    for (i = 0; i < n; i++) {
      cd = candles[i];
      var d = new Date(cd.ts * 1000).toISOString().slice(0, 10);
      if (!days[d]) days[d] = { h: -Infinity, l: Infinity, vol: 0 };
      if (cd.h > days[d].h) days[d].h = cd.h;
      if (cd.l < days[d].l) days[d].l = cd.l;
      days[d].vol += (cd.volQuote || 0);
    }
    var dayKeys = Object.keys(days).sort();
    var dayAmps = [], dayVols = [];
    for (i = 0; i < dayKeys.length; i++) {
      var dd = days[dayKeys[i]];
      dayAmps.push((dd.h - dd.l) / dd.l * 100);
      dayVols.push(dd.vol);
    }
    var sortedCloses = closes.slice().sort(function (a, b) { return a - b; });
    return {
      count: n,
      startTs: n ? candles[0].ts : null,
      endTs: n ? candles[n - 1].ts : null,
      lastClose: n ? candles[n - 1].c : NaN,
      buckets: buckets,
      avgAmplitude: mean(amps),          // 平均振幅 %（所选周期）
      avgHigh: mean(highs),              // 平均顶部
      avgLow: mean(lows),                // 平均底部
      periodHigh: periodHigh,
      periodLow: periodLow,
      dailyAvgAmplitude: mean(dayAmps),  // 日均波幅 %
      dailyAvgTurnover: mean(dayVols),   // 日均成交额（USDT，数据源无此字段时为 0）
      dayCount: dayKeys.length,
      p5Close: percentile(sortedCloses, 0.05),
      p95Close: percentile(sortedCloses, 0.95),
      closes: closes
    };
  }

  /* ---------- M2 区间评估 ----------
   * ctx: {
   *   price 现价, leverage 杠杆, equity 保证金(USDT),
   *   feePct 单边手续费%, slipPct 单边滑点%, fundingSharePct 每往返资金费分摊%,
   *   spacingFactor 格距系数(日均波幅的几分之一, 0.25~0.5),
   *   mmr 维持保证金率(小数, 默认 0.005)
   * }
   * 返回每个区间的完整伴随数字；覆盖率由 closes 计算。
   */
  function roundTripCostPct(ctx) {
    return 2 * (ctx.feePct + ctx.slipPct) + ctx.fundingSharePct;
  }

  function evaluateRange(range, stats, ctx) {
    var lower = range.lower, upper = range.upper;
    var cost = roundTripCostPct(ctx);
    var rawSpacing = stats.dailyAvgAmplitude * ctx.spacingFactor;
    var spacing = Math.max(rawSpacing, cost);
    var grids = Math.max(1, Math.floor(Math.log(upper / lower) / Math.log(1 + spacing / 100)));
    var totalNotional = ctx.equity * ctx.leverage;
    // 简化强平估算：以现价满仓总名义开仓计
    var mmr = ctx.mmr;
    var liqLong = ctx.price * (1 - 1 / ctx.leverage + mmr);
    var liqShort = ctx.price * (1 + 1 / ctx.leverage - mmr);
    var inside = 0;
    for (var i = 0; i < stats.closes.length; i++) {
      if (stats.closes[i] >= lower && stats.closes[i] <= upper) inside++;
    }
    return {
      name: range.name,
      formula: range.formula,
      lower: lower,
      upper: upper,
      widthPct: (upper / lower - 1) * 100,
      distLowerPct: (lower / ctx.price - 1) * 100,   // 现价到下沿（负数）
      distUpperPct: (upper / ctx.price - 1) * 100,   // 现价到上沿（正数）
      rawSpacingPct: rawSpacing,
      spacingPct: spacing,
      costFloorPct: cost,
      costWarning: rawSpacing <= cost,               // 格距被成本顶起来 = 原格距不够覆盖成本
      gridCount: grids,
      perGridNotional: totalNotional / grids,
      totalNotional: totalNotional,
      liqLong: liqLong,
      liqShort: liqShort,
      liqDistLongPct: (ctx.price - liqLong) / ctx.price * 100,  // 做多爆仓距离
      liqDistShortPct: (liqShort - ctx.price) / ctx.price * 100, // 做空爆仓距离
      longRangeBroken: lower < liqLong,    // 做多：下沿已穿强平价
      shortRangeBroken: upper > liqShort,  // 做空：上沿已穿强平价
      coveragePct: stats.closes.length ? inside / stats.closes.length * 100 : NaN
    };
  }

  function candidateRanges(stats, ctx) {
    var out = [];
    // A 实际高低点法：期间最高/最低 ± 缓冲（缓冲 = 日均波幅 × bufferFactor）
    var buf = stats.dailyAvgAmplitude * ctx.bufferFactor / 100;
    out.push({
      name: 'A 实际高低点法',
      formula: '期间最低×(1−缓冲) ~ 期间最高×(1+缓冲)，缓冲 = 日均波幅×' + ctx.bufferFactor,
      lower: stats.periodLow * (1 - buf),
      upper: stats.periodHigh * (1 + buf)
    });
    // B 振幅投影法：现价 ×(1 ± 平均振幅×√根数)；根数 = 天数 × 每日根数
    var perDay = 24 / ctx.barHours;
    function proj(days) {
      var half = stats.avgAmplitude * Math.sqrt(days * perDay) / 100;
      return { lower: ctx.price * (1 - half), upper: ctx.price * (1 + half) };
    }
    var b1 = proj(ctx.projFastDays);
    out.push({
      name: 'B 振幅投影·激进（' + ctx.projFastDays + ' 天）',
      formula: '现价×(1 ± 平均振幅×√(' + ctx.projFastDays + '天根数))',
      lower: b1.lower, upper: b1.upper
    });
    var b2 = proj(ctx.projSlowDays);
    out.push({
      name: 'B 振幅投影·稳健（' + ctx.projSlowDays + ' 天）',
      formula: '现价×(1 ± 平均振幅×√(' + ctx.projSlowDays + '天根数))',
      lower: b2.lower, upper: b2.upper
    });
    // C 分位数法：收盘价 5%–95% 分位带
    out.push({
      name: 'C 分位数法',
      formula: '期间收盘价 P5 ~ P95（剔除两端极端插针）',
      lower: stats.p5Close,
      upper: stats.p95Close
    });
    return out.map(function (r) { return evaluateRange(r, stats, ctx); });
  }

  /* ---------- M3 阶梯推演（固定区间） ----------
   * cfg: {
   *   mode: 'long' | 'short' | 'neutral',
   *   lower, upper, grids 格数, spacingType: 'geo' | 'arith',
   *   perGridNotional 单格名义(USDT), equity 保证金(USDT),
   *   startPrice 现价(锚点), mmr 维持保证金率(小数),
   *   feePct 单边手续费%（盈亏计算用）
   * }
   * 推演口径：
   *   单格数量固定 = 单格名义 / 现价（同潮汐机器人每档固定数量的做法）。
   *   做多网格：开局按上方卖格数买入底仓（现价成交）；价格下行逐格加仓、上行逐格卖出。
   *   做空网格：镜像。开局按下方买格数卖出底仓；上行逐格加空、下行逐格买回。
   *   中性网格：开局零仓；下行逐格开多、上行逐格开空。
   *   每行盈亏 = 从现价单边直达该格的路径账：沿途每格成交一次，
   *   已实现盈亏（卖出/买回与均价之差）− 手续费 + 到达该格时剩余仓位的浮动盈亏。
   *   未计资金费。来回震荡的往返收益不在推演内，那是回测（二期）的事。
   *   强平价（逐仓简化估算）：多头 P=(E·Q−M)/(Q·(1−mmr))；空头 P=(E·Q+M)/(Q·(1+mmr))。
   *   E=持仓均价，Q=持仓数量(币)，M=保证金。结果 ≤0 表示该仓位下公式上不会强平，记 0。
   */
  function gridPrices(lower, upper, grids, spacingType) {
    var prices = [], i;
    if (spacingType === 'arith') {
      var step = (upper - lower) / grids;
      for (i = 0; i <= grids; i++) prices.push(lower + step * i);
    } else {
      var ratio = Math.pow(upper / lower, 1 / grids);
      for (i = 0; i <= grids; i++) prices.push(lower * Math.pow(ratio, i));
    }
    return prices; // 升序，grids+1 个价位（格线）
  }

  function liqLong(avgEntry, qty, margin, mmr) {
    if (qty <= 0) return 0;
    var p = (avgEntry * qty - margin) / (qty * (1 - mmr));
    return p > 0 ? p : 0;
  }
  function liqShort(avgEntry, qty, margin, mmr) {
    if (qty <= 0) return 0;
    return (avgEntry * qty + margin) / (qty * (1 + mmr));
  }

  function buildLadder(cfg) {
    var prices = gridPrices(cfg.lower, cfg.upper, cfg.grids, cfg.spacingType);
    var P0 = cfg.startPrice;
    var rows = [];
    var i, price;

    // 找出离现价最近的格线作为锚点行
    var anchor = 0, best = Infinity;
    for (i = 0; i < prices.length; i++) {
      var d = Math.abs(prices[i] - P0);
      if (d < best) { best = d; anchor = i; }
    }

    var lot = cfg.perGridNotional / P0;      // 单格数量（币），全程固定
    var feeR = (cfg.feePct || 0) / 100;

    // 模拟从锚点单边走到第 idx 格：返回仓位与盈亏状态
    function simTo(idx) {
      var qtyL = 0, costL = 0, qtyS = 0, costS = 0, realized = 0, fees = 0, j;
      function buyLong(p) { qtyL += lot; costL += lot * p; fees += lot * p * feeR; }
      function sellLong(p) {
        if (qtyL <= 1e-12) return;
        var q = Math.min(lot, qtyL), avg = costL / qtyL;
        realized += (p - avg) * q; fees += q * p * feeR;
        qtyL -= q; costL -= avg * q;
        if (qtyL < 1e-12) { qtyL = 0; costL = 0; }
      }
      function openShort(p) { qtyS += lot; costS += lot * p; fees += lot * p * feeR; }
      function closeShort(p) {
        if (qtyS <= 1e-12) return;
        var q = Math.min(lot, qtyS), avg = costS / qtyS;
        realized += (avg - p) * q; fees += q * p * feeR;
        qtyS -= q; costS -= avg * q;
        if (qtyS < 1e-12) { qtyS = 0; costS = 0; }
      }
      if (cfg.mode === 'long') {
        var sellsAbove = prices.length - 1 - anchor;
        for (j = 0; j < sellsAbove; j++) buyLong(P0);       // 底仓，现价买入
        if (idx < anchor) { for (j = anchor - 1; j >= idx; j--) buyLong(prices[j]); }
        else if (idx > anchor) { for (j = anchor + 1; j <= idx; j++) sellLong(prices[j]); }
      } else if (cfg.mode === 'short') {
        var buysBelow = anchor;
        for (j = 0; j < buysBelow; j++) openShort(P0);      // 底仓，现价卖出
        if (idx > anchor) { for (j = anchor + 1; j <= idx; j++) openShort(prices[j]); }
        else if (idx < anchor) { for (j = anchor - 1; j >= idx; j--) closeShort(prices[j]); }
      } else { // neutral：开局零仓
        if (idx < anchor) { for (j = anchor - 1; j >= idx; j--) buyLong(prices[j]); }
        else if (idx > anchor) { for (j = anchor + 1; j <= idx; j++) openShort(prices[j]); }
      }
      var p = prices[idx];
      var avgL = qtyL > 0 ? costL / qtyL : 0;
      var avgS = qtyS > 0 ? costS / qtyS : 0;
      var unreal = (p - avgL) * qtyL + (avgS - p) * qtyS;
      return {
        qtyL: qtyL, costL: costL, qtyS: qtyS, costS: costS, avgL: avgL, avgS: avgS,
        realized: realized, fees: fees, unreal: unreal, total: realized - fees + unreal
      };
    }

    for (i = prices.length - 1; i >= 0; i--) { // 从高到低输出（同潮汐阶梯表）
      price = prices[i];
      var st = simTo(i);
      var notional = (st.qtyL + st.qtyS) * price;
      var action = i === anchor ? '现价' : (cfg.mode === 'short'
        ? (i > anchor ? '加空' : '减空')
        : cfg.mode === 'neutral'
          ? (i > anchor ? '开空' : '开多')
          : (i > anchor ? '卖出' : '买入'));
      // 配对腿：这一格成交后，落袋单挂在相邻一格——锚点下方各格向上配对、上方各格向下配对
      var pairPrice = 0, pairGross = 0, pairNet = 0;
      if (i !== anchor) {
        var pairIdx = i < anchor ? i + 1 : i - 1;
        pairPrice = prices[pairIdx];
        pairGross = lot * Math.abs(pairPrice - price);
        pairNet = pairGross - lot * (price + pairPrice) * feeR;
      }
      rows.push({
        idx: i,
        price: price,
        action: action,
        pairPrice: pairPrice,
        pairGross: pairGross,
        pairNet: pairNet,
        qtyLong: st.qtyL,
        qtyShort: st.qtyS,
        avgLong: st.avgL,
        avgShort: st.avgS,
        notional: notional,
        realized: st.realized,
        fees: st.fees,
        unreal: st.unreal,
        totalPnl: st.total,
        netMultiple: cfg.equity > 0 ? notional / cfg.equity : NaN,
        liqLong: liqLong(st.avgL, st.qtyL, cfg.equity, cfg.mmr),
        liqShort: liqShort(st.avgS, st.qtyS, cfg.equity, cfg.mmr),
        distPct: (price / P0 - 1) * 100
      });
    }

    // 汇总：两个端点的合计盈亏 + 走完不利方向全程的强平状态
    var topRow = rows[0], bottomRow = rows[rows.length - 1];
    var adverse = cfg.mode === 'short' ? topRow : bottomRow;
    var summary = {
      anchorIdx: anchor,
      adverseRow: adverse,
      topTotal: topRow.totalPnl,
      bottomTotal: bottomRow.totalPnl,
      topTotalPct: cfg.equity > 0 ? topRow.totalPnl / cfg.equity * 100 : NaN,
      bottomTotalPct: cfg.equity > 0 ? bottomRow.totalPnl / cfg.equity * 100 : NaN,
      maxNetMultiple: Math.max.apply(null, rows.map(function (r) { return r.netMultiple; })),
      adverseLiq: cfg.mode === 'short' ? adverse.liqShort : adverse.liqLong,
      adverseLiqDistPct: 0
    };
    if (summary.adverseLiq > 0) {
      summary.adverseLiqDistPct = cfg.mode === 'short'
        ? (summary.adverseLiq / adverse.price - 1) * 100
        : (1 - summary.adverseLiq / adverse.price) * 100;
    }
    return { rows: rows, summary: summary, prices: prices };
  }

  var GridCore = {
    percentile: percentile,
    mean: mean,
    amplitudeStats: amplitudeStats,
    candidateRanges: candidateRanges,
    evaluateRange: evaluateRange,
    roundTripCostPct: roundTripCostPct,
    gridPrices: gridPrices,
    buildLadder: buildLadder,
    liqLong: liqLong,
    liqShort: liqShort
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = GridCore;
  global.GridCore = GridCore;
})(typeof window !== 'undefined' ? window : globalThis);
