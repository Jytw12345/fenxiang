'use strict';
// 通用右键菜单：接管浏览器默认菜单，让右键内容和页面里真正能做的操作对齐。
// 用法：showCtxMenu(ev, [{ label, danger, disabled, onClick }, '-', ...])
//   items 里出现字符串 '-' 表示一条分隔线；返回 false 表示没有可用项、未接管右键。
(function () {
  let el = null;

  function close() {
    if (!el) return;
    el.remove();
    el = null;
  }

  function show(ev, items) {
    close();
    const list = (items || []).filter(Boolean);
    // 没有任何可用项时不拦截右键，交还浏览器默认菜单（宁可少接管，也不要弹出空白菜单）
    if (!list.length) return false;
    ev.preventDefault();

    el = document.createElement('div');
    el.className = 'ctxmenu';
    el.innerHTML = list.map((it) => {
      if (it === '-') return '<div class="ctx-sep"></div>';
      const cls = ['ctx-item', it.danger ? 'danger' : '', it.disabled ? 'disabled' : ''].filter(Boolean).join(' ');
      return '<button type="button" class="' + cls + '">' + it.label + '</button>';
    }).join('');
    document.body.appendChild(el);

    // 绑定点击：按顺序跳过 '-' 与 list 对齐
    const btns = el.querySelectorAll('.ctx-item');
    let bi = 0;
    list.forEach((it) => {
      if (it === '-') return;
      const b = btns[bi++];
      if (!b || it.disabled) return;
      b.addEventListener('click', (e) => { e.stopPropagation(); close(); if (it.onClick) it.onClick(); });
    });

    // 先隐形渲染量尺寸，再决定是否贴着视口边缘翻转，避免菜单被切掉
    el.style.visibility = 'hidden';
    const r = el.getBoundingClientRect();
    const pad = 8;
    let x = ev.clientX, y = ev.clientY;
    if (x + r.width + pad > window.innerWidth) x = Math.max(pad, window.innerWidth - r.width - pad);
    if (y + r.height + pad > window.innerHeight) y = Math.max(pad, window.innerHeight - r.height - pad);
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.visibility = '';
    return true;
  }

  // 捕获阶段响应，保证在页面其它 click 逻辑之前关掉；但点击菜单内部要放行，
  // 否则元素会先被移除、按钮的 click 永远收不到。
  document.addEventListener('click', (e) => { if (el && el.contains(e.target)) return; close(); }, true);
  document.addEventListener('contextmenu', close, true);
  window.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
  window.addEventListener('blur', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  window.showCtxMenu = show;
  window.closeCtxMenu = close;
})();
