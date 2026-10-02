import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "server.js");
const port = 4637 + Math.floor(Math.random() * 200);
const base = `http://localhost:${port}`;
let dir;
let child;

async function api(path, options = {}) {
  const res = await fetch(base + path, options.body
    ? { ...options, headers: { "Content-Type": "application/json" } }
    : options);
  const data = await res.json();
  return { status: res.status, data };
}
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });
const patch = (path, body) => api(path, { method: "PATCH", body: JSON.stringify(body) });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ink-test-"));
  // 旧格式数据：无批次号、无版本、IS-OLD-2 的评分只在 logs 里
  const legacy = {
    items: [
      { code: "IS-OLD-1", smokeSource: "黄山松烟", glueRatio: "7.5%", ageYears: 8, storage: "恒湿柜B", status: "已试磨",
        logs: [{ at: "2026-06-11", step: "试磨", note: "宣纸20滴水，评分86", score: 86 }] },
      { code: "IS-OLD-2", smokeSource: "桐油烟", glueRatio: "8%", ageYears: 3, storage: "试样盒C", status: "重点观察",
        logs: [{ at: "2026-06-21T03:50:28.907Z", step: "试磨", note: "棉连纸，评分79", score: 79 }],
        tests: [{ at: "2026-06-21T03:50:28.907Z", paper: "棉连纸", water: "18滴", speed: "中", colorLayer: "偏暖", sediment: "少", score: 79 }] }
    ]
  };
  await writeFile(join(dir, "db.json"), JSON.stringify(legacy, null, 2));
  child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(port), DATA_FILE: join(dir, "db.json") },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", d => { if (String(d).includes("listening")) resolve(); });
    child.on("exit", code => reject(new Error("server exited " + code)));
    setTimeout(() => reject(new Error("server start timeout")), 10000);
  });
});

after(async () => {
  child?.kill();
  await rm(dir, { recursive: true, force: true });
});

test("旧记录缺少批次号时升级补初始批次，历史评分仍可查", async () => {
  const { status, data } = await api("/api/items");
  assert.equal(status, 200);
  const old1 = data.find(i => i.code === "IS-OLD-1");
  const old2 = data.find(i => i.code === "IS-OLD-2");
  assert.equal(old1.batches.length, 1);
  assert.equal(old1.batches[0].batchNo, "IS-OLD-1-B00");
  // 评分只在 logs 里的旧记录也补进了初始批次
  assert.equal(old1.batches[0].tests[0].score, 86);
  assert.equal(old1.batches[0].conclusions[0].state, "未定级");
  assert.equal(old1.batches[0].conclusions[0].grade, "乙等");
  // tests 数组里的历史评分完整迁入
  assert.equal(old2.batches[0].tests[0].score, 79);
  assert.equal(old2.batches[0].tests[0].paper, "棉连纸");
  assert.equal(old2.paper, "棉连纸");
  assert.equal(old2.tests, undefined);
  // 迁移是幂等的：再次读取不会重复补批次
  const again = await api("/api/items");
  assert.equal(again.data.find(i => i.code === "IS-OLD-1").batches.length, 1);
});

test("两人同时提交同一墨锭：先到者成立，后到者按现场单号留冲突草稿", async () => {
  const { data: items } = await api("/api/items");
  const target = items.find(i => i.code === "IS-OLD-1");
  const baseVersion = target.version;
  const [a, b] = await Promise.all([
    post(`/api/items/${target.code}/action`, { ticketNo: "XD-A", baseVersion, paper: "宣纸", water: "20滴", score: 88 }),
    post(`/api/items/${target.code}/action`, { ticketNo: "XD-B", baseVersion, paper: "毛边纸", water: "22滴", score: 91 })
  ]);
  const results = [a, b];
  const winner = results.find(r => r.status === 201);
  const loser = results.find(r => r.status === 409);
  assert.ok(winner, "应有一方成立");
  assert.ok(loser, "应有一方冲突");
  assert.equal(loser.data.error, "version_conflict");
  // 先到者开了一个新批次，后到者内容完整留在冲突草稿里
  const { data: after1 } = await api(`/api/items/${target.code}`);
  assert.equal(after1.batches.length, 2);
  assert.equal(after1.conflicts.length, 1);
  const draft = after1.conflicts[0];
  assert.equal(draft.ticketNo, loser.data.ticketNo);
  assert.equal(draft.payload.score, loser.data.ticketNo === "XD-A" ? 88 : 91);
  assert.equal(after1.tickets["XD-A"].result + after1.tickets["XD-B"].result, "committedconflict");
});

