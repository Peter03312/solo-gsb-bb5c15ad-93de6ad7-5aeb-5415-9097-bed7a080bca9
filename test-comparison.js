'use strict';

// 报告间比较功能端到端自测：启动真实 HTTP 服务，走 上传→定标→轮廓→发布→比较 全流程。
// 运行：node test-comparison.js（自动使用临时 DATA_DIR 与空闲端口）

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { spawn } = require('child_process');

// ---------- 生成最小合法 PNG（W×H，8-bit 灰度） ----------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function makePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 0;   // grayscale
  const row = Buffer.alloc(w + 1, 128);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- 启动服务 ----------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phyto-cmp-'));
const PORT = 8931;
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, [path.join(__dirname, 'server', 'index.js')], {
  env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CC: '/usr/bin/gcc', CXX: '/usr/bin/g++' },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

async function waitReady(deadline = Date.now() + 15000) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/reports`);
      if (res.ok) return;
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('服务启动超时');
}

async function api(method, urlPath, body, isForm) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (isForm) opts.body = body;
    else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(`${BASE}${urlPath}`, opts);
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, json, text: json ? null : await res.text() };
}

async function uploadDraft() {
  const fd = new FormData();
  fd.append('image', new Blob([makePng(100, 100)], { type: 'image/png' }), 'slide.png');
  const r = await api('POST', '/api/images', fd, true);
  assert.strictEqual(r.status, 201, `上传失败: ${JSON.stringify(r.json)}`);
  return r.json;
}

const rect = (x1, y1, x2, y2) => [
  { x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }
];

async function makePublishedReport(cells, scale, version0) {
  const img = await uploadDraft();
  let r = await api('PUT', `/api/images/${img.id}/calibration`, {
    version: img.version,
    p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, distanceUm: scale * 10
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  r = await api('PUT', `/api/images/${img.id}/contours`, {
    version: r.json.version,
    cells: cells.map((c, i) => ({
      id: c.id, name: c.name, outer: rect(...c.box), holes: []
    }))
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  r = await api('POST', `/api/images/${img.id}/publish`, { version: r.json.version });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.report;
}

async function cleanup() {
  server.kill();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

(async () => {
  await waitReady();
  try {
    // 两份报告：细胞 A(0,0,10,10,面积100px²)、B(0,0,20,20,面积400px²)
    // 基线 scale=1：A=100μm²,40μm；B=400μm²,80μm
    // 复测 scale=1：同名细胞 A(0,0,20,20,面积400)、B(0,0,10,10,面积100)
    //               另有一个零面积无法构造（几何限制），故零基线变化率用单元层测试覆盖
    const baseline = await makePublishedReport([
      { id: 'base-a', name: 'A', box: [1, 1, 11, 11] },
      { id: 'base-b', name: 'B', box: [1, 1, 21, 21] }
    ], 1);
    const retest = await makePublishedReport([
      { id: 'ret-a', name: 'A', box: [1, 1, 21, 21] },
      { id: 'ret-b', name: 'B', box: [1, 1, 11, 11] },
      { id: 'ret-c', name: 'C', box: [30, 30, 39, 39] }
    ], 1);

    // 1. 报告不存在：整次保存不生效
    let r = await api('POST', '/api/comparisons', {
      baselineReportId: 'nope', retestReportId: retest.id, pairs: []
    });
    assert.strictEqual(r.status, 400, '基线不存在应 400');
    assert.match(r.json.error, /基线报告不存在/);

    // 2. 两侧相同：拒绝
    r = await api('POST', '/api/comparisons', {
      baselineReportId: baseline.id, retestReportId: baseline.id, pairs: []
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /不同的报告/);

    // 3. 细胞不存在：拒绝
    r = await api('POST', '/api/comparisons', {
      baselineReportId: baseline.id, retestReportId: retest.id,
      pairs: [{ baseCellId: 'ghost', retestCellId: 'ret-a' }]
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /基线报告中不存在细胞/);
    r = await api('POST', '/api/comparisons', {
      baselineReportId: baseline.id, retestReportId: retest.id,
      pairs: [{ baseCellId: 'base-a', retestCellId: 'ghost' }]
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /复测报告中不存在细胞/);

    // 4. 配对重复（同一细胞配对两次）：拒绝
    r = await api('POST', '/api/comparisons', {
      baselineReportId: baseline.id, retestReportId: retest.id,
      pairs: [
        { baseCellId: 'base-a', retestCellId: 'ret-a' },
        { baseCellId: 'base-a', retestCellId: 'ret-b' }
      ]
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /配对重复/);
    r = await api('POST', '/api/comparisons', {
      baselineReportId: baseline.id, retestReportId: retest.id,
      pairs: [
        { baseCellId: 'base-a', retestCellId: 'ret-a' },
        { baseCellId: 'base-b', retestCellId: 'ret-a' }
      ]
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /配对重复/);

    // 此前所有失败保存均不生效
    r = await api('GET', '/api/comparisons');
    assert.strictEqual(r.json.length, 0, '失败保存不应产生任何记录');

    // 5. 正常保存：手动配对 A→B、B→A（刻意交叉，同名不自动配对）；C 未配对
    r = await api('POST', '/api/comparisons', {
      title: '首轮比较',
      baselineReportId: baseline.id, retestReportId: retest.id,
      pairs: [
        { baseCellId: 'base-a', retestCellId: 'ret-b' },
        { baseCellId: 'base-b', retestCellId: 'ret-a' }
      ]
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    const created = r.json;
    assert.strictEqual(created.title, '首轮比较');
    assert.strictEqual(created.version, 1);
    assert.strictEqual(created.paired.length, 2);
    assert.strictEqual(created.unpairedBaseline.length, 0);
    assert.strictEqual(created.unpairedRetest.length, 1);
    assert.strictEqual(created.unpairedRetest[0].cellId, 'ret-c');

    const p1 = created.paired[0];
    assert.strictEqual(p1.baseName, 'A');
    assert.strictEqual(p1.retestName, 'B');
    assert.strictEqual(p1.baseAreaUm2, 100);
    assert.strictEqual(p1.retestAreaUm2, 100);
    assert.strictEqual(p1.areaDelta, 0);
    assert.strictEqual(p1.areaRate, 0);
    assert.strictEqual(p1.basePerimeterUm, 40);
    assert.strictEqual(p1.retestPerimeterUm, 40);
    assert.strictEqual(p1.perimeterDelta, 0);

    const p2 = created.paired[1];
    // 基线 B=400, 复测 A=400 -> 差值 0；面积率 0
    assert.strictEqual(p2.baseAreaUm2, 400);
    assert.strictEqual(p2.retestAreaUm2, 400);
    assert.strictEqual(p2.areaRate, 0);
    console.log('ok 1 手动交叉配对与未配对细胞');

    // 6. 差值/变化率符号：新配 A→A，100 → 400：+300，+300%；周长 40→80：+40，+100%
    const cid = created.id;
    r = await api('PUT', `/api/comparisons/${cid}`, {
      version: 1,
      pairs: [{ baseCellId: 'base-a', retestCellId: 'ret-a' }]
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.version, 2);
    const q = r.json.paired[0];
    assert.strictEqual(q.areaDelta, 300);
    assert.strictEqual(q.areaRate, 300);
    assert.strictEqual(q.perimeterDelta, 40);
    assert.strictEqual(q.perimeterRate, 100);
    assert.strictEqual(r.json.unpairedBaseline.length, 1);
    assert.strictEqual(r.json.unpairedBaseline[0].cellId, 'base-b');
    assert.strictEqual(r.json.unpairedRetest.length, 2);
    console.log('ok 2 带符号差值与相对基线变化率');

    // 7. 乐观并发：过期版本被拒绝且返回当前版本，记录不变
    r = await api('PUT', `/api/comparisons/${cid}`, {
      version: 1, pairs: []
    });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.currentVersion, 2);
    r = await api('GET', `/api/comparisons/${cid}`);
    assert.strictEqual(r.json.version, 2, '过期修改不得改变记录');
    assert.strictEqual(r.json.paired.length, 1);
    console.log('ok 3 过期修改被 409 拒绝并返回当前版本');

    // 8. 修改时的校验仍为整次生效：携带合法版本但配对非法 -> 不改
    r = await api('PUT', `/api/comparisons/${cid}`, {
      version: 2,
      pairs: [{ baseCellId: 'base-a', retestCellId: 'ret-a' },
              { baseCellId: 'base-b', retestCellId: 'ret-a' }]
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /配对重复/);
    r = await api('GET', `/api/comparisons/${cid}`);
    assert.strictEqual(r.json.version, 2);
    assert.strictEqual(r.json.paired.length, 1);

    // 改成两侧相同同样拒绝
    r = await api('PUT', `/api/comparisons/${cid}`, {
      version: 2, baselineReportId: baseline.id, retestReportId: baseline.id
    });
    assert.strictEqual(r.status, 400);
    r = await api('GET', `/api/comparisons/${cid}`);
    assert.strictEqual(r.json.baseline.reportId, baseline.id);
    console.log('ok 4 修改时校验失败整次不生效');

    // 9. 修改不存在的比较记录 -> 404
    r = await api('PUT', '/api/comparisons/missing', { version: 1, pairs: [] });
    assert.strictEqual(r.status, 404);
    r = await api('GET', '/api/comparisons/missing');
    assert.strictEqual(r.status, 404);

    // 10. 草稿后续改动 / 另发报告不影响已存比较：改基线草稿再发布新版
    let img = await api('GET', `/api/images/${baseline.imageId}`);
    assert.strictEqual(img.status, 200);
    // 重新保存轮廓（改形状）后再次发布为另一份报告
    let up = await api('PUT', `/api/images/${baseline.imageId}/contours`, {
      version: img.json.version,
      cells: [
        { id: 'base-a', name: 'A', outer: rect(2, 2, 8, 8), holes: [] },
        { id: 'base-b', name: 'B', outer: rect(2, 2, 30, 30), holes: [] }
      ]
    });
    assert.strictEqual(up.status, 200, JSON.stringify(up.json));
    up = await api('POST', `/api/images/${baseline.imageId}/publish`, { version: up.json.version });
    assert.strictEqual(up.status, 201);
    r = await api('GET', `/api/comparisons/${cid}`);
    const frozen = r.json;
    assert.strictEqual(frozen.paired[0].baseAreaUm2, 100, '已存比较必须保持冻结值 100');
    assert.strictEqual(frozen.paired[0].retestAreaUm2, 400);
    assert.strictEqual(frozen.paired[0].areaDelta, 300);
    assert.strictEqual(frozen.baseline.reportId, baseline.id);
    console.log('ok 5 草稿改动与另发报告不改变已存比较');

    // 11. CSV 导出与页面一致（含未配对段、不可计算由单测覆盖）
    const csvRes = await fetch(`${BASE}/api/comparisons/${cid}/csv`);
    assert.strictEqual(csvRes.status, 200);
    const csvBuf = Buffer.from(await csvRes.arrayBuffer());
    assert.strictEqual(csvBuf[0], 0xEF, 'CSV 须带 UTF-8 BOM');
    assert.strictEqual(csvBuf[1], 0xBB);
    assert.strictEqual(csvBuf[2], 0xBF);
    const csvText = csvBuf.toString('utf8').slice(1);
    assert.match(csvText, /类别,基线细胞,复测细胞/);
    assert.match(csvText, /配对,A,A/);
    assert.match(csvText, /基线未配对,B,/);
    assert.match(csvText, /复测未配对,,B/);
    assert.match(csvText, /复测未配对,,C/);
    assert.match(csvText, /,100,400,300,\+300%/);
    assert.match(csvText, /,40,80,40,\+100%/);
    console.log('ok 6 CSV 与页面一致（配对 + 两侧未配对）');

    // 12. 冻结定标信息在结果中提供
    assert.strictEqual(frozen.baseline.calib.scale, 1);
    assert.strictEqual(frozen.retest.calib.scale, 1);

    // 13. 空配对允许保存（全部细胞未配对）
    r = await api('POST', '/api/comparisons', {
      baselineReportId: baseline.id, retestReportId: retest.id, pairs: []
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.json.paired.length, 0);
    assert.strictEqual(r.json.unpairedBaseline.length, 2);
    assert.strictEqual(r.json.unpairedRetest.length, 3);
    assert.match(r.json.title, /比较：/);
    console.log('ok 7 空配对保存（全部列为未配对）');

    console.log('\n比较功能端到端测试全部通过 ✔');
  } finally {
    await cleanup();
  }
})().catch(async (e) => {
  console.error('测试失败：', e);
  await cleanup();
  process.exit(1);
});
