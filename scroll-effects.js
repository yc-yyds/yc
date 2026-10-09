/* ============================================================================
   scroll-effects.js — 滚动动效库（原生实现，零依赖）
   ----------------------------------------------------------------------------
   对外接口（index.html 已按此契约调用，勿改名）：
     window.ScrollFX.arm(root)        武装 root 内所有 .rv 元素，开始监听
     window.ScrollFX.parallax()       启用 data-parallax 视差
     window.ScrollFX.destroy()        解绑全部监听
     window.ScrollFX.reduceMotion()   查询是否处于「减少动效」偏好
     注：动态插入内容后重新武装，直接再次调用 arm(document) 即可。

   手动模式：
     <script>window.SCROLLFX_MANUAL = true;</script>
     置 true 时不在 DOMContentLoaded 自动武装 —— 由页面在合适时机
     （如开场页结束后）主动调用 ScrollFX.arm(document)。
     index.html 正是用这个模式，避免开场页锁定期间动画被提前消耗。

   行为：
     · 进入视口加 .rv-in（回静止态）；离开视口移除 .rv-in（复位可重播）
     · 只写 class，不碰 style —— 过渡全在 CSS，零重排
     · prefers-reduced-motion：直接全部置为可见，不注册观察器
   ============================================================================ */

(function (global) {
  'use strict';

  var RV_SELECTOR = '.rv';
  var ARMED = 'rv-armed';
  var IN = 'rv-in';

  /* —— 环境能力探测 —— */
  var hasIO = typeof IntersectionObserver !== 'undefined';

  function reduceMotion() {
    return !!(global.matchMedia &&
      global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* 记录已武装的元素，避免重复 observe */
  var armedEls = [];
  var armedSet = null;

  var observer = null;
  /* 出场复位余量：元素完全离开视口后（含 80px 缓冲）才复位，
     防止在视口边缘反复触发造成闪烁 */
  var EXIT_MARGIN = '0px 0px 80px 0px';

  function ensureObserver() {
    if (observer || !hasIO) return observer;

    observer = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var en = entries[i];
        var el = en.target;

        if (en.isIntersecting) {
          el.classList.add(IN);
        } else {
          /* 复位以便滚回时重播；但若元素仍在视口上沿之上，
             保留 .rv-in，避免向上滚动时内容闪没 */
          if (en.boundingClientRect.top > 0) {
            el.classList.remove(IN);
          }
        }
      }
    }, {
      threshold: 0.12,
      rootMargin: EXIT_MARGIN
    });

    return observer;
  }

  /* --------------------------------------------------------------------------
     arm(root)：扫描 root 内的 .rv 元素并武装
     · 先加 .rv-armed 造成初始隐藏态，下一帧再 observe（保证过渡生效）
     -------------------------------------------------------------------------- */
  function arm(root) {
    root = root || document;

    var nodes;
    try {
      nodes = root.querySelectorAll(RV_SELECTOR);
    } catch (e) {
      return;
    }
    if (!nodes || !nodes.length) return;

    /* 减少动效：直接全部可视，不做任何动画 */
    if (reduceMotion()) {
      for (var r = 0; r < nodes.length; r++) {
        nodes[r].classList.remove(ARMED);
        nodes[r].classList.add(IN);
      }
      return;
    }

    if (!hasIO) {
      /* 不支持 IntersectionObserver：保持全部可见（.rv 默认即可见），
         不添加 .rv-armed，避免内容被永久隐藏 */
      return;
    }

    if (!armedSet) armedSet = [];

    var vh = global.innerHeight || 0;

    var pending = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (armedSet.indexOf(el) !== -1) continue;

      armedSet.push(el);
      armedEls.push(el);

      /* ------------------------------------------------------------------
         首屏豁免：武装时已在视口内的元素，直接呈现最终态，不做入场动画。
         ------------------------------------------------------------------
         原因：这些元素在页面加载瞬间就应当可见。若也给它们加 .rv-armed
         置为 opacity:0，就得等一次「IntersectionObserver 回调 → 加 .rv-in」
         的往返才恢复显示，用户实际看到的是首屏先空一下再淡入。
         首屏内容不该有这种延迟 —— 入场动画只服务于「滚动后发现」的内容。

         判定：元素顶边在视口底部以上（即已进入或正跨入视口）即视为可见。
         预留 4px 容差，避免恰好压在边界上的元素反复横跳。
         ------------------------------------------------------------------ */
      var rect = null;
      try { rect = el.getBoundingClientRect(); } catch (e) { rect = null; }

      /* rect 取不到时保守处理：当作「已可见」，优先保证内容不消失 */
      var alreadyVisible = rect ? (rect.top < vh - 4) : true;

      if (alreadyVisible) {
        el.classList.remove(ARMED);
        el.classList.add(IN);
        continue;
      }

      el.classList.add(ARMED);
      pending.push(el);
    }

    if (!pending.length) return;

    var io = ensureObserver();
    if (!io) return;

    /* 下一帧再 observe：给浏览器一次样式计算机会，
       确保「armed 初始态」已渲染，过渡才会真实从初始态开始 */
    requestAnimationFrame(function () {
      for (var k = 0; k < pending.length; k++) io.observe(pending[k]);
    });

    scheduleSafetyNet();
  }

  /* --------------------------------------------------------------------------
     安全兜底：内容永远比动效重要
     --------------------------------------------------------------------------
     极端情况下 observe 可能始终不回调（观察器被节流、布局异常等）。
     此时若放任 .rv-armed 存在，内容将永久不可见 —— 不可接受。
     自检策略（只在「真正卡住」时介入，不影响正常的入场动画）：
       · 元素已在视口内却仍带 .rv-armed  → 强制显示（真卡住）
       · 元素在视口外                     → 保持不动，等它自然滚入
     这样既不牺牲下方内容的入场效果，又能保证任何可见区域绝不空白。
     -------------------------------------------------------------------------- */
  var safetyTimer = null;
  var SAFETY_DELAY = 3000;
  var SAFETY_PASSES = 3;

  function safetyCheck(pass) {
    safetyTimer = null;
    var vh = global.innerHeight || 0;

    for (var i = 0; i < armedEls.length; i++) {
      var el = armedEls[i];
      if (!el.classList.contains(ARMED) || el.classList.contains(IN)) continue;

      var rect;
      try { rect = el.getBoundingClientRect(); } catch (e) { continue; }

      /* 已在视口内（含少量上下缓冲）却仍未显示 → 判定为卡住，强制显示 */
      var inView = rect.top < vh + 60 && rect.bottom > -60;
      if (inView) {
        el.classList.remove(ARMED);
        el.classList.add(IN);
      }
    }

    /* 连续复查几轮，覆盖「滚动后才卡住」的情况；全部到位后停止 */
    if (pass > 1) {
      safetyTimer = setTimeout(function () { safetyCheck(pass - 1); }, SAFETY_DELAY);
    }
  }

  function scheduleSafetyNet() {
    if (safetyTimer) return;   /* 已有自检在排队，不重复排 */
    safetyTimer = setTimeout(function () { safetyCheck(SAFETY_PASSES); }, SAFETY_DELAY);
  }

  /* --------------------------------------------------------------------------
     parallax()：data-parallax="speed" 触发的滚动视差
     · speed 正数 = 随滚动向上偏移；负数 = 向下偏移（营造景深）
     · 仅写 CSS 变量 --se-py，transform 在 CSS 里完成，零重排
     -------------------------------------------------------------------------- */
  var parallaxEls = [];
  var paraTicking = false;

  function collectParallax() {
    parallaxEls = [];
    var nodes = document.querySelectorAll('[data-parallax]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var speed = parseFloat(el.getAttribute('data-parallax'));
      if (isNaN(speed)) continue;
      parallaxEls.push({ el: el, speed: speed });
    }
  }

  function updateParallax() {
    paraTicking = false;
    var vh = global.innerHeight || 0;

    for (var i = 0; i < parallaxEls.length; i++) {
      var item = parallaxEls[i];
      var rect = item.el.getBoundingClientRect();

      /* 元素远离视口时不计算，省掉无谓的样式写入 */
      if (rect.bottom < -200 || rect.top > vh + 200) continue;

      /* 以元素中心相对视口中心的偏移为基准，做「随滚动推移」效果 */
      var center = rect.top + rect.height / 2;
      var offset = (center - vh / 2) * item.speed;

      item.el.style.setProperty('--se-py', offset.toFixed(2) + 'px');
    }
  }

  function onScrollParallax() {
    if (paraTicking) return;
    paraTicking = true;
    requestAnimationFrame(updateParallax);
  }

  function parallax() {
    /* 减少动效：清掉一切偏移，保持静态 */
    if (reduceMotion()) return;

    collectParallax();
    if (!parallaxEls.length) return;

    global.addEventListener('scroll', onScrollParallax, { passive: true });
    global.addEventListener('resize', onScrollParallax, { passive: true });
    updateParallax();
  }

  /* --------------------------------------------------------------------------
     destroy()：解绑
     -------------------------------------------------------------------------- */
  function destroy() {
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }

    if (observer) {
      for (var i = 0; i < armedEls.length; i++) {
        try { observer.unobserve(armedEls[i]); } catch (e) {}
      }
      try { observer.disconnect(); } catch (e) {}
      observer = null;
    }
    armedEls = [];
    armedSet = null;

    global.removeEventListener('scroll', onScrollParallax);
    global.removeEventListener('resize', onScrollParallax);

    for (var k = 0; k < parallaxEls.length; k++) {
      parallaxEls[k].el.style.removeProperty('--se-py');
    }
    parallaxEls = [];
  }

  /* --------------------------------------------------------------------------
     自动模式：未声明 SCROLLFX_MANUAL 时，DOM 就绪即自动武装
     -------------------------------------------------------------------------- */
  function autoInit() {
    if (global.SCROLLFX_MANUAL) return;   /* 手动模式：等外部调用 */
    arm(document);
    parallax();
  }

  global.ScrollFX = {
    arm: arm,
    parallax: parallax,
    destroy: destroy,
    reduceMotion: reduceMotion
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }

})(typeof window !== 'undefined' ? window : this);