test("写盘失败后可凭原现场单号续办：重放不重复追加试磨、日志和状态", async () => {
  const before1 = (await api("/api/items/IS-OLD-1")).data;
  const logCount = before1.logs.length;
  const ticketNo = before1.conflicts[0].ticketNo; // 冲突单号重放
  const replayConflict = await post("/api/items/IS-OLD-1/action", { ticketNo, baseVersion: 0, paper: "毛边纸", score: 91 });
  assert.equal(replayConflict.status, 409);
  assert.equal(replayConflict.data.replayed, true);
  const committedTicket = Object.keys(before1.tickets).find(t => before1.tickets[t].result === "committed");
  const replayWin = await post("/api/items/IS-OLD-1/action", { ticketNo: committedTicket, baseVersion: 0, paper: "宣纸", score: 88 });
  assert.equal(replayWin.status, 200);
  assert.equal(replayWin.data.replayed, true);
  const after1 = (await api("/api/items/IS-OLD-1")).data;
  assert.equal(after1.batches.length, before1.batches.length, "批次不重复");
  assert.equal(after1.conflicts.length, before1.conflicts.length, "冲突草稿不重复");
  assert.equal(after1.logs.length, logCount, "日志不重复");
  assert.equal(after1.version, before1.version, "版本不前进");
  // 凭单号可查办理结果
  const lookup = await api(`/api/items/IS-OLD-1/tickets/${committedTicket}`);
  assert.equal(lookup.status, 200);
  assert.equal(lookup.data.result, "committed");
  assert.ok(lookup.data.batchNo);
});

test("胶料比例、存放位置或试磨纸张一变，未定级结论立即失效重算", async () => {
  // 当前 IS-OLD-1 最新结论是新批次的未定级结论
  let item = (await api("/api/items/IS-OLD-1")).data;
  const pendingId = item.activeConclusion.id;
  assert.equal(item.activeConclusion.state, "未定级");
  // 改胶料比例
  let r = await patch("/api/items/IS-OLD-1", { glueRatio: "9%" });
  assert.equal(r.status, 200);
  item = r.data;
  const batch = item.batches[item.batches.length - 1];
  const invalidated = batch.conclusions.find(c => c.id === pendingId);
  assert.equal(invalidated.state, "已失效");
  assert.match(invalidated.invalidReason, /胶料比例变更/);
  assert.equal(item.activeConclusion.state, "未定级");
  assert.match(item.activeConclusion.note, /重算/);
  assert.equal(item.activeConclusion.conditions.glueRatio, "9%");
  // 改存放位置
  r = await patch("/api/items/IS-OLD-1", { storage: "恒湿柜C" });
  assert.match(r.data.batches.at(-1).conclusions.at(-2).invalidReason, /存放位置变更/);
  // 改试磨纸张
  r = await patch("/api/items/IS-OLD-1", { paper: "连史纸" });
  assert.match(r.data.batches.at(-1).conclusions.at(-2).invalidReason, /试磨纸张变更/);
  assert.ok(r.data.logs.some(l => l.step === "失效重算"));
  // 已定级结论不受条件变化影响
  const graded = await post("/api/items/IS-OLD-1/grade", { note: "复核通过" });
  assert.equal(graded.status, 200);
  assert.equal(graded.data.conclusion.state, "已定级");
  r = await patch("/api/items/IS-OLD-1", { glueRatio: "10%" });
  assert.equal(r.data.activeConclusion.state, "已定级");
  assert.equal(r.data.activeConclusion.invalidReason, null);
  // 重复定级返回 409，不重复记日志
  const again = await post("/api/items/IS-OLD-1/grade", {});
  assert.equal(again.status, 409);
  assert.equal(again.data.error, "already_graded");
});

test("新批次试磨纸张变化让旧的未定级结论失效，状态随评分推导", async () => {
  // IS-OLD-2 迁移后是未定级（79分，棉连纸）
  let item = (await api("/api/items/IS-OLD-2")).data;
  assert.equal(item.activeConclusion.state, "未定级");
  assert.equal(item.status, "重点观察");
  const r = await post("/api/items/IS-OLD-2/action", { ticketNo: "XD-P1", baseVersion: item.version, paper: "宣纸", water: "20滴", score: 92 });
  assert.equal(r.status, 201);
  item = r.data.item;
  assert.equal(item.status, "已试磨");
  assert.equal(item.paper, "宣纸");
  const oldBatch = item.batches[0];
  assert.equal(oldBatch.conclusions.at(-1).state, "已失效");
  assert.match(oldBatch.conclusions.at(-1).invalidReason, /试磨纸张变更/);
  assert.equal(item.activeConclusion.grade, "甲等");
  // 历史评分仍可查
  assert.equal(item.batches[0].tests[0].score, 79);
});

test("档案编号唯一，统计接口正常", async () => {
  const dup = await post("/api/items", { code: "IS-OLD-1", smokeSource: "重复" });
  assert.equal(dup.status, 409);
  const created = await post("/api/items", { code: "IS-NEW-1", smokeSource: "漆烟", glueRatio: "7%", ageYears: 1, storage: "试样盒A" });
  assert.equal(created.status, 201);
  assert.equal(created.data.batches.length, 0);
  assert.equal(created.data.status, "待试磨");
  const stats = await api("/api/stats");
  assert.equal(stats.status, 200);
  assert.ok(stats.data["已试磨"] >= 1);
});
