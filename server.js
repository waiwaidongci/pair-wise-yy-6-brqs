import http from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "ink-stick-testing.json");
const tmpPath = dbPath + ".tmp";
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

// ---------- id / grading ----------
function newId(prefix) { return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); }
function newItemId() { return newId("IS"); }
function newBatchId() { return newId("B"); }
function newConclusionId() { return newId("C"); }
function newTicketId() { return newId("P"); }

function gradeFor(score) {
  if (score >= 90) return "优";
  if (score >= 80) return "良";
  if (score >= 70) return "中";
  return "差";
}
function statusFor(score) { return score >= 85 ? "已试磨" : "重点观察"; }

// ---------- db load / atomic save ----------
async function atomicWrite(db) {
  await writeFile(tmpPath, JSON.stringify(db, null, 2));
  await rename(tmpPath, dbPath);
}
async function saveDb(db) { await atomicWrite(db); }

// 写操作串行化：保证「读盘 → 版本校验 → 应用 → 写盘」对并发写是原子的，
// 否则两人同时提交会都读到旧版本、都通过校验，先到者内容被后到者覆盖。
let writeChain = Promise.resolve();
function withWriteLock(fn) {
  const run = writeChain.then(fn);
  writeChain = run.catch(() => {});
  return run;
}

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await atomicWrite(seed);
  }
  let db;
  try {
    db = JSON.parse(await readFile(dbPath, "utf8"));
  } catch (err) {
    // 写盘中断可能留下损坏的正式文件；回退到同目录临时文件续办
    if (existsSync(tmpPath)) db = JSON.parse(await readFile(tmpPath, "utf8"));
    else throw err;
  }
  const before = JSON.stringify(db);
  migrateDb(db);
  if (JSON.stringify(db) !== before) await saveDb(db);
  return db;
}

// ---------- migration: 补初始批次 + 历史结论 ----------
function migrateDb(db) {
  db.items ||= [];
  db.tickets ||= {};
  for (const item of db.items) {
    item.logs ||= [];
    item.tests ||= [];
    item.batches ||= [];
    item.conclusions ||= [];
    item.conflicts ||= [];
    if (typeof item.version !== "number") item.version = 0;
    if (item.schemaVersion >= 1) continue;

    if (item.batches.length === 0) {
      const firstAt = item.logs[0]?.at || item.tests[0]?.at || new Date().toISOString();
      const hasConclusion = item.tests.length > 0 || item.logs.some(l => l.score != null);
      const batch = {
        id: newBatchId(),
        no: 1,
        ticketId: null,
        paper: "—",
        glueRatio: item.glueRatio,
        storage: item.storage,
        state: hasConclusion ? "已定级" : "未定级",
        initial: true,
        createdAt: firstAt,
        conclusionIds: []
      };
      // 历史试磨 → 批次 + 已定级结论（历史评分仍可查）
      for (const t of item.tests) {
        t.batchId = batch.id;
        const score = Number(t.score) || 0;
        const c = {
          id: newConclusionId(),
          batchId: batch.id,
          ticketId: null,
          score,
          grade: gradeFor(score),
          state: "已定级",
          paper: t.paper || "—",
          glueRatio: item.glueRatio,
          storage: item.storage,
          createdAt: t.at,
          decidedAt: t.at,
          invalidAt: null,
          recalculatedFrom: null,
          historical: true
        };
        batch.conclusionIds.push(c.id);
        item.conclusions.push(c);
      }
      // 历史日志中带评分且未被试磨覆盖的，补结论
      const covered = new Set(item.tests.map(t => Number(t.score)));
      for (const l of item.logs) {
        l.batchId = batch.id;
        if (l.score != null && !covered.has(Number(l.score))) {
          const score = Number(l.score) || 0;
          const c = {
            id: newConclusionId(),
            batchId: batch.id,
            ticketId: null,
            score,
            grade: gradeFor(score),
            state: "已定级",
            paper: "—",
            glueRatio: item.glueRatio,
            storage: item.storage,
            createdAt: l.at,
            decidedAt: l.at,
            invalidAt: null,
            recalculatedFrom: null,
            historical: true
          };
          batch.conclusionIds.push(c.id);
          item.conclusions.push(c);
          covered.add(score);
        }
      }
      item.batches.push(batch);
    }
    item.schemaVersion = 1;
  }
}

