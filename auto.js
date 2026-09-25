/*
 * SBR GoGo Auto Runner — auto.js（MAIN world, document_idle）
 *
 * 机制分析（基于游戏代码）：
 *  - 交替按 ←/→（或点击 L/R 按钮）给马加 impulse，速度由空气阻力平衡；
 *    同侧连按只有 50% 效果，必须严格交替。
 *  - 连续踏步时“气力槽”(gauge) 涨到 1，速度上限 = vMax*(0.1+0.9*gauge) = vMax；
 *    一旦速度顶到 vMax（速度比≥1 且 HUD≥99.5% 持续 10ms）就会 SLIP：
 *    速度×0.3、气力清零、900ms 无法踏步。所以“最大速度”必须留一点余量地悬停。
 *  - 反馈控制：HUD 仪表条 #gmGaugeBar 的宽度就是平滑后的速度比。
 *    双积分器自动校准踏频（次/秒），目标速度比 ~97%，并叠加两道保险：
 *      1) 踏频自适应上限（触发滑倒前自动回退）；
 *      2) 速度比 >98.5% 时暂停踏步，回落到 95% 再继续。
 *  - BEYOND(小熊冲刺) 期间无滑倒判定且阻力为 0 → 全力踏步吃满 2x 加速。
 *  - 对手/仙人掌/小熊都是运行期生成、带 pointerdown 的 PIXI 对象：
 *    扫描其屏幕位置并合成 pointerdown 即可驱赶(机会神击+5s)/拍碎(+5s)/收集(+5s 或 BEYOND)。
 *  - 开局与重开由玩家手动进行，起跑后扩展自动接管踏步与清障。
 */
