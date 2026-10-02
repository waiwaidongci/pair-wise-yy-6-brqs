import http from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATA_FILE || join(__dirname, "data", "ink-stick-testing.json");
const port = Number(process.env.PORT || 3037);
const seed = {
  "items": [
    {
      "code": "IS-001",
      "smokeSource": "黄山松烟",
      "glueRatio": "7.5%",
      "ageYears": 8,
      "storage": "恒湿柜B",
      "status": "已试磨",
      "logs": [
        {
          "at": "2026-06-11",
          "step": "试磨",
          "note": "宣纸20滴水，出墨快，评分86",
          "score": 86
        }
      ]
    },
    {
      "code": "IS-002",
      "smokeSource": "桐油烟",
      "glueRatio": "8%",
      "ageYears": 3,
      "storage": "试样盒C",
      "status": "待试磨",
      "logs": []
    }
  ]
};
const fields = [["code","墨锭编号","text"],["smokeSource","烟料来源","text"],["glueRatio","胶料比例","text"],["ageYears","存放年限","number"],["storage","存放位置","text"]];
const stages = ["待试磨","已试磨","重点观察"];
const statLabels = ["待试磨","已试磨","重点观察"];
const extraFields = [["paper","试磨纸张"],["water","加水量"],["speed","出墨速度"],["colorLayer","墨色层次"],["sediment","沉淀情况"],["score","评分"]];
// 条件三要素：任一变化都会让未定级结论失效重算
const conditionFields = [["glueRatio","胶料比例"],["storage","存放位置"],["paper","试磨纸张"]];

// ---------- 存储：原子写盘 + 串行写队列（防止并发整库覆盖） ----------
async function saveDb(db) {
  await mkdir(dirname(dbPath), { recursive: true });
  const tmp = dbPath + ".tmp";
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath);
}
let writeChain = Promise.resolve();
function serialized(job) {
  const run = writeChain.then(job);
  writeChain = run.catch(() => {});
  return run;
}

// ---------- 领域：批次 / 结论 / 状态推导 ----------
function gradeOf(score) {
  const s = Number(score) || 0;
  if (s >= 90) return "甲等";
  if (s >= 85) return "乙等";
  if (s >= 75) return "丙等";
  return "等外";
}
function statusOf(score) {
  if (score === null || score === undefined || score === "") return "待试磨";
  return Number(score) >= 85 ? "已试磨" : "重点观察";
}
function latestBatch(item) {
  return (item.batches || [])[item.batches.length - 1] || null;
}
function activeConclusionOf(batch) {
  if (!batch || !Array.isArray(batch.conclusions) || !batch.conclusions.length) return null;
  return batch.conclusions[batch.conclusions.length - 1];
}
function currentConditions(item) {
  return { glueRatio: item.glueRatio ?? "", storage: item.storage ?? "", paper: item.paper ?? "" };
}
function newConclusion(item, score, note, at) {
  item.conclusionSeq = (item.conclusionSeq || 0) + 1;
  return {
    id: "C-" + item.conclusionSeq,
    state: "未定级",
    score: Number(score) || 0,
    grade: gradeOf(score),
    conditions: currentConditions(item),
    createdAt: at,
    decidedAt: null,
    invalidatedAt: null,
    invalidReason: null,
    note: note || ""
  };
}
// 条件变化：最新批次的未定级结论立即失效，并按新条件重算一条（历史结论保留可查）
function invalidatePending(item, reason, at) {
  const batch = latestBatch(item);
  const c = activeConclusionOf(batch);
  if (!c || c.state !== "未定级") return null;
  c.state = "已失效";
  c.invalidatedAt = at;
  c.invalidReason = reason;
  const recomputed = newConclusion(item, c.score, "因" + reason + "重算", at);
  batch.conclusions.push(recomputed);
  return { batchNo: batch.batchNo, invalidated: c, recomputed };
}
function deriveStatus(item) {
  const c = activeConclusionOf(latestBatch(item));
  if (c) return statusOf(c.score);
  return item.status || "待试磨";
}
function addLog(item, step, note, extra) {
  item.logs ||= [];
  item.logs.push({ at: new Date().toISOString(), step, note, ...extra });
}
function nextBatchNo(item) {
  item.batchSeq = (item.batchSeq || 0) + 1;
  return (item.code || item.id || "IS") + "-B" + String(item.batchSeq).padStart(2, "0");
}
function findItem(db, ref) {
  return db.items.find(x => x.id === ref || x.code === ref);
}

