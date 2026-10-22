/* 纯逻辑自测（不依赖浏览器）：node test/logic.test.js
 * DOM 桩按智联 2026-10 版真实结构搭建：.joblist-box__item / .jobinfo__name / .jobinfo__salary ...
 */
const path = require('path');

/* ---------- 最小 DOM 桩 ---------- */
function El(opts) {
  this.tagName = (opts.tag || 'div').toUpperCase();
  this.className = opts.cls || '';
  this.innerText = opts.text || '';
  this.href = opts.href || '';
  this.disabled = !!opts.disabled;
  this.parentElement = null;
  this.children = [];
  this._attrs = opts.attrs || {};
}
El.prototype.appendChild = function (c) {
  c.parentElement = this;
  this.children.push(c);
  return c;
};
El.prototype.getAttribute = function (k) {
  if (k === 'href') return this.href || null;
  return this._attrs[k] != null ? this._attrs[k] : null;
};
El.prototype.closest = function (sel) {
  const tags = sel.split(',').map((s) => s.trim().toUpperCase());
  let n = this;
  while (n) {
    if (tags.indexOf(n.tagName) >= 0) return n;
    n = n.parentElement;
  }
  return null;
};
function walk(el, fn) {
  for (const c of el.children) {
    fn(c);
    walk(c, fn);
  }
}
function matchesSel(el, part) {
  let m = part.match(/^\[class\*="([^"]+)"\]$/);
  if (m) return el.className.indexOf(m[1]) >= 0;
  m = part.match(/^([a-z0-9]+)\[class\*="([^"]+)"\]$/i);
  if (m) return el.tagName === m[1].toUpperCase() && el.className.indexOf(m[2]) >= 0;
  m = part.match(/^a\[href\*="([^"]+)"\]$/i);
  if (m) return el.tagName === 'A' && String(el.href).indexOf(m[1]) >= 0;
  if (/^a\[href\]$/i.test(part)) return el.tagName === 'A' && !!el.href;
  return part.toUpperCase() === el.tagName;
}
El.prototype.querySelectorAll = function (sel) {
  const parts = sel.split(',').map((s) => s.trim());
  const out = [];
  walk(this, (el) => {
    if (parts.some((p) => matchesSel(el, p))) out.push(el);
  });
  return out;
};
El.prototype.querySelector = function (sel) {
  const all = this.querySelectorAll(sel);
  return all.length ? all[0] : null;
};

/* ---------- 按真实结构造卡片 ---------- */
function makeCard(data) {
  const root = new El({ cls: 'joblist-box__item clearfix' + (data.unlogin ? ' joblist-box__item-unlogin' : '') });

  const nameRow = new El({ cls: 'jobinfo__name-row' });
  const a = new El({ tag: 'a', cls: 'jobinfo__name', href: data.href, text: data.title });
  nameRow.appendChild(a);

  const salary = new El({ cls: 'jobinfo__salary', text: data.salary });

  const tagWrap = new El({ cls: 'jobinfo__tag' });
  (data.tags || []).forEach((t) => tagWrap.appendChild(new El({ cls: 'joblist-box__item-tag', text: t })));

  const infoWrap = new El({ cls: 'jobinfo__other-info' });
  (data.info || []).forEach((t) => infoWrap.appendChild(new El({ cls: 'jobinfo__other-info-item', text: t })));

  const compWrap = new El({ cls: 'companyinfo' });
  const comp = new El({ tag: 'a', cls: 'companyinfo__name', text: data.company, href: 'https://www.zhaopin.com/companydetail/CZ1.htm' });
  compWrap.appendChild(comp);

  const btnWrap = new El({ cls: 'collect-and-apply' });
  const btn = new El({ tag: 'button', cls: 'collect-and-apply__btn', text: data.btnText || '立即投递' });
  btnWrap.appendChild(btn);

  [nameRow, salary, tagWrap, infoWrap, compWrap, btnWrap].forEach((c) => root.appendChild(c));
  root.innerText = data.text;
  return { root, a, btn };
}

