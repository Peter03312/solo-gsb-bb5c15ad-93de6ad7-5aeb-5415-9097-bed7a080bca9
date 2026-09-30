'use strict';

// 比较模块纯逻辑自测：配对校验、差值/变化率（含基线零）、结果装配与 CSV

const assert = require('assert');
const { normalizePairs, buildResult, hydrateComparison } = require('./server/comparisons');
const { buildComparisonCsv } = require('./server/exporter');

function fakeReport(id, cells) {
  return {
    id,
    title: `报告 ${id}`,
    filename: 's.png',
    createdAt: '2026-09-30 00:00:00',
    calib: { p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, distanceUm: 10, scale: 1 },
    cells: cells.map((c) => ({
      id: c.id, name: c.name === undefined ? c.id : c.name, outer: [], holes: [],
      areaUm2: c.area, perimeterUm: c.per
    }))
  };
}

// 1. 同名细胞不会自动配对：normalizePairs 只承认显式 ID 配对
{
  const b = fakeReport('B', [{ id: 'b1', area: 100, per: 40 }]);
  const r = fakeReport('R', [{ id: 'r1', area: 200, per: 50 }]);
  assert.deepStrictEqual(normalizePairs([], b, r), []);
  assert.deepStrictEqual(
    normalizePairs([{ baseCellId: 'b1', retestCellId: 'r1' }], b, r),
    [{ baseCellId: 'b1', retestCellId: 'r1' }]
  );
  console.log('ok 1 同名不自动配对，只接受显式 ID 配对');
}

// 2. 各种非法配对
{
  const b = fakeReport('B', [{ id: 'b1' }, { id: 'b2' }].map((c) => ({ ...c, area: 1, per: 1 })));
  const r = fakeReport('R', [{ id: 'r1' }, { id: 'r2' }].map((c) => ({ ...c, area: 1, per: 1 })));
  assert.throws(() => normalizePairs(null, b, r), /必须是数组/);
  assert.throws(() => normalizePairs([{ baseCellId: 'x', retestCellId: 'r1' }], b, r), /基线报告中不存在/);
  assert.throws(() => normalizePairs([{ baseCellId: 'b1', retestCellId: 'x' }], b, r), /复测报告中不存在/);
  assert.throws(() => normalizePairs([
    { baseCellId: 'b1', retestCellId: 'r1' },
    { baseCellId: 'b1', retestCellId: 'r2' }
  ], b, r), /配对重复/);
  assert.throws(() => normalizePairs([
    { baseCellId: 'b1', retestCellId: 'r1' },
    { baseCellId: 'b2', retestCellId: 'r1' }
  ], b, r), /配对重复/);
  assert.throws(() => normalizePairs([{}], b, r), /缺少基线细胞/);
  console.log('ok 2 非法/重复/缺失配对被拒绝');
}

// 3. 差值符号、相对基线变化率、基线为零 => null（不可计算）
{
  const b = fakeReport('B', [
    { id: 'b-zero', area: 0, per: 40 },
    { id: 'b-up', area: 100, per: 40 },
    { id: 'b-down', area: 200, per: 80 }
  ]);
  const r = fakeReport('R', [
    { id: 'r-zero', area: 50, per: 40 },
    { id: 'r-up', area: 130, per: 50 },
    { id: 'r-down', area: 150, per: 60 }
  ]);
  const row = {
    id: 'c1', baseline_report_id: 'B', retest_report_id: 'R', title: 'T',
    pairs: JSON.stringify([
      { baseCellId: 'b-zero', retestCellId: 'r-zero' },
      { baseCellId: 'b-up', retestCellId: 'r-up' },
      { baseCellId: 'b-down', retestCellId: 'r-down' }
    ]),
    version: 1, created_at: 't', updated_at: 't'
  };
  const result = buildResult(hydrateComparison(row), b, r);
  const [zero, up, down] = result.paired;

  assert.strictEqual(zero.areaDelta, 50);
  assert.strictEqual(zero.areaRate, null, '基线面积为零变化率必须为 null');
  assert.strictEqual(zero.perimeterDelta, 0);
  assert.strictEqual(zero.perimeterRate, 0);

  assert.strictEqual(up.areaDelta, 30);
  assert.strictEqual(up.areaRate, 30);
  assert.strictEqual(up.perimeterDelta, 10);
  assert.strictEqual(up.perimeterRate, 25);

  assert.strictEqual(down.areaDelta, -50);
  assert.strictEqual(down.areaRate, -25);
  assert.strictEqual(down.perimeterDelta, -20);
  assert.strictEqual(down.perimeterRate, -25);

  assert.strictEqual(result.unpairedBaseline.length, 0);
  assert.strictEqual(result.unpairedRetest.length, 0);
  console.log('ok 3 带符号差值/变化率，基线零为不可计算');

  // 4. CSV 中基线零显示“不可计算”，其余与页面同值
  const csv = buildComparisonCsv(result);
  assert.match(csv, /配对,b-zero,r-zero,0,50,50,不可计算,40,40,0,0%/);
  assert.match(csv, /配对,b-up,r-up,100,130,30,\+30%,40,50,10,\+25%/);
  assert.match(csv, /配对,b-down,r-down,200,150,-50,-25%,80,60,-20,-25%/);
  assert.ok(csv.charCodeAt(0) === 0xFEFF, 'CSV 带 BOM');
  console.log('ok 4 CSV 与页面一致，基线零写“不可计算”');
}

// 5. 未配对细胞分别落到两侧
{
  const b = fakeReport('B', [
    { id: 'b1', area: 1, per: 1 }, { id: 'b2', name: '', area: 2, per: 2 }
  ]);
  const r = fakeReport('R', [
    { id: 'r1', area: 1, per: 1 }, { id: 'r2', area: 2, per: 2 }
  ]);
  const row = {
    id: 'c2', baseline_report_id: 'B', retest_report_id: 'R', title: 'T',
    pairs: JSON.stringify([{ baseCellId: 'b1', retestCellId: 'r2' }]),
    version: 3, created_at: 't', updated_at: 't2'
  };
  const result = buildResult(hydrateComparison(row), b, r);
  assert.strictEqual(result.unpairedBaseline[0].cellId, 'b2');
  assert.strictEqual(result.unpairedBaseline[0].name, '细胞 2', '无名细胞回退展示编号');
  assert.strictEqual(result.unpairedRetest[0].cellId, 'r1');
  assert.strictEqual(result.version, 3);
  console.log('ok 5 未配对细胞分侧列出，无名细胞回退命名');
}

console.log('\n比较模块单元测试全部通过 ✔');
