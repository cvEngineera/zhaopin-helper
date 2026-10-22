/* 智联投递助手 — 列表页控制器
 * 悬浮球 + 面板 UI、筛选链调度、限速引擎、统计与日志展示。
 */
(function () {
  'use strict';

  const Z = window.ZPH;
  if (!Z) return;

  /* ---------- 页面判定 ---------- */
  function isDetailPage() {
    const u = location.href;
    return /jobdetail/i.test(u) || /jobs\.zhaopin\.com\//i.test(u) || /\/job\/[A-Za-z0-9]{6,}\.htm/i.test(u);
  }
  // 详情页也挂面板：提供「投递当前岗位」；列表类页面才显示批量按钮
  let PAGE = Z.detectPageType();
  let IS_DETAIL = PAGE.type === 'detail';

  const HOST_ID = 'zp-helper-host';
  if (document.getElementById(HOST_ID)) return;

  /* ---------- 状态 ---------- */
  const state = {
    running: false,
    stopping: false,
    rotating: false,
    keywordIndex: 0,
    pendingJobs: [],
    pending: new Map(), // tabId -> resolve
    counts: { scan: 0, pass: 0, skip: 0, ok: 0, fail: 0 },
    page: 1,
    current: null,
    status: '待机'
  };

  /* ---------- 配置字段表 ---------- */
  const GROUPS = [
    {
      title: '运行',
      fields: [
        { path: 'dryRun', type: 'check', label: '演练模式（只筛选、不真实投递）', hint: '默认关闭。只想看筛选结果时自己勾上，勾上就不会真的投' },
        {
          path: 'applyMode',
          type: 'select',
          label: '投递方式',
          options: [
            { v: 'auto', t: '自动（按页面类型判断）' },
            { v: 'list', t: '列表页直投（快）' },
            { v: 'split', t: '同页点卡片 + 右侧投递' },
            { v: 'detail', t: '打开详情页（高风险，需开下方开关）' }
          ],
          hint: '默认自动：搜索页直投、分栏页点卡片、详情页投当前页'
        },
        { path: 'dailyLimit', type: 'number', label: '每日投递上限', min: 1, max: 200, hint: '建议 40–60。平台允许 100，但顶满本身就是高风险特征' },
        { path: 'intervalMin', type: 'number', label: '间隔下限（秒）', min: 8, max: 600, hint: '默认 15。**不要设成和上限相等**，固定周期是最典型的脚本特征' },
        { path: 'intervalMax', type: 'number', label: '间隔上限（秒）', min: 8, max: 900, hint: '默认 40。每次在上下限之间随机' },
        { path: 'batchSize', type: 'number', label: '每投几个长停一次', min: 0, max: 50, hint: '默认 10，填 0 = 不插长停' },
        { path: 'longPauseMin', type: 'number', label: '长停下限（秒）', min: 30, max: 1800, hint: '默认 120' },
        { path: 'longPauseMax', type: 'number', label: '长停上限（秒）', min: 30, max: 3600, hint: '默认 300' },
        { path: 'preStayMinSec', type: 'number', label: '投前停留下限（秒）', min: 0, max: 60, hint: '默认 3，模拟看一眼岗位描述' },
        { path: 'preStayMaxSec', type: 'number', label: '投前停留上限（秒）', min: 0, max: 60, hint: '默认 8' },
        { path: 'postStayMinSec', type: 'number', label: '投后停留下限（秒）', min: 0, max: 120, hint: '默认 3。投完别马上切走' },
        { path: 'postStayMaxSec', type: 'number', label: '投后停留上限（秒）', min: 0, max: 120, hint: '默认 6' },
        { path: 'tabCloseDelaySec', type: 'number', label: '后台标签页延迟关闭（秒）', min: 0, max: 60, hint: '默认 4。投完立刻关标签页是很明显的机器特征，填 0 = 立即关' },
        { path: 'followUpDays', type: 'number', label: '待跟进天数', min: 1, max: 60, hint: '投出去超过多少天还没回复就在台账里提醒' },
        { path: 'attachResume', type: 'check', label: '投递时自动附加简历', hint: '需先在「台账」里选好文件。智联投递弹窗没有附件入口时会静默跳过' },
        { path: 'allowTabMode', type: 'check', label: '允许后台标签页模式（高风险）', hint: '开启后才能用「打开详情页」和「复核结果」。短时间内批量开标签页异常特征很强，建议保持关闭' },
        { path: 'maxPages', type: 'number', label: '最多翻页数', min: 1, max: 50 },
        { path: 'autoNextPage', type: 'check', label: '允许自动翻页' },
        { path: 'detailTimeout', type: 'number', label: '详情页超时（毫秒）', min: 10000, max: 120000 },
        { path: 'notifyOnFinish', type: 'check', label: '结束时发系统通知' },
        { path: 'continueOnUnknown', type: 'check', label: '结果不确定时继续投下一个', hint: '默认开启。遇到「无法确认成功」不停，继续下一个' },
        { path: 'failStreakLimit', type: 'number', label: '连续失败几次后停止', min: 0, max: 50, hint: '填 0 = 永不因失败停止' },
        { path: 'parallelTabs', type: 'number', label: '并行搜索页数量', min: 1, max: 8, hint: '默认 3。每个页一个关键词，共用一个全局限速槽，总速率不变' },
        { path: 'autoScan', type: 'check', label: '自动扫描当前页', hint: '不用点「仅扫描」，打开页面/翻页自动识别并统计' },
        { path: 'verifyAfter', type: 'check', label: '投后复核（4 秒后再确认一次）', hint: '防止把一闪而过的提示误判成成功' },
        { path: 'autoRotate', type: 'check', label: '关键词跑完自动换下一个', hint: '需要填下面的关键词列表；会重新加载页面并从断点继续' },
        { path: 'searchKeywords', type: 'text', label: '关键词列表（逗号分隔）', hint: '例：Java,后端开发,开发工程师' },
        { path: 'searchCityCode', type: 'text', label: '城市代码 jl', hint: '广州=763，全国=489。留空则用当前搜索的城市' }
      ]
    },
    {
      title: '筛选',
      fields: [
        { path: 'filters.keywordOn', type: 'check', label: '启用关键词筛选' },
        { path: 'filters.keywordInclude', type: 'text', label: '必须包含（逗号分隔，任一命中）' },
        { path: 'filters.keywordExclude', type: 'text', label: '排除词（逗号分隔）', hint: '例：外包,驻场,销售' },
        { path: 'filters.salaryOn', type: 'check', label: '启用薪资过滤' },
        { path: 'filters.salaryMin', type: 'number', label: '薪资下限（K/月）', min: 0, max: 500 },
        { path: 'filters.salaryMax', type: 'number', label: '薪资上限（K/月）', min: 0, max: 500, hint: '「面议」默认放行' },
        { path: 'filters.companyExcludeOn', type: 'check', label: '启用公司名排除' },
        { path: 'filters.companyExclude', type: 'text', label: '公司名排除词（逗号分隔）' },
        { path: 'filters.sizeOn', type: 'check', label: '启用公司规模过滤' },
        { path: 'filters.sizeMin', type: 'number', label: '最小人数', min: 0, max: 100000, hint: '「100-499人」按 100 计' },
        { path: 'filters.hunterOn', type: 'check', label: '排除猎头/中介/外包标签' },
        { path: 'filters.eduOn', type: 'check', label: '启用学历过滤' },
        { path: 'filters.eduExclude', type: 'text', label: '排除的学历', hint: '填「大专」则大专岗位被跳过' },
        { path: 'filters.appliedDays', type: 'number', label: '已处理去重天数', min: 0, max: 365, hint: '0 表示永不过期' },
        { path: 'filters.sameCompanyOn', type: 'check', label: '同公司只投一次' },
        { path: 'filters.sameCompanyDays', type: 'number', label: '同公司去重天数', min: 0, max: 365 },
        { path: 'filters.companyNormalize', type: 'check', label: '公司名归一化后再去重', hint: '去掉「有限公司/集团/科技」等后缀再比对，避免同一家公司换写法就重复投' },
        { path: 'filters.sameHrOn', type: 'check', label: '同 HR 只投一次', hint: '智联列表页不带 HR 信息，靠详情页/卡片上能识别到的招聘者判断；识别不到就退化成同公司过滤' },
        { path: 'filters.sameHrDays', type: 'number', label: '同 HR 去重天数', min: 0, max: 365 }
      ]
    },
    {
      title: '行为拟真',
      fields: [
        { path: 'confirmMode', type: 'check', label: '半自动模式（逐个确认再投）', hint: '插件只筛不投，列出候选清单，你点「投」才投。最稳，也最不像脚本' },
        { path: 'skipRatio', type: 'number', label: '随机放弃比例（%）', min: 0, max: 50, hint: '默认 0。真人不会 100% 匹配就投，随机放掉一部分更像人，也能筛掉边缘岗位' },
        { path: 'randomOrder', type: 'check', label: '投递顺序随机打乱', hint: '默认开。按列表顺序逐个投是明显的机器特征' },
        { path: 'workStart', type: 'number', label: '允许投递起始（点）', min: 0, max: 23, hint: '默认 9。深夜批量投递很扎眼' },
        { path: 'workEnd', type: 'number', label: '允许投递结束（点）', min: 0, max: 24, hint: '默认 23' },
        { path: 'blackList', type: 'textarea', label: '公司黑名单（每行一个）', hint: '公司名模糊匹配，命中直接跳过' },
        { path: 'remark', type: 'textarea', label: '投递附言', hint: '如果投递弹窗里有留言输入框就自动填上；检测不到就跳过，不会乱填' },
        { path: 'failBackoff', type: 'check', label: '连续失败时指数退避', hint: '默认开。失败越多等越久，避免密集重试被当成异常' }
      ]
    },
    {
      title: 'AI 筛选（可选）',
      fields: [
        { path: 'ai.on', type: 'check', label: '启用 AI 打分', hint: '需要自备 OpenAI 兼容 API；用不到就关掉' },
        { path: 'ai.baseUrl', type: 'text', label: 'base_url', hint: '例：https://api.deepseek.com/v1' },
        { path: 'ai.apiKey', type: 'password', label: 'api_key', hint: '明文存在本机 chrome.storage.local' },
        { path: 'ai.model', type: 'text', label: '模型名' },
        { path: 'ai.minScore', type: 'number', label: '低于该分数跳过', min: 0, max: 10 },
        { path: 'ai.prompt', type: 'textarea', label: '系统提示词（留空用默认）' }
      ],
      actions: [{ id: 'grant-ai', label: '授权 AI 域名', hint: '首次启用需要点一次，给该域名发起请求的权限' }]
    },
    {
      title: '数据与隐私',
      fields: [],
      actions: [
        { id: 'clear-records', label: '清空投递记录', hint: '已处理岗位 / 公司 / 统计 / 日志 / 待复核 / 断点。配置保留' },
        { id: 'clear-all', label: '清空全部数据', hint: '连配置和 AI Key 一起清掉，回到初始状态' }
      ]
    },
    {
      title: '选择器（改版后校准）',
      fields: [
        { path: 'selectors.cardSelector', type: 'text', label: '职位卡片选择器', hint: '留空=自动识别。改版后可在页面右键卡片→检查→Copy selector 粘进来' },
        { path: 'selectors.applyText', type: 'text', label: '投递按钮文案（逗号分隔）' },
        { path: 'selectors.confirmText', type: 'text', label: '确认按钮文案' },
        { path: 'selectors.successText', type: 'text', label: '成功提示文案' }
      ],
      actions: [
        { id: 'scan-test', label: '检测本页岗位数', hint: '点一下，看能不能认出卡片；为 0 说明页面结构变了' },
        { id: 'diag', label: '诊断并复制报告', hint: '识别不到岗位时点这个，把复制的报告发给我就能定位' }
      ]
    }
  ];

  const TABS = [
    { id: 'run', label: '运行' },
    { id: 'filter', label: '筛选' },
    { id: 'ledger', label: '台账' },
    { id: 'stats', label: '统计' },
    { id: 'logs', label: '日志' },
    { id: 'cfg', label: '配置' }
  ];

  /* ---------- 样式 ---------- */
  const CSS = `
  :host {
    all: initial;
    --acc: #1668dc;
    --acc-weak: #eaf2ff;
    --acc-text: #0f52ad;
    --bg: #ffffff;
    --bg-sub: #f6f7f9;
    --bg-hover: #f1f3f6;
    --bd: #e6e8ec;
    --bd-strong: #d5d9df;
    --tx: #1a1c1f;
    --tx-2: #4a5057;
    --tx-3: #868d97;
    --warn-bg: #fff8e6;
    --warn-bd: #ffe1a6;
    --warn-tx: #8a5b00;
    --danger: #d92d20;
    --danger-bg: #fff1f0;
    --danger-bd: #ffccc7;
    --ok: #12805c;
    --radius: 10px;
    --shadow: 0 12px 40px rgba(16, 24, 40, .16), 0 2px 8px rgba(16, 24, 40, .06);
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --acc: #4c8dff;
      --acc-weak: #1b2a44;
      --acc-text: #9dc0ff;
      --bg: #1b1d20;
      --bg-sub: #23262a;
      --bg-hover: #2a2e33;
      --bd: #2e3238;
      --bd-strong: #3c424a;
      --tx: #e8eaed;
      --tx-2: #b3b9c2;
      --tx-3: #838a94;
      --warn-bg: #2e2617;
      --warn-bd: #4d3d1c;
      --warn-tx: #e3c07a;
      --danger: #ff6b5e;
      --danger-bg: #36201e;
      --danger-bd: #4d2a26;
      --ok: #4dd4a0;
      --shadow: 0 12px 40px rgba(0, 0, 0, .5), 0 2px 8px rgba(0, 0, 0, .3);
    }
  }
  * { box-sizing: border-box; margin: 0; }
  * {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  /* ---------- 悬浮球 ---------- */
  .ball {
    position: fixed; right: 22px; bottom: 22px; width: 46px; height: 46px; border-radius: 15px;
    background: linear-gradient(150deg, var(--acc), #0f52ad);
    color: #fff; font-size: 17px; font-weight: 600; letter-spacing: .5px;
    display: flex; align-items: center; justify-content: center; cursor: pointer;
    z-index: 2147483000; box-shadow: 0 6px 20px rgba(22, 104, 220, .38);
    user-select: none; transition: transform .18s cubic-bezier(.2,.8,.3,1), box-shadow .18s;
  }
  .ball:hover { transform: translateY(-2px) scale(1.03); box-shadow: 0 10px 26px rgba(22, 104, 220, .45); }
  .ball:active { transform: scale(.97); }
  .ball .dot {
    position: absolute; right: -2px; top: -2px; width: 11px; height: 11px; border-radius: 50%;
    background: #98a2b3; border: 2px solid #fff;
  }
  .ball .dot.on { background: #12b76a; box-shadow: 0 0 0 0 rgba(18,183,106,.6); animation: pulse 1.8s infinite; }
  .ball .dot.pause { background: #f79009; }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(18,183,106,.5); }
    70% { box-shadow: 0 0 0 7px rgba(18,183,106,0); }
    100% { box-shadow: 0 0 0 0 rgba(18,183,106,0); }
  }

  /* ---------- 面板 ---------- */
  .panel {
    position: fixed; right: 22px; bottom: 78px; width: 424px; max-height: 78vh;
    background: var(--bg); color: var(--tx); border: 1px solid var(--bd);
    border-radius: 14px; box-shadow: var(--shadow); z-index: 2147483001;
    display: none; flex-direction: column; overflow: hidden; font-size: 12.5px; line-height: 1.55;
    opacity: 0; transform: translateY(8px) scale(.985); transition: opacity .16s, transform .16s;
  }
  .panel.open { display: flex; opacity: 1; transform: none; }

  .head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 11px 14px 9px; border-bottom: 1px solid var(--bd);
  }
  .head b { font-size: 13px; font-weight: 600; letter-spacing: .2px; }
  .head .sub { font-size: 10.5px; color: var(--tx-3); margin-left: 7px; font-weight: 400; }
  .head .x {
    cursor: pointer; color: var(--tx-3); width: 22px; height: 22px; border-radius: 6px;
    display: flex; align-items: center; justify-content: center; font-size: 12px; transition: .15s;
  }
  .head .x:hover { background: var(--bg-hover); color: var(--tx); }

  /* ---------- 标签 ---------- */
  .tabs { display: flex; gap: 2px; padding: 8px 10px 0; }
  .tabs div {
    flex: 1; text-align: center; padding: 6px 0 7px; cursor: pointer; border-radius: 7px 7px 0 0;
    color: var(--tx-3); font-size: 11.5px; position: relative; transition: .15s; white-space: nowrap;
  }
  .tabs div:hover { color: var(--tx-2); background: var(--bg-sub); }
  .tabs div.active { color: var(--acc); font-weight: 600; background: var(--acc-weak); }
  .tabs div.active::after {
    content: ""; position: absolute; left: 12%; right: 12%; bottom: 0; height: 2px;
    background: var(--acc); border-radius: 2px 2px 0 0;
  }

  /* ---------- 内容区 ---------- */
  .body { padding: 12px 14px 16px; overflow-y: auto; flex: 1; overscroll-behavior: contain; }
  .body::-webkit-scrollbar { width: 8px; }
  .body::-webkit-scrollbar-thumb { background: var(--bd-strong); border-radius: 8px; border: 2px solid var(--bg); }
  .body::-webkit-scrollbar-track { background: transparent; }
  .sec { display: none; animation: fade .18s ease; }
  .sec.active { display: block; }
  @keyframes fade { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }

  h4 {
    margin: 16px 0 8px; font-size: 11px; font-weight: 600; color: var(--tx-3);
    letter-spacing: .6px; text-transform: uppercase;
  }
  h4:first-child { margin-top: 0; }

  /* ---------- 表单行 ---------- */
  .row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 6px 0; border-bottom: 1px dashed var(--bd);
  }
  .row:last-child { border-bottom: 0; }
  .row > label { color: var(--tx-2); flex: 1; min-width: 0; }
  .row input[type=text], .row input[type=password], .row input[type=number], .row select {
    width: 132px; height: 27px; padding: 0 8px; border: 1px solid var(--bd-strong); border-radius: 6px;
    font-size: 12px; color: var(--tx); background: var(--bg); transition: .15s; flex: none;
  }
  .row input:focus, .row select:focus, .row textarea:focus {
    outline: none; border-color: var(--acc); box-shadow: 0 0 0 3px var(--acc-weak);
  }
  .row input[type=checkbox] { width: 15px; height: 15px; accent-color: var(--acc); cursor: pointer; flex: none; }
  .row .hint { display: block; font-size: 10.5px; color: var(--tx-3); line-height: 1.5; margin-top: 2px; }
  .row:has(textarea) { flex-direction: column; align-items: stretch; gap: 4px; }
  .row textarea {
    width: 100%; min-height: 54px; padding: 7px 8px; border: 1px solid var(--bd-strong);
    border-radius: 6px; font-size: 12px; color: var(--tx); background: var(--bg); resize: vertical; line-height: 1.5;
  }

  .hint { color: var(--tx-3); font-size: 10.5px; line-height: 1.55; margin: 3px 0 8px; }

  /* ---------- 按钮 ---------- */
  .btns { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0; }
  .btns:last-child { margin-bottom: 0; }
  button {
    height: 28px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--acc);
    background: var(--acc); color: #fff; font-size: 12px; font-weight: 500; cursor: pointer;
    font-family: inherit; transition: .15s; white-space: nowrap;
  }
  button:hover { filter: brightness(1.06); }
  button:active { transform: translateY(.5px); }
  button.ghost { background: transparent; color: var(--acc); border-color: var(--bd-strong); }
  button.ghost:hover { background: var(--acc-weak); border-color: var(--acc); }
  button.warn { background: transparent; color: var(--danger); border-color: var(--danger-bd); }
  button.warn:hover { background: var(--danger-bg); border-color: var(--danger); }
  button.sm { height: 24px; padding: 0 8px; font-size: 11px; border-radius: 5px; }
  button:disabled { opacity: .4; cursor: not-allowed; filter: none; transform: none; }

  /* ---------- 统计卡 ---------- */
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 7px; margin: 10px 0; }
  .card { background: var(--bg-sub); border-radius: 9px; padding: 9px 4px; text-align: center; }
  .card b {
    display: block; font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums;
    letter-spacing: -.3px; line-height: 1.2;
  }
  .card span { color: var(--tx-3); font-size: 10px; }

  /* ---------- 状态条 ---------- */
  .status {
    background: var(--bg-sub); border-radius: 8px; padding: 8px 10px; color: var(--tx-2);
    font-size: 11.5px; line-height: 1.6; word-break: break-word; border-left: 2px solid var(--acc);
  }
  .status b { color: var(--tx); font-weight: 600; }

  /* ---------- 提示 ---------- */
  .tip {
    background: var(--warn-bg); border: 1px solid var(--warn-bd); color: var(--warn-tx);
    border-radius: 8px; padding: 8px 10px; font-size: 11px; line-height: 1.6; margin: 8px 0;
  }
  .tip.danger { background: var(--danger-bg); border-color: var(--danger-bd); color: var(--danger); }

  /* ---------- 表格 ---------- */
  table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 11.5px; }
  thead th {
    position: sticky; top: 0; z-index: 1; background: var(--bg);
    text-align: left; padding: 5px 6px; color: var(--tx-3); font-weight: 500; font-size: 10.5px;
    border-bottom: 1px solid var(--bd); white-space: nowrap;
  }
  tbody td { padding: 5px 6px; border-bottom: 1px dashed var(--bd); color: var(--tx-2); }
  tbody tr:hover td { background: var(--bg-hover); }
  tbody td:first-child { color: var(--tx-3); font-variant-numeric: tabular-nums; white-space: nowrap; }

  /* ---------- 日志 ---------- */
  .loglist { font-size: 11px; line-height: 1.65; }
  .logitem { display: grid; grid-template-columns: 54px 1fr; gap: 6px; padding: 4px 0; border-bottom: 1px dashed var(--bd); }
  .logitem .lv {
    font-size: 9.5px; text-transform: uppercase; letter-spacing: .4px; color: var(--tx-3);
    padding-top: 2px;
  }
  .logitem .lv.ok { color: var(--ok); }
  .logitem .lv.error { color: var(--danger); }
  .logitem .lv.warn { color: var(--warn-tx); }
  .logitem .lv.skip { color: var(--tx-3); }

  /* ---------- 候选清单 ---------- */
  #confirm-list .row { align-items: center; }
  #confirm-list .row > label { font-size: 11.5px; }
  #confirm-list .row .hint { margin: 1px 0 0; }
  `;

  /* ---------- 挂载 ---------- */
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;z-index:2147483000;';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  const wrap = document.createElement('div');
  wrap.innerHTML = buildHtml();
  root.append(style, wrap);
  document.documentElement.appendChild(host);

  function buildHtml() {
    const tabs = TABS.map((t, i) => `<div data-tab="${t.id}" class="${i === 0 ? 'active' : ''}">${t.label}</div>`).join('');
    return `
      <div class="ball" data-act="toggle">智<span class="dot"></span></div>
      <div class="panel" id="panel">
        <div class="head"><b>智联投递助手</b><span class="sub" id="head-sub"></span><span class="x" data-act="toggle">✕</span></div>
        <div class="tabs">${tabs}</div>
        <div class="body">
          <div class="sec active" data-sec="run">
            <div class="status" id="pageinfo" style="margin-bottom:8px">正在识别页面…</div>
            <div class="tip" id="dry-tip"></div>
            <div class="btns">
              <button data-act="start" style="flex:1">开始投递</button>
              <button class="warn" data-act="stop" disabled style="flex:1">停止</button>
            </div>
            <div class="btns" style="margin-top:2px">
              <button class="ghost sm" data-act="scan">仅扫描</button>
              <button class="ghost sm" data-act="one">试投一个</button>
              <button class="ghost sm" data-act="apply-current">投递当前岗位</button>
              <button class="ghost sm" data-act="pick">框选卡片</button>
              <button class="ghost sm" data-act="verify" id="btn-verify">复核结果</button>
              <button class="ghost sm" data-act="parallel">开并行搜索页</button>
              <button class="warn sm" data-act="stop-all">全部停止</button>
            </div>
            <div class="cards">
              <div class="card"><b id="c-scan">0</b><span>扫描</span></div>
              <div class="card"><b id="c-pass">0</b><span>通过</span></div>
              <div class="card"><b id="c-ok">0</b><span>投递</span></div>
              <div class="card"><b id="c-skip">0</b><span>跳过</span></div>
            </div>
            <div class="status" id="status">待机</div>
            <div id="confirm-box" style="display:none;margin-top:10px">
              <div class="btns" style="margin:0 0 6px">
                <button data-act="confirm-all" class="ghost">全部投</button>
                <button data-act="confirm-clear" class="ghost">清空</button>
                <span class="hint" style="margin:0" id="confirm-tip"></span>
              </div>
              <div id="confirm-list"></div>
            </div>
          </div>
          <div class="sec" data-sec="filter">${renderGroups(['筛选'])}</div>
          <div class="sec" data-sec="ledger">
            <div class="cards" id="ledger-cards"></div>
            <div id="followup-box"></div>
            <div class="btns">
              <button class="ghost" data-act="export-records">导出台账 CSV</button>
              <button class="ghost" data-act="pick-resume">选择简历文件</button>
              <button class="warn" data-act="clear-records">清空台账</button>
            </div>
            <div class="hint" id="resume-hint"></div>
            <input type="file" id="resume-file" accept=".pdf,.doc,.docx" style="display:none">
            <div id="ledger-table"></div>
          </div>
          <div class="sec" data-sec="stats"><div id="stats-box"></div></div>
          <div class="sec" data-sec="logs">
            <div class="btns"><button class="ghost" data-act="export">导出 CSV</button><button class="warn" data-act="clearlog">清空</button></div>
            <div class="loglist" id="loglist"></div>
          </div>
          <div class="sec" data-sec="cfg">${renderGroups(['运行', '行为拟真', 'AI 筛选（可选）', '选择器（改版后校准）', '数据与隐私'])}
            <div class="tip" style="margin-top:10px">配置改动即时保存。所有数据只存在本机浏览器里，没有任何上传。</div>
          </div>
        </div>
      </div>`;
  }

  function renderGroups(titles) {
    return GROUPS.filter((g) => titles.indexOf(g.title) >= 0)
      .map((g) => {
        const rows = g.fields.map(renderField).join('');
        const acts = (g.actions || [])
          .map((a) => `<div class="row"><label>${a.label}<div class="hint" style="margin:0">${a.hint || ''}</div></label><button class="ghost" data-act="${a.id}">执行</button></div>`)
          .join('');
        return `<h4>${g.title}</h4>${rows}${acts}`;
      })
      .join('');
  }

  function renderField(f) {
    const id = 'f_' + f.path.replace(/\./g, '_');
    let input;
    if (f.type === 'check') input = `<input type="checkbox" id="${id}" data-path="${f.path}">`;
    else if (f.type === 'select') {
      const opts = (f.options || []).map((o) => `<option value="${o.v}">${o.t}</option>`).join('');
      input = `<select id="${id}" data-path="${f.path}">${opts}</select>`;
    } else if (f.type === 'number') input = `<input type="number" id="${id}" data-path="${f.path}" min="${f.min ?? ''}" max="${f.max ?? ''}">`;
    else if (f.type === 'password') input = `<input type="password" id="${id}" data-path="${f.path}" autocomplete="off">`;
    else if (f.type === 'textarea') input = `<textarea id="${id}" data-path="${f.path}"></textarea>`;
    else input = `<input type="text" id="${id}" data-path="${f.path}" autocomplete="off">`;
    const hint = f.hint ? `<div class="hint" style="margin:0">${f.hint}</div>` : '';
    return `<div class="row"><label for="${id}">${f.label}${hint}</label>${input}</div>`;
  }

  /* ---------- 配置读写 ---------- */
  let cfgCache = null;

  function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  function setPath(obj, path, val) {
    const parts = path.split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof o[parts[i]] !== 'object' || o[parts[i]] === null) o[parts[i]] = {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = val;
  }

  async function fillForm() {
    cfgCache = await Z.getConfig();
    wrap.querySelectorAll('[data-path]').forEach((el) => {
      const v = getPath(cfgCache, el.dataset.path);
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v == null ? '' : v;
    });
    updateDryTip();
  }

  async function onFieldChange(e) {
    const el = e.target;
    const path = el.dataset.path;
    if (!path) return;
    let val;
    if (el.type === 'checkbox') val = el.checked;
    else if (el.type === 'number') val = el.value === '' ? 0 : Number(el.value);
    else val = el.value;
    setPath(cfgCache, path, val);
    cfgCache = await Z.setConfig(cfgCache);
    if (path === 'dryRun') updateDryTip();
  }

  /* ---------- UI 事件 ---------- */
  wrap.addEventListener('click', async (e) => {
    const tabEl = e.target.closest('[data-tab]');
    if (tabEl) {
      wrap.querySelectorAll('[data-tab]').forEach((d) => d.classList.toggle('active', d === tabEl));
      wrap.querySelectorAll('[data-sec]').forEach((s) => s.classList.toggle('active', s.dataset.sec === tabEl.dataset.tab));
      if (tabEl.dataset.tab === 'stats') renderStats();
      if (tabEl.dataset.tab === 'ledger') renderLedger();
      if (tabEl.dataset.tab === 'logs') renderLogs();
      return;
    }

    const rr = e.target.closest('[data-rec-reply]');
    if (rr) {
      const recs = await Z.getRecords();
      const rec = recs.find((r) => r.id === rr.dataset.recReply);
      if (rec) { await Z.updateRecord(rec.id, { replied: rec.replied ? 0 : 1 }); renderLedger(); }
      return;
    }
    const rf = e.target.closest('[data-rec-follow]');
    if (rf) {
      const recs = await Z.getRecords();
      const rec = recs.find((r) => r.id === rf.dataset.recFollow);
      if (rec) { await Z.updateRecord(rec.id, { followed: rec.followed ? 0 : 1 }); renderLedger(); }
      return;
    }
    const rd = e.target.closest('[data-rec-del]');
    if (rd) { await Z.removeRecord(rd.dataset.recDel); renderLedger(); return; }

    const ap = e.target.closest('[data-confirm-apply]');
    if (ap) {
      const job = (state.pendingJobs || [])[Number(ap.dataset.confirmApply)];
      if (job) applyOneFromList(job);
      return;
    }
    const dr = e.target.closest('[data-confirm-drop]');
    if (dr) {
      const idx = Number(dr.dataset.confirmDrop);
      state.pendingJobs.splice(idx, 1);
      renderConfirmList();
      return;
    }

    const actEl = e.target.closest('[data-act]');
    if (!actEl) return;
    const act = actEl.dataset.act;

    if (act === 'toggle') {
      const p = root.getElementById('panel');
      p.classList.toggle('open');
      if (p.classList.contains('open')) fillForm();
    } else if (act === 'start') {
      startRun();
    } else if (act === 'stop') {
      state.stopping = true;
      setStatus('正在停止…');
    } else if (act === 'scan') {
      scanOnly();
    } else if (act === 'one') {
      runOne();
    } else if (act === 'clearlog') {
      await Z.clearLogs();
      renderLogs();
    } else if (act === 'export') {
      exportCsv();
    } else if (act === 'export-records') {
      exportRecords();
    } else if (act === 'pick-resume') {
      const input = root.getElementById('resume-file');
      if (input) input.click();
    } else if (act === 'clear-records') {
      if (!confirm('清空投递台账？\n\n记录、回复标记、跟进标记都会没了（导出过 CSV 的话另存着）。')) return;
      await Z.clearRecords();
      renderLedger();
    } else if (act === 'parallel') {
      openParallel();
    } else if (act === 'stop-all') {
      await Z.setStopAll();
      state.stopping = true;
      setStatus('已发出「全部停止」指令');
      alert('已通知所有并行搜索页停止。\n（正在等待限速槽的页面会在下一次醒来时退出）');
    } else if (act === 'confirm-all') {
      const jobs = (state.pendingJobs || []).slice();
      for (const j of jobs) {
        if (state.stopping) break;
        await applyOneFromList(j);
        const left = state.pendingJobs.indexOf(j);
        if (left >= 0) state.pendingJobs.splice(left, 1);
        renderConfirmList();
        await Z.sleep(Z.randInt(20, 45) * 1000);
      }
    } else if (act === 'confirm-clear') {
      state.pendingJobs = [];
      renderConfirmList();
    } else if (act === 'verify') {
      verifyPending();
    } else if (act === 'apply-current') {
      applyCurrent();
    } else if (act === 'pick') {
      startPick();
    } else if (act === 'clear-records') {
      clearRecords();
    } else if (act === 'clear-all') {
      clearAll();
    } else if (act === 'diag') {
      runDiagnostic();
    } else if (act === 'scan-test') {
      const jobs = Z.scanCards();
      setStatus('本页识别到 ' + jobs.length + ' 个岗位。示例：' + (jobs[0] ? jobs[0].title + ' / ' + (jobs[0].salaryRaw || '薪资未识别') : '无'));
      alert('识别到 ' + jobs.length + ' 个岗位' + (jobs[0] ? '\n示例：' + jobs[0].title + '（' + (jobs[0].salaryRaw || '薪资未识别') + '）' : '\n如果为 0，说明页面结构变了，需要在智联新版页面上重新校准。'));
    } else if (act === 'grant-ai') {
      grantAi();
    }
  });

  wrap.addEventListener('change', onFieldChange);

  wrap.addEventListener('change', async (e) => {
    const input = e.target.closest('#resume-file');
    if (!input || !input.files || !input.files[0]) return;
    const file = input.files[0];
    if (file.size > 3 * 1024 * 1024) {
      alert('文件太大（' + (file.size / 1024 / 1024).toFixed(1) + ' MB）。建议用 3 MB 以内的 PDF。');
      input.value = '';
      return;
    }
    try {
      const meta = await Z.setResume(file);
      Z.log('ok', '已保存附件简历：' + meta.name);
      renderLedger();
    } catch (err) {
      alert('保存失败：' + String((err && err.message) || err));
    }
    input.value = '';
  });

  /** 顶部状态条：演练 / 真实投递要一眼能分清 */
  function updateDryTip() {
    const tip = root.getElementById('dry-tip');
    if (!tip) return;
    if (cfgCache && cfgCache.dryRun) {
      tip.className = 'tip';
      tip.innerHTML = '当前为<b>演练模式</b>：只做筛选与记录，不会真的投递。';
    } else {
      tip.className = 'tip danger';
      tip.innerHTML = '当前为<b>真实投递模式</b>：点「开始」会真的投递简历。想先看筛选结果，请在下方勾选「演练模式」。';
    }
  }

  function setStatus(text) {
    state.status = text;
    const el = root.getElementById('status');
    if (el) el.textContent = text;
  }
  function setCounts() {
    const m = { 'c-scan': state.counts.scan, 'c-pass': state.counts.pass, 'c-ok': state.counts.ok, 'c-skip': state.counts.skip };
    for (const k in m) {
      const el = root.getElementById(k);
      if (el) el.textContent = m[k];
    }
  }
  function setRunning(on) {
    state.running = on;
    const start = wrap.querySelector('[data-act="start"]');
    const stop = wrap.querySelector('[data-act="stop"]');
    if (start) start.disabled = on;
    if (stop) stop.disabled = !on;
    const dot = wrap.querySelector('.dot');
    if (dot) dot.className = 'dot' + (on ? ' on' : '');
  }

  /* ---------- 引擎 ---------- */
  async function scanOnly(quiet) {
    const cfg = await Z.getConfig();
    const jobs = Z.scanCards(document, cfg.selectors.cardSelector);
    state.counts = { scan: jobs.length, pass: 0, skip: 0, ok: 0, fail: 0 };
    state.firstSkip = '';

    if (!jobs.length) {
      if (quiet) {
        setStatus('本页未识别到岗位（' + PAGE.label + '）');
        return;
      }
      setStatus('识别到 0 个岗位。若页面确实是职位列表，点「配置 → 诊断并复制报告」把报告发我');
      alert('识别到 0 个岗位。\n\n可能原因：\n1. 当前不是职位列表页（推荐页/详情页结构不同）\n2. 页面改版了\n\n可以点「配置 → 诊断并复制报告」，把报告发我，我按你的真实页面改。');
      return;
    }

    const seen = await Z.getSeen();
    const comp = await Z.getCompanyMap();
    let pass = 0;
    const passed = [];
    for (const j of jobs) {
      const v = Z.matchJob(j, cfg, seen, comp);
      if (v.pass) {
        pass++;
        passed.push(j);
        if (quiet) continue;
      }
      if (!quiet) {
        Z.log(v.pass ? 'ok' : 'skip', (v.pass ? '通过' : '跳过：' + v.reason) + ' — ' + j.title + (j.salaryRaw ? '（' + j.salaryRaw + '）' : ''), j);
      }
    }
    state.counts.pass = pass;
    state.counts.skip = jobs.length - pass;
    setCounts();
    const msg = '扫描完成：' + jobs.length + ' 个岗位，' + pass + ' 个通过筛选';
    setStatus(msg);
    if (quiet) {
      if (pass) Z.log('info', msg + (passed[0] ? '｜首个：' + passed[0].title : ''));
    } else {
      refreshPageType();
      renderLogs();
    }
  }

  /** 只真实投递一个岗位，用来校准流程 */
  async function runOne() {
    if (state.running) return;
    const cfg = await Z.getConfig();
    const jobs = Z.scanCards(document, cfg.selectors.cardSelector);
    if (!jobs.length) return alert('当前页没识别到岗位，先点「仅扫描」或「诊断并复制报告」排查');

    const seen = await Z.getSeen();
    const comp = await Z.getCompanyMap();
    const job = jobs.find((j) => Z.matchJob(j, cfg, seen, comp).pass);
    if (!job) return alert('当前页没有通过筛选的岗位');

    const msg =
      '将对以下岗位真实投递一次（忽略演练模式）：\n\n' +
      job.title +
      '\n' +
      job.company +
      '\n' +
      (job.salaryRaw || '薪资未识别') +
      '\n\n投递方式：' +
      (cfg.applyMode === 'list' ? '列表页直投' : '打开详情页') +
      '\n\n确认？';
    if (!confirm(msg)) return;

    state.running = true;
    setRunning(true);
    setStatus('试投：' + job.title);
    let result;
    try {
      result = await dispatchApply(job, cfg);
    } catch (e) {
      result = { status: 'error', message: String((e && e.message) || e) };
    }
    state.running = false;
    setRunning(false);

    if (result.status === 'ok') {
      await Z.markSeen(job.id, 'ok');
      await Z.markCompany(job.companyKey);
      await Z.bumpStat('applied', 1);
      await Z.bumpStat('ok', 1);
      Z.log('ok', '试投成功 — ' + job.title + ' @ ' + job.company, job);
      alert('✅ 投递成功');
    } else {
      Z.log(result.status === 'already' ? 'skip' : 'warn', '试投结果：' + result.status + ' ' + (result.message || ''), job);
      alert('结果：' + result.status + '\n' + (result.message || '无附加信息') + '\n\n如果一直停在 need_manual，把「投递方式」切到「打开详情页」再试。');
    }
    setStatus('试投结束：' + result.status + (result.message ? '｜' + result.message : ''));
    renderLogs();
  }

  /* ---------- 关键词轮换 ---------- */
  function splitKeywords(cfg) {
    return String((cfg && cfg.searchKeywords) || '')
      .split(/[,，\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  function currentKeywordIndex(kws) {
    if (!kws.length) return 0;
    let kw = '';
    try {
      kw = new URL(location.href).searchParams.get('kw') || '';
    } catch (e) {
      kw = '';
    }
    if (!kw) return 0;
    const i = kws.findIndex((k) => kw.toLowerCase().indexOf(k.toLowerCase()) >= 0);
    return i >= 0 ? i : 0;
  }

  async function rotateKeyword(cfg) {
    if (!cfg.autoRotate) return false;
    const kws = splitKeywords(cfg);
    if (kws.length < 2) return false;
    const next = (state.keywordIndex || 0) + 1;
    if (next >= kws.length) return false;

    let jl = String(cfg.searchCityCode || '').trim();
    if (!jl) {
      try {
        jl = new URL(location.href).searchParams.get('jl') || '';
      } catch (e) {
        jl = '';
      }
    }
    const url = 'https://sou.zhaopin.com/?kw=' + encodeURIComponent(kws[next]) + (jl ? '&jl=' + jl : '');

    state.rotating = true;
    await Z.saveSession({ running: true, keywordIndex: next, counts: state.counts, at: Date.now() });
    Z.log('info', '切换关键词：' + kws[next] + '（第 ' + (next + 1) + '/' + kws.length + ' 个）');
    setStatus('关键词跑完了，切到「' + kws[next] + '」…（页面会刷新，然后自动继续）');
    setTimeout(() => {
      location.href = url;
    }, 1500);
    return true;
  }

  /* ---------- 复核：开后台标签页看这个岗位是不是真投过 ---------- */
  function checkViaTab(item) {
    return new Promise(async (resolve) => {
      let res;
      try {
        res = await chrome.runtime.sendMessage({
          type: 'OPEN_TAB',
          url: item.url,
          task: { mode: 'check', closeDelay: 2, job: { id: item.id, title: item.title, company: item.company }, selectors: {} }
        });
      } catch (e) {
        resolve({ status: 'error', message: '打不开标签页' });
        return;
      }
      if (!res || !res.ok) {
        resolve({ status: 'error', message: (res && res.error) || '打开失败' });
        return;
      }
      const tabId = res.tabId;
      const timer = setTimeout(() => {
        state.pending.delete(tabId);
        resolve({ status: 'error', message: '复核超时' });
      }, 45000);
      state.pending.set(tabId, (r) => {
        clearTimeout(timer);
        state.pending.delete(tabId);
        resolve(r);
      });
    });
  }

  async function verifyPending() {
    const cfg = await Z.getConfig();
    if (!cfg.allowTabMode) {
      return alert('复核需要批量打开后台标签页，属于高风险操作，已禁用。\n\n如果确实要复核，到「配置」里打开「允许后台标签页模式」。');
    }
    const list = await Z.getPending();
    if (!list.length) {
      return alert('还没有待复核记录。\n只有「投递成功」的岗位才会进这个队列，且需要卡片带链接。');
    }
    const targets = list.slice(-15);
    if (!confirm('逐个打开 ' + targets.length + ' 个岗位详情页，核对是否真的投递成功。\n期间会开若干后台标签页，跑完自动关闭。\n\n确认？')) return;

    state.running = true;
    setRunning(true);
    let okN = 0;
    let badN = 0;
    for (const item of targets) {
      if (state.stopping) break;
      setStatus('复核中（' + (okN + badN + 1) + '/' + targets.length + '）：' + item.title);
      const r = await checkViaTab(item);
      if (r.status === 'verified') {
        okN++;
        Z.log('ok', '复核通过 — ' + item.title, item);
      } else {
        badN++;
        Z.log('warn', '复核存疑（' + (r.message || r.status) + '）— ' + item.title, item);
      }
      await Z.sleep(1500);
    }
    state.running = false;
    state.stopping = false;
    setRunning(false);
    await Z.clearPending();
    setStatus('复核完成：通过 ' + okN + '，存疑 ' + badN);
    alert('复核完成\n\n通过：' + okN + '\n存疑：' + badN + (badN ? '\n\n存疑的岗位可能在页面刷新前就投完了，或确实没投上。' : ''));
    renderLogs();
  }

  async function startRun(opts) {
    const resume = !!(opts && opts.resume);
    const auto = !!(opts && opts.auto);
    if (state.running) return;
    if (IS_DETAIL) {
      alert('这是职位详情页，批量投递没有列表可扫。\n请用「投递当前岗位」按钮逐个投，或打开搜索结果页再批量跑。');
      return;
    }
    const cfg = await Z.getConfig();
    if (!resume && !cfg.dryRun) {
      if (document.querySelector('[class*="joblist-box__item-unlogin"]')) {
        alert('当前是未登录状态的职位列表，卡片上没有可用的投递按钮。请先登录智联再运行。');
        return;
      }
      if (Z.siteLimitHit()) {
        alert('页面已经提示「今日投递已达上限」（智联单账号约 100 个/天）。\n今天投不出去了，明天再来。');
        return;
      }
      const modeName =
        cfg.applyMode === 'detail' ? '打开详情页' : cfg.applyMode === 'list' ? '列表页直投' : cfg.applyMode === 'split' ? '点卡片+右侧投递' : '自动';
      const ok = auto ? true : confirm(
        '当前不是演练模式，会对通过筛选的岗位真实投递简历。\n\n' +
          '投递方式：' + modeName + '\n' +
          '每日上限：' + cfg.dailyLimit + ' 个\n' +
          '间隔：' + cfg.intervalMin + '–' + cfg.intervalMax + ' 秒（随机）\n' +
          '长停：每 ' + (cfg.batchSize || 0) + ' 个停 ' + cfg.longPauseMin + '–' + cfg.longPauseMax + ' 秒\n' +
          '投前停留：' + cfg.preStayMinSec + '–' + cfg.preStayMaxSec + ' 秒\n\n' +
          '提醒：固定间隔 + 顶满额度是最容易被判成脚本的组合，默认值已按保守设。\n\n确认开始？'
      );
      if (!ok) return;
    }

    state.running = true;
    state.stopping = false;
    state.rotating = false;
    if (!resume) {
      state.counts = { scan: 0, pass: 0, skip: 0, ok: 0, fail: 0 };
      state.firstSkip = '';
      state.page = 1;
      const kws = splitKeywords(cfg);
      state.keywordIndex = currentKeywordIndex(kws);
    }
    if (!Z.inWorkHours(cfg)) {
      const msg = '当前不在允许投递的时段（' + cfg.workStart + ':00–' + cfg.workEnd + ':00），已中止。';
      setStatus(msg);
      return alert(msg + '\n\n要现在跑的话，把「行为拟真 → 允许投递时段」调宽。');
    }

    state.done = new Set();
    state.sinceLongPause = 0;
    state.runStartedAt = Date.now();
    state.pendingJobs = [];
    renderConfirmList();
    setRunning(true);
    setCounts();
    await Z.saveSession({ running: true, keywordIndex: state.keywordIndex, counts: state.counts, at: Date.now() });

    let failStreak = 0;
    const pages = cfg.autoNextPage ? Math.max(1, Number(cfg.maxPages)) : 1;

    try {
      for (let p = 1; p <= pages; p++) {
        if (state.stopping) break;
        const all = Z.scanCards(document, cfg.selectors.cardSelector);
        let jobs = all.filter((j) => !(state.done && state.done.has(j.id)));
        if (cfg.randomOrder) jobs = Z.shuffle(jobs);
        state.counts.scan += jobs.length;
        if (!all.length) {
          setStatus('第 ' + p + ' 轮识别到 0 个岗位，已中止（点「诊断并复制报告」排查）');
          Z.log('error', '第 ' + p + ' 轮识别到 0 个岗位，页面结构可能不匹配');
          break;
        }
        if (!jobs.length) {
          Z.log('info', '第 ' + p + ' 轮没有新岗位，继续往下翻');
        }
        setCounts();
        setStatus('第 ' + p + ' 页：识别到 ' + jobs.length + ' 个岗位');
        Z.log('info', '第 ' + p + ' 页扫描到 ' + jobs.length + ' 个岗位');

        const seen = await Z.getSeen();
        const comp = await Z.getCompanyMap();
        const hrMap = await Z.getHrMap();

        for (const job of jobs) {
          if (state.stopping) break;
          if (await Z.checkStopAll(state.runStartedAt)) {
            Z.log('warn', '收到「全部停止」指令，退出');
            state.stopping = true;
            break;
          }

          const applied = await Z.todayApplied();
          if (applied >= Number(cfg.dailyLimit)) {
            Z.log('warn', '已达今日上限 ' + cfg.dailyLimit + '，停止');
            setStatus('已达今日上限（' + applied + '/' + cfg.dailyLimit + '），已停止');
            state.stopping = true;
            break;
          }

          const verdict = Z.matchJob(job, cfg, seen, comp, hrMap);
          if (!verdict.pass) {
            state.done.add(job.id);
            state.counts.skip++;
            if (!state.firstSkip) state.firstSkip = verdict.reason;
            setCounts();
            Z.log('skip', '跳过：' + verdict.reason + ' — ' + job.title, job);
            continue;
          }

          if (cfg.ai.on) {
            setStatus('AI 打分中：' + job.title);
            const ai = await Z.aiScore(job, cfg);
            if (ai && ai.score != null && ai.score < Number(cfg.ai.minScore)) {
              state.counts.skip++;
              setCounts();
              Z.log('skip', 'AI 打分 ' + ai.score + '，跳过：' + (ai.reason || '') + ' — ' + job.title, job);
              continue;
            }
            if (ai && ai.score != null) Z.log('info', 'AI 打分 ' + ai.score + '：' + (ai.reason || ''), job);
          }

          // 随机放弃一部分：真人不会 100% 匹配就投
          const ratio = Math.max(0, Math.min(50, Number(cfg.skipRatio) || 0)) / 100;
          if (ratio > 0 && Math.random() < ratio) {
            state.done.add(job.id);
            state.counts.skip++;
            setCounts();
            Z.log('skip', '随机放弃（' + Math.round(ratio * 100) + '%）— ' + job.title, job);
            continue;
          }

          state.counts.pass++;
          setCounts();

          // 半自动：只收集候选，等你点
          if (cfg.confirmMode && !cfg.dryRun) {
            state.done.add(job.id);
            if (state.pendingJobs.length < 40) state.pendingJobs.push(job);
            renderConfirmList();
            Z.log('info', '进入候选清单 — ' + job.title + ' @ ' + job.company, job);
            continue;
          }

          if (cfg.dryRun) {
            state.counts.ok++;
            setCounts();
            Z.log('ok', '[演练] 会投递 — ' + job.title + ' @ ' + job.company, job);
            await Z.bumpStat('scanned', 1);
            await Z.bumpStat('passed', 1);
            continue;
          }

          setStatus('投递中：' + job.title);
          state.current = job;
          state.done.add(job.id);

          // 跨页认领：同一个岗位只允许一个页投
          const claimed = await Z.claimJob(job.id);
          if (!claimed) {
            state.counts.skip++;
            setCounts();
            Z.log('skip', '其他并行页正在投这个岗位，跳过 — ' + job.title, job);
            continue;
          }

          const result = await dispatchApply(job, cfg);
          state.current = null;
          closeSuccessModal(); // 兜底：不管结果如何，先把「已向对方发送简历」弹窗收掉，否则会挡住下一个
          if (!cfg.dryRun) await postStay(cfg);

          if (result.status === 'ok') {
            state.counts.ok++;
            failStreak = 0;
            await Z.markSeen(job.id, 'ok');
            await Z.markCompany(job.companyKey);
            const hrNow = job.hrSign || Z.extractHrFromPage();
            if (hrNow) await Z.markHr(hrNow);
            await Z.addRecord({
              id: job.id, title: job.title, company: job.company, salary: job.salaryRaw || '',
              size: job.sizeRaw || '', kw: currentKeyword(), hr: hrNow || '', at: Date.now(), status: 'ok'
            });
            await Z.bumpStat('applied', 1);
            await Z.bumpStat('ok', 1);
            if (job.url) {
              await Z.addPending({ id: job.id, title: job.title, company: job.company, url: job.url, at: Date.now() });
            }
            Z.log('ok', '投递成功 — ' + job.title + ' @ ' + job.company, job);
          } else if (result.status === 'already') {
            state.counts.skip++;
            setCounts();
            await Z.markSeen(job.id, 'skip');
            Z.log('skip', '已投递过，跳过 — ' + job.title, job);
          } else if (result.status === 'limit') {
            Z.log('error', '智联提示已达今日投递上限，停止：' + (result.message || ''));
            setStatus('智联提示今天投满了（约 100 个），明天再来');
            notify('已达智联今日上限', '已停止，明天再继续');
            state.stopping = true;
            break;
          } else if (result.status === 'job_gone') {
            state.counts.skip++;
            setCounts();
            await Z.markSeen(job.id, 'gone');
            Z.log('skip', '岗位已下架，跳过 — ' + job.title, job);
          } else if (result.status === 'need_resume') {
            Z.log('error', '简历不完整，已停止：' + (result.message || ''));
            setStatus('简历不完整，请先去「我的简历」补齐再跑');
            notify('需要先完善简历', '任务已停止');
            state.stopping = true;
            break;
          } else if (result.status === 'blocked') {
            Z.log('error', '触发验证码/风控，已停止：' + (result.message || ''), job);
            setStatus('触发验证码或风控，已停止。请手动处理后再继续');
            notify('触发风控', '智联页面出现验证码或异常提示，任务已停止');
            state.stopping = true;
            break;
          } else if (result.status === 'need_manual' && !cfg.continueOnUnknown) {
            Z.log('warn', '需要人工处理：' + (result.message || ''), job);
            setStatus('需要人工处理：' + (result.message || '') + '，已停止（想继续可在配置里打开「结果不确定时继续」）');
            state.stopping = true;
            break;
          } else if (result.status === 'need_manual') {
            state.counts.fail++;
            await Z.markSeen(job.id, 'unknown');
            await Z.bumpStat('applied', 1);
            await Z.bumpStat('fail', 1);
            Z.log('warn', '结果不确定，按配置继续 — ' + (result.message || '') + '｜' + job.title, job);
          } else {
            state.counts.fail++;
            failStreak++;
            await Z.markSeen(job.id, 'fail');
            await Z.bumpStat('applied', 1);
            await Z.bumpStat('fail', 1);
            await Z.addRecord({
              id: job.id, title: job.title, company: job.company, salary: job.salaryRaw || '',
              kw: currentKeyword(), at: Date.now(), status: 'fail', msg: result.message || result.status
            });
            Z.log('error', '投递失败（' + result.status + '）：' + (result.message || ''), job);
            const limit = Number(cfg.failStreakLimit) || 0;
            if (limit > 0 && failStreak >= limit) {
              setStatus('连续 ' + limit + ' 次失败，已停止。请检查选择器配置');
              Z.log('error', '连续 ' + limit + ' 次失败，停止任务');
              state.stopping = true;
              break;
            }
          }

          setCounts();

          // 节奏：普通随机间隔；每投 N 个插一次长停
          state.sinceLongPause = (state.sinceLongPause || 0) + 1;
          const batch = Math.max(0, Number(cfg.batchSize) || 0);
          if (batch > 0 && state.sinceLongPause >= batch) {
            state.sinceLongPause = 0;
            const mins = Math.max(30, Number(cfg.longPauseMin) || 120);
            const maxs = Math.max(mins, Number(cfg.longPauseMax) || 300);
            let left = Z.randInt(mins, maxs);
            const cool = await Z.claimCooldown(left * 1000); // 其他并行页也一起安静
            left += Math.ceil(cool / 1000);
            while (left > 0 && !state.stopping) {
              setStatus('长停中，剩余约 ' + Math.ceil(left / 60) + ' 分钟（模拟正常节奏）');
              const step = Math.min(left, 5);
              await Z.sleep(step * 1000);
              left -= step;
            }
          } else {
            // 全局限速：所有并行页抢同一个「投递时刻槽」，总速率 = 单页速率
            let extraSec = 0;
            if (cfg.failBackoff && failStreak > 0) {
              extraSec = Math.min(600, 30 * Math.pow(2, Math.min(failStreak, 3))); // 连续失败指数退避
            }
            const slotWait = await Z.claimSlot(cfg);
            const wait = Math.ceil((slotWait + extraSec * 1000) / 1000);
            setStatus(wait > 0 ? '全局排队 ' + wait + ' 秒后继续…' : '继续下一个');
            if (wait > 0) await Z.sleep(wait * 1000);
          }
        }

        if (state.stopping || p >= pages) break;
        setStatus('翻页中…');
        const ok = await goNextPage();
        if (!ok) {
          const rotated = await rotateKeyword(cfg);
          if (rotated) return;
          setStatus('没有更多岗位了，任务结束');
          break;
        }
        await Z.sleep(Z.randInt(3000, 7000));
      }
    } catch (err) {
      Z.log('error', '任务异常：' + String((err && err.message) || err));
      setStatus('任务异常：' + String((err && err.message) || err));
    } finally {
      state.running = false;
      state.stopping = false;
      setRunning(false);
      setCounts();
      let summary = '本次：扫描 ' + state.counts.scan + '，通过 ' + state.counts.pass + '，投递 ' + state.counts.ok + '，失败 ' + state.counts.fail + '，跳过 ' + state.counts.skip;
      if (!state.counts.pass && state.counts.skip && state.firstSkip) {
        summary += '｜全部被筛掉，首个原因：' + state.firstSkip;
      }
      if (state.counts.pass && !state.counts.ok && !state.counts.fail) {
        summary += '｜注意：通过 ' + state.counts.pass + ' 个但一个都没投出去，看「日志」里的具体原因';
      }
      setStatus(summary);
      Z.log('info', summary);
      if (cfg.notifyOnFinish && state.counts.ok > 0) notify('投递助手完成', summary);
      if (!state.rotating) await Z.clearSession();
      renderLogs();
    }
  }

  /* ---------- 投递：列表页内联点「立即投递」 ---------- */
  function splitTexts(s) {
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
    return st.visibility !== 'hidden' && st.display !== 'none';
  }
  function isDisabledEl(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    return /disabled|is-disabled/i.test(el.className || '');
  }
  /** 在 scope 里按文案找可点元素；preferDialog 时优先弹窗内的 */
  function findBtnIn(scope, texts, preferDialog) {
    if (!texts.length || !scope || !scope.querySelectorAll) return null;
    const nodes = scope.querySelectorAll('button,a,[role="button"],span,div');
    const hits = [];
    for (const el of nodes) {
      const t = (el.innerText || '').trim();
      if (!t || t.length > 14) continue;
      if (!texts.some((x) => t.indexOf(x) >= 0)) continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 16) continue;
      let score = 0;
      if (texts.some((x) => t === x)) score += 2;
      if (preferDialog && el.closest('[class*="dialog"],[class*="modal"],[class*="popup"],[class*="layer"],[role="dialog"]')) score += 3;
      hits.push({ el, score, len: t.length });
    }
    if (!hits.length) return null;
    hits.sort((a, b) => b.score - a.score || a.len - b.len);
    const el = hits[0].el;
    const inner = el.querySelector('button,a,[role="button"]');
    return inner && visible(inner) ? inner : el;
  }
  async function waitUntil(fn, timeout) {
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
    return null;
  }

  /** 投前停留 + 轻微滚动，别让「点开即投」成为固定节拍 */
  async function humanPause(cfg) {
    const a = Math.max(0, Number(cfg.preStayMinSec) || 0);
    const b = Math.max(a, Number(cfg.preStayMaxSec) || a);
    const sec = Z.randInt(a, b);
    if (!sec) return;
    try {
      window.scrollBy({ top: Z.randInt(60, 240), behavior: 'smooth' });
    } catch (e) {
      /* 滚动失败不影响 */
    }
    await Z.sleep(sec * 1000);
  }

  /** 把存好的简历挂到投递弹窗的文件输入框上（浏览器不允许直接赋值，只能用 drop 事件） */
  async function attachResumeToDialog() {
    const meta = await Z.getResume();
    if (!meta) { Z.log('warn', '投递时想附加简历，但还没选文件'); return false; }
    const file = Z.resumeToFile(meta);
    if (!file) return false;

    const inputs = Array.from(document.querySelectorAll('input[type="file"]')).filter((el) => visible(el));
    if (!inputs.length) { Z.log('info', '这个投递弹窗没有附件入口，跳过简历附件'); return false; }
    const input = inputs[0];
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = input.closest('[class*="upload"],[class*="drop"]') || input.parentElement || input;
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      Z.log('ok', '已尝试附加简历：' + meta.name);
      return true;
    } catch (e) {
      Z.log('warn', '附加简历失败：' + String((e && e.message) || e));
      return false;
    }
  }

  /** 在投递弹窗里找留言/附言输入框并填上；找不到返回 false */
  function fillRemark(text) {
    const scopes = Array.from(
      document.querySelectorAll('[class*="modal"],[class*="dialog"],[class*="popup"],[class*="drawer"],[role="dialog"]')
    );
    const all = scopes.length ? scopes : [document];
    for (const scope of all) {
      if (!visible(scope)) continue;
      const inputs = scope.querySelectorAll('textarea,input[type="text"],input:not([type])');
      for (const el of inputs) {
        if (!visible(el)) continue;
        const ph = (el.getAttribute('placeholder') || '') + (el.getAttribute('aria-label') || '');
        if (!/留言|附言|打招呼|自我|介绍|留言板|说点什么|期望|附上/i.test(ph) && el.tagName !== 'TEXTAREA') continue;
        const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
        if (setter && setter.set) setter.set.call(el, text);
        else el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  /** 投完在页面上多待几秒，别立刻切走/关页 */
  async function postStay(cfg) {
    const a = Math.max(0, Number(cfg.postStayMinSec) || 0);
    const b = Math.max(a, Number(cfg.postStayMaxSec) || a);
    const sec = Z.randInt(a, b);
    if (!sec) return;
    setStatus('投完停留 ' + sec + ' 秒…');
    await Z.sleep(sec * 1000);
  }

  function dispatchApply(job, cfg) {
    const mode = cfg.applyMode || 'auto';
    if (mode === 'detail') {
      if (!cfg.allowTabMode) {
        Z.log('warn', '后台标签页模式已禁用（高风险），改用当前页投递');
        return job.el && job.el.isConnected ? applyInline(job, cfg) : applySplit(job, cfg);
      }
      return applyViaTab(job, cfg);
    }
    if (mode === 'split') return applySplit(job, cfg);
    if (mode === 'list') return applyInline(job, cfg);

    // 自动：按页面类型 + 这张卡片本身有没有按钮来选
    if (IS_DETAIL) return applyCurrent(true);
    if (PAGE.type === 'split') return applySplit(job, cfg);

    if (job.el && job.el.isConnected) {
      const hasBtn = Array.from(job.el.querySelectorAll('button,a')).some((b) =>
        /立即投递|投递简历|申请职位|立即申请|我要投递/.test((b.innerText || '').trim())
      );
      // 卡片里没按钮（或按钮在右侧详情区）→ 点开这张卡片，从详情区投
      return hasBtn ? applyInline(job, cfg) : applySplit(job, cfg);
    }

    if (job.url) return applyViaTab(job, cfg);
    return { status: 'error', message: '这个岗位既没有按钮也没有链接' };
  }

  /* ---------- 通用点击 + 结果判定 ---------- */
  async function clickApplyAndVerify(btn, cfg) {
    if (/已投递|继续沟通|已申请/.test(btn.innerText || '')) return { status: 'already' };
    if (isDisabledEl(btn)) return { status: 'already', message: '按钮不可点' };

    // 投前停留：像人一样先看一眼，别点开就投
    await humanPause(cfg);

    btn.click();
    await Z.sleep(1500);

    if (/请先登录|扫码登录|登录后查看/.test(document.body.innerText || '')) {
      return { status: 'need_manual', message: '当前未登录' };
    }

    // 附件简历：只在弹窗里确实有 file input 时才尝试
    if (cfg.attachResume) {
      const attached = await attachResumeToDialog();
      if (attached) { setStatus('已尝试附加简历…'); await Z.sleep(800); }
    }

    // 投递附言：只在确实找到留言输入框时才填，检测不到就跳过
    if (cfg.remark) {
      const filled = fillRemark(cfg.remark);
      if (filled) {
        setStatus('已填入投递附言');
        await Z.sleep(800);
      }
    }

    const confirm = await waitUntil(() => findBtnIn(document, splitTexts(cfg.selectors.confirmText), true), 6000);
    if (confirm && !isDisabledEl(confirm)) {
      confirm.click();
      await Z.sleep(1500);
    }

    const successTexts = splitTexts(cfg.selectors.successText);
    const ok = await waitUntil(() => {
      const modal = document.querySelector('.deliver-greeting-modal');
      if (modal && getComputedStyle(modal).display !== 'none') return true;
      if (/已投递|继续沟通|已申请/.test(btn.innerText || '')) return true;
      const b = document.body.innerText || '';
      return successTexts.some((x) => b.indexOf(x) >= 0);
    }, 12000);

    if (ok) {
      closeSuccessModal();

      // 投后复核：4 秒后再确认一次，防止一闪而过的提示造成假阳性
      if (cfg.verifyAfter) {
        await Z.sleep(2500);
        const still = await waitUntil(() => {
          const b = document.body.innerText || '';
          if (/已投递|继续沟通|已申请/.test(b)) return true;
          return successTexts.some((x) => b.indexOf(x) >= 0);
        }, 1800);
        if (!still) {
          return { status: 'need_manual', message: '初次判定成功，但 4 秒后信号消失，可能没真投上' };
        }
      }
      return { status: 'ok' };
    }

    const body = document.body.innerText || '';

    if (Z.siteLimitHit()) return { status: 'limit', message: '页面提示今日投递已达上限' };
    if (/验证码|安全验证|操作过于频繁|人机验证/.test(body)) return { status: 'blocked', message: '出现验证' };
    if (/简历.{0,8}(不完整|未完善|未填写)|请先(完善|上传|填写)简历/.test(body)) {
      return { status: 'need_resume', message: '简历不完整，需要先补简历' };
    }
    if (/已下线|停止招聘|岗位不存在|职位已关闭|职位已失效|该职位已?取消/.test(body)) {
      return { status: 'job_gone', message: '岗位已下架/停止招聘' };
    }
    if (/暂时无法投递|投递失败，请稍后/.test(body)) {
      return { status: 'error', message: '站点提示暂时无法投递' };
    }
    return { status: 'need_manual', message: '已点击但没确认到成功状态' };
  }

  function findSuccessModal() {
    const box = document.querySelector('.deliver-greeting-modal');
    if (box && getComputedStyle(box).display !== 'none') return box;
    const cands = Array.from(document.querySelectorAll('[class*="modal"],[class*="dialog"],[class*="popup"],[class*="layer"]')).filter((el) => {
      if (!el.innerText || getComputedStyle(el).display === 'none') return false;
      return /已向对方发送简历|投递成功|简历已发送/.test(el.innerText);
    });
    return cands.length ? cands[0] : null;
  }

  /** 关掉「已向对方发送简历和打招呼语」弹窗；关不掉会再试一次 */
  function closeSuccessModal() {
    const box = findSuccessModal();
    if (!box) return false;

    const pickBtn = () =>
      Array.from(box.querySelectorAll('button')).find((b) => /留在此页|关闭|知道了|确定/.test((b.innerText || '').trim()));

    (pickBtn() || box.querySelector('[class*="close"]') || { click() {} }).click();

    setTimeout(() => {
      const still = findSuccessModal();
      if (still) {
        const again = Array.from(still.querySelectorAll('button')).find((b) => /留在此页|关闭|知道了/.test((b.innerText || '').trim()));
        if (again) again.click();
        else if (still.querySelector('[class*="close"]')) still.querySelector('[class*="close"]').click();
      }
    }, 600);

    return true;
  }

  /* ---------- 详情页：投递当前岗位 ---------- */
  function currentJobInfo() {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      return el ? Z.norm(el.innerText) : '';
    };
    let title =
      pick('h1') ||
      pick('[class*="job-title"]') ||
      pick('[class*="jobTitle"]') ||
      pick('[class*="summary"]') ||
      (document.title || '').split(/[-_|]/)[0];
    title = String(title).replace(/\s+/g, ' ').trim().slice(0, 60);
    const company = pick('[class*="company-name"],[class*="companyName"],[class*="company__name"]').slice(0, 40);
    return {
      id: 'cur-' + Z.hashId(title + '|' + company),
      title: title || '当前岗位',
      company,
      salaryRaw: '',
      text: ''
    };
  }

  async function applyCurrent(silent) {
    if (state.running) {
      if (!silent) alert('任务运行中，先停止再单投');
      return { status: 'error', message: 'busy' };
    }
    const cfg = await Z.getConfig();
    const job = currentJobInfo();
    if (!silent) {
      const ok = confirm('对当前页岗位真实投递一次：\n\n' + job.title + (job.company ? '\n' + job.company : '') + '\n\n确认？');
      if (!ok) return { status: 'cancel' };
    }

    state.running = true;
    setRunning(true);
    state.counts = { scan: 1, pass: 1, skip: 0, ok: 0, fail: 0 };
    setCounts();
    setStatus('投递中：' + job.title);
    let result;
    try {
      const btn = await waitUntil(() => findBtnIn(document, splitTexts(cfg.selectors.applyText)), 5000);
      result = btn
        ? await clickApplyAndVerify(btn, cfg)
        : { status: 'error', message: '当前页没找到「立即投递」按钮（可能不是职位详情页，或按钮文案变了）' };
    } catch (e) {
      result = { status: 'error', message: String((e && e.message) || e) };
    }
    state.running = false;
    setRunning(false);

    if (result.status === 'ok') {
      state.counts.ok = 1;
      setCounts();
      await Z.markSeen(job.id, 'ok');
      await Z.bumpStat('applied', 1);
      await Z.bumpStat('ok', 1);
      Z.log('ok', '当前岗位投递成功 — ' + job.title, job);
    } else if (result.status !== 'cancel') {
      Z.log(result.status === 'already' ? 'skip' : 'warn', '当前岗位：' + result.status + ' ' + (result.message || ''), job);
    }

    if (!silent && result.status !== 'cancel') {
      setStatus('当前岗位：' + result.status + (result.message ? '（' + result.message + '）' : ''));
      if (result.status === 'limit') {
        alert('智联提示今天投满了（单账号约 100 个/天），明天再来。');
      } else {
        alert(result.status === 'ok' ? '✅ 投递成功' : '结果：' + result.status + '\n' + (result.message || ''));
      }
    }
    renderLogs();
    return result;
  }

  /* ---------- 框选卡片：给认不出的页面手动指定选择器 ---------- */
  /** 内容脚本里 CSS.escape 不一定可用，自己转义 */
  function cssEscape(str) {
    return String(str).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
  }

  function bestCardSelector(el) {
    const cands = [];
    let n = el;
    for (let i = 0; i < 5 && n && n.nodeType === 1; i++) {
      if (n.id) cands.push('#' + cssEscape(n.id));
      const cls = Array.from(n.classList || []).filter((c) => c && c.length < 32);
      if (cls.length) cands.push(n.tagName.toLowerCase() + '.' + cssEscape(cls[0]));
      if (cls.length > 1) cands.push(n.tagName.toLowerCase() + '.' + cls.slice(0, 2).map((c) => cssEscape(c)).join('.'));
      n = n.parentElement;
    }
    for (const sel of cands) {
      let list;
      try {
        list = document.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      if (list.length < 2 || list.length > 300) continue;
      const first = list[0];
      const looksLikeCard = /\d+(?:\.\d+)?\s*[-~]\s*\d+(?:\.\d+)?\s*(K|k|千|万)/.test(first.innerText || '') || !!first.querySelector('button,a');
      if (looksLikeCard) return { s: sel, cnt: list.length };
    }
    return null;
  }

  let picking = false;
  function startPick() {
    if (picking) return;
    picking = true;
    setStatus('框选模式：把鼠标移到一张职位卡片上，点一下确认（Esc 取消）');

    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #1668dc;background:rgba(22,104,220,.08);border-radius:6px;display:none';
    document.documentElement.appendChild(box);

    let lastEl = null;

    const onMove = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === box || el.closest('#' + HOST_ID)) return;
      lastEl = el;
      const r = el.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
    };

    const teardown = () => {
      picking = false;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      box.remove();
    };

    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = lastEl;
      teardown();
      if (!el) return;
      const best = bestCardSelector(el);
      if (!best) {
        setStatus('没生成出可用的选择器，换一张卡片或选更外层的块再试');
        return alert('这个元素生成的选择器命中数不合适（太少或太多）。\n试着点卡片更外层的一圈再试一次。');
      }
      saveCardSelector(best.s, best.cnt);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        teardown();
        setStatus('已取消框选');
      }
    };

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }

  async function saveCardSelector(sel, cnt) {
    cfgCache = await Z.setConfig({ selectors: { cardSelector: sel } });
    await fillForm();
    const jobs = Z.scanCards(document, sel);
    updatePageInfo();
    alert(
      '已保存卡片选择器：\n' + sel + '\n\n页面内命中 ' + cnt + ' 个元素，识别出 ' + jobs.length + ' 个岗位。\n' +
        (jobs.length ? '可以点「仅扫描」看看筛选结果了。' : '识别为 0，说明这个块里解析不出岗位名/薪资，换个更大的块再框一次。')
    );
    setStatus('已保存选择器，识别到 ' + jobs.length + ' 个岗位');
  }

  /* ---------- 顶部页面信息 ---------- */
  function updatePageInfo() {
    const el = root.getElementById('pageinfo');
    if (!el) return;
    const cnt = IS_DETAIL ? 0 : Z.scanCards(document, cfgCache ? cfgCache.selectors.cardSelector : '').length;
    const sub = root.getElementById('head-sub');
    if (sub) {
      sub.textContent = IS_DETAIL ? '详情页' : PAGE.type === 'other' ? '未识别' : '识别 ' + cnt;
    }
    el.innerHTML =
      '当前页：<b>' + PAGE.label + '</b>' +
      (IS_DETAIL ? ' · 可直接投这个岗位' : ' · 识别 ' + cnt + ' 个岗位') +
      (PAGE.type === 'other' && !PAGE.cards ? '<br>认不出列表结构，点「框选卡片」框一次职位卡片' : '');

    if (IS_DETAIL) {
      ['start', 'scan', 'one'].forEach((a) => {
        const b = wrap.querySelector('[data-act="' + a + '"]');
        if (b) {
          b.disabled = true;
          b.title = '详情页请用「投递当前岗位」';
        }
      });
    }
  }

  /** 页面类型会在懒加载后变化，扫描完重新判定一次 */
  function refreshPageType() {
    const p = Z.detectPageType();
    PAGE = p;
    IS_DETAIL = p.type === 'detail';
    updatePageInfo();
    return p;
  }

  async function applyInline(job, cfg) {
    const card = job.el && job.el.isConnected ? job.el : Z.findCardEl(job);
    if (!card) return { status: 'error', message: '找不到该岗位的卡片（列表可能已刷新）' };

    const btn =
      findBtnIn(card, splitTexts(cfg.selectors.applyText)) ||
      findBtnIn(card, ['立即投递', '投递简历', '申请职位']);
    if (!btn) {
      return {
        status: 'error',
        message: '卡片里没找到投递按钮（这页可能不是职位列表，或按钮在右侧详情区——试试「投递当前岗位」）'
      };
    }

    return await clickApplyAndVerify(btn, cfg);
  }

  /** 同页模式：左列表点卡片 → 右侧详情出现「立即投递」→ 点它 */
  async function applySplit(job, cfg) {
    const card = job.el && job.el.isConnected ? job.el : Z.findCardEl(job);
    if (!card) return { status: 'error', message: '找不到该岗位的卡片' };

    const key = (job.title || '').slice(0, 8);
    const switched = () => key.length >= 4 && (document.body.innerText || '').indexOf(key) >= 0;

    // 先点卡片容器（Vue 的事件一般挂在容器上，不会开新标签页）
    card.click();
    await Z.sleep(1000);
    let ok = await waitUntil(switched, 2500);

    // 容器点不动就点标题链接，但要临时摘掉 target，否则会开新标签页
    if (!ok) {
      const a = card.querySelector('a[href*="jobdetail"],[class*="jobinfo__name"],[class*="title"]');
      if (a) {
        const t = a.getAttribute('target');
        a.removeAttribute('target');
        a.click();
        if (t) a.setAttribute('target', t);
        ok = await waitUntil(switched, 5000);
      }
    }
    setStatus('已点开：' + job.title);

    // 详情没切过来就别点，否则会把上一个岗位的「已投递」误判成本岗位已投
    if (key.length >= 4 && !switched()) {
      return { status: 'error', message: '右侧详情没切换到该岗位，为避免误判已跳过' };
    }

    // 详情面板已切换到该岗位，这里才拿得到 HR 信息 → 同 HR 去重只能在这一步做
    if (cfg.filters && cfg.filters.sameHrOn) {
      const hr = Z.extractHrFromPage();
      if (hr) {
        const hrMap = await Z.getHrMap();
        const ts = hrMap[hr];
        const days = Number(cfg.filters.sameHrDays) || 0;
        if (ts && (!days || Date.now() - ts < days * 86400000)) {
          return { status: 'already', message: '同 HR 已投过（' + hr + '）' };
        }
      }
    }

    const btn = await waitUntil(() => findBtnIn(document, splitTexts(cfg.selectors.applyText)), 8000);
    if (!btn) return { status: 'error', message: '点开卡片后没找到「立即投递」按钮' };

    return await clickApplyAndVerify(btn, cfg);
  }

  /* ---------- 诊断 ---------- */
  function countSel(sel) {
    try {
      return document.querySelectorAll(sel).length;
    } catch (e) {
      return -1;
    }
  }

  function buildReport(cfg) {
    const SAL = /\d+(\.\d+)?\s*[-~]\s*\d+(\.\d+)?\s*(K|k|千|万)/;
    let salaryBlocks = 0;
    document.querySelectorAll('div,li,section,article').forEach((el) => {
      const t = el.innerText || '';
      if (t.length > 12 && t.length < 300 && SAL.test(t)) salaryBlocks++;
    });

    const cards = Z.scanCards(document, cfg.selectors.cardSelector);
    let sample = '';
    let sampleFrom = '';
    if (cards[0] && cards[0].el) {
      sample = cards[0].el.outerHTML;
      sampleFrom = '扫描识别出的卡片';
    } else {
      let best = null;
      let bestDepth = -1;
      document.querySelectorAll('div,li').forEach((el) => {
        const t = el.innerText || '';
        if (!(t.length > 12 && t.length < 300 && SAL.test(t))) return;
        let d = 0;
        let n = el;
        while (n && n.parentElement) {
          d++;
          n = n.parentElement;
        }
        if (d > bestDepth) {
          bestDepth = d;
          best = el;
        }
      });
      if (best) {
        sample = best.outerHTML;
        sampleFrom = '深度最大的含薪资块（可能是详情面板，不一定准）';
      }
    }

    const classes = new Set();
    document.querySelectorAll('[class]').forEach((el) => {
      String(el.className || '')
        .split(/\s+/)
        .forEach((c) => {
          if (c && c.length < 40 && classes.size < 120) classes.add(c);
        });
    });

    const lines = [
      '===== 智联助手诊断报告 =====',
      '时间: ' + new Date().toLocaleString('zh-CN'),
      '版本: ' + (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '?'),
      'URL: ' + location.href,
      '',
      '--- 结构计数 ---',
      '[class*=joblist-box__item]: ' + countSel('[class*="joblist-box__item"]'),
      'a[href*=jobdetail]: ' + countSel('a[href*="jobdetail"]'),
      'a[href]: ' + countSel('a[href]'),
      'button: ' + countSel('button'),
      '含薪资的块(文本12~300字): ' + salaryBlocks,
      '自定义卡片选择器: ' + (cfg.selectors.cardSelector || '（未设置）'),
      '该选择器命中: ' + (cfg.selectors.cardSelector ? countSel(cfg.selectors.cardSelector) : '—'),
      '最终识别岗位数: ' + cards.length,
      '',
      '--- 识别结果前 5 条 ---',
      cards.slice(0, 5).map((j, i) => i + 1 + '. ' + j.title + ' | ' + (j.company || '?') + ' | ' + (j.salaryRaw || '薪资未识别') + ' | id=' + j.id).join('\n') || '（无）',
      '',
      '--- 页面 class 采样（前 120 个）---',
      Array.from(classes).join(' '),
      '',
      '--- 卡片 HTML 样本（来源：' + sampleFrom + '）---',
      sample.slice(0, 3000) || '（未取到）'
    ];
    return lines.join('\n');
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      /* 落到手动复制 */
    }
    return false;
  }

  function showCopyBox(text) {
    const old = root.getElementById('zp-copybox');
    if (old) old.remove();
    const box = document.createElement('div');
    box.id = 'zp-copybox';
    box.style.cssText =
      'position:fixed;inset:8% 6% auto 6%;z-index:2147483002;background:#fff;border:1px solid #d9d9d9;border-radius:10px;padding:12px;box-shadow:0 8px 30px rgba(0,0,0,.2)';
    box.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
      '<b style="font-size:13px;font-weight:500">自动复制失败，请按 Ctrl+A 再 Ctrl+C</b>' +
      '<span data-close style="cursor:pointer;color:#888">✕</span></div>';
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'width:100%;height:50vh;font:11px/1.5 ui-monospace,Consolas,monospace;border:1px solid #eee;border-radius:6px;padding:8px';
    box.appendChild(ta);
    box.addEventListener('click', (e) => {
      if (e.target.hasAttribute('data-close')) box.remove();
    });
    root.appendChild(box);
    ta.focus();
    ta.select();
  }

  async function runDiagnostic() {
    const cfg = await Z.getConfig();
    const report = buildReport(cfg);
    const ok = await copyText(report);
    if (ok) {
      alert('诊断报告已复制到剪贴板。\n\n报告里含页面结构计数、识别结果和一段卡片 HTML，直接粘贴发我即可。');
      setStatus('诊断完成：识别 ' + Z.scanCards(document, cfg.selectors.cardSelector).length + ' 个岗位');
    } else {
      showCopyBox(report);
      setStatus('诊断完成，请手动复制文本框内容');
    }
  }

  /* ---------- 投递：开新标签页交给 detail.js ---------- */
  function applyViaTab(job, cfg) {
    return new Promise(async (resolve) => {
      let res;
      try {
        res = await chrome.runtime.sendMessage({
          type: 'OPEN_TAB',
          url: job.url,
          task: {
            job: { id: job.id, title: job.title, company: job.company },
            selectors: cfg.selectors,
            closeDelay: Math.max(0, Number(cfg.tabCloseDelaySec) || 0)
          }
        });
      } catch (e) {
        resolve({ status: 'error', message: '无法打开标签页' });
        return;
      }
      if (!res || !res.ok) {
        resolve({ status: 'error', message: (res && res.error) || '打开失败' });
        return;
      }
      const tabId = res.tabId;
      const timer = setTimeout(() => {
        state.pending.delete(tabId);
        resolve({ status: 'timeout', message: '详情页处理超时' });
      }, Number(cfg.detailTimeout) + 20000);
      state.pending.set(tabId, (r) => {
        clearTimeout(timer);
        state.pending.delete(tabId);
        resolve(r);
      });
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'JOB_RESULT') return;
    const fn = state.pending.get(msg.tabId);
    if (fn) fn(msg.result || { status: 'error', message: '空结果' });
  });

  /* ---------- 翻页 ---------- */
  /** 找到第一个卡片所在的可滚动容器 */
  function findListScroller() {
    const card = document.querySelector('[class*="joblist-box__item"]') ||
      Array.from(document.querySelectorAll('a[href]')).find((a) => Z.isDetailHref(a.getAttribute('href') || ''));
    let n = card && card.parentElement;
    for (let i = 0; i < 8 && n; i++) {
      if (n.scrollHeight > n.clientHeight + 80 && n.clientHeight > 200) {
        const st = getComputedStyle(n);
        if (/auto|scroll/.test(st.overflowY)) return n;
      }
      n = n.parentElement;
    }
    return null;
  }

  async function goNextPage() {
    const before = Z.scanCards(document, (cfgCache && cfgCache.selectors && cfgCache.selectors.cardSelector) || '').length;

    // 1) 有「下一页」按钮就点
    const isDisabled = (el) => {
      if (!el) return true;
      if (el.disabled) return true;
      if (el.getAttribute('aria-disabled') === 'true') return true;
      return /disabled|is-disabled/.test(el.className || '');
    };

    const cands = Array.from(document.querySelectorAll('button,a,li,span,div')).filter((el) => {
      const t = Z.norm(el.innerText);
      return t && t.length <= 6 && /^(下一页|下一頁|下页)$/.test(t);
    });
    for (const el of cands) {
      const clickable = el.tagName === 'A' || el.tagName === 'BUTTON' ? el : el.closest('button,a,li') || el;
      if (!isDisabled(clickable)) {
        clickable.click();
        return true;
      }
    }

    // 2) 内层滚动容器（左列表右详情这种页面基本都是内层滚动）
    const scroller = findListScroller();
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
      await Z.sleep(2500);
      const now = Z.scanCards(document, (cfgCache && cfgCache.selectors && cfgCache.selectors.cardSelector) || '').length;
      if (now > before) return true;
      scroller.scrollTop = scroller.scrollHeight;
      await Z.sleep(1500);
      return Z.scanCards(document, (cfgCache && cfgCache.selectors && cfgCache.selectors.cardSelector) || '').length > before;
    }

    // 3) 整页滚动兜底
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    await Z.sleep(2500);
    return Z.scanCards(document, (cfgCache && cfgCache.selectors && cfgCache.selectors.cardSelector) || '').length > before;
  }

  /* ---------- 统计与日志渲染 ---------- */
  async function renderStats() {
    const box = root.getElementById('stats-box');
    if (!box) return;
    const all = await Z.getStats();
    const keys = Object.keys(all).sort().reverse();
    if (!keys.length) {
      box.innerHTML = '<div class="hint">还没有数据。跑一轮演练就有了。</div>';
      return;
    }
    const today = all[Z.todayKey()] || {};
    const rows = keys
      .slice(0, 14)
      .map((k) => {
        const d = all[k];
        return `<tr><td>${k}</td><td>${d.scanned || 0}</td><td>${d.passed || 0}</td><td>${d.applied || 0}</td><td>${d.ok || 0}</td><td>${d.fail || 0}</td></tr>`;
      })
      .join('');
    box.innerHTML =
      `<div class="cards">
        <div class="card"><b>${today.applied || 0}</b><span>今日投递</span></div>
        <div class="card"><b>${today.ok || 0}</b><span>今日成功</span></div>
        <div class="card"><b>${today.fail || 0}</b><span>今日失败</span></div>
        <div class="card"><b>${today.scanned || 0}</b><span>今日扫描</span></div>
      </div>
      <table><thead><tr><th>日期</th><th>扫描</th><th>通过</th><th>投递</th><th>成功</th><th>失败</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  async function renderLogs() {
    const box = root.getElementById('loglist');
    if (!box) return;
    const logs = (await Z.getLogs()).slice(-120).reverse();
    if (!logs.length) {
      box.innerHTML = '<div class="hint">暂无日志。</div>';
      return;
    }
    box.innerHTML = logs
      .map((l) => {
        const time = new Date(l.t).toLocaleTimeString('zh-CN', { hour12: false });
        const lv = l.level === 'ok' ? 'ok' : l.level === 'error' ? 'error' : l.level === 'warn' ? 'warn' : l.level === 'skip' ? 'skip' : '';
        return `<div class="logitem"><span class="lv ${lv}">${l.level || 'info'}</span>${escapeHtml(time)} ${escapeHtml(l.msg)}</div>`;
      })
      .join('');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function exportCsv() {
    const logs = await Z.getLogs();
    if (!logs.length) return alert('没有日志可导出');
    const head = 'time,level,title,company,message\n';
    const body = logs
      .map((l) => [new Date(l.t).toISOString(), l.level, l.title, l.company, l.msg].map((x) => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"').join(','))
      .join('\n');
    const blob = new Blob(['\ufeff' + head + body], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'zhaopin-helper-log-' + Z.todayKey() + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  function notify(title, message) {
    chrome.runtime.sendMessage({ type: 'NOTIFY', title, message }).catch(() => {});
  }

  async function grantAi() {
    // 注意：必须在点击手势内同步发起，不能先 await 存储，否则会被判为「非用户手势」
    const cfg = cfgCache;
    if (!cfg) return alert('请先重新打开面板再授权');
    let origin;
    try {
      origin = new URL(cfg.ai.baseUrl).origin + '/*';
    } catch (e) {
      return alert('请先填写合法的 base_url，例如 https://api.deepseek.com/v1');
    }
    try {
      const ok = await chrome.permissions.request({ origins: [origin] });
      alert(ok ? '已授权：' + origin : '未授权，AI 请求会失败');
    } catch (e) {
      alert('授权失败：' + String((e && e.message) || e));
    }
  }

  /* ---------- 并行搜索页 ---------- */
  async function openParallel() {
    const cfg = await Z.getConfig();
    const kws = String(cfg.searchKeywords || '')
      .split(/[,，\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (!kws.length) {
      return alert('先在「配置 → 关键词列表」里填要并行搜索的关键词，逗号分隔。\n例如：Java,后端开发,软件开发工程师');
    }
    const n = Math.max(1, Math.min(8, Number(cfg.parallelTabs) || 3));
    const picked = kws.slice(0, n);
    const city = String(cfg.searchCityCode || '').trim();
    const ok = confirm(
      '将打开 ' + picked.length + ' 个后台搜索页并行投递：\n\n' +
        picked.map((k) => '· ' + k).join('\n') +
        (city ? '\n\n城市代码：' + city : '') +
        '\n\n要点：\n· 所有页共用一个全局限速槽，总速率和单页跑一样，不会变快\n' +
        '· 跨页自动去重，同一个岗位只会被一个页投\n' +
        '· 每个页都会自己开始跑\n\n确认打开？'
    );
    if (!ok) return;
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'OPEN_SEARCH_TABS', keywords: picked, city, limit: n });
    } catch (e) {
      return alert('打开失败：' + String((e && e.message) || e));
    }
    if (!res || !res.ok) return alert('打开失败：' + ((res && res.error) || '未知错误'));
    setStatus('已打开 ' + (res.created || []).length + ' 个并行搜索页');
    Z.log('info', '开启并行搜索页：' + (res.created || []).map((c) => c.kw).join('、'));
  }

  /* ---------- 半自动模式：候选清单 ---------- */
  function renderConfirmList() {
    const box = root.getElementById('confirm-box');
    const list = root.getElementById('confirm-list');
    const tip = root.getElementById('confirm-tip');
    if (!box || !list) return;
    const jobs = state.pendingJobs || [];
    box.style.display = jobs.length ? 'block' : 'none';
    if (tip) tip.textContent = jobs.length ? '共 ' + jobs.length + ' 个候选，点「投」逐个投递' : '';
    list.innerHTML = jobs
      .map(
        (j, i) =>
          '<div class="row" style="padding:6px 0">' +
          '<label style="flex:1">' + escapeHtml(j.title) +
          '<span class="hint" style="margin:0">' + escapeHtml(j.company || '') + (j.salaryRaw ? ' · ' + escapeHtml(j.salaryRaw) : '') + '</span></label>' +
          '<button class="ghost sm" data-confirm-apply="' + i + '">投</button>' +
          '<button class="warn sm" data-confirm-drop="' + i + '">×</button>' +
          '</div>'
      )
      .join('');
  }

  async function applyOneFromList(job) {
    const cfg = await Z.getConfig();
    if (state.running) return;
    state.running = true;
    setRunning(true);
    setStatus('投递中：' + job.title);
    let result;
    try {
      result = await dispatchApply(job, cfg);
    } catch (e) {
      result = { status: 'error', message: String((e && e.message) || e) };
    }
    state.running = false;
    setRunning(false);

    if (result.status === 'ok') {
      state.counts.ok++;
      await Z.markSeen(job.id, 'ok');
      await Z.markCompany(job.companyKey);
      await Z.bumpStat('applied', 1);
      await Z.bumpStat('ok', 1);
      await Z.addRecord({
        id: job.id, title: job.title, company: job.company, salary: job.salaryRaw || '',
        kw: currentKeyword(), hr: job.hrSign || '', at: Date.now(), status: 'ok'
      });
      Z.log('ok', '投递成功 — ' + job.title + ' @ ' + job.company, job);
    } else if (result.status === 'already') {
      state.counts.skip++;
      await Z.markSeen(job.id, 'skip');
      Z.log('skip', '已投递过，跳过 — ' + job.title, job);
    } else {
      state.counts.fail++;
      await Z.markSeen(job.id, 'fail');
      await Z.bumpStat('applied', 1);
      await Z.bumpStat('fail', 1);
      Z.log('error', '投递失败（' + result.status + '）：' + (result.message || '') + '｜' + job.title, job);
    }
    setCounts();
    renderConfirmList();
    renderLogs();
    setStatus('完成：' + job.title + ' — ' + result.status);
  }

  /* ---------- 投递台账 ---------- */
  function currentKeyword() {
    try {
      return new URL(location.href).searchParams.get('kw') || '';
    } catch (e) {
      return '';
    }
  }

  async function renderLedger() {
    const recs = await Z.getRecords();
    const cfg = await Z.getConfig();
    const st = Z.replyStats(recs);
    const follow = Z.followUpList(recs, cfg.followUpDays);

    const cards = root.getElementById('ledger-cards');
    if (cards) {
      cards.innerHTML =
        '<div class="card"><b>' + st.sent + '</b><span>已投递</span></div>' +
        '<div class="card"><b>' + st.replied + '</b><span>有回复</span></div>' +
        '<div class="card"><b>' + (st.rate * 100).toFixed(0) + '%</b><span>回复率</span></div>' +
        '<div class="card"><b>' + follow.length + '</b><span>待跟进</span></div>';
    }

    const fu = root.getElementById('followup-box');
    if (fu) {
      fu.innerHTML = follow.length
        ? '<div class="tip" style="margin:8px 0">已超过 ' + (cfg.followUpDays || 3) + ' 天没回复，建议跟进：<br>' +
          follow.slice(0, 8).map((r) => '· ' + escapeHtml(r.title) + ' @ ' + escapeHtml(r.company || '')).join('<br>') +
          '</div>'
        : '';
    }

    const kwRows = Object.keys(st.byKw)
      .map(
        (k) =>
          '<tr><td>' + escapeHtml(k) + '</td><td>' + st.byKw[k].sent + '</td><td>' + st.byKw[k].replied + '</td><td>' +
          (st.byKw[k].rate * 100).toFixed(0) + '%</td></tr>'
      )
      .join('');

    const rows = recs
      .slice()
      .reverse()
      .slice(0, 80)
      .map((r) => {
        const d = new Date(r.at || 0);
        const time = d.getMonth() + 1 + '/' + d.getDate();
        const stt = r.status === 'ok' ? '成功' : r.status === 'fail' ? '失败' : r.status === 'already' ? '已投过' : '跳过';
        return (
          '<tr><td>' + time + '</td><td>' + escapeHtml(r.title || '') + '</td><td>' + escapeHtml(r.company || '') + '</td>' +
          '<td>' + escapeHtml(r.salary || '') + '</td><td>' + stt + '</td>' +
          '<td><button class="ghost sm" data-rec-reply="' + escapeHtml(r.id) + '">' + (r.replied ? '✓ 已回' : '标记回复') + '</button></td>' +
          '<td><button class="ghost sm" data-rec-follow="' + escapeHtml(r.id) + '">' + (r.followed ? '已跟进' : '跟进') + '</button></td>' +
          '<td><button class="warn sm" data-rec-del="' + escapeHtml(r.id) + '">删</button></td></tr>'
        );
      })
      .join('');

    const table = root.getElementById('ledger-table');
    if (table) {
      table.innerHTML =
        (kwRows ? '<h4 style="margin:12px 0 4px;font-size:12px;font-weight:500">按关键词的回复率</h4>' +
          '<table><thead><tr><th>关键词</th><th>投</th><th>回</th><th>回复率</th></tr></thead><tbody>' + kwRows + '</tbody></table>' : '') +
        '<h4 style="margin:12px 0 4px;font-size:12px;font-weight:500">投递记录（最近 80 条）</h4>' +
        (rows
          ? '<table><thead><tr><th>日期</th><th>岗位</th><th>公司</th><th>薪资</th><th>结果</th><th>回复</th><th>跟进</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
          : '<div class="hint">还没有记录。投出去之后会自动记账。</div>');
    }

    const hint = root.getElementById('resume-hint');
    if (hint) {
      const meta = await Z.getResume();
      hint.textContent = meta
        ? '已设置附件简历：' + meta.name + '（' + (meta.size / 1024).toFixed(0) + ' KB）' + (cfg.attachResume ? '，投递时会自动尝试附加' : '，但「自动附加简历」没开')
        : '未设置附件简历（点「选择简历文件」，文件只存在本机浏览器里，不上传）';
    }
  }

  async function exportRecords() {
    const recs = await Z.getRecords();
    if (!recs.length) return alert('台账是空的，没什么可导出的。');
    const head = ['日期', '岗位', '公司', '薪资', '关键词', '结果', '是否回复', '是否跟进', 'HR'];
    const lines = [head.join(',')];
    for (const r of recs) {
      const d = new Date(r.at || 0);
      const p = (n) => String(n).padStart(2, '0');
      const row = [
        d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()),
        r.title || '', r.company || '', r.salary || '', r.kw || '',
        r.status === 'ok' ? '成功' : r.status === 'fail' ? '失败' : r.status === 'already' ? '已投过' : '跳过',
        r.replied ? '是' : '否', r.followed ? '是' : '否', r.hr || ''
      ];
      lines.push(row.map((x) => '"' + String(x).replace(/"/g, '""') + '"').join(','));
    }
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'zhaopin-台账-' + Z.todayKey() + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  /* ---------- 数据清理 ---------- */
  async function clearRecords() {
    const ok = confirm(
      '清空投递记录：\n\n• 已处理岗位（去重记录）\n• 已投公司\n• 每日统计\n• 日志\n• 待复核队列\n• 未完成的断点\n\n' +
        '配置（筛选规则、间隔、上限、API Key）会保留。\n\n确认清空？'
    );
    if (!ok) return;
    await Z.save({
      [Z.K.SEEN]: {},
      [Z.K.COMPANY]: {},
      [Z.K.STATS]: {},
      [Z.K.LOGS]: [],
      [Z.K.PENDING]: [],
      [Z.K.SESSION]: null
    });
    state.counts = { scan: 0, pass: 0, skip: 0, ok: 0, fail: 0 };
    setCounts();
    renderStats();
    renderLogs();
    alert('投递记录已清空（配置保留）');
    setStatus('投递记录已清空');
  }

  async function clearAll() {
    const ok = confirm('清空全部本地数据？\n\n包括配置、筛选规则、AI API Key、所有记录与日志。\n清完后插件回到初始状态，页面会刷新。\n\n确认？');
    if (!ok) return;
    await chrome.storage.local.clear();
    location.reload();
  }

  /* ---------- 自动扫描 ---------- */
  let autoTimer = null;
  let lastScanSig = '';

  function scanSignature() {
    try {
      const jobs = Z.scanCards(document, cfgCache ? cfgCache.selectors.cardSelector : '');
      return jobs.length + '|' + jobs.slice(0, 5).map((j) => j.id).join(',');
    } catch (e) {
      return '';
    }
  }

  function scheduleAutoScan(delay) {
    if (!cfgCache || !cfgCache.autoScan || state.running || IS_DETAIL) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(autoScanOnce, delay == null ? 1200 : delay);
  }

  async function autoScanOnce() {
    if (!cfgCache || !cfgCache.autoScan || state.running || IS_DETAIL) return;
    const sig = scanSignature();
    if (sig === lastScanSig) return;
    lastScanSig = sig;
    await scanOnly(true);
    refreshPageType();
  }

  /* ---------- 扩展失效提示 ---------- */
  let deadShown = false;
  function showDeadBanner() {
    if (deadShown) return;
    deadShown = true;
    const bar = document.createElement('div');
    bar.style.cssText =
      'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;' +
      'background:#a8071a;color:#fff;padding:10px 18px;border-radius:8px;cursor:pointer;' +
      'font:13px/1.5 -apple-system,"Microsoft YaHei",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25)';
    bar.textContent = '智联助手已失效（扩展被更新过），点这里刷新页面';
    bar.addEventListener('click', () => location.reload());
    root.appendChild(bar);
    setStatus('插件已失效，请刷新页面');
  }

  /* ---------- 初始化 ---------- */
  fillForm().then(async () => {
    renderStats();
    updatePageInfo();
    setStatus('待机 · 已就绪（' + PAGE.label + '）');

    // 并行搜索页：后台给它派的任务里带 autoRun → 加载完自己开始跑
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_TASK' });
      const task = res && res.ok && res.payload ? res.payload.task : null;
      if (task && task.autoRun && !IS_DETAIL) {
        setStatus('并行模式 · ' + (task.keyword || '') + ' · 3 秒后自动开始…');
        await Z.sleep(3500);
        startRun({ auto: true });
      }
    } catch (e) {
      /* 正常浏览时没有任务 */
    }

    // 自动扫描：页面结构变化（翻页/懒加载）后自动重扫
    if (!IS_DETAIL) {
      scheduleAutoScan(600);
      try {
        const mo = new MutationObserver(() => scheduleAutoScan(1500));
        mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
      } catch (e) {
        /* 观察失败不影响手动扫描 */
      }
      setInterval(() => {
        if (!document.hidden) scheduleAutoScan(1000);
      }, 6000);

      setInterval(() => {
        if (!Z.isContextAlive() || Z.isContextDead()) showDeadBanner();
      }, 4000);
    }

    // 上次任务没跑完（比如关键词轮换刷新了页面）→ 自动续跑
    const sess = await Z.getSession();
    if (sess && sess.running && !IS_DETAIL) {
      state.counts = sess.counts || state.counts;
      state.keywordIndex = sess.keywordIndex || 0;
      setCounts();
      const kws = splitKeywords(await Z.getConfig());
      const kwName = kws[state.keywordIndex] || '当前关键词';
      setStatus('检测到上次未完成的任务（' + kwName + '），4 秒后自动继续…');
      setTimeout(() => startRun({ resume: true }), 4000);
    }
  });
})();
