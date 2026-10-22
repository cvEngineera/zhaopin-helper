/* 智联投递助手 — 后台 Service Worker
 * 职责：开/关投递标签页、给详情页派发任务、把结果回传列表页、桌面通知、AI 请求代理。
 * 不含业务判断，业务全在 content script。
 */

const TASK_PREFIX = 'task:';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

async function handle(msg, sender) {
  const type = msg && msg.type;

  if (type === 'PING') return { ok: true, pong: Date.now() };

  /* 列表页请求：开一个后台标签页去投递 */
  if (type === 'OPEN_TAB') {
    const tab = await chrome.tabs.create({ url: msg.url, active: false });
    await chrome.storage.session.set({
      [TASK_PREFIX + tab.id]: {
        task: msg.task,
        listTabId: sender.tab ? sender.tab.id : null,
        createdAt: Date.now()
      }
    });
    return { ok: true, tabId: tab.id };
  }

  /* 详情页请求：取自己的任务 */
  if (type === 'GET_TASK') {
    const id = sender.tab && sender.tab.id;
    if (!id) return { ok: false, error: 'no tab id' };
    const key = TASK_PREFIX + id;
    const got = await chrome.storage.session.get(key);
    return { ok: true, payload: got[key] || null };
  }

  /* 详情页报告结果 → 关标签页 + 回传列表页 */
  if (type === 'DONE') {
    const id = sender.tab && sender.tab.id;
    if (!id) return { ok: true };
    const key = TASK_PREFIX + id;
    const got = await chrome.storage.session.get(key);
    const payload = got[key] || null;
    await chrome.storage.session.remove(key);

    // 先回传结果，再延迟关页：投完立刻关标签页本身就是个明显的机器特征
    if (payload && payload.listTabId) {
      chrome.tabs.sendMessage(payload.listTabId, { type: 'JOB_RESULT', tabId: id, result: msg.result || {} }).catch(() => {});
    }

    const delay = Math.max(0, Number(msg.closeDelay == null ? 4000 : msg.closeDelay));
    const closeTab = () => {
      try {
        chrome.tabs.remove(id);
      } catch (e) {
        /* 已关闭 */
      }
    };
    if (delay > 0) setTimeout(closeTab, delay);
    else closeTab();

    return { ok: true };
  }

  /* 打开多个搜索页并行投递 */
  if (type === 'OPEN_SEARCH_TABS') {
    const kws = (msg.keywords || []).filter(Boolean);
    const city = String(msg.city || '').trim();
    const limit = Math.max(1, Math.min(8, Number(msg.limit) || kws.length || 1));
    const created = [];
    for (const kw of kws.slice(0, limit)) {
      const url = 'https://sou.zhaopin.com/?kw=' + encodeURIComponent(kw) + (city ? '&jl=' + encodeURIComponent(city) : '');
      const tab = await chrome.tabs.create({ url, active: false });
      await chrome.storage.session.set({
        [TASK_PREFIX + tab.id]: {
          task: { mode: 'search', autoRun: true, keyword: kw },
          listTabId: sender.tab ? sender.tab.id : null,
          createdAt: Date.now()
        }
      });
      created.push({ kw, tabId: tab.id });
    }
    return { ok: true, created };
  }

  if (type === 'NOTIFY') {
    try {
      await chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/128.png',
        title: msg.title || '智联投递助手',
        message: String(msg.message || '')
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  if (type === 'AI_CHAT') return await aiChat(msg);

  return { ok: false, error: 'unknown message type: ' + type };
}

/* 标签页被用户手动关掉时，按「超时/中断」把结果回传，避免列表页干等 */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const key = TASK_PREFIX + tabId;
  try {
    const got = await chrome.storage.session.get(key);
    const payload = got[key];
    if (!payload) return;
    await chrome.storage.session.remove(key);
    if (payload.listTabId) {
      chrome.tabs.sendMessage(payload.listTabId, {
        type: 'JOB_RESULT',
        tabId,
        result: { status: 'error', message: '投递标签页被关闭' }
      }).catch(() => {});
    }
  } catch (e) { /* ignore */ }
});

/* AI 请求代理：地址与 key 全由用户自己填，扩展不内置任何服务商 */
async function aiChat(msg) {
  const base = String(msg.baseUrl || '').replace(/\/+$/, '');
  if (!base) return { ok: false, error: '未填写 base_url' };
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: 'base_url 必须以 http(s):// 开头' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(msg.timeout) || 60000));

  try {
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (msg.apiKey || ''),
        ...(msg.extraHeaders || {})
      },
      body: JSON.stringify({
        model: msg.model || 'gpt-4o-mini',
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: msg.messages
      })
    });

    const text = await res.text();
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' ' + text.slice(0, 300) };

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: '返回不是 JSON：' + text.slice(0, 200) };
    }
    const content =
      json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    return { ok: true, content: content || '' };
  } catch (e) {
    const m = String((e && e.message) || e);
    return { ok: false, error: /abort/i.test(m) ? '请求超时' : m };
  } finally {
    clearTimeout(timer);
  }
}
