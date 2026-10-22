/* 智联投递助手 — 公共层
 * 配置、存储、岗位卡片提取、筛选规则、统计与日志。
 * list.js（列表页控制器）与 detail.js（详情页执行器）共用本文件的 window.ZPH。
 */
(function () {
  'use strict';

  const K = {
    CONFIG: 'zp:config',
    SEEN: 'zp:seen',
    COMPANY: 'zp:company',
    STATS: 'zp:stats',
    LOGS: 'zp:logs',
    PENDING: 'zp:pending',
    SESSION: 'zp:session',
    HR: 'zp:hr',
    SLOT: 'zp:slot',
    CLAIMS: 'zp:claims',
    RECORDS: 'zp:records',
    RESUME: 'zp:resume'
  };

  const CONFIG_VERSION = 10;

  const DEFAULT_CONFIG = {
    version: CONFIG_VERSION,
    dryRun: false,
    applyMode: 'auto',
    dailyLimit: 50,
    intervalMin: 15,
    intervalMax: 40,
    batchSize: 10,
    longPauseMin: 120,
    longPauseMax: 300,
    preStayMinSec: 3,
    preStayMaxSec: 8,
    postStayMinSec: 3,
    postStayMaxSec: 6,
    tabCloseDelaySec: 4,
    allowTabMode: false,
    confirmMode: false,
    parallelTabs: 3,
    followUpDays: 3,
    attachResume: false,
    skipRatio: 0,
    randomOrder: true,
    workStart: 9,
    workEnd: 23,
    blackList: '',
    remark: '',
    failBackoff: true,
    maxPages: 30,
    autoNextPage: true,
    detailTimeout: 45000,
    continueOnUnknown: true,
    failStreakLimit: 0,
    autoScan: true,
    verifyAfter: true,
    autoRotate: false,
    searchKeywords: '',
    searchCityCode: '',
    notifyOnFinish: true,
    filters: {
      keywordOn: false,
      keywordInclude: '',
      keywordExclude: '',
      salaryOn: true,
      salaryMin: 5,
      salaryMax: 30,
      companyExcludeOn: false,
      companyExclude: '',
      sizeOn: false,
      sizeMin: 100,
      eduOn: false,
      eduExclude: '大专',
      hunterOn: true,
      appliedDays: 30,
      sameCompanyOn: true,
      sameCompanyDays: 30,
      sameHrOn: true,
      sameHrDays: 30,
      companyNormalize: true
    },
    ai: {
      on: false,
      baseUrl: '',
      apiKey: '',
      model: 'gpt-4o-mini',
      minScore: 6,
      prompt: ''
    },
    selectors: {
      applyText: '立即投递,申请职位,投递简历,立即申请,我要投递',
      confirmText: '确认投递,确定投递,确认,确定',
      successText: '已向对方发送简历,投递成功,已投递,简历已发送,投递已发送,已发送简历'
    }
  };

  /* ---------- 存储 ---------- */
  let contextDead = false;

  /** 扩展被刷新/更新后，页面里的旧脚本会失去权限，这里统一兜住 */
  function isContextAlive() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  async function load(keys) {
    if (!isContextAlive()) {
      contextDead = true;
      return {};
    }
    try {
      const got = await chrome.storage.local.get(keys);
      return got || {};
    } catch (e) {
      if (/context invalidated|Extension context/i.test(String((e && e.message) || e))) contextDead = true;
      return {};
    }
  }

  async function save(obj) {
    if (!isContextAlive()) {
      contextDead = true;
      return;
    }
    try {
      await chrome.storage.local.set(obj);
    } catch (e) {
      if (/context invalidated|Extension context/i.test(String((e && e.message) || e))) contextDead = true;
    }
  }

  function deepMerge(base, patch) {
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (!patch || typeof patch !== 'object') return out;
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object') {
        out[k] = deepMerge(base[k], v);
      } else if (v !== undefined) {
        out[k] = v;
      }
    }
    return out;
  }

  // 老版本配置升级时套用的参数
  const MIGRATIONS = {
    // v1 -> v2：改成连投模式
    2: {
      applyMode: 'auto',
      dailyLimit: 120,
      intervalMin: 10,
      intervalMax: 10,
      autoNextPage: true,
      maxPages: 30,
      continueOnUnknown: true,
      failStreakLimit: 0
    },
    // v2 -> v3：上限对齐智联的每日 100
    3: { dailyLimit: 100 },
    // v3 -> v4：自动扫描 + 投后复核
    4: { autoScan: true, verifyAfter: true },
    // v4 -> v5：风控加固（随机间隔 + 批次长停 + 投前停留 + 禁后台标签页）
    5: {
      dailyLimit: 50,
      intervalMin: 15,
      intervalMax: 40,
      batchSize: 10,
      longPauseMin: 120,
      longPauseMax: 300,
      preStayMinSec: 3,
      preStayMaxSec: 8,
      allowTabMode: false
    },
    // v5 -> v6：演练模式改为默认关闭（需要时自己勾）
    6: { dryRun: false },
    // v6 -> v7：行为拟真（半自动 / 随机放弃 / 时段窗口 / 黑名单 / 退避 / 附言）
    7: {
      confirmMode: false,
      skipRatio: 0,
      randomOrder: true,
      workStart: 9,
      workEnd: 23,
      blackList: '',
      remark: '',
      failBackoff: true
    },
    // v7 -> v8：同 HR 过滤 + 公司名归一化
    8: { sameHrOn: true, sameHrDays: 30, companyNormalize: true },
    // v8 -> v9：多搜索页并行（全局限速 + 跨页认领）
    9: { parallelTabs: 3 },
    // v9 -> v10：台账 / 回复率 / 待跟进 / 简历附件
    10: { followUpDays: 3, attachResume: false }
  };

  async function getConfig() {
    const got = await load(K.CONFIG);
    const stored = got[K.CONFIG] || {};
    let merged = deepMerge(DEFAULT_CONFIG, stored);

    const v = Number(stored.version || 1);
    if (v < CONFIG_VERSION) {
      Object.keys(MIGRATIONS)
        .map(Number)
        .sort((a, b) => a - b)
        .filter((k) => k > v)
        .forEach((k) => {
          merged = deepMerge(merged, MIGRATIONS[k]);
        });
      merged.version = CONFIG_VERSION;
      try {
        await save({ [K.CONFIG]: merged });
      } catch (e) {
        /* 存不进去也不影响本次运行 */
      }
    }
    return merged;
  }
  async function setConfig(cfg) {
    const merged = deepMerge(await getConfig(), cfg);
    await save({ [K.CONFIG]: merged });
    return merged;
  }

  /* ---------- 时间与数字 ---------- */
  function todayKey(d) {
    const t = d || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function randInt(min, max) {
    const a = Math.max(0, Math.floor(min));
    const b = Math.max(a, Math.floor(max));
    return a + Math.floor(Math.random() * (b - a + 1));
  }
  function norm(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }
  function splitList(s) {
    return String(s || '')
      .split(/[,，\n|、;；]/)
      .map((x) => norm(x).toLowerCase())
      .filter(Boolean);
  }

  /* ---------- 薪资解析：统一折算成「月薪 K」 ---------- */
  const SALARY_RE = /(\d+(?:\.\d+)?)\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*(K|k|千|万|元)|(\d+(?:\.\d+)?)\s*(K|k|千|万)\s*以上|面议/;

  function salaryToK(value, unit) {
    const v = parseFloat(value);
    if (!isFinite(v)) return null;
    const u = String(unit || '').toLowerCase();
    if (u === 'k' || u === '千') return v;
    if (u === '万') return v * 10;
    if (u === '元') return v / 1000;
    return v;
  }

  /** 从一段文本里抽薪资，返回 { minK, maxK, raw, unit } */
  function parseSalary(text) {
    const s = norm(text);
    if (!s) return { minK: null, maxK: null, raw: '', unit: '' };
    if (/面议/.test(s)) return { minK: null, maxK: null, raw: '面议', unit: 'negotiable' };

    // 日薪 / 时薪
    let m = s.match(/(\d+(?:\.\d+)?)\s*元\s*\/\s*(天|日|小时|时)/);
    if (m) {
      const v = parseFloat(m[1]);
      const perDay = /天|日/.test(m[2]);
      const k = perDay ? (v * 21.75) / 1000 : (v * 8 * 21.75) / 1000;
      return { minK: k, maxK: k, raw: m[0], unit: perDay ? 'day' : 'hour' };
    }

    m = s.match(/(\d+(?:\.\d+)?)\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*(K|k|千|万|元)/);
    if (m) {
      const a = salaryToK(m[1], m[3]);
      const b = salaryToK(m[2], m[3]);
      return { minK: Math.min(a, b), maxK: Math.max(a, b), raw: m[0], unit: m[3] };
    }

    m = s.match(/(\d+(?:\.\d+)?)\s*(K|k|千|万)\s*以上/);
    if (m) {
      const a = salaryToK(m[1], m[2]);
      return { minK: a, maxK: a * 1.5, raw: m[0], unit: m[2] };
    }

    return { minK: null, maxK: null, raw: '', unit: '' };
  }

  function parseSize(text) {
    const s = norm(text);
    let m = s.match(/(\d+)\s*-\s*(\d+)\s*人/);
    if (m) return { min: +m[1], max: +m[2], raw: m[0] };
    m = s.match(/(\d+)\s*人以上/);
    if (m) return { min: +m[1], max: Infinity, raw: m[0] };
    return { min: null, max: null, raw: '' };
  }

  const EDU_LEVELS = ['博士', '硕士', '本科', '大专', '中专', '高中', '初中', '不限'];
  function pickByList(text, list) {
    for (const item of list) if (text.indexOf(item) >= 0) return item;
    return '';
  }

  /** 没有链接时用标题+公司生成稳定 id */
  function hashId(str) {
    let h = 5381;
    const t = String(str);
    for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0;
    return 'h' + h.toString(36);
  }

  /* ---------- 岗位卡片提取（启发式，不依赖 class 名） ---------- */
  function isDetailHref(href) {
    if (!href) return false;
    return /jobdetail|jobs\.zhaopin\.com\/|\/job\/[A-Za-z0-9]{6,}/i.test(href);
  }

  function climbCard(anchor) {
    let el = anchor;
    for (let i = 0; i < 8 && el; i++) {
      const t = el.innerText || '';
      if (t.length > 40 && t.length < 900 && SALARY_RE.test(t)) return el;
      el = el.parentElement;
    }
    return anchor.closest('li,article,div');
  }

  function jobIdFromHref(href) {
    const m = String(href).match(/([A-Za-z0-9]{6,})\.htm/) || String(href).match(/(\d{6,})/);
    return m ? m[1] : String(href);
  }

  /** 按真实 DOM（2026-10 版）精确解析，失败时退回文本启发式 */
  function parseCard(root, anchor) {
    const text = norm(root.innerText || '');
    if (!text) return null;

    const nameEl = root.querySelector('a[class*="jobinfo__name"],[class*="jobinfo__name"]');
    const salaryEl = root.querySelector('[class*="jobinfo__salary"]');
    const companyEl = root.querySelector('[class*="companyinfo__name"]');
    const infoItems = Array.from(root.querySelectorAll('[class*="jobinfo__other-info-item"]')).map((e) => norm(e.innerText)).filter(Boolean);
    const tags = Array.from(root.querySelectorAll('[class*="joblist-box__item-tag"]')).map((e) => norm(e.innerText)).filter(Boolean);

    let title = norm(nameEl && nameEl.innerText) || norm(anchor && anchor.innerText).split('\n')[0] || '';
    if (!title) {
      // 分栏页的卡片没有标题节点：取薪资之前的那段文字当岗位名
      const raw = norm(root.innerText || '');
      const m = raw.match(SALARY_RE);
      title = (m ? raw.slice(0, raw.indexOf(m[0])) : raw.slice(0, 30)).replace(/[|/·\-]+$/, '').trim().slice(0, 40);
    }
    const company = norm(companyEl && companyEl.innerText).split('\n')[0] || '';
    const href =
      (nameEl && nameEl.href) ||
      (anchor && anchor.href) ||
      root.getAttribute('data-url') ||
      root.getAttribute('data-href') ||
      '';

    const salary = parseSalary(norm(salaryEl && salaryEl.innerText) || text);
    const size = parseSize(tags.join(' ') || text);

    if (!title) return null;

    // 地点 / 经验 / 学历 一般落在 other-info-item 里，按顺序兜底识别
    const infoText = infoItems.join(' ');
    const exp = (infoText.match(/\d+\s*-\s*\d+\s*年|应届|经验不限|无经验/) || [''])[0];
    const city = infoItems.find((x) => /·|市|区|县/.test(x) && !/年|本科|大专|硕士|博士|不限/.test(x)) || '';
    const edu = pickByList(infoText || text, EDU_LEVELS);

    const labelText = tags.join(' ') + ' ' + text.slice(0, 400);

    return {
      id: href ? jobIdFromHref(href) : hashId(title + '|' + company),
      url: href,
      title: title.replace(/\s+/g, ' ').slice(0, 80),
      company: company.replace(/\s+/g, ' ').slice(0, 60),
      companyKey: normalizeCompany(company).slice(0, 40),
      hrSign: extractHrSign(text),
      salaryRaw: salary.raw,
      minK: salary.minK,
      maxK: salary.maxK,
      sizeMin: size.min,
      sizeRaw: size.raw,
      edu,
      exp,
      city,
      tags: tags.slice(0, 6),
      hunter: /猎头|人力资源服务|劳务派遣|中介|外包|外派/.test(labelText),
      unlogin: /unlogin/.test(String(root.className || '')),
      text: text.slice(0, 600),
      scannedAt: Date.now()
    };
  }

  const APPLY_WORDS = /立即投递|投递简历|申请职位|立即申请|我要投递/;

  // 智联自己说的「投满了」，比我们本地计数更权威
  const SITE_LIMIT_RE = /(今日|今天).{0,8}(投递|投递次数).{0,8}(上限|已满|已达|用完)|投递.{0,4}已达.{0,4}上限|(投递|申请)次数已用完|已达.{0,6}上限.{0,10}(明天|次日)/;

  function siteLimitHit(d) {
    const doc = d || document;
    const t = (doc.body && doc.body.innerText) || '';
    return SITE_LIMIT_RE.test(t);
  }

  /** 统计「文本里带薪资、长度像卡片」的块数量 */
  function countSalaryBlocks(d) {
    const doc = d || document;
    const SAL = /\d+(\.\d+)?\s*[-~]\s*\d+(\.\d+)?\s*(K|k|千|万|元)/;
    let n = 0;
    doc.querySelectorAll('div,li,section,article').forEach((el) => {
      const t = el.innerText || '';
      if (t.length > 12 && t.length < 300 && SAL.test(t)) n++;
    });
    return n;
  }

  /**
   * 判断当前是什么页面，决定用哪种投递策略
   * search: 搜索结果页，卡片自带投递按钮 → 列表直投
   * split : 左列表右详情，按钮在右侧     → 点卡片再投
   * detail: 职位详情页                  → 直接投当前页
   * other : 认不出来                     → 让用户框选或去搜索页
   */
  function detectPageType(d) {
    const doc = d || document;
    let url = '';
    try {
      url = location.href;
    } catch (e) {
      url = '';
    }

    let cardCount = 0;
    doc.querySelectorAll('[class*="joblist-box__item"]').forEach((el) => {
      const c = String(el.className || '');
      if (!/__iteminfo|__item-tag|__jobbtn|__icon-job/.test(c)) cardCount++;
    });

    let anchorCount = 0;
    doc.querySelectorAll('a[href]').forEach((a) => {
      if (isDetailHref(a.getAttribute('href'))) anchorCount++;
    });

    const salaryBlocks = countSalaryBlocks(doc);
    const isDetailUrl = /jobdetail|\/job\/[A-Za-z0-9]{6,}\.htm|jobs\.zhaopin\.com/i.test(url);

    let hasApplyBtn = false;
    doc.querySelectorAll('button,a').forEach((b) => {
      if (!hasApplyBtn && APPLY_WORDS.test((b.innerText || '').trim())) hasApplyBtn = true;
    });

    // 列表页再细分：卡片自带投递按钮 → 直投；按钮在右侧详情 → 点卡片
    // 以实际能识别出的岗位数为准，避免「识别 8 个却说认不出」
    const scanned = scanCards(doc).length;

    let cardHasApply = false;

    if (scanned >= 2 || cardCount > 1 || anchorCount > 1) {
      // 只看「第一个卡片元素内部」有没有投递按钮，不能用父容器判断（父容器里啥都有，必然为真）
      const firstJob = (() => {
        try {
          return scanCards(doc)[0] || null;
        } catch (e) {
          return null;
        }
      })();
      if (firstJob && firstJob.el) {
        Array.from(firstJob.el.querySelectorAll('button,a')).forEach((b) => {
          if (!cardHasApply && APPLY_WORDS.test((b.innerText || '').trim())) cardHasApply = true;
        });
      }
      return {
        type: cardHasApply ? 'search' : 'split',
        label: cardHasApply ? '职位列表页（卡片可直接投）' : '职位列表页（按钮在详情区）',
        cards: Math.max(scanned, cardCount, anchorCount),
        hasApplyBtn,
        cardHasApply
      };
    }
    if (!isDetailUrl && salaryBlocks >= 3) {
      return { type: 'split', label: '列表+详情页', cards: salaryBlocks, hasApplyBtn };
    }
    if (isDetailUrl || hasApplyBtn) {
      return { type: 'detail', label: '职位详情页', cards: scanned, hasApplyBtn };
    }
    if (scanned === 1) {
      return { type: 'other', label: '单岗位页面', cards: 1, hasApplyBtn, cardHasApply };
    }
    return { type: 'other', label: '其他页面', cards: 0, hasApplyBtn, cardHasApply };
  }

  /** 把一批卡片根节点解析成岗位，并挂上元素引用（同页投递时直接用） */
  function parseRoots(roots) {
    const out = [];
    for (const root of roots) {
      const a = root.querySelector('a[href*="jobdetail"]') || root.querySelector('a[href]');
      const job = parseCard(root, a);
      if (!job) continue;
      job.el = root;
      out.push(job);
    }
    return out;
  }

  /**
   * 扫描当前页面上的所有岗位卡片
   * 四种策略依次跑，取「识别数量最多」的那个（>=3 就提前收手），避免只捞到 1 个就返回
   * @param {Document} doc
   * @param {string} cardSelector 用户自定义的卡片选择器
   */
  function scanCards(doc, cardSelector) {
    const d = doc || document;
    let best = [];

    const take = (list) => {
      if (list && list.length > best.length) best = list;
    };

    // 1) 自定义选择器
    if (cardSelector) {
      try {
        take(parseRoots(Array.from(d.querySelectorAll(cardSelector))));
      } catch (e) {
        /* 选择器非法，继续 */
      }
    }

    // 2) 已知的搜索页卡片容器
    if (best.length < 3) {
      const roots = Array.from(d.querySelectorAll('[class*="joblist-box__item"]')).filter((el) => {
        const c = String(el.className || '');
        return !/__iteminfo|__item-tag|__jobbtn|__icon-job/.test(c);
      });
      if (roots.length) take(parseRoots(roots));
    }

    // 3) 带 jobdetail 链接的卡片
    if (best.length < 3) {
      const anchors = Array.from(d.querySelectorAll('a[href]')).filter((a) => isDetailHref(a.getAttribute('href')));
      const seenRoot = new Set();
      const list = [];
      for (const a of anchors) {
        const root = climbCard(a);
        if (!root || seenRoot.has(root)) continue;
        seenRoot.add(root);
        const job = parseCard(root, a);
        if (job) {
          job.el = root;
          list.push(job);
        }
      }
      if (list.length) take(list);
    }

    // 4) 兜底：含薪资且成组的块（分栏页、改版页面）
    if (best.length < 3) {
      const blocks = findSalaryBlocks(d);
      if (blocks.length) take(parseRoots(blocks));
    }

    return dedupe(best);
  }

  function dedupe(list) {
    const map = new Map();
    for (const j of list) if (!map.has(j.id)) map.set(j.id, j);
    return Array.from(map.values());
  }

  /** 找不到任何已知结构时：把「文本里含薪资、且长度不大、且有同类兄弟节点」的最小块当卡片 */
  function findSalaryBlocks(d) {
    const SAL = /\d+(\.\d+)?\s*[-~]\s*\d+(\.\d+)?\s*(K|k|千|万|元)|\d+(\.\d+)?\s*(K|k)\s*以上/;
    const cands = [];
    const all = d.querySelectorAll('div,li,article,section');
    for (const el of all) {
      const t = el.innerText || '';
      if (t.length < 12 || t.length > 300) continue;
      if (!SAL.test(t)) continue;
      cands.push(el);
    }
    if (cands.length < 3) return [];
    // 按「父节点下同类候选数」排序，取最多的一组，保证是列表而不是详情面板
    const byParent = new Map();
    for (const el of cands) {
      const p = el.parentElement;
      if (!p) continue;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(el);
    }
    let best = [];
    for (const [, arr] of byParent) if (arr.length > best.length) best = arr;
    return best.length >= 3 ? best : [];
  }

  /** 按 job.id 反查页面上的卡片元素（列表页内联投递用） */
  function findCardEl(job) {
    const anchors = Array.from(document.querySelectorAll('a[href*="jobdetail"],a[href]')).filter((a) => {
      const h = a.getAttribute('href') || '';
      return job.id && h.indexOf(job.id) >= 0;
    });
    for (const a of anchors) {
      let el = a;
      for (let i = 0; i < 10 && el; i++) {
        const c = String(el.className || '');
        if (/joblist-box__item/.test(c) && !/__iteminfo|__item-tag|__jobbtn|__icon-job/.test(c)) return el;
        el = el.parentElement;
      }
    }
    const root = anchors[0] ? climbCard(anchors[0]) : null;
    return root || null;
  }

  /* ---------- 筛选链 ---------- */
  async function getSeen() {
    const got = await load(K.SEEN);
    return got[K.SEEN] || {};
  }
  async function markSeen(id, status) {
    const all = await getSeen();
    all[id] = { t: Date.now(), s: status || 'ok' };
    const cutoff = Date.now() - 1000 * 60 * 60 * 24 * 120;
    for (const k of Object.keys(all)) if (all[k].t < cutoff) delete all[k];
    await save({ [K.SEEN]: all });
  }
  async function getCompanyMap() {
    const got = await load(K.COMPANY);
    return got[K.COMPANY] || {};
  }
  async function markCompany(key) {
    if (!key) return;
    const all = await getCompanyMap();
    all[key] = Date.now();
    await save({ [K.COMPANY]: all });
  }

  function withinDays(ts, days) {
    if (!days || days <= 0) return true;
    return Date.now() - ts < days * 86400000;
  }

  /**
   * 同步部分筛选。返回 { pass, reason }
   * seen / companyMap 由调用方异步取好后传入，避免每个岗位都读一次存储。
   */
  function matchJob(job, cfg, seen, companyMap, hrMap) {
    const f = cfg.filters || {};
    const hay = (job.title + ' ' + job.company + ' ' + job.text).toLowerCase();

    if (f.keywordOn) {
      const inc = splitList(f.keywordInclude);
      if (inc.length && !inc.some((w) => hay.indexOf(w) >= 0)) return { pass: false, reason: '关键词未命中' };
    }
    const exc = splitList(f.keywordExclude);
    if (exc.length) {
      const hit = exc.find((w) => hay.indexOf(w) >= 0);
      if (hit) return { pass: false, reason: '命中排除词「' + hit + '」' };
    }

    const black = hitBlackList(job, cfg);
    if (black) return { pass: false, reason: '公司命中黑名单「' + black + '」' };

    if (f.companyExcludeOn) {
      const list = splitList(f.companyExclude);
      const comp = job.company.toLowerCase();
      const hit = list.find((w) => comp.indexOf(w) >= 0);
      if (hit) return { pass: false, reason: '公司名命中排除「' + hit + '」' };
    }

    if (f.hunterOn && job.hunter) return { pass: false, reason: '猎头/中介岗位' };

    if (f.salaryOn) {
      if (job.maxK != null) {
        if (job.maxK < Number(f.salaryMin)) return { pass: false, reason: '薪资低于下限 ' + job.salaryRaw };
        if (job.minK != null && job.minK > Number(f.salaryMax)) return { pass: false, reason: '薪资高于上限 ' + job.salaryRaw };
      }
    }

    if (f.sizeOn && job.sizeMin != null) {
      if (job.sizeMin < Number(f.sizeMin)) return { pass: false, reason: '公司规模偏小 ' + job.sizeRaw };
    }

    if (f.eduOn && job.edu) {
      if (job.edu === String(f.eduExclude)) return { pass: false, reason: '学历要求 ' + job.edu };
    }

    const rec = seen[job.id];
    if (rec && withinDays(rec.t, Number(f.appliedDays))) {
      return { pass: false, reason: '已处理过（' + (rec.s || 'ok') + '）' };
    }

    if (f.sameCompanyOn && job.companyKey) {
      const ts = companyMap[job.companyKey];
      if (ts && withinDays(ts, Number(f.sameCompanyDays))) return { pass: false, reason: '同公司已投过' };
    }

    if (f.sameHrOn && job.hrSign && hrMap) {
      const ts = hrMap[job.hrSign];
      if (ts && withinDays(ts, Number(f.sameHrDays))) return { pass: false, reason: '同 HR 已投过（' + job.hrSign + '）' };
    }

    return { pass: true, reason: '' };
  }

  /* ---------- 统计 ---------- */
  async function getStats() {
    const got = await load(K.STATS);
    return got[K.STATS] || {};
  }
  async function bumpStat(field, n) {
    const all = await getStats();
    const key = todayKey();
    const day = all[key] || { scanned: 0, passed: 0, applied: 0, ok: 0, fail: 0, skip: 0 };
    day[field] = (day[field] || 0) + (n == null ? 1 : n);
    all[key] = day;
    // 只保留 90 天
    const keys = Object.keys(all).sort();
    while (keys.length > 90) delete all[keys.shift()];
    await save({ [K.STATS]: all });
    return day;
  }
  async function todayApplied() {
    const all = await getStats();
    const day = all[todayKey()];
    return day ? day.applied || 0 : 0;
  }

  /* ---------- 日志 ---------- */
  const logBuf = [];
  let logTimer = null;

  function log(level, msg, job) {
    const entry = { t: Date.now(), level: level || 'info', msg: String(msg || ''), title: job ? job.title : '', company: job ? job.company : '' };
    logBuf.push(entry);
    if (logBuf.length > 60) logBuf.shift();
    if (level === 'error') console.warn('[智联助手]', msg, job || '');
    if (!logTimer) {
      logTimer = setTimeout(() => {
        logTimer = null;
        const batch = logBuf.splice(0, logBuf.length);
        if (!batch.length) return;
        load(K.LOGS).then((got) => {
          const all = (got[K.LOGS] || []).concat(batch);
          save({ [K.LOGS]: all.slice(-300) });
        });
      }, 800);
    }
    return entry;
  }
  async function getLogs() {
    const got = await load(K.LOGS);
    return got[K.LOGS] || [];
  }
  async function clearLogs() {
    await save({ [K.LOGS]: [] });
  }

  /* ---------- 行为拟真工具 ---------- */

  /** 当前是否在允许投递的时段内（默认 9:00–23:00） */
  function inWorkHours(cfg, now) {
    const d = now || new Date();
    const h = d.getHours() + d.getMinutes() / 60;
    const a = Number(cfg.workStart == null ? 9 : cfg.workStart);
    const b = Number(cfg.workEnd == null ? 23 : cfg.workEnd);
    if (a === b) return true;
    if (a < b) return h >= a && h < b;
    return h >= a || h < b; // 跨零点
  }

  /** 洗牌：真人不按列表顺序投 */
  function shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** 黑名单：命中即跳过（公司名模糊匹配） */
  function hitBlackList(job, cfg) {
    const list = String((cfg && cfg.blackList) || '')
      .split(/[\n,，;；]/)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    if (!list.length) return '';
    const name = String(job.company || '').toLowerCase();
    return list.find((w) => name.indexOf(w) >= 0) || '';
  }

  /* ---------- HR 指纹 ---------- */

  // 常见的「招聘者 / HR / 联系人」写法
  const HR_PATTERNS = [
    /招聘者\s*[:：]?\s*([\u4e00-\u9fa5]{2,4})/,
    /HR\s*[:：]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z.]{1,11})/i,
    /联系人\s*[:：]?\s*([\u4e00-\u9fa5]{2,4})/
  ];
  // 明显不是人名的词，排除
  const HR_STOPWORDS = ['公司', '部门', '项目', '我们', '团队', '负责', '直招', '诚聘', '招聘'];

  /** 从一段文本里提取 HR 标识，取不到返回 '' */
  function extractHrSign(text) {
    const t = norm(text);
    if (!t) return '';
    for (const re of HR_PATTERNS) {
      const m = t.match(re);
      if (!m || !m[1]) continue;
      if (HR_STOPWORDS.some((w) => m[1].indexOf(w) >= 0)) continue;
      // 名字后面紧跟「公司/有限/部门」等 → 说明抓到的是公司名不是人名
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + 4);
      if (/^(公司|有限|部门|团队|中心|集团|项目|股份)/.test(after)) continue;
      return m[1];
    }
    return '';
  }

  /** 从当前页面（详情面板/详情页）里找 HR 标识 */
  function extractHrFromPage(doc) {
    const d = doc || document;
    // 1) 头像 alt 常是 HR 姓名
    const imgs = Array.from(d.querySelectorAll('img[alt]'));
    for (const img of imgs) {
      const alt = norm(img.getAttribute('alt') || '');
      if (/^[\u4e00-\u9fa5]{2,4}$/.test(alt) && !HR_STOPWORDS.some((w) => alt.indexOf(w) >= 0)) return alt;
    }
    // 2) 文本模式
    const text = (d.body && d.body.innerText) || '';
    return extractHrSign(text);
  }

  /** 公司名归一化：去掉后缀与空格，提升去重命中率 */
  function normalizeCompany(name) {
    let n = norm(name).toLowerCase();
    n = n.replace(/[（(][^）)]*[）)]/g, ''); // 去掉括号
    n = n.replace(/(股份)?有限(责任)?公司|集团|科技|技术|信息|网络|实业|控股/g, '');
    n = n.replace(/[\s·.,，。]/g, '');
    return n;
  }

  async function getHrMap() {
    const got = await load(K.HR);
    return got[K.HR] || {};
  }
  async function markHr(sign) {
    if (!sign) return;
    const all = await getHrMap();
    all[sign] = Date.now();
    const cutoff = Date.now() - 1000 * 60 * 60 * 24 * 180;
    for (const k of Object.keys(all)) if (all[k] < cutoff) delete all[k];
    await save({ [K.HR]: all });
  }

  /* ---------- 多标签页并行协调 ---------- */

  /** 每个页面一个随机 id，用来区分「是我抢到的」还是「别人抢到的」 */
  function tabId() {
    try {
      let id = sessionStorage.getItem('zp-tab-id');
      if (!id) {
        id = 't' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        sessionStorage.setItem('zp-tab-id', id);
      }
      return id;
    } catch (e) {
      return 't' + Math.random().toString(36).slice(2, 10);
    }
  }

  /**
   * 全局限速槽：多个标签页共用一个「下一个可投递时刻」。
   * 返回需要等待的毫秒数。
   */
  async function claimSlot(cfg) {
    const gapMin = Math.max(3, Number((cfg && cfg.intervalMin) || 15)) * 1000;
    const gapMax = Math.max(gapMin / 1000, Number((cfg && cfg.intervalMax) || 40)) * 1000;
    const now = Date.now();
    const got = await load(K.SLOT);
    const cur = got[K.SLOT] || { nextAt: 0 };
    const wait = Math.max(0, (cur.nextAt || 0) - now);
    const myNext = now + wait + randInt(Math.round(gapMin / 1000), Math.round(gapMax / 1000)) * 1000;
    await save({ [K.SLOT]: { nextAt: myNext, by: tabId(), at: now } });

    // 复查：若别人刚写入了更晚的时刻，以它为准，避免两个页同时开跑
    const again = await load(K.SLOT);
    const latest = (again[K.SLOT] || {}).nextAt || myNext;
    if (latest > myNext) return Math.max(wait, latest - now);
    return wait;
  }

  /** 全局冷却：所有页一起安静一段时间（用于批次长停） */
  async function claimCooldown(ms) {
    const now = Date.now();
    const got = await load(K.SLOT);
    const cur = got[K.SLOT] || { nextAt: 0 };
    const wait = Math.max(0, (cur.nextAt || 0) - now);
    await save({ [K.SLOT]: { nextAt: now + wait + (ms || 0), by: tabId(), at: now } });
    return wait;
  }

  /**
   * 岗位认领：多个标签页可能同时扫到同一个岗位。
   * 抢到返回 true；被别人抢走返回 false。
   */
  async function claimJob(id, ttlMs) {
    if (!id) return true;
    const ttl = ttlMs || 10 * 60 * 1000;
    const got = await load(K.CLAIMS);
    const all = got[K.CLAIMS] || {};
    const now = Date.now();
    const rec = all[id];
    const me = tabId();
    if (rec && rec.by !== me && now - rec.t < ttl) return false; // 别人正在投
    all[id] = { t: now, by: me };
    for (const k of Object.keys(all)) if (now - all[k].t > ttl) delete all[k];
    await save({ [K.CLAIMS]: all });
    return true;
  }

  /** 「全部停止」标志：只有 startedAt 早于标志时间的运行才会被停掉 */
  async function setStopAll() {
    await save({ 'zp:stopall': { at: Date.now() } });
  }
  async function checkStopAll(startedAt) {
    const got = await load('zp:stopall');
    const f = got['zp:stopall'];
    if (!f || !f.at) return false;
    return f.at > (startedAt || 0);
  }

  /* ---------- 投递台账 ---------- */

  /** 记一条投递记录（台账的原子数据） */
  async function addRecord(rec) {
    const got = await load(K.RECORDS);
    const list = got[K.RECORDS] || [];
    const i = list.findIndex((r) => r.id === rec.id);
    const item = Object.assign({ replied: 0, followed: 0 }, rec);
    if (i >= 0) list[i] = Object.assign(list[i], item);
    else list.push(item);
    await save({ [K.RECORDS]: list.slice(-500) });
    return item;
  }
  async function getRecords() {
    const got = await load(K.RECORDS);
    return got[K.RECORDS] || [];
  }
  async function updateRecord(id, patch) {
    const got = await load(K.RECORDS);
    const list = got[K.RECORDS] || [];
    const i = list.findIndex((r) => r.id === id);
    if (i < 0) return null;
    list[i] = Object.assign(list[i], patch);
    await save({ [K.RECORDS]: list });
    return list[i];
  }
  async function removeRecord(id) {
    const got = await load(K.RECORDS);
    const list = (got[K.RECORDS] || []).filter((r) => r.id !== id);
    await save({ [K.RECORDS]: list });
  }
  async function clearRecords() {
    await save({ [K.RECORDS]: [] });
  }

  /** 回复率统计：整体 + 按关键词分组 */
  function replyStats(records) {
    const sent = records.filter((r) => r.status === 'ok');
    const replied = sent.filter((r) => r.replied);
    const byKw = {};
    for (const r of sent) {
      const k = r.kw || '未标注';
      if (!byKw[k]) byKw[k] = { sent: 0, replied: 0 };
      byKw[k].sent++;
      if (r.replied) byKw[k].replied++;
    }
    for (const k in byKw) byKw[k].rate = byKw[k].sent ? byKw[k].replied / byKw[k].sent : 0;
    return {
      sent: sent.length,
      replied: replied.length,
      rate: sent.length ? replied.length / sent.length : 0,
      byKw
    };
  }

  /** 待跟进：投递成功、还没回复、且已过 followUpDays */
  function followUpList(records, days, now) {
    const d = (days == null ? 3 : Number(days)) * 86400000;
    const t = now || Date.now();
    return records.filter(
      (r) => r.status === 'ok' && !r.replied && !r.followed && t - (r.at || 0) >= d
    );
  }

  /* ---------- 简历附件 ---------- */
  async function getResume() {
    const got = await load(K.RESUME);
    return got[K.RESUME] || null;
  }
  async function setResume(file) {
    const buf = await file.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    const data = { name: file.name, type: file.type, size: file.size, data: btoa(bin) };
    await save({ [K.RESUME]: data });
    return data;
  }
  async function clearResume() {
    await save({ [K.RESUME]: null });
  }

  /** 把存的简历还原成 File 对象 */
  function resumeToFile(meta) {
    if (!meta || !meta.data) return null;
    try {
      const bin = atob(meta.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], meta.name, { type: meta.type || 'application/pdf' });
    } catch (e) {
      return null;
    }
  }

  /* ---------- 待复核队列 ---------- */
  async function addPending(item) {
    const got = await load(K.PENDING);
    const list = (got[K.PENDING] || []).filter((x) => x.id !== item.id);
    list.push(item);
    await save({ [K.PENDING]: list.slice(-50) });
  }
  async function getPending() {
    const got = await load(K.PENDING);
    return got[K.PENDING] || [];
  }
  async function clearPending() {
    await save({ [K.PENDING]: [] });
  }

  /* ---------- 运行会话（跨页面续跑用） ---------- */
  async function saveSession(sess) {
    await save({ [K.SESSION]: sess });
  }
  async function getSession() {
    const got = await load(K.SESSION);
    const s = got[K.SESSION] || null;
    if (!s) return null;
    if (Date.now() - (s.at || 0) > 30 * 60 * 1000) {
      await save({ [K.SESSION]: null });
      return null;
    }
    return s;
  }
  async function clearSession() {
    await save({ [K.SESSION]: null });
  }

  /* ---------- AI 打分（可选） ---------- */
  async function aiScore(job, cfg) {
    const ai = cfg.ai || {};
    if (!ai.on) return null;
    const prompt = (ai.prompt || '').trim() ||
      '你是求职评委。根据岗位信息判断是否值得投递，只返回 JSON：{"score":0-10,"reason":"一句话理由"}。';
    const user = [
      '岗位：' + job.title,
      '公司：' + job.company,
      '薪资：' + (job.salaryRaw || '未知'),
      '规模：' + (job.sizeRaw || '未知'),
      '学历：' + (job.edu || '未知'),
      '描述片段：' + job.text.slice(0, 500)
    ].join('\n');

    const res = await chrome.runtime.sendMessage({
      type: 'AI_CHAT',
      baseUrl: ai.baseUrl,
      apiKey: ai.apiKey,
      model: ai.model,
      timeout: 60000,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: user }
      ]
    });
    if (!res || !res.ok) return { score: null, reason: 'AI 调用失败：' + (res && res.error) };
    try {
      const json = JSON.parse(res.content);
      return { score: Number(json.score), reason: String(json.reason || '') };
    } catch (e) {
      return { score: null, reason: 'AI 返回无法解析' };
    }
  }

  window.ZPH = {
    K,
    DEFAULT_CONFIG,
    load,
    save,
    getConfig,
    setConfig,
    deepMerge,
    todayKey,
    sleep,
    randInt,
    norm,
    splitList,
    parseSalary,
    parseSize,
    scanCards,
    findCardEl,
    detectPageType,
    siteLimitHit,
    countSalaryBlocks,
    hashId,
    isDetailHref,
    jobIdFromHref,
    getSeen,
    markSeen,
    getCompanyMap,
    getHrMap,
    addRecord,
    getRecords,
    updateRecord,
    removeRecord,
    clearRecords,
    replyStats,
    followUpList,
    getResume,
    setResume,
    clearResume,
    resumeToFile,
    tabId,
    setStopAll,
    checkStopAll,
    claimSlot,
    claimCooldown,
    claimJob,
    markHr,
    extractHrSign,
    extractHrFromPage,
    normalizeCompany,
    markCompany,
    matchJob,
    getStats,
    bumpStat,
    todayApplied,
    log,
    getLogs,
    clearLogs,
    aiScore,
    addPending,
    getPending,
    clearPending,
    isContextAlive,
    inWorkHours,
    shuffle,
    hitBlackList,
    isContextDead: () => contextDead,
    saveSession,
    getSession,
    clearSession
  };
})();
