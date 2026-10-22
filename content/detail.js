/* 智联投递助手 — 详情页执行器
 * 由后台打开的后台标签页加载本脚本；取任务 → 点投递 → 点确认 → 判定结果 → 上报并关页。
 * 用户自己正常浏览详情页时，这里不会做任何事。
 */
(function () {
  'use strict';

  const Z = window.ZPH;
  if (!Z) return;

  function isDetailPage() {
    const u = location.href;
    return /jobdetail/i.test(u) || /jobs\.zhaopin\.com\//i.test(u) || /\/job\/[A-Za-z0-9]{6,}\.htm/i.test(u);
  }
  if (!isDetailPage()) return;

  boot();

  async function boot() {
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: 'GET_TASK' });
    } catch (e) {
      return;
    }
    if (!res || !res.ok || !res.payload || !res.payload.task) return; // 正常浏览，不介入

    const task = res.payload.task;
    const sel = task.selectors || {};

    // 复核模式：只看这个岗位是不是已投递状态，不做任何点击
    if (task.mode === 'check') {
      await checkMode(task);
      return;
    }

    badge('准备投递：' + ((task.job && task.job.title) || ''));
    await Z.sleep(600);

    let result;
    try {
      result = await run(sel);
    } catch (e) {
      result = { status: 'error', message: String((e && e.message) || e) };
    }

    badge(result.status === 'ok' ? '投递成功，正在关闭…' : '结束：' + result.status);
    await Z.sleep(400);

    try {
      const delaySec = Number(task && task.closeDelay);
      await chrome.runtime.sendMessage({
        type: 'DONE',
        result,
        closeDelay: (isFinite(delaySec) ? delaySec : 4) * 1000
      });
    } catch (e) {
      /* 后台可能已休眠，忽略 */
    }
  }

  /** 复核：不点击任何东西，只读页面判断是否已投递 */
  async function checkMode(task) {
    badge('核对该岗位：' + ((task.job && task.job.title) || ''));
    await Z.sleep(2600);
    const body = document.body.innerText || '';
    const applied = /已投递|继续沟通|已申请|已发送简历|已向对方发送简历/.test(body);
    try {
      await chrome.runtime.sendMessage({
        type: 'DONE',
        result: { status: applied ? 'verified' : 'unverified', message: applied ? '' : '页面未见已投递状态' },
        closeDelay: 2000
      });
    } catch (e) {
      /* ignore */
    }
  }

  /* ---------- 主流程 ---------- */
  async function run(sel) {
    const applyTexts = parse(sel.applyText);
    const confirmTexts = parse(sel.confirmText);
    const successTexts = parse(sel.successText);

    if (isBlocked()) return { status: 'blocked', message: '页面出现验证码/安全验证' };

    // 等按钮渲染出来（SPA 常见）
    const btn = await waitFor(() => findButton(applyTexts), 15000);
    if (!btn) {
      if (hasAnyText(['已投递', '已申请', '查看简历', '继续沟通'])) return { status: 'already' };
      if (isBlocked()) return { status: 'blocked', message: '页面出现验证码/安全验证' };
      return { status: 'error', message: '找不到投递按钮，选择器可能已失效' };
    }
    if (isDisabled(btn)) return { status: 'already', message: '按钮不可点，可能已投递' };

    btn.click();
    await Z.sleep(1200);

    if (isBlocked()) return { status: 'blocked', message: '点击后出现验证码' };

    // 可能出现二次确认弹窗
    const confirm = await waitFor(() => findButton(confirmTexts, true), 6000, true);
    if (confirm && !isDisabled(confirm)) {
      confirm.click();
      await Z.sleep(1500);
    }

    if (isBlocked()) return { status: 'blocked', message: '确认后出现验证码' };

    if (/简历.{0,6}(不完整|未完善|完善)|请先(完善|上传)简历/.test(document.body.innerText || '')) {
      return { status: 'need_manual', message: '需要先完善简历' };
    }

    const ok = await waitFor(() => successSignal(successTexts), 12000, true);
    if (ok) {
      closeModal();
      return { status: 'ok' };
    }
    if (isBlocked()) return { status: 'blocked', message: '出现验证码' };
    return { status: 'need_manual', message: '已点击但未检测到成功提示，请人工确认' };
  }

  /* ---------- DOM 工具 ---------- */
  function parse(s) {
    return String(s || '')
      .split(/[,，\n|、;；]/)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    return /disabled|is-disabled/i.test(el.className || '');
  }

  /** 按文案找可点元素：完全匹配优先，其次包含匹配，取文字最短的 */
  function findButton(texts, preferDialog) {
    if (!texts.length) return null;
    const nodes = document.querySelectorAll('button,a,[role="button"],span,div');
    const hits = [];
    for (const el of nodes) {
      const t = (el.innerText || '').trim();
      if (!t || t.length > 16) continue;
      if (!texts.some((x) => t.indexOf(x) >= 0)) continue;
      if (!visible(el)) continue;
      // 太小的容器（图标、占位）跳过
      const r = el.getBoundingClientRect();
      if (r.height < 16) continue;
      const exact = texts.some((x) => t === x);
      const inDialog = preferDialog && el.closest('[class*="dialog"],[class*="modal"],[class*="popup"],[class*="layer"],[role="dialog"]') ? 3 : 0;
      hits.push({ el, score: (exact ? 2 : 0) + inDialog, len: t.length });
    }
    if (!hits.length) return null;
    hits.sort((a, b) => (b.score - a.score) || (a.len - b.len));
    // 若命中是 div 套 span，取最内层可点元素
    let el = hits[0].el;
    const inner = el.querySelector('button,a,[role="button"]');
    if (inner && visible(inner)) el = inner;
    return el;
  }

  /** 成功信号：投递成功弹窗可见，或页面出现成功文案 */
  function successSignal(texts) {
    const modal = document.querySelector('.deliver-greeting-modal');
    if (modal && getComputedStyle(modal).display !== 'none') return true;
    const body = document.body.innerText || '';
    if (/已向对方发送简历/.test(body)) return true;
    return texts.some((x) => body.indexOf(x) >= 0);
  }

  /** 投递成功后会弹「已向对方发送简历和打招呼语」，点「留在此页」或关闭收掉 */
  function closeModal() {
    const box = document.querySelector('.deliver-greeting-modal');
    if (!box || getComputedStyle(box).display === 'none') return;
    const stay = Array.from(box.querySelectorAll('button')).find((b) => /留在此页|关闭/.test(b.innerText || ''));
    const close = box.querySelector('.deliver-greeting-modal__close');
    (stay || close || { click() {} }).click();
  }

  function hasAnyText(list) {
    const body = document.body.innerText || '';
    return list.some((x) => body.indexOf(x) >= 0);
  }

  function isBlocked() {
    const body = document.body.innerText || '';
    if (/滑动验证|安全验证|请完成验证|人机验证|操作过于频繁|账号异常|请先登录|登录后查看/.test(body)) return true;
    if (document.querySelector('iframe[src*="captcha"],iframe[src*="verify"],.geetest_panel,#captcha,.yidun')) return true;
    return false;
  }

  async function waitFor(fn, timeout, soft) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      let v = null;
      try {
        v = fn();
      } catch (e) {
        v = null;
      }
      if (v) return v;
      await Z.sleep(300);
    }
    if (soft) return null;
    return null;
  }

  /* ---------- 页面角标（告诉用户这个标签页在干嘛） ---------- */
  function badge(text) {
    let el = document.getElementById('zp-helper-badge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'zp-helper-badge';
      el.style.cssText = [
        'position:fixed', 'top:12px', 'left:50%', 'transform:translateX(-50%)',
        'z-index:2147483647', 'background:#1668dc', 'color:#fff', 'padding:6px 14px',
        'border-radius:16px', 'font:12px/1.5 -apple-system,"Microsoft YaHei",sans-serif',
        'box-shadow:0 2px 8px rgba(0,0,0,.2)', 'pointer-events:none', 'max-width:80vw',
        'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis'
      ].join(';');
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = '智联助手 · ' + text;
  }
})();
