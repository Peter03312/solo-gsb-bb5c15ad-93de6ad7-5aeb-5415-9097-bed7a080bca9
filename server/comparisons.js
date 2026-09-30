'use strict';

// 报告间比较：配对校验、从两份报告冻结的定标与测量值计算比较结果。
// 报告一经发布即不可变，因此比较记录只保存 ID 配对，结果始终可由冻结值重算。

const round3 = (v) => Math.round(v * 1000) / 1000;
const round2 = (v) => Math.round(v * 100) / 100;

function hydrateComparison(row) {
  return {
    id: row.id,
    baselineReportId: row.baseline_report_id,
    retestReportId: row.retest_report_id,
    title: row.title,
    pairs: JSON.parse(row.pairs),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// 校验并标准化客户端提交的配对表。
// 规则：
//  - 必须是数组（允许空数组：所有细胞均列为未配对）；
//  - 每项形如 {baseCellId, retestCellId}，两侧细胞必须存在于对应报告；
//  - 同一侧的同一个细胞不得出现在两对中（配对重复）；
//  - 细胞按 id 精确匹配，同名细胞不会自动配对（此函数不做任何名称推断）。
function normalizePairs(rawPairs, baseline, retest) {
  if (!Array.isArray(rawPairs)) {
    throw new Error('配对数据无效：pairs 必须是数组');
  }
  const baseIds = new Set(baseline.cells.map((c) => c.id));
  const retestIds = new Set(retest.cells.map((c) => c.id));
  const seenBase = new Set();
  const seenRetest = new Set();

  const pairs = rawPairs.map((p, i) => {
    const at = `第 ${i + 1} 对`;
    if (!p || typeof p !== 'object') throw new Error(`${at}：配对数据格式错误`);
    const { baseCellId, retestCellId } = p;
    if (typeof baseCellId !== 'string' || !baseCellId) {
      throw new Error(`${at}：缺少基线细胞 ID（baseCellId）`);
    }
    if (typeof retestCellId !== 'string' || !retestCellId) {
      throw new Error(`${at}：缺少复测细胞 ID（retestCellId）`);
    }
    if (!baseIds.has(baseCellId)) {
      throw new Error(`${at}：基线报告中不存在细胞 ${baseCellId}`);
    }
    if (!retestIds.has(retestCellId)) {
      throw new Error(`${at}：复测报告中不存在细胞 ${retestCellId}`);
    }
    if (seenBase.has(baseCellId)) {
      throw new Error(`配对重复：基线细胞 ${baseCellId} 已与其他复测细胞配对，一个细胞只能配对一次`);
    }
    if (seenRetest.has(retestCellId)) {
      throw new Error(`配对重复：复测细胞 ${retestCellId} 已与其他基线细胞配对，一个细胞只能配对一次`);
    }
    seenBase.add(baseCellId);
    seenRetest.add(retestCellId);
    return { baseCellId, retestCellId };
  });

  return pairs;
}

function cellName(cell, index) {
  return cell.name || `细胞 ${index + 1}`;
}

// 带符号差值：复测 - 基线
function signedDelta(base, retest) {
  return round3(retest - base);
}

// 相对基线变化率：(复测 - 基线) / 基线 × 100%（百分比数值，保留 2 位）。
// 基线为 0 时无法定义，返回 null，页面与 CSV 显示“不可计算”。
function rateVsBaseline(base, retest) {
  if (base === 0) return null;
  return round2(((retest - base) / base) * 100);
}

function buildCellEntry(report, cell) {
  const index = report.cells.indexOf(cell);
  return {
    cellId: cell.id,
    name: cellName(cell, index),
    holes: (cell.holes || []).length,
    areaUm2: round3(cell.areaUm2),
    perimeterUm: round3(cell.perimeterUm)
  };
}

// 由两份冻结报告与配对表计算完整比较结果（页面展示与 CSV 导出共用同一份数据）
function buildResult(comparison, baseline, retest) {
  const baseById = new Map(baseline.cells.map((c) => [c.id, c]));
  const retestById = new Map(retest.cells.map((c) => [c.id, c]));

  const paired = comparison.pairs.map((p) => {
    const b = baseById.get(p.baseCellId);
    const r = retestById.get(p.retestCellId);
    return {
      baseCellId: p.baseCellId,
      retestCellId: p.retestCellId,
      baseName: cellName(b, baseline.cells.indexOf(b)),
      retestName: cellName(r, retest.cells.indexOf(r)),
      baseAreaUm2: round3(b.areaUm2),
      retestAreaUm2: round3(r.areaUm2),
      areaDelta: signedDelta(b.areaUm2, r.areaUm2),
      areaRate: rateVsBaseline(b.areaUm2, r.areaUm2),
      basePerimeterUm: round3(b.perimeterUm),
      retestPerimeterUm: round3(r.perimeterUm),
      perimeterDelta: signedDelta(b.perimeterUm, r.perimeterUm),
      perimeterRate: rateVsBaseline(b.perimeterUm, r.perimeterUm)
    };
  });

  const pairedBase = new Set(comparison.pairs.map((p) => p.baseCellId));
  const pairedRetest = new Set(comparison.pairs.map((p) => p.retestCellId));

  const unpairedBaseline = baseline.cells
    .filter((c) => !pairedBase.has(c.id))
    .map((c) => buildCellEntry(baseline, c));
  const unpairedRetest = retest.cells
    .filter((c) => !pairedRetest.has(c.id))
    .map((c) => buildCellEntry(retest, c));

  return {
    ...comparison,
    baseline: {
      reportId: baseline.id,
      title: baseline.title,
      filename: baseline.filename,
      createdAt: baseline.createdAt,
      calib: baseline.calib
    },
    retest: {
      reportId: retest.id,
      title: retest.title,
      filename: retest.filename,
      createdAt: retest.createdAt,
      calib: retest.calib
    },
    paired,
    unpairedBaseline,
    unpairedRetest
  };
}

module.exports = {
  hydrateComparison,
  normalizePairs,
  buildResult
};