// ---------- helpers ----------
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return {}; }
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function findItem(db, ref) { return db.items.find(x => x.id === ref || x.code === ref); }

function summarize(item) {
  const logCount = (item.logs || []).length;
  const batchCount = (item.batches || []).length;
  const conclusionCount = (item.conclusions || []).length;
  const conflictCount = (item.conflicts || []).filter(c => !c.resolved).length;
  return { ...item, logCount, batchCount, conclusionCount, conflictCount };
}

// 先到者成立：版本不一致 → 后到内容按现场单号留作冲突草稿
async function storeConflict(db, item, input, ticketId, baseVersion) {
  const draft = {
    ticketId,
    at: new Date().toISOString(),
    input,
    reason: "version_conflict",
    baseVersion,
    currentVersion: item.version,
    resolved: null
  };
  item.conflicts ||= [];
  item.conflicts.push(draft);
  db.tickets[ticketId] = { kind: "conflict", at: draft.at, itemId: item.id || item.code, result: { error: "conflict", draft } };
  await saveDb(db);
  return draft;
}

// 未定级结论失效重算：胶料比例 / 存放位置 / 试磨纸张一变即触发
function invalidatePending(item, reason, ticketId) {
  const now = new Date().toISOString();
  const changed = [];
  for (const c of item.conclusions) {
    if (c.state !== "未定级") continue;
    const stale =
      (reason.glueRatio !== undefined && c.glueRatio !== reason.glueRatio) ||
      (reason.storage !== undefined && c.storage !== reason.storage) ||
      (reason.paper !== undefined && c.paper !== reason.paper);
    if (!stale) continue;
    const oldId = c.id;
    c.state = "失效";
    c.invalidAt = now;
    const next = {
      ...c,
      id: newConclusionId(),
      state: "未定级",
      paper: reason.paper !== undefined ? reason.paper : c.paper,
      glueRatio: reason.glueRatio !== undefined ? reason.glueRatio : c.glueRatio,
      storage: reason.storage !== undefined ? reason.storage : c.storage,
      createdAt: now,
      decidedAt: null,
      invalidAt: null,
      recalculatedFrom: oldId
    };
    const batch = item.batches.find(b => b.id === c.batchId);
    if (batch) { batch.conclusionId = next.id; batch.state = "未定级"; }
    item.conclusions.push(next);
    const why = [];
    if (reason.glueRatio !== undefined) why.push("胶料比例");
    if (reason.storage !== undefined) why.push("存放位置");
    if (reason.paper !== undefined) why.push("试磨纸张");
    item.logs.push({
      at: now, step: "重算", ticketId, batchId: c.batchId, conclusionId: next.id,
      note: "未定级结论失效重算：" + oldId + " 已失效，新结论 " + next.id + " 按更新后的" + why.join("、") + "重算，评分仍 " + next.score
    });
    changed.push({ oldId, newId: next.id });
  }
  return changed;
}