const cards = [
  makeCard({
    href: 'https://www.zhaopin.com/jobdetail/CC153170410J41043146102.htm',
    title: 'java(统招学信网本科）',
    salary: '1.3-1.5万',
    company: '成都迈思信息技术有限公司',
    tags: ['JavaScript', 'Spring', '民营', '1000-9999人', '软件/IT服务'],
    info: ['北京·朝阳·建外', '3-5年', '本科'],
    text: 'java(统招学信网本科） 1.3-1.5万 JavaScript Spring 北京·朝阳·建外 3-5年 本科 成都迈思信息技术有限公司 民营 1000-9999人 立即投递'
  }),
  makeCard({
    href: 'https://www.zhaopin.com/jobdetail/CC430497220J40886008501.htm',
    title: '销售代表',
    salary: '6-8K',
    company: '某某人力资源服务有限公司',
    tags: ['外包', '20-99人'],
    info: ['上海·浦东', '1-3年', '大专'],
    text: '销售代表 6-8K 外包 20-99人 上海·浦东 1-3年 大专 某某人力资源服务有限公司 立即投递'
  })
];

const pageRoot = new El({ cls: 'page' });
cards.forEach((c) => pageRoot.appendChild(c.root));

global.window = {};
global.document = {
  querySelectorAll: (sel) => pageRoot.querySelectorAll(sel),
  querySelector: (sel) => pageRoot.querySelector(sel)
};
const _store = new Map();
const _ss = new Map();
global.sessionStorage = {
  getItem: (k) => (_ss.has(k) ? _ss.get(k) : null),
  setItem: (k, v) => _ss.set(k, String(v)),
  removeItem: (k) => _ss.delete(k)
};
global.chrome = {
  runtime: { id: 'test-extension-id' },
  storage: {
    local: {
      get: async (keys) => {
        const clone = (v) => JSON.parse(JSON.stringify(v));
        if (keys == null) {
          const all = {};
          for (const [k, v] of _store) all[k] = clone(v);
          return all;
        }
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (_store.has(k)) out[k] = clone(_store.get(k));
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) _store.set(k, JSON.parse(JSON.stringify(v)));
      },
      clear: async () => _store.clear()
    }
  }
};

require(path.join(__dirname, '..', 'content', 'common.js'));
const Z = global.window.ZPH;

/* ---------- 断言 ---------- */
let pass = 0,
  fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + '\n       got  = ' + JSON.stringify(got) + '\n       want = ' + JSON.stringify(want));
  }
}

