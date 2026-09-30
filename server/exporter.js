'use strict';

const archiver = require('archiver');

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function round(v, n = 4) {
  const f = 10 ** n;
  return Math.round(v * f) / f;
}

// 单份报告的测量 CSV（UTF-8 BOM，便于 Excel 直接打开）
function buildReportCsv(report) {
  const calib = report.calib;
  const header = [
    '报告ID', '报告标题', '图片文件名', '图片宽(px)', '图片高(px)',
    '定标点1 X(px)', '定标点1 Y(px)', '定标点2 X(px)', '定标点2 Y(px)',
    '标定距离(μm)', '每像素微米(μm/px)',
    '细胞名称', '孔洞数', '面积(μm²)', '含孔洞边界总周长(μm)'
  ];
  const rows = [header];
  const c = calib || {};
  const base = [
    report.id, report.title, report.filename, report.width, report.height,
    c.p1 ? round(c.p1.x, 2) : '', c.p1 ? round(c.p1.y, 2) : '',
    c.p2 ? round(c.p2.x, 2) : '', c.p2 ? round(c.p2.y, 2) : '',
    c.distanceUm ?? '', c.scale ? round(c.scale, 6) : ''
  ];
  for (const cell of report.cells) {
    rows.push([
      ...base,
      cell.name || '',
      (cell.holes || []).length,
      round(cell.areaUm2),
      round(cell.perimeterUm)
    ]);
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

// 多份报告汇总 CSV
function buildCombinedCsv(reports) {
  const rows = [[
    '报告ID', '报告标题', '发布时间', '草稿版本', '图片文件名',
    '标定距离(μm)', '每像素微米(μm/px)',
    '细胞名称', '孔洞数', '面积(μm²)', '含孔洞边界总周长(μm)'
  ]];
  for (const report of reports) {
    const c = report.calib || {};
    for (const cell of report.cells) {
      rows.push([
        report.id, report.title, report.createdAt, report.draftVersion, report.filename,
        c.distanceUm ?? '', c.scale ? round(c.scale, 6) : '',
        cell.name || '', (cell.holes || []).length,
        round(cell.areaUm2), round(cell.perimeterUm)
      ]);
    }
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

async function streamZip(reports, pngByName, res) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const names = new Set();
  const uniq = (n) => {
    let name = n; let k = 1;
    while (names.has(name)) name = n.replace(/(\.[^.]*)?$/, `_${k}$1`), k++;
    names.add(name);
    return name;
  };

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="reports.zip"');
  archive.on('error', (err) => { res.destroy(err); });
  archive.pipe(res);

  const combined = [];
  for (const r of reports) {
    const base = uniq(`${r.title || r.id}`.replace(/[\\/:*?"<>|]+/g, '_'));
    archive.append(pngByName[r.id], { name: `${base}_标注.png` });
    archive.append(buildReportCsv(r), { name: `${base}_测量.csv` });
    combined.push(r);
  }
  archive.append(buildCombinedCsv(combined), { name: '汇总_测量.csv' });
  await archive.finalize();
}

// 报告间比较 CSV：列顺序与页面一致，基线值为零时变化率写“不可计算”，未配对细胞单列成行
function buildComparisonCsv(result) {
  const head = [
    '比较ID', '比较标题', '保存时间', '比较记录版本',
    '基线报告ID', '基线报告标题', '复测报告ID', '复测报告标题',
    '类别', '基线细胞', '复测细胞',
    '基线净面积(μm²)', '复测净面积(μm²)', '净面积差值(μm²)', '净面积变化率',
    '基线总周长(μm)', '复测总周长(μm)', '总周长差值(μm)', '总周长变化率'
  ];
  const rows = [head];

  const fixed = [
    result.id, result.title, result.updatedAt, result.version,
    result.baseline.reportId, result.baseline.title,
    result.retest.reportId, result.retest.title
  ];
  const rateText = (v) => (v === null ? '不可计算' : `${v > 0 ? '+' : ''}${v}%`);

  for (const p of result.paired) {
    rows.push([
      ...fixed,
      '配对', p.baseName, p.retestName,
      p.baseAreaUm2, p.retestAreaUm2, p.areaDelta, rateText(p.areaRate),
      p.basePerimeterUm, p.retestPerimeterUm, p.perimeterDelta, rateText(p.perimeterRate)
    ]);
  }
  for (const c of result.unpairedBaseline) {
    rows.push([
      ...fixed,
      '基线未配对', c.name, '',
      c.areaUm2, '', '', '',
      c.perimeterUm, '', '', ''
    ]);
  }
  for (const c of result.unpairedRetest) {
    rows.push([
      ...fixed,
      '复测未配对', '', c.name,
      '', c.areaUm2, '', '',
      '', c.perimeterUm, '', ''
    ]);
  }

  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

module.exports = { buildReportCsv, buildCombinedCsv, buildComparisonCsv, streamZip };