// 试磨提交 → 批次 + 未定级结论（不触碰 db，便于复用）
function buildAction(item, input, ticketId) {
  const score = Number(input.score || 0);
  const now = new Date().toISOString();
  const batch = {
    id: newBatchId(),
    no: item.batches.length + 1,
    ticketId,
    paper: input.paper || "—",
    glueRatio: item.glueRatio,
    storage: item.storage,
    state: "未定级",
    initial: false,
    createdAt: now,
    conclusionId: null
  };
  const test = {
    at: now,
    batchId: batch.id,
    ticketId,
    paper: input.paper || "—",
    water: input.water || "",
    speed: input.speed || "",
    colorLayer: input.colorLayer || "",
    sediment: input.sediment || "",
    score
  };
  const conclusion = {
    id: newConclusionId(),
    batchId: batch.id,
    ticketId,
    score,
    grade: gradeFor(score),
    state: "未定级",
    paper: batch.paper,
    glueRatio: batch.glueRatio,
    storage: batch.storage,
    createdAt: now,
    decidedAt: null,
    invalidAt: null,
    recalculatedFrom: null
  };
  batch.conclusionId = conclusion.id;
  item.batches.push(batch);
  item.tests.push(test);
  item.conclusions.push(conclusion);
  item.status = statusFor(score);
  item.logs.push(
    { at: now, step: "试磨", ticketId, batchId: batch.id, note: (input.paper || "试纸") + "，评分" + score, score },
    { at: now, step: "定级", ticketId, batchId: batch.id, conclusionId: conclusion.id, note: "未定级结论 " + conclusion.id + "（" + gradeFor(score) + "），待最终定级" }
  );
  return { batch, conclusion, test };
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
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:110px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .chain { border-top:1px dashed var(--line); padding-top:8px; display:grid; gap:4px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>墨锭试磨室</h1><div class="meta">墨锭档案 · 试磨批次 · 定级结论 可恢复处置链</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增墨锭</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存墨锭</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>创建试磨记录</h2><label>选择墨锭</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>先到者成立，后到留冲突草稿；胶料/存放/纸张变更会让未定级结论失效重算；写盘失败凭原现场单号续办。</h2><div class="grid" id="cards"></div></div>
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
    let items = [];
    function newTicketId(){ return 'P-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8); }
    let ticketId = newTicketId();

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      let data = {};
      try { data = await res.json(); } catch {}
      if (!res.ok) { const e = new Error(data.error || '请求失败'); e.status = res.status; e.data = data; throw e; }
      return data;
    }
    // 写盘失败 / 网络波动：凭同一现场单号重试，服务端幂等不重复追加
    async function request(method, path, body) {
      let last;
      for (let i = 0; i < 4; i++) {
        try { return await api(path, { method, body: body ? JSON.stringify(body) : undefined }); }
        catch (e) {
          last = e;
          if (e.status === 409) throw e;                 // 冲突是确定性的，不重试
          if (e.status && e.status < 500) throw e;        // 客户端错误不重试
          await new Promise(r => setTimeout(r, 400 * (i + 1)));
        }
      }
      throw last;
    }

    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function verOf(ref) { const it = items.find(i => (i.id||i.code) === ref); return it ? (it.version||0) : 0; }
    function refOf(btn) { return btn.closest('article').querySelector('[data-status]').dataset.status; }

    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.smokeSource || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(cardHtml).join('');
      bindCard();
    }

    function cardHtml(item) {
      const main = fields.map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const conclOf = b => (item.conclusions||[]).find(c => c.id === b.conclusionId);
      const batches = (item.batches||[]).map(b => {
        const c = conclOf(b);
        const grade = c ? c.grade : '—';
        const cstate = c ? c.state : '—';
        const fin = (c && c.state === '未定级') ? ' <button data-finalize="'+b.id+'">定级</button>' : '';
        return '<div class="meta">批次 '+b.no+' · '+(b.paper||'—')+' · 评分 '+(c?c.score:'—')+' · 结论 '+grade+'（'+cstate+'）'+fin+'</div>';
      }).join('');
      const conflicts = (item.conflicts||[]).filter(c => !c.resolved).map(c => {
        const sc = c.input.score ?? '';
        return '<div class="meta warn">冲突草稿 '+c.ticketId+'：'+(c.input.paper||'')+' 评分'+sc+' <button data-apply="'+c.ticketId+'">应用</button> <button data-discard="'+c.ticketId+'" class="secondary">丢弃</button></div>';
      }).join('');
      const logs = (item.logs||[]).slice(-5).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+(item.code||item.id)+'</h3><span class="pill">'+item.status+'</span> <span class="meta">v'+(item.version||0)+' · 批次'+(item.batchCount||(item.batches||[]).length)+' · 结论'+(item.conclusionCount||(item.conclusions||[]).length)+'</span>'
        + main
        + '<div class="chain">'+(batches || '<div class="meta">暂无试磨批次</div>')+'</div>'
        + conflicts
        + '<label>状态</label><select data-status="'+(item.id||item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select>'
        + '<button class="secondary" data-note="'+(item.id||item.code)+'">追加备注</button> <button class="secondary" data-scores="'+(item.id||item.code)+'">历史评分</button>'
        + '<div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }

    function bindCard() {
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => {
        const ref = sel.dataset.status;
        try { await request('PATCH','/api/items/'+ref, { status: sel.value, ticketId:newTicketId(), baseVersion:verOf(ref) }); await load(); }
        catch(e){ if(e.status===409){ alert('与他人同时修改同一墨锭，先到者成立；本次内容已留冲突草稿。'); await load(); } else throw e; }
      });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => {
        const note = prompt('记录备注');
        if(!note) return;
        const ref = btn.dataset.note;
        try { await request('POST','/api/items/'+ref+'/logs', { step:'备注', note, ticketId:newTicketId(), baseVersion:verOf(ref) }); await load(); }
        catch(e){ if(e.status===409){ alert('与他人同时提交，内容已留冲突草稿。'); await load(); } else throw e; }
      });
      document.querySelectorAll('[data-finalize]').forEach(btn => btn.onclick = async () => {
        const ref = refOf(btn);
        try { await request('POST','/api/items/'+ref+'/batches/'+btn.dataset.finalize+'/finalize', { ticketId:newTicketId(), baseVersion:verOf(ref) }); await load(); }
        catch(e){ if(e.status===409){ alert('与他人同时操作，已留冲突草稿。'); await load(); } else throw e; }
      });
      document.querySelectorAll('[data-apply]').forEach(btn => btn.onclick = async () => {
        const ref = refOf(btn);
        try { await request('POST','/api/items/'+ref+'/conflicts/'+btn.dataset.apply+'/resolve', { action:'apply', ticketId:newTicketId() }); await load(); }
        catch(e){ if(e.status===409){ alert('与他人同时操作，已留冲突草稿。'); await load(); } else throw e; }
      });
      document.querySelectorAll('[data-discard]').forEach(btn => btn.onclick = async () => {
        const ref = refOf(btn);
        try { await request('POST','/api/items/'+ref+'/conflicts/'+btn.dataset.discard+'/resolve', { action:'discard', ticketId:newTicketId() }); await load(); }
        catch(e){ if(e.status===409){ alert('与他人同时操作，已留冲突草稿。'); await load(); } else throw e; }
      });
      document.querySelectorAll('[data-scores]').forEach(btn => btn.onclick = async () => {
        const ref = btn.dataset.scores;
        try {
          const data = await api('/api/items/'+ref+'/scores');
          const text = (data.scores||[]).map(s => '批次结论 '+s.grade+' 评分'+s.score+'（'+s.state+'）'+(s.paper!=='—'?' · '+s.paper:'')).join('\\n');
          alert((data.item||ref)+' 历史评分：\\n'+(text||'暂无'));
        } catch(e){ alert('查询失败：'+e.message); }
      });
    }

    async function load() { items = await api('/api/items'); render(); }
    createForm.onsubmit = async event => {
      event.preventDefault();
      try { await request('POST','/api/items', Object.fromEntries(new FormData(createForm).entries())); createForm.reset(); await load(); }
      catch(e){ alert('保存失败：'+e.message); }
    };
    actionForm.onsubmit = async event => {
      event.preventDefault();
      const ref = itemSelect.value;
      const body = Object.fromEntries(new FormData(actionForm).entries());
      body.ticketId = ticketId;
      body.baseVersion = verOf(ref);
      try {
        await request('POST','/api/items/'+ref+'/action', body);
        ticketId = newTicketId();
        actionForm.reset();
        await load();
      } catch(err) {
        if (err.status === 409) { ticketId = newTicketId(); await load(); alert('两人同时提交同一墨锭，先到者成立；本次内容已按现场单号 '+body.ticketId+' 留作冲突草稿，可在下方应用或丢弃。'); }
        else { alert('提交失败，可凭原现场单号 '+body.ticketId+' 重试：'+err.message); }
      }
    };
    document.querySelector('#statusFilter').onchange = render;
    document.querySelector('#search').oninput = render;
    document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    const isWrite = req.method === "POST" || req.method === "PATCH";
    const handle = async () => {
      const db = await loadDb();
      if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
      if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));

    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const item = { id: newItemId(), ...input, version: 0, schemaVersion: 1, logs: [], tests: [], batches: [], conclusions: [], conflicts: [] };
      item.logs.push({ at: new Date().toISOString(), step: "建档", note: "创建墨锭" });
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, summarize(item));
    }

    // 历史评分查询（含补初始批次时带入的历史结论）
    const scores = url.pathname.match(/^\/api\/items\/([^/]+)\/scores$/);
    if (scores && req.method === "GET") {
      const item = findItem(db, scores[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      return send(res, 200, {
        item: item.code || item.id,
        scores: (item.conclusions || []).map(c => ({
          conclusionId: c.id, batchId: c.batchId, score: c.score, grade: c.grade, state: c.state,
          paper: c.paper, glueRatio: c.glueRatio, storage: c.storage,
          at: c.createdAt, decidedAt: c.decidedAt, invalidAt: c.invalidAt, recalculatedFrom: c.recalculatedFrom, historical: !!c.historical
        }))
      });
    }

    // 冲突草稿列表
    const conflicts = url.pathname.match(/^\/api\/items\/([^/]+)\/conflicts$/);
    if (conflicts && req.method === "GET") {
      const item = findItem(db, conflicts[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      return send(res, 200, { item: item.code || item.id, conflicts: item.conflicts || [] });
    }

    // 冲突草稿处置：apply（按当前状态成立）/ discard（丢弃留痕）
    const resolve = url.pathname.match(/^\/api\/items\/([^/]+)\/conflicts\/([^/]+)\/resolve$/);
    if (resolve && req.method === "POST") {
      const item = findItem(db, resolve[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const draft = (item.conflicts || []).find(c => c.ticketId === resolve[2]);
      if (!draft) return send(res, 404, { error: "conflict_not_found" });
      const input = await body(req);
      if (draft.resolved) return send(res, 200, summarize(item));
      const now = new Date().toISOString();
      if (input.action === "discard") {
        const ticketId = input.ticketId || newTicketId();
        draft.resolved = { at: now, action: "discard", byTicket: ticketId };
        item.logs.push({ at: now, step: "冲突", ticketId, note: "冲突草稿 " + draft.ticketId + " 已丢弃" });
      } else {
        const ticketId = input.ticketId || newTicketId();
        const { batch, conclusion } = buildAction(item, draft.input, ticketId);
        draft.resolved = { at: now, action: "apply", byTicket: ticketId, batchId: batch.id, conclusionId: conclusion.id };
        item.logs.push({ at: now, step: "冲突", ticketId, note: "冲突草稿 " + draft.ticketId + " 已按当前状态应用" });
        db.tickets[ticketId] = { kind: "action", at: now, itemId: item.id || item.code, result: summarize(item) };
      }
      item.version += 1;
      await saveDb(db);
      return send(res, 200, summarize(item));
    }

    // 定级：未定级结论 → 已定级
    const finalize = url.pathname.match(/^\/api\/items\/([^/]+)\/batches\/([^/]+)\/finalize$/);
    if (finalize && req.method === "POST") {
      const item = findItem(db, finalize[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const batch = (item.batches || []).find(b => b.id === finalize[2]);
      if (!batch) return send(res, 404, { error: "batch_not_found" });
      const input = await body(req);
      const ticketId = input.ticketId || newTicketId();
      if (db.tickets[ticketId]) return send(res, 200, db.tickets[ticketId].result);
      if (input.baseVersion !== undefined && input.baseVersion !== item.version) {
        const draft = await storeConflict(db, item, input, ticketId, input.baseVersion);
        return send(res, 409, { error: "conflict", draft });
      }
      const now = new Date().toISOString();
      const conclusion = (item.conclusions || []).find(c => c.id === batch.conclusionId);
      if (conclusion && conclusion.state === "未定级") {
        conclusion.state = "已定级";
        conclusion.decidedAt = now;
        batch.state = "已定级";
        item.logs.push({ at: now, step: "定级", ticketId, batchId: batch.id, conclusionId: conclusion.id, note: "结论 " + conclusion.id + " 已定级：" + conclusion.grade + "（评分 " + conclusion.score + "）" });
      }
      item.version += 1;
      db.tickets[ticketId] = { kind: "finalize", at: now, itemId: item.id || item.code, result: summarize(item) };
      await saveDb(db);
      return send(res, 200, summarize(item));
    }

    // 批次变更（试磨纸张）→ 未定级结论失效重算
    const batchPatch = url.pathname.match(/^\/api\/items\/([^/]+)\/batches\/([^/]+)$/);
    if (batchPatch && req.method === "PATCH") {
      const item = findItem(db, batchPatch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const batch = (item.batches || []).find(b => b.id === batchPatch[2]);
      if (!batch) return send(res, 404, { error: "batch_not_found" });
      const input = await body(req);
      const ticketId = input.ticketId || newTicketId();
      if (db.tickets[ticketId]) return send(res, 200, db.tickets[ticketId].result);
      if (input.baseVersion !== undefined && input.baseVersion !== item.version) {
        const draft = await storeConflict(db, item, input, ticketId, input.baseVersion);
        return send(res, 409, { error: "conflict", draft });
      }
      const reason = {};
      if (input.paper !== undefined && input.paper !== batch.paper) { reason.paper = input.paper; batch.paper = input.paper; }
      const invalidated = Object.keys(reason).length ? invalidatePending(item, reason, ticketId) : [];
      item.logs.push({ at: new Date().toISOString(), step: "试磨", ticketId, batchId: batch.id, note: "批次 " + batch.no + " 试磨纸张调整为 " + batch.paper + (invalidated.length ? "，未定级结论已失效重算" : "") });
      item.version += 1;
      db.tickets[ticketId] = { kind: "batch_patch", at: new Date().toISOString(), itemId: item.id || item.code, result: summarize(item) };
      await saveDb(db);
      return send(res, 200, { ...summarize(item), invalidated });
    }

    // 追加日志/备注
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = findItem(db, log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      const ticketId = input.ticketId || newTicketId();
      if (db.tickets[ticketId]) return send(res, 200, db.tickets[ticketId].result);
      if (input.baseVersion !== undefined && input.baseVersion !== item.version) {
        const draft = await storeConflict(db, item, input, ticketId, input.baseVersion);
        return send(res, 409, { error: "conflict", draft });
      }
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "", ticketId });
      item.version += 1;
      db.tickets[ticketId] = { kind: "log", at: new Date().toISOString(), itemId: item.id || item.code, result: summarize(item) };
      await saveDb(db);
      return send(res, 201, summarize(item));
    }

    // 试磨提交（先到者成立，后到留冲突草稿；幂等续办）
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = findItem(db, action[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      const ticketId = input.ticketId || newTicketId();
      if (db.tickets[ticketId]) return send(res, 200, db.tickets[ticketId].result);
      if (input.baseVersion !== undefined && input.baseVersion !== item.version) {
        const draft = await storeConflict(db, item, input, ticketId, input.baseVersion);
        return send(res, 409, { error: "conflict", draft });
      }
      const { batch, conclusion } = buildAction(item, input, ticketId);
      item.version += 1;
      db.tickets[ticketId] = { kind: "action", at: new Date().toISOString(), itemId: item.id || item.code, result: summarize(item) };
      await saveDb(db);
      return send(res, 201, { ...summarize(item), batch, conclusion });
    }

    // 墨锭档案变更（胶料比例 / 存放位置 → 未定级结论失效重算）
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = findItem(db, patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      const ticketId = input.ticketId || newTicketId();
      if (db.tickets[ticketId]) return send(res, 200, db.tickets[ticketId].result);
      if (input.baseVersion !== undefined && input.baseVersion !== item.version) {
        const draft = await storeConflict(db, item, input, ticketId, input.baseVersion);
        return send(res, 409, { error: "conflict", draft });
      }
      const before = { glueRatio: item.glueRatio, storage: item.storage };
      const allowed = ["smokeSource", "glueRatio", "ageYears", "storage", "status"];
      for (const k of allowed) if (input[k] !== undefined) item[k] = input[k];
      const reason = {};
      if (input.glueRatio !== undefined && input.glueRatio !== before.glueRatio) reason.glueRatio = input.glueRatio;
      if (input.storage !== undefined && input.storage !== before.storage) reason.storage = input.storage;
      const invalidated = Object.keys(reason).length ? invalidatePending(item, reason, ticketId) : [];
      item.logs.push({ at: new Date().toISOString(), step: "状态", ticketId, note: "更新为" + item.status + (invalidated.length ? "；未定级结论已失效重算" : "") });
      item.version += 1;
      db.tickets[ticketId] = { kind: "patch", at: new Date().toISOString(), itemId: item.id || item.code, result: summarize(item) };
      await saveDb(db);
      return send(res, 200, { ...summarize(item), invalidated });
    }

      send(res, 404, { error: "not_found" });
    };
    if (isWrite) return await withWriteLock(handle);
    return await handle();
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});

function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) if (stats[item.status] !== undefined) stats[item.status] += 1;
  return stats;
}

server.listen(port, () => console.log("墨锭试磨室 listening on http://localhost:" + port));