(() => {
  'use strict';
  if (window.__sbrAutoRunner) return;
  window.__sbrAutoRunner = true;

  const PATH = location.pathname.replace(/index\.html$/, '');
  const IS_GAME = /\/game\/?$/.test(PATH);
  if (!IS_GAME) return;

  /* ---------------- 偏好设置 ---------------- */
  const PREF_KEY = 'sbrAutoPrefs';
  const prefs = Object.assign(
    { enabled: true, autoClear: true },
    (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch (e) { return {}; } })()
  );
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ } };

  /* ---------------- 运行状态 ---------------- */
  const stats = { taps: 0, slips: 0, rate: 0, ratio: 0, playing: false, clicks: 0 };
  let nextSide = 'L';
  let acc = 0;
  let paused = false;
  let rate = 11.0;             // 当前踏频（次/秒），双积分自动校准
  let ceil = 11.35;            // 踏频自适应上限
  let prevDisabled = false;

  /* ---------------- DOM 引用 ---------------- */
  const $ = (id) => document.getElementById(id);
  const btnL = () => $('gmBtnL');
  const overlay = () => $('gmOverlay');
  const fieldRoot = () => document.querySelector('.p-game-field');
  const gaugeEl = () => document.querySelector('.p-game-gauge');

  function isPlaying() {
    const ov = overlay(), fr = fieldRoot();
    return !!(ov && fr && ov.hidden && fr.classList.contains('is-ready'));
  }

  function readRatio() {
    const bar = $('gmGaugeBar');
    if (bar) {
      const w = parseFloat(bar.style.width);
      if (!isNaN(w)) return Math.min(1, Math.max(0, w / 100));
    }
    const g = gaugeEl();
    if (g) {
      const w = parseFloat(g.style.getPropertyValue('--gauge-progress'));
      if (!isNaN(w)) return Math.min(1, Math.max(0, w / 100));
    }
    return 0;
  }

  /* ---------------- 踏步输入 ---------------- */
  function tap(side) {
    const code = side === 'L' ? 'ArrowLeft' : 'ArrowRight';
    const opts = { bubbles: true, cancelable: true, code, key: code, view: window };
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  /* ---------------- 控制器 ---------------- */
  const C = {
    TICK: 40,        // 控制周期 ms（25Hz）
    TARGET: 0.968,   // 目标速度比（留 ~3% 余量防滑倒）
    KI: 3.5,         // 踏频积分增益（每秒/单位误差）
    KC: 1.4,         // 踏频上限自适应增益：自动校准游戏真实机制
    RATE_MIN: 4,
    CEIL_MIN: 10.6,
    CEIL_MAX: 13.4,  // 自适应上限的硬顶（远高于稳态所需）
    PAUSE_HI: 0.985, // 高速暂停阈值（HUD ≥99.5% 持续 10ms 才会滑倒）
    RESUME_LO: 0.95, // 恢复阈值
    BURST_R: 12.5,   // BEYOND 期间踏频（无滑倒判定且阻力为 0）
    BACKOFF_PAUSE: 0.15, // 触发暂停护栏时上限回退量
    BACKOFF_SLIP: 0.6    // 打滑后上限回退量
  };

  let lastTickAt = performance.now();

  function controllerTick() {
    refreshStatus();
    const now = performance.now();
    const dt = Math.min(0.25, (now - lastTickAt) / 1000); // 真实 dt，抗节流
    lastTickAt = now;

    if (!prefs.enabled || !isPlaying()) {
      acc = 0; paused = false; prevDisabled = false; stats.rate = 0;
      return;
    }
    const bl = btnL();
    const disabled = !!(bl && bl.disabled);
    if (disabled && !prevDisabled) {
      stats.slips++; // 打滑（过热锁定）计数
      ceil = Math.max(C.CEIL_MIN, ceil - C.BACKOFF_SLIP); // 打滑后主动回退
      rate = Math.min(rate, ceil);
    }
    prevDisabled = disabled;
    if (disabled) { acc = 0; paused = false; stats.rate = 0; return; }

    const od = !!(gaugeEl() && gaugeEl().classList.contains('is-overdrive'));
    if (od) {
      paused = false;
      rate = C.BURST_R; // 冲刺期无滑倒判定，全力踏
    } else {
      const rho = readRatio();
      stats.ratio = rho;
      if (paused) {
        if (rho < C.RESUME_LO) paused = false;
        else { acc = 0; stats.rate = 0; return; }
      } else if (rho > C.PAUSE_HI) {
        paused = true; acc = 0; stats.rate = 0;
        ceil = Math.max(C.CEIL_MIN, ceil - C.BACKOFF_PAUSE);
        return;
      }
      // 双积分：踏频跟随误差，同时上限按误差缓慢爬升（自动校准）
      ceil += C.KC * (C.TARGET - rho) * dt;
      ceil = Math.min(C.CEIL_MAX, Math.max(C.CEIL_MIN, ceil));
      rate += C.KI * (C.TARGET - rho) * dt;
      rate = Math.min(ceil, Math.max(C.RATE_MIN, rate));
      if (rho < 0.9) rate = ceil; // 低速重建期用满上限
    }
    stats.rate = rate;
    acc += rate * dt;
    let n = Math.min(4, Math.floor(acc)); acc -= n;
    let delay = 0;
    while (n-- > 0) {
      const s = nextSide;
      nextSide = nextSide === 'L' ? 'R' : 'L';
      stats.taps++;
      if (delay === 0) tap(s);
      else { const ss = s; setTimeout(() => tap(ss), delay); }
      delay += 12;
    }
  }

  /* ---------------- 清障/收集（PIXI 对象点击）---------------- */
  const clickCooldown = new WeakMap();

  function boundsOf(o) {
    const b = o.getBounds();
    if (!b) return null;
    if (typeof b.minX === 'number') return { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
    if (typeof b.width === 'number') return { x: b.x, y: b.y, w: b.width, h: b.height };
    return null;
  }

  function clickCanvas(canvas, clientX, clientY) {
    const opts = {
      bubbles: true, cancelable: true, composed: true, view: window,
      pointerId: 1, pointerType: 'mouse', isPrimary: true,
      button: 0, buttons: 1, clientX, clientY
    };
    canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
    canvas.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, opts, { buttons: 0 })));
    stats.clicks++;
  }

  function scannerTick() {
    if (!prefs.enabled || !prefs.autoClear || !isPlaying()) return;
    const reg = window.__sbrAuto && window.__sbrAuto.targets;
    if (!reg || reg.size === 0) return;

    let app = null;
    for (const a of (window.__sbrAuto.apps || [])) {
      if (a && a.renderer && a.renderer.canvas && a.stage) { app = a; break; }
    }
    let logicalW = 750, logicalH = 750, canvas = null;
    if (app) {
      const r = app.renderer, res = r.resolution || 1;
      logicalW = r.width / res || logicalW;
      logicalH = r.height / res || logicalH;
      canvas = r.canvas;
    } else {
      canvas = document.querySelector('#gmField canvas');
    }
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    // 清理已回收对象
    for (const t of reg) { if (!t || !t.parent) reg.delete(t); }

    const now = performance.now();
    for (const t of reg) {
      try {
        if (t.destroyed || !t.parent) continue;
        if (t.eventMode !== 'static' || !t.visible || t.alpha < 0.05) continue;
        const b = boundsOf(t);
        if (!b) continue;
        if (b.w <= 2 || b.h <= 2 || b.w > logicalW * 1.25 || b.h > logicalH * 1.25) continue;
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        if (cx < -10 || cy < -10 || cx > logicalW + 10 || cy > logicalH + 10) continue;
        const last = clickCooldown.get(t) || 0;
        if (now - last < 500) continue;
        clickCooldown.set(t, now);
        clickCanvas(canvas,
          rect.left + (cx / logicalW) * rect.width,
          rect.top + (cy / logicalH) * rect.height);
      } catch (e) { /* 单个对象异常不影响整体 */ }
    }
  }

  /* ---------------- 状态面板 ---------------- */
  let ui = null;
  function buildPanel() {
    const css = `
      #sbrPanel{position:fixed;right:12px;bottom:12px;z-index:2147483000;width:216px;
        background:rgba(14,17,26,.92);color:#e8ecf3;border-radius:12px;padding:10px 12px 9px;
        font:12px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;
        box-shadow:0 6px 24px rgba(0,0,0,.4);user-select:none}
      #sbrPanel .head{display:flex;align-items:center;justify-content:space-between;
        font-weight:600;font-size:12.5px;letter-spacing:.02em}
      #sbrPanel .badge{cursor:pointer;border-radius:999px;padding:1px 10px;font-size:11px;
        font-weight:700;background:#2ecc71;color:#06240f}
      #sbrPanel .badge.off{background:#3a4152;color:#aab2c0}
      #sbrPanel .status{margin-top:5px;color:#9aa5b5}
      #sbrPanel .status b{color:#fff;font-variant-numeric:tabular-nums}
      #sbrPanel .bar{position:relative;height:7px;border-radius:4px;background:#2a3040;
        margin:7px 0 8px;overflow:hidden}
      #sbrPanel .bar .fill{height:100%;width:0%;border-radius:4px;
        background:linear-gradient(90deg,#37d67a,#ffd166 78%,#ff6b6b)}
      #sbrPanel .bar .mark{position:absolute;top:-1px;bottom:-1px;left:97.5%;width:2px;
        background:rgba(255,255,255,.85)}
      #sbrPanel .toggles{display:flex;flex-wrap:wrap;gap:2px 10px;color:#b9c2d0}
      #sbrPanel .toggles label{display:flex;align-items:center;gap:4px;cursor:pointer}
      #sbrPanel .toggles input{accent-color:#2ecc71;margin:0}
      #sbrPanel .foot{margin-top:6px;color:#7d8798;font-size:11px;
        font-variant-numeric:tabular-nums}`;
    const style = document.createElement('style');
    style.textContent = css;
    document.documentElement.appendChild(style);

    const el = document.createElement('div');
    el.id = 'sbrPanel';
    el.innerHTML = `
      <div class="head"><span>🏇 SBR 自动驾驶</span><span class="badge" id="sbrMaster">ON</span></div>
      <div class="status">状态 <b id="sbrStatus">待机</b></div>
      <div class="bar"><div class="fill" id="sbrFill"></div><div class="mark"></div></div>
      <div class="toggles">
        <label><input type="checkbox" id="sbrTClear">自动清障</label>
      </div>
      <div class="foot" id="sbrFoot">踏 0 · 打滑 0 · 点击 0</div>`;
    document.body.appendChild(el);

    const bind = (id, key) => {
      const box = $(id);
      box.checked = !!prefs[key];
      box.addEventListener('change', () => { prefs[key] = box.checked; savePrefs(); });
    };
    bind('sbrTClear', 'autoClear');

    const master = $('sbrMaster');
    const paintMaster = () => {
      master.textContent = prefs.enabled ? 'ON' : 'OFF';
      master.classList.toggle('off', !prefs.enabled);
    };
    master.addEventListener('click', () => {
      prefs.enabled = !prefs.enabled;
      savePrefs(); paintMaster();
      ['sbrTClear'].forEach(id => { $(id).disabled = !prefs.enabled; });
    });
    paintMaster();
    ['sbrTClear'].forEach(id => { $(id).disabled = !prefs.enabled; });

    ui = { status: $('sbrStatus'), fill: $('sbrFill'), foot: $('sbrFoot') };
  }

  let lastFoot = '';
  function refreshStatus() {
    if (!ui) return;
    const rho = readRatio();
    let text, color = '#fff';
    if (!prefs.enabled) { text = '已停用'; color = '#8b93a3'; }
    else if (!isPlaying()) { text = '待机'; }
    else if (btnL() && btnL().disabled) { text = '😵 打滑恢复中'; color = '#ff9f43'; }
    else if (gaugeEl() && gaugeEl().classList.contains('is-overdrive')) { text = '⚡ BEYOND!'; color = '#ff6b6b'; }
    else { text = `🏃 奔跑 ${(rho * 100).toFixed(1)}%`; }
    ui.status.textContent = text;
    ui.status.style.color = color;
    ui.fill.style.width = (rho * 100).toFixed(1) + '%';
    const foot = `踏 ${stats.taps} · 打滑 ${stats.slips} · 点击 ${stats.clicks}`;
    if (foot !== lastFoot) { ui.foot.textContent = foot; lastFoot = foot; }
  }

  /* ---------------- 启动 ---------------- */
  function main() {
    buildPanel();
    setInterval(controllerTick, C.TICK);
    setInterval(scannerTick, 300);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }

  // 供调试/验证读取
  Object.defineProperty(window, '__sbrAutoDebug', {
    get: () => ({ taps: stats.taps, slips: stats.slips, clicks: stats.clicks, ratio: stats.ratio, rate: stats.rate, ceil, playing: isPlaying(), paused })
  });
})();