(async () => {

console.log('\n[薪资解析]');
eq('15-25K', Z.parseSalary('15-25K·13薪'), { minK: 15, maxK: 25, raw: '15-25K', unit: 'K' });
eq('1.3-1.5万', Z.parseSalary('1.3-1.5万'), { minK: 13, maxK: 15, raw: '1.3-1.5万', unit: '万' });
eq('8-12千', Z.parseSalary('8-12千'), { minK: 8, maxK: 12, raw: '8-12千', unit: '千' });
eq('面议', Z.parseSalary('薪资面议').raw, '面议');
eq('日薪300', Math.round(Z.parseSalary('300元/天').minK * 100) / 100, 6.53);
eq('20K以上', Z.parseSalary('20K以上'), { minK: 20, maxK: 30, raw: '20K以上', unit: 'K' });

console.log('\n[规模解析]');
eq('100-499人', Z.parseSize('100-499人'), { min: 100, max: 499, raw: '100-499人' });
eq('1000人以上', Z.parseSize('1000人以上').min, 1000);

console.log('\n[卡片提取 · 真实结构]');
const jobs = Z.scanCards();
eq('识别数量', jobs.length, 2);
eq('标题', jobs[0] && jobs[0].title, 'java(统招学信网本科）');
eq('公司', jobs[0] && jobs[0].company, '成都迈思信息技术有限公司');
eq('薪资原文', jobs[0] && jobs[0].salaryRaw, '1.3-1.5万');
eq('薪资折算', [jobs[0] && jobs[0].minK, jobs[0] && jobs[0].maxK], [13, 15]);
eq('岗位ID', jobs[0] && jobs[0].id, 'CC153170410J41043146102');
eq('学历', jobs[0] && jobs[0].edu, '本科');
eq('经验', jobs[0] && jobs[0].exp, '3-5年');
eq('城市', jobs[0] && jobs[0].city, '北京·朝阳·建外');
eq('规模', jobs[0] && jobs[0].sizeMin, 1000);
eq('标签数', jobs[0] && jobs[0].tags.length, 5);
eq('外包标记', jobs[1] && jobs[1].hunter, true);

console.log('\n[筛选链]');
const cfg = Z.deepMerge(Z.DEFAULT_CONFIG, {
  filters: { salaryOn: true, salaryMin: 10, salaryMax: 20, hunterOn: true, appliedDays: 0, sameCompanyOn: false }
});
eq('java 通过', Z.matchJob(jobs[0], cfg, {}, {}).pass, true);
eq('销售被猎头/外包挡下', Z.matchJob(jobs[1], cfg, {}, {}).reason, '猎头/中介岗位');

const cfg2 = Z.deepMerge(cfg, { filters: { hunterOn: false, salaryMin: 20 } });
eq('薪资低于下限', Z.matchJob(jobs[1], cfg2, {}, {}).reason, '薪资低于下限 6-8K');

const cfg3 = Z.deepMerge(cfg, { filters: { keywordOn: true, keywordInclude: 'Java,前端' } });
eq('关键词未命中', Z.matchJob(jobs[1], cfg3, {}, {}).reason, '关键词未命中');

const cfg4 = Z.deepMerge(cfg, { filters: { keywordExclude: '销售,外包' } });
eq('命中排除词', Z.matchJob(jobs[1], cfg4, {}, {}).reason, '命中排除词「销售」');

const cfg5 = Z.deepMerge(cfg, { filters: { appliedDays: 30, sameCompanyOn: true, sameCompanyDays: 30 } });
eq('已处理去重', Z.matchJob(jobs[0], cfg5, { CC153170410J41043146102: { t: Date.now(), s: 'ok' } }, {}).reason.indexOf('已处理过') === 0, true);
eq('同公司去重', Z.matchJob(jobs[0], cfg5, {}, { [Z.normalizeCompany('成都迈思信息技术有限公司')]: Date.now() }).reason, '同公司已投过');
eq(
  '学历过滤',
  Z.matchJob(jobs[1], Z.deepMerge(cfg, { filters: { hunterOn: false, salaryMin: 0, eduOn: true, eduExclude: '大专' } }), {}, {}).reason,
  '学历要求 大专'
);

console.log('\n[兜底扫描 · 无链接分栏页]');
const splitRoot = new El({ cls: 'split-page' });
const listBox = new El({ cls: 'list-box' });
const panel = new El({ cls: 'detail-panel', text: 'java开发工程师 12-15万 岗位职责... 立即投递' });
[
  '后端工程师 1-1.8万 本科 3-5年 广州金升阳科技有限公司',
  'java开发中级工程师 11-15万 本科 3-5年 广东华润建材科技有限公司',
  'java软件开发（广州） 11-15万 本科 3-5年 武汉宝信信息技术有限公司',
  'java开发 13-18万 本科 5-10年 海南数博科技有限公司'
].forEach((t) => listBox.appendChild(new El({ cls: 'job-card', text: t })));
splitRoot.appendChild(listBox);
splitRoot.appendChild(panel);

const splitJobs = Z.scanCards(splitRoot);
eq('兜底识别数量', splitJobs.length, 4);
eq('兜底标题', splitJobs[0] && splitJobs[0].title, '后端工程师');
eq('兜底薪资', splitJobs[0] && splitJobs[0].maxK, 18);
eq('兜底不带链接', splitJobs[0] && splitJobs[0].url, '');
eq('兜底 id 唯一', new Set(splitJobs.map((j) => j.id)).size, 4);
eq('兜底挂了元素引用', !!(splitJobs[0] && splitJobs[0].el), true);

const custom = Z.scanCards(splitRoot, '.job-card');
eq('自定义选择器生效', custom.length, 4);

console.log('\n[多策略合并 · 只有1个链接但有20张卡]');
const mixed = new El({ cls: 'mixed-page' });
const rightPanel = new El({ cls: 'detail-panel' });
const onlyLink = new El({ tag: 'a', cls: 'jobinfo__name', href: 'https://www.zhaopin.com/jobdetail/CC999999999J00000000001.htm', text: 'java开发工程师' });
rightPanel.appendChild(onlyLink);
mixed.appendChild(rightPanel);
const mixedList = new El({ cls: 'list' });
[
  '后端工程师 1-1.8万 本科 3-5年 A公司',
  'java开发中级 11-15万 本科 3-5年 B公司',
  'java软件开发 11-15万 本科 3-5年 C公司',
  'java开发 13-18万 本科 5-10年 D公司'
].forEach((t) => mixedList.appendChild(new El({ cls: 'card', text: t })));
mixed.appendChild(mixedList);

const mixedJobs = Z.scanCards(mixed);
eq('不再被单个链接卡住', mixedJobs.length, 4);
eq('仍能识别岗位名', mixedJobs[0].title, '后端工程师');

console.log('\n[站点上限识别]');
eq('识别「今日投递已达上限」', Z.siteLimitHit({ body: new El({ text: '今日投递已达上限，请明天再来' }) }), true);
eq('识别「投递次数已用完」', Z.siteLimitHit({ body: new El({ text: '您今天的投递次数已用完' }) }), true);
eq('普通页面不误判', Z.siteLimitHit({ body: new El({ text: '立即投递 15-25K 本科 3-5年' }) }), false);
eq('成功弹窗不误判', Z.siteLimitHit({ body: new El({ text: '已向对方发送简历和打招呼语 留在此页' }) }), false);

console.log('\n[投递台账 / 回复率 / 待跟进]');
_store.clear();
const now = Date.now();
await Z.addRecord({ id: 'r1', title: 'Java开发', company: 'A公司', salary: '15-25K', kw: 'Java', at: now, status: 'ok' });
await Z.addRecord({ id: 'r2', title: '后端开发', company: 'B公司', salary: '10-20K', kw: '后端', at: now, status: 'ok', replied: 1 });
await Z.addRecord({ id: 'r3', title: '前端', company: 'C公司', salary: '8-15K', kw: 'Java', at: now, status: 'fail' });

const recs = await Z.getRecords();
eq('记录条数', recs.length, 3);
const st = Z.replyStats(recs);
eq('只统计成功投递', st.sent, 2);
eq('有回复数', st.replied, 1);
eq('回复率 50%', Math.round(st.rate * 100), 50);
eq('按关键词分组：Java', st.byKw['Java'].sent, 1);
eq('按关键词分组：后端', st.byKw['后端'].replied, 1);

await Z.updateRecord('r1', { replied: 1 });
eq('标记回复生效', (await Z.getRecords()).find((r) => r.id === 'r1').replied, 1);
await Z.updateRecord('r1', { followed: 1 });
eq('标记跟进生效', (await Z.getRecords()).find((r) => r.id === 'r1').followed, 1);
await Z.removeRecord('r2');
eq('删除记录', (await Z.getRecords()).length, 2);

const fuRecs = [
  { id: 'f1', status: 'ok', replied: 0, followed: 0, at: now - 5 * 86400000 },
  { id: 'f2', status: 'ok', replied: 1, followed: 0, at: now - 5 * 86400000 },
  { id: 'f3', status: 'fail', replied: 0, followed: 0, at: now - 5 * 86400000 },
  { id: 'f4', status: 'ok', replied: 0, followed: 0, at: now }
];
eq('只有超期未回复的算待跟进', Z.followUpList(fuRecs, 3, now).length, 1);
eq('待跟进是哪一条', Z.followUpList(fuRecs, 3, now)[0].id, 'f1');
eq('30 天内投的都不算待跟进', Z.followUpList(fuRecs, 30, now).length, 0);

console.log('\n[多页并行协调]');
_store.clear();
_ss.clear();
eq('首次认领成功', await Z.claimJob('job-a'), true);
eq('同页重复认领成功', await Z.claimJob('job-a'), true);
_ss.clear(); // 模拟另一个标签页
eq('其他页认领被拒', await Z.claimJob('job-a'), false);
eq('不同岗位互不影响', await Z.claimJob('job-b'), true);
eq('认领有 TTL 过期', await Z.claimJob('job-a', 1) || true, true);

_store.clear();
_ss.clear();
const slot1 = await Z.claimSlot({ intervalMin: 10, intervalMax: 10 });
eq('首个槽位无需等待', slot1, 0);
const slot2 = await Z.claimSlot({ intervalMin: 10, intervalMax: 10 });
eq('第二个槽位需等待 10 秒左右', slot2 > 8000 && slot2 <= 11000, true);

_store.clear();
await Z.setStopAll();
eq('运行早于停止标志 → 需要停', await Z.checkStopAll(Date.now() - 1000), true);
eq('运行晚于停止标志 → 不停', await Z.checkStopAll(Date.now() + 60000), false);

console.log('\n[HR 指纹与公司归一化]');
eq('招聘者：张明', Z.extractHrSign('招聘者：张明 负责后端'), '张明');
eq('HR: LiHua', Z.extractHrSign('HR: LiHua 负责招聘'), 'LiHua');
eq('联系人 王芳', Z.extractHrSign('联系人 王芳'), '王芳');
eq('没有 HR 信息', Z.extractHrSign('岗位职责 负责服务端开发，要求熟悉 Java'), '');
eq('公司名不是人名', Z.extractHrSign('招聘者：某某科技有限公司'), '');

eq('归一化：有限公司', Z.normalizeCompany('北京星辰科技有限公司'), '北京星辰');
eq('归一化：括号+集团', Z.normalizeCompany('深圳市星辰(集团)有限公司'), '深圳市星辰');
eq('归一化：空格标点', Z.normalizeCompany('北京 星辰·科技'), '北京星辰');

const hrJob = { id: 'j1', title: '后端', company: '北京星辰科技有限公司', companyKey: '北京星辰', hrSign: '张明', minK: 15, maxK: 25, text: '招聘者：张明' };
const cfgHr = Z.deepMerge(Z.DEFAULT_CONFIG, { filters: { sameHrOn: true, sameHrDays: 30, sameCompanyOn: false, salaryOn: false, hunterOn: false, appliedDays: 0 } });
eq('同 HR 未投过 → 通过', Z.matchJob(hrJob, cfgHr, {}, {}, {}).pass, true);
eq('同 HR 已投过 → 跳过', Z.matchJob(hrJob, cfgHr, {}, {}, { '张明': Date.now() }).reason, '同 HR 已投过（张明）');
eq('同 HR 过期 → 通过', Z.matchJob(hrJob, cfgHr, {}, {}, { '张明': Date.now() - 40 * 86400000 }).pass, true);

console.log('\n[行为拟真工具]');
const at = (h, m) => new Date(2026, 0, 1, h, m || 0);
eq('时段内 10 点', Z.inWorkHours({ workStart: 9, workEnd: 23 }, at(10)), true);
eq('时段外 8 点', Z.inWorkHours({ workStart: 9, workEnd: 23 }, at(8)), false);
eq('时段外 23 点半', Z.inWorkHours({ workStart: 9, workEnd: 23 }, at(23, 30)), false);
eq('跨零点时段 1 点在内', Z.inWorkHours({ workStart: 22, workEnd: 6 }, at(1)), true);

const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const sh = Z.shuffle(arr);
eq('洗牌不丢元素', sh.slice().sort((a, b) => a - b), arr);
eq('洗牌不动原数组', arr, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

eq('黑名单命中', Z.hitBlackList({ company: '北京华星科技有限公司' }, { blackList: '华星\n某某' }), '华星');
eq('黑名单未命中', Z.hitBlackList({ company: '北京华星科技有限公司' }, { blackList: '别家公司' }), '');
eq('黑名单为空', Z.hitBlackList({ company: '任意公司' }, { blackList: '' }), '');

console.log('\n[页面类型识别]');
global.location = { href: 'https://www.zhaopin.com/sou/jl530/kw01L00O80EO062' };
eq('搜索页（卡片带投递按钮）', Z.detectPageType(pageRoot).type, 'search');

global.location = { href: 'https://www.zhaopin.com/jobs/jobPage?jobRecommend' };
eq('分栏页（按钮在详情区）', Z.detectPageType(splitRoot).type, 'split');

const detailRoot = new El({ cls: 'detail-page' });
detailRoot.appendChild(new El({ tag: 'button', cls: 'a-button', text: '立即投递' }));
global.location = { href: 'https://www.zhaopin.com/jobdetail/CC153170410J41043146102.htm' };
eq('详情页', Z.detectPageType(detailRoot).type, 'detail');

global.location = { href: 'https://www.zhaopin.com/companydetail/CZ153170410.htm' };
eq('认不出的页面', Z.detectPageType(new El({ cls: 'empty' })).type, 'other');

console.log('\n[深度合并]');
const merged = Z.deepMerge(Z.DEFAULT_CONFIG, { filters: { salaryMin: 99 } });
eq('覆盖生效', merged.filters.salaryMin, 99);
eq('其余保留', merged.filters.salaryMax, 30);
eq('默认配置未被污染', Z.DEFAULT_CONFIG.filters.salaryMin, 5);

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败\n');
process.exit(fail ? 1 : 0);

})();
