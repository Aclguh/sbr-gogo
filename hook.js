/*
 * SBR GoGo Auto Runner — hook.js
 * 在游戏脚本加载前（document_start, MAIN world）运行：
 *  1. 拦截 window.PIXI 赋值，捕获 PIXI.Application 实例（用于坐标换算/舞台扫描）
 *  2. 包一层 Container.prototype 的 on/addEventListener/eventMode，
 *     记录运行期生成的可点击对象（对手 / 仙人掌 / 小熊）
 * 不修改游戏任何逻辑，只做只读登记。
 */
(() => {
  'use strict';
  if (window.__sbrAutoHook) return;
  window.__sbrAutoHook = true;

  const state = {
    apps: [],          // 捕获到的 PIXI.Application 实例
    targets: new Set() // 注册过 pointerdown 监听的 Container
  };
  window.__sbrAuto = state;

  function register(obj) {
    if (obj && typeof obj === 'object') {
      try { state.targets.add(obj); } catch (e) { /* ignore */ }
    }
  }

  function findOwner(proto, name) {
    let o = proto;
    while (o) {
      if (Object.prototype.hasOwnProperty.call(o, name)) return o;
      o = Object.getPrototypeOf(o);
    }
    return null;
  }

  function patch(PIXI) {
    if (!PIXI || !PIXI.Container) return false;
    let did = false;

    // --- 1. 捕获 Application 实例 ---
    if (PIXI.Application && PIXI.Application.prototype) {
      const owner = findOwner(PIXI.Application.prototype, 'init');
      if (owner && typeof owner.init === 'function' && !owner.__sbrInitPatched) {
        const origInit = owner.init;
        owner.init = function (...args) {
          try { state.apps.push(this); } catch (e) { /* ignore */ }
          return origInit.apply(this, args);
        };
        owner.__sbrInitPatched = true;
        did = true;
      }
    }

    // --- 2. 登记 pointerdown 监听对象（on / addEventListener）---
    const cProto = PIXI.Container.prototype;
    if (cProto && !cProto.__sbrOnPatched) {
      for (const name of ['on', 'addEventListener']) {
        const owner = findOwner(cProto, name);
        if (!owner || typeof owner[name] !== 'function' || owner['__sbrPatched_' + name]) continue;
        const orig = owner[name];
        owner[name] = function (type, ...rest) {
          if (type === 'pointerdown' || type === 'pointertap') register(this);
          return orig.call(this, type, ...rest);
        };
        owner['__sbrPatched_' + name] = true;
        did = true;
      }
      cProto.__sbrOnPatched = true;
    }

    // --- 3. eventMode 访问器兜底登记（若为访问器则包装 setter）---
    const emOwner = cProto ? findOwner(cProto, 'eventMode') : null;
    if (emOwner) {
      const desc = Object.getOwnPropertyDescriptor(emOwner, 'eventMode');
      if (desc && desc.set && !desc.set.__sbrEmPatched) {
        const origSet = desc.set;
        Object.defineProperty(emOwner, 'eventMode', {
          configurable: true,
          enumerable: desc.enumerable,
          get: desc.get,
          set: function (v) {
            if (v === 'static' || v === 'dynamic') register(this);
            return origSet.call(this, v);
          }
        });
        desc.set.__sbrEmPatched = true;
        did = true;
      }
    }
    return did;
  }

  // PIXI 尚未加载：先定义访问器拦截后续赋值（var PIXI 声明会复用该属性）
  try {
    let val = window.PIXI;
    Object.defineProperty(window, 'PIXI', {
      configurable: true,
      get() { return val; },
      set(v) { val = v; patch(v); }
    });
  } catch (e) { /* 已存在不可配置属性时忽略 */ }

  if (window.PIXI) patch(window.PIXI);

  // 轮询兜底（defineProperty 失败等情形）
  let tries = 0;
  const iv = setInterval(() => {
    if (patch(window.PIXI) || ++tries > 1250) clearInterval(iv);
  }, 16);
})();