// ---------- 迁移：旧记录缺少批次号时补初始批次，历史评分仍可查 ----------
function migrateItem(item) {
  let changed = false;
  item.logs ||= [];
  if (!Array.isArray(item.batches)) {
    const tests = Array.isArray(item.tests) ? item.tests.slice() : [];
    const seen = new Set(tests.map(t => `${t.at}|${t.score}`));
    for (const log of item.logs) {
      if (log && log.step === "试磨" && log.score !== undefined && !seen.has(`${log.at}|${log.score}`)) {
        tests.push({ at: log.at, paper: log.paper, score: log.score, note: log.note, migrated: true });
        seen.add(`${log.at}|${log.score}`);
      }
    }
    tests.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const last = tests[tests.length - 1];
    item.paper ??= last?.paper || "";
    item.batchSeq = 0;
    item.conclusionSeq = 0;
    const batch = {
      batchNo: (item.code || item.id || "IS") + "-B00",
      createdAt: last?.at || item.logs[0]?.at || new Date().toISOString(),
      ticketNo: "MIGRATION",
      conditions: { glueRatio: item.glueRatio ?? "", storage: item.storage ?? "", paper: item.paper ?? "" },
      tests,
      conclusions: [],
      note: "初始批次（历史数据迁移补录）"
    };
    if (last && last.score !== undefined) {
      batch.conclusions.push(newConclusion(item, last.score, "历史评分迁移补录", batch.createdAt));
    }
    item.batches = [batch];
    delete item.tests;
    changed = true;
  }
  if (typeof item.version !== "number") { item.version = 0; changed = true; }
  if (!item.tickets) { item.tickets = {}; changed = true; }
  if (!item.conflicts) { item.conflicts = []; changed = true; }
  if (typeof item.batchSeq !== "number") { item.batchSeq = item.batches.length; changed = true; }
  if (typeof item.conclusionSeq !== "number") { item.conclusionSeq = 0; changed = true; }
  if (item.paper === undefined) { item.paper = latestBatch(item)?.conditions?.paper || ""; changed = true; }
  return changed;
}
async function loadDb() {
  if (!existsSync(dbPath)) {
    await saveDb(seed);
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  db.items ||= [];
  for (const item of db.items) migrateItem(item);
  return db;
}
// 启动时落盘一次迁移结果，之后请求内只读
async function migrateOnDisk() {
  const db = await loadDb();
  await saveDb(db);
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId() { return "IS-" + Date.now(); }
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const batch = latestBatch(item);
  return {
    ...item,
    logCount: (item.logs || []).length,
    activeBatchNo: batch ? batch.batchNo : null,
    activeConclusion: activeConclusionOf(batch)
  };
}
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>墨锭试磨室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .batch { border-top:1px dashed var(--line); padding-top:6px; display:grid; gap:3px; font-size:13px; }
    .conflict { color:var(--warn); font-size:13px; } .ticket-row { display:flex; gap:6px; } .ticket-row input { flex:1; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:110px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>墨锭试磨室</h1><div class="meta">档案 → 试磨批次 → 定级结论，现场单号可恢复续办</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增墨锭</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存墨锭</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>创建试磨记录</h2><label>选择墨锭</label><select name="id" id="itemSelect"></select><label>现场单号（提交失败可凭原单号续办，不重复记录）</label><div class="ticket-row"><input name="ticketNo" id="ticketInput" readonly><button type="button" class="secondary" id="newTicket">换单</button></div><div id="extraFields"></div><button>提交记录</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>两人同时提交同一墨锭时先到者成立，后到内容按现场单号留作冲突草稿；胶料比例、存放位置或试磨纸张一变，未定级结论立即失效重算。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = ${JSON.stringify(fields)};
    const stages = ${JSON.stringify(stages)};
    const extraFields = ${JSON.stringify(extraFields)};
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const ticketInput = document.querySelector('#ticketInput');
    let items = [];
    function newTicket() { return 'XD-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase(); }
    let ticketNo = newTicket();
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) { const err = new Error(data.error || '请求失败'); err.status = res.status; err.data = data; throw err; }
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
      ticketInput.value = ticketNo;
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.smokeSource || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
      document.querySelectorAll('[data-grade]').forEach(btn => btn.onclick = async () => { const [id, batchNo] = btn.dataset.grade.split('|'); const note = prompt('定级备注（可空）'); if (note === null) return; try { await api('/api/items/'+id+'/grade', { method:'POST', body: JSON.stringify({ batchNo, note }) }); await load(); } catch (err) { alert('定级失败：' + err.message); await load(); } });
    }
    function batchHtml(item, b) {
      const cond = b.conditions || {};
      const tests = (b.tests || []).map(t => '<div>评分 ' + t.score + ' · ' + (t.paper || '试纸') + (t.water ? ' · ' + t.water : '') + (t.migrated ? ' · 历史迁移' : '') + '</div>').join('');
      const cons = (b.conclusions || []).map((c, i, arr) => {
        const last = i === arr.length - 1;
        return '<div>' + c.id + ' <span class="pill">' + c.state + '</span> ' + c.grade + '（' + c.score + '分）'
          + (c.invalidReason ? ' · ' + c.invalidReason : '')
          + (c.note ? ' · ' + c.note : '')
          + (last && c.state === '未定级' ? ' <button class="secondary" data-grade="'+(item.id || item.code)+'|'+b.batchNo+'">定级</button>' : '')
          + '</div>';
      }).join('');
      return '<div class="batch"><b>'+b.batchNo+'</b> <span class="meta">'+String(b.createdAt || '').slice(0, 10)+(b.ticketNo ? ' · 单号 '+b.ticketNo : '')+(b.note ? ' · '+b.note : '')+'</span>'
        + '<div class="meta">条件：胶料 '+(cond.glueRatio || '—')+' · 位置 '+(cond.storage || '—')+' · 纸张 '+(cond.paper || '—')+'</div>'
        + tests + cons + '</div>';
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const batches = (item.batches || []).slice().reverse().map(b => batchHtml(item, b)).join('');
      const conflicts = (item.conflicts || []).length
        ? '<div class="conflict"><b>冲突草稿</b>' + item.conflicts.map(c => '<div>单号 '+c.ticketNo+' · 评分 '+(c.payload && c.payload.score ?? '')+' · '+c.reason+'</div>').join('') + '</div>'
        : '';
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main
        + '<div><b>试磨纸张</b> '+(item.paper || '—')+'</div>'
        + (batches || '<div class="meta">暂无批次</div>') + conflicts
        + '<button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    async function load() { items = await api('/api/items'); render(); }
    createForm.onsubmit = async event => { event.preventDefault(); try { await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); } catch (err) { alert('保存失败：' + err.message); } };
    actionForm.onsubmit = async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(actionForm).entries());
      const item = items.find(i => (i.id || i.code) === itemSelect.value);
      data.baseVersion = item ? item.version : 0;
      try {
        await api('/api/items/' + itemSelect.value + '/action', { method:'POST', body: JSON.stringify(data) });
        actionForm.reset();
        ticketNo = newTicket(); ticketInput.value = ticketNo;
        await load();
      } catch (err) {
        if (err.status === 409) {
          alert('他人已先行提交，先到者成立。您的内容已按现场单号 ' + data.ticketNo + ' 留作冲突草稿。');
          ticketNo = newTicket(); ticketInput.value = ticketNo;
          await load();
        } else {
          alert('提交失败：' + err.message + '。可凭原现场单号 ' + data.ticketNo + ' 重新提交，不会重复记录。');
        }
      }
    };
    document.querySelector('#newTicket').onclick = () => { ticketNo = newTicket(); ticketInput.value = ticketNo; };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") {
      const db = await loadDb();
      return send(res, 200, db.items.map(summarize));
    }
    if (req.method === "GET" && url.pathname === "/api/stats") {
      const db = await loadDb();
      return send(res, 200, computeStats(db.items));
    }
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const result = await serialized(async () => {
        const db = await loadDb();
        const code = String(input.code || "").trim() || newId();
        if (db.items.some(x => x.code === code)) return { status: 409, data: { error: "code_exists", code } };
        const at = new Date().toISOString();
        const item = {
          id: newId(),
          code,
          smokeSource: input.smokeSource || "",
          glueRatio: input.glueRatio || "",
          ageYears: input.ageYears === "" || input.ageYears === undefined ? "" : Number(input.ageYears),
          storage: input.storage || "",
          paper: input.paper || "",
          status: input.status || "待试磨",
          version: 0,
          batchSeq: 0,
          conclusionSeq: 0,
          batches: [],
          tickets: {},
          conflicts: [],
          logs: [{ at, step: "建档", note: "创建墨锭" }]
        };
        db.items.unshift(item);
        await saveDb(db);
        return { status: 201, data: summarize(item) };
      });
      return send(res, result.status, result.data);
    }
    const ticket = url.pathname.match(/^\/api\/items\/([^/]+)\/tickets\/([^/]+)$/);
    if (ticket && req.method === "GET") {
      const db = await loadDb();
      const item = findItem(db, decodeURIComponent(ticket[1]));
      if (!item) return send(res, 404, { error: "item_not_found" });
      const ticketNo = decodeURIComponent(ticket[2]);
      const rec = (item.tickets || {})[ticketNo];
      if (!rec) return send(res, 404, { error: "ticket_not_found" });
      return send(res, 200, { ticketNo, ...rec });
    }
    const one = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (one && req.method === "GET") {
      const db = await loadDb();
      const item = findItem(db, decodeURIComponent(one[1]));
      if (!item) return send(res, 404, { error: "item_not_found" });
      return send(res, 200, summarize(item));
    }
    if (one && req.method === "PATCH") {
      const input = await body(req);
      const result = await serialized(async () => {
        const db = await loadDb();
        const item = findItem(db, decodeURIComponent(one[1]));
        if (!item) return { status: 404, data: { error: "item_not_found" } };
        const allowed = ["smokeSource", "glueRatio", "ageYears", "storage", "paper"];
        const at = new Date().toISOString();
        const changes = [];
        const reasons = [];
        for (const key of allowed) {
          if (input[key] === undefined) continue;
          const after = key === "ageYears" ? (input[key] === "" ? "" : Number(input[key])) : input[key];
          if (item[key] === after) continue;
          changes.push(key + "：" + (item[key] ?? "") + "→" + after);
          item[key] = after;
          const cond = conditionFields.find(([k]) => k === key);
          if (cond) reasons.push(cond[1] + "变更");
        }
        if (!changes.length) return { status: 200, data: summarize(item) };
        if (reasons.length) {
          const r = invalidatePending(item, reasons.join("、"), at);
          if (r) addLog(item, "失效重算", reasons.join("、") + "，批次" + r.batchNo + "未定级结论已失效并重算", { batchNo: r.batchNo });
        }
        item.version += 1;
        addLog(item, "档案", "更新" + changes.join("；"));
        await saveDb(db);
        return { status: 200, data: summarize(item) };
      });
      return send(res, result.status, result.data);
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const input = await body(req);
      const result = await serialized(async () => {
        const db = await loadDb();
        const item = findItem(db, decodeURIComponent(log[1]));
        if (!item) return { status: 404, data: { error: "item_not_found" } };
        addLog(item, input.step || "备注", input.note || "");
        await saveDb(db);
        return { status: 201, data: summarize(item) };
      });
      return send(res, result.status, result.data);
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const input = await body(req);
      const result = await serialized(async () => {
        const db = await loadDb();
        const item = findItem(db, decodeURIComponent(action[1]));
        if (!item) return { status: 404, data: { error: "item_not_found" } };
        const at = new Date().toISOString();
        const ticketNo = String(input.ticketNo || "").trim() || ("AUTO-" + Date.now());
        // 幂等续办：同一现场单号直接返回已记录结果，试磨、日志和状态不重复追加
        const seen = (item.tickets || {})[ticketNo];
        if (seen) {
          const data = { ticketNo, replayed: true, result: seen.result, batchNo: seen.batchNo || null, item: summarize(item) };
          if (seen.result === "conflict") return { status: 409, data: { error: "version_conflict", ...data } };
          return { status: 200, data };
        }
        const score = Number(input.score || 0);
        const baseVersion = input.baseVersion === undefined || input.baseVersion === null || input.baseVersion === ""
          ? item.version : Number(input.baseVersion);
        if (baseVersion !== item.version) {
          // 后到者：内容按现场单号留作冲突草稿，不覆盖先到者
          const draft = {
            ticketNo,
            at,
            baseVersion,
            currentVersion: item.version,
            reason: "他人已先行提交，先到者成立，本单留作冲突草稿",
            payload: {
              paper: input.paper || "",
              water: input.water || "",
              speed: input.speed || "",
              colorLayer: input.colorLayer || "",
              sediment: input.sediment || "",
              score
            }
          };
          item.conflicts.push(draft);
          item.tickets[ticketNo] = { result: "conflict", at };
          addLog(item, "冲突", "现场单号" + ticketNo + "与他人提交冲突，已存冲突草稿", { ticketNo });
          await saveDb(db);
          return { status: 409, data: { error: "version_conflict", ticketNo, currentVersion: item.version, draft } };
        }
        // 先到者成立：开新批次接到处置链上
        const newPaper = input.paper || item.paper || "";
        const paperChanged = newPaper !== (item.paper || "");
        const previous = activeConclusionOf(latestBatch(item));
        if (previous && previous.state === "未定级") {
          previous.state = "已失效";
          previous.invalidatedAt = at;
          previous.invalidReason = paperChanged ? "试磨纸张变更，新批次重算" : "新试磨批次重算";
        }
        item.paper = newPaper;
        const batchNo = nextBatchNo(item);
        const batch = {
          batchNo,
          createdAt: at,
          ticketNo,
          conditions: currentConditions(item),
          tests: [{ at, paper: newPaper, water: input.water || "", speed: input.speed || "", colorLayer: input.colorLayer || "", sediment: input.sediment || "", score }],
          conclusions: []
        };
        const conclusion = newConclusion(item, score, paperChanged ? "试磨纸张变更后重算" : "试磨提交", at);
        batch.conclusions.push(conclusion);
        item.batches.push(batch);
        item.status = deriveStatus(item);
        item.version += 1;
        item.tickets[ticketNo] = { result: "committed", at, batchNo };
        addLog(item, "试磨", (newPaper || "试纸") + "，评分" + score + "，批次" + batchNo + "（单号" + ticketNo + "）", { score, batchNo, ticketNo });
        await saveDb(db);
        return { status: 201, data: { ticketNo, batchNo, conclusion, item: summarize(item) } };
      });
      return send(res, result.status, result.data);
    }
    const grade = url.pathname.match(/^\/api\/items\/([^/]+)\/grade$/);
    if (grade && req.method === "POST") {
      const input = await body(req);
      const result = await serialized(async () => {
        const db = await loadDb();
        const item = findItem(db, decodeURIComponent(grade[1]));
        if (!item) return { status: 404, data: { error: "item_not_found" } };
        const batch = input.batchNo
          ? (item.batches || []).find(b => b.batchNo === input.batchNo)
          : latestBatch(item);
        if (!batch) return { status: 404, data: { error: "batch_not_found" } };
        const c = activeConclusionOf(batch);
        if (!c) return { status: 404, data: { error: "conclusion_not_found" } };
        if (c.state === "已定级") return { status: 409, data: { error: "already_graded", batchNo: batch.batchNo } };
        if (c.state === "已失效") return { status: 409, data: { error: "conclusion_invalidated", batchNo: batch.batchNo } };
        const at = new Date().toISOString();
        c.state = "已定级";
        c.decidedAt = at;
        if (input.grade) c.grade = String(input.grade);
        if (input.note) c.note = (c.note ? c.note + "；" : "") + String(input.note);
        item.version += 1;
        addLog(item, "定级", "批次" + batch.batchNo + "定级为" + c.grade + "（评分" + c.score + "）", { batchNo: batch.batchNo });
        await saveDb(db);
        return { status: 200, data: { batchNo: batch.batchNo, conclusion: c, item: summarize(item) } };
      });
      return send(res, result.status, result.data);
    }
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});

await migrateOnDisk();
server.listen(port, () => console.log("墨锭试磨室 listening on http://localhost:" + port));
