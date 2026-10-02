# 墨锭试磨室

墨锭档案、试磨批次和定级结论接成一条可恢复处置链，多人同时补录不会互相覆盖。

运行：

```bash
npm start
```

访问`http://localhost:3037`。数据保存在`data/ink-stick-testing.json`（可用环境变量`DATA_FILE`覆盖，`PORT`改端口）。

测试：

```bash
npm test
```

## 处置链模型

- **档案（item）**：墨锭基础信息，带`version`（乐观锁）和`paper`（当前试磨纸张）。
- **试磨批次（batches[]）**：每次成立的试磨提交追加一个批次，快照当时的条件三要素（胶料比例、存放位置、试磨纸张）和试磨记录。
- **定级结论（conclusions[]）**：挂在批次上，状态为`未定级 → 已定级`，或`已失效`；全部历史结论保留可查。墨锭状态（待试磨/已试磨/重点观察）由最新结论评分推导。

## 并发与恢复规则

- **先到者成立**：提交试磨时带`ticketNo`（现场单号）和`baseVersion`。两人同时提交同一墨锭，先处理者开新批次；后到者返回 409，内容按现场单号存入`conflicts[]`冲突草稿，不覆盖先到者。
- **凭单号续办**：写盘失败或超时后，用原现场单号重新提交即可——已记录的结果直接返回（`replayed: true`），试磨、日志和状态不重复追加。`GET /api/items/:id/tickets/:ticketNo`可查询单号办理结果。
- **失效重算**：胶料比例、存放位置或试磨纸张任一变化（PATCH 档案或新批次换纸），最新批次的`未定级`结论立即标记`已失效`并按新条件重算一条；`已定级`结论不受影响。
- **升级迁移**：旧记录缺少批次号时，启动/读取时自动补`初始批次`（B00），历史评分（含只记在日志里的）迁入批次，仍可查询。
- 所有变更经串行写队列 + 临时文件原子 rename 落盘，杜绝并发整库覆盖。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/items` / `/api/items/:id` | 列表 / 单条（含批次、结论、冲突草稿、票账本） |
| POST | `/api/items` | 建档（编号重复返回 409） |
| PATCH | `/api/items/:id` | 更新档案字段；条件三要素变化触发失效重算 |
| POST | `/api/items/:id/action` | 提交试磨：`{ticketNo, baseVersion, paper, water, speed, colorLayer, sediment, score}` |
| POST | `/api/items/:id/grade` | 定级：`{batchNo?, grade?, note?}`，默认最新批次 |
| POST | `/api/items/:id/logs` | 追加备注 |
| GET | `/api/items/:id/tickets/:ticketNo` | 凭现场单号查询办理结果 |
| GET | `/api/stats` | 状态统计 |
