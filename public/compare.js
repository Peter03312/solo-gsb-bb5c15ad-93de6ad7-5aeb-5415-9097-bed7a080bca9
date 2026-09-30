'use strict';

// 报告间比较：在两份不同的已发布报告之间，按细胞手动一对一配对。
// 同名细胞不会自动配对；所有数值来自两份报告冻结的定标与测量结果。

const Compare = {
  // 编辑器状态
  mode: 'create',       // 'create' | 'edit'
  editingId: null,
  loadedVersion: null,
  reports: [],
  baselineReport: null,
  retestReport: null,
  // 正在编辑的配对：[{baseCellId|null, retestCellId|null}]
  draftPairs: [],

  // ---------- 列表 ----------

  async showSavedList() {
    const el = document.getElementById('comparison-list');
    el.innerHTML = '<p class="muted">加载中…</p>';
    let list;
    try {
      list = await API.listComparisons();
    } catch (e) {
      el.innerHTML = `<p class="muted">${e.message}</p>`;
      return;
    }
    if (!list.length) {
      el.innerHTML = '<p class="muted">还没有比较记录。选择两份不同报告，手动逐一配对细胞后保存。</p>';
      return;
    }
    const byId = new Map(this.reports.map((r) => [r.id, r]));
    el.innerHTML = '';
    for (const c of list) {
      const b = byId.get(c.baselineReportId);
      const r = byId.get(c.retestReportId);
      const item = document.createElement('div');
      item.className = 'item';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('div');
      name.className = 'name';
      const link = document.createElement('a');
      link.href = `#/comparison/${c.id}`;
      link.style.color = 'var(--text)';
      link.textContent = c.title;
      name.appendChild(link);
      meta.appendChild(name);
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent =
        `基线：${b ? b.title : c.baselineReportId} ⇄ 复测：${r ? r.title : c.retestReportId} · ` +
        `配对 ${c.pairs.length} 对 · v${c.version} · 更新于 ${c.updatedAt}`;
      meta.appendChild(sub);
      item.appendChild(meta);
      el.appendChild(item);
    }
  },

  // ---------- 编辑器（新建 / 修改） ----------

  async openCreate() {
    this.mode = 'create';
    this.editingId = null;
    this.loadedVersion = null;
    document.getElementById('view-reports').classList.add('hidden');
    document.getElementById('view-compare-edit').classList.remove('hidden');
    document.getElementById('cmp-edit-title').textContent = '新建报告间比较';
    document.getElementById('cmp-edit-tag').textContent = '';
    document.getElementById('cmp-msg').className = 'info';
    document.getElementById('cmp-msg').textContent = '';
    document.getElementById('cmp-title').value = '';
    this.reports = await API.listReports();
    this.fillReportSelects(null, null);
  },

  async openEdit(id) {
    this.mode = 'edit';
    this.editingId = id;
    document.getElementById('view-reports').classList.add('hidden');
    document.getElementById('view-report-detail').classList.add('hidden');
    document.getElementById('view-compare-detail').classList.add('hidden');
    document.getElementById('view-compare-edit').classList.remove('hidden');
    document.getElementById('cmp-msg').className = 'info';
    document.getElementById('cmp-msg').textContent = '';

    let result;
    try {
      result = await API.getComparison(id);
    } catch (e) {
      alert(e.message);
      location.hash = '#/reports';
      return;
    }
    this.reports = await API.listReports();
    this.loadedVersion = result.version;
    document.getElementById('cmp-edit-title').textContent = '修改比较记录';
    document.getElementById('cmp-edit-tag').textContent = `编辑中 · v${result.version}`;
    document.getElementById('cmp-title').value = result.title;
    this.fillReportSelects(result.baseline.reportId, result.retest.reportId);
    this.draftPairs = result.paired.map((p) => ({
      baseCellId: p.baseCellId,
      retestCellId: p.retestCellId
    }));
    this.renderPairEditor();
  },

  fillReportSelects(baseId, retestId) {
    const bs = document.getElementById('cmp-baseline');
    const rs = document.getElementById('cmp-retest');
    const options = '<option value="">— 请选择报告 —</option>' +
      this.reports.map((r) => `<option value="${r.id}">${this.esc(r.title)}（${r.cells.length} 个细胞）</option>`).join('');
    bs.innerHTML = options;
    rs.innerHTML = options;
    bs.value = baseId || '';
    rs.value = retestId || '';

    bs.onchange = () => this.onReportChanged();
    rs.onchange = () => this.onReportChanged();

    this.baselineReport = this.reports.find((r) => r.id === bs.value) || null;
    this.retestReport = this.reports.find((r) => r.id === rs.value) || null;
    this.draftPairs = [];
    this.renderPairEditor();
  },

  onReportChanged() {
    this.baselineReport = this.reports.find((r) => r.id === document.getElementById('cmp-baseline').value) || null;
    this.retestReport = this.reports.find((r) => r.id === document.getElementById('cmp-retest').value) || null;
    this.draftPairs = [];
    this.renderPairEditor();
  },

  cellLabel(report, cell) {
    const i = report.cells.indexOf(cell);
    return cell.name || `细胞 ${i + 1}`;
  },

  renderPairEditor() {
    const wrap = document.getElementById('cmp-pairs-wrap');
    const calib = document.getElementById('cmp-calib');
    const addBtn = document.getElementById('cmp-add-pair');
    const saveBtn = document.getElementById('cmp-save');

    if (!this.baselineReport || !this.retestReport) {
      calib.innerHTML = '<p class="muted">请在上方分别选择基线报告与复测报告（不能相同）。</p>';
      wrap.innerHTML = '';
      addBtn.disabled = true;
      saveBtn.disabled = true;
      return;
    }
    if (this.baselineReport.id === this.retestReport.id) {
      calib.innerHTML = '<p class="hint" style="color:var(--danger)">基线与复测不能是同一份报告。</p>';
      wrap.innerHTML = '';
      addBtn.disabled = true;
      saveBtn.disabled = true;
      return;
    }
    addBtn.disabled = false;
    saveBtn.disabled = false;

    calib.innerHTML =
      `<p>基线冻结定标：1 px = <b>${this.baselineReport.calib.scale.toFixed(6)}</b> μm；` +
      `复测冻结定标：1 px = <b>${this.retestReport.calib.scale.toFixed(6)}</b> μm。</p>` +
      '<p class="hint">比较直接取两份报告发布时冻结的测量值，同名细胞不会自动配对，请逐行手动选择。</p>';

    const usedBase = new Set(this.draftPairs.map((p) => p.baseCellId).filter(Boolean));
    const usedRetest = new Set(this.draftPairs.map((p) => p.retestCellId).filter(Boolean));

    const selectHtml = (report, used, selected, which, rowIdx) => {
      const opts = ['<option value="">— 未选择 —</option>'].concat(
        report.cells.map((c) => {
          const v = c.id;
          const disabled = used.has(v) && v !== selected ? ' disabled' : '';
          const sel = v === selected ? ' selected' : '';
          return `<option value="${v}"${disabled}${sel}>${this.esc(this.cellLabel(report, c))} · 净面积 ${this.fmt(c.areaUm2)}</option>`;
        })
      );
      return `<select data-row="${rowIdx}" data-which="${which}">${opts.join('')}</select>`;
    };

    let html = this.draftPairs.map((p, i) => `
      <div class="cmp-pair-row">
        <span class="cmp-row-no">${i + 1}</span>
        ${selectHtml(this.baselineReport, usedBase, p.baseCellId, 'base', i)}
        <span class="cmp-arrow">⇄</span>
        ${selectHtml(this.retestReport, usedRetest, p.retestCellId, 'retest', i)}
        <button type="button" class="small cmp-del" data-row="${i}">移除</button>
      </div>`).join('');
    if (!html) {
      html = '<p class="muted">尚未配对。点击下方「+ 添加一对」手动选择两侧细胞；未配对细胞保存后分别列出。</p>';
    }
    wrap.innerHTML = html;

    wrap.querySelectorAll('select').forEach((sel) => {
      sel.onchange = () => {
        const idx = Number(sel.dataset.row);
        const which = sel.dataset.which === 'base' ? 'baseCellId' : 'retestCellId';
        this.draftPairs[idx][which] = sel.value || null;
        this.renderPairEditor();
      };
    });
    wrap.querySelectorAll('.cmp-del').forEach((btn) => {
      btn.onclick = () => {
        this.draftPairs.splice(Number(btn.dataset.row), 1);
        this.renderPairEditor();
      };
    });

    this.renderUnpairedPreview(usedBase, usedRetest);
  },

  renderUnpairedPreview(usedBase, usedRetest) {
    const list = (report, used) => report.cells
      .filter((c) => !used.has(c.id))
      .map((c) => `<li>${this.esc(this.cellLabel(report, c))}（净面积 ${this.fmt(c.areaUm2)}，总周长 ${this.fmt(c.perimeterUm)}）</li>`)
      .join('');
    document.getElementById('cmp-unpaired').innerHTML = `
      <div class="cmp-unpaired-col">
        <h4>基线未配对（${this.baselineReport.cells.length - usedBase.size}）</h4>
        <ul class="cmp-unlist">${list(this.baselineReport, usedBase) || '<li class="muted">无</li>'}</ul>
      </div>
      <div class="cmp-unpaired-col">
        <h4>复测未配对（${this.retestReport.cells.length - usedRetest.size}）</h4>
        <ul class="cmp-unlist">${list(this.retestReport, usedRetest) || '<li class="muted">无</li>'}</ul>
      </div>`;
  },

  collectPairsOrError() {
    const pairs = [];
    for (let i = 0; i < this.draftPairs.length; i++) {
      const p = this.draftPairs[i];
      if (!p.baseCellId || !p.retestCellId) {
        return { error: `第 ${i + 1} 对尚未选全两侧细胞（请选全或移除该行）` };
      }
      pairs.push({ baseCellId: p.baseCellId, retestCellId: p.retestCellId });
    }
    return { pairs };
  },

  async save() {
    const msg = document.getElementById('cmp-msg');
    msg.className = 'info';
    msg.textContent = '';
    if (!this.baselineReport || !this.retestReport) return;
    if (this.baselineReport.id === this.retestReport.id) {
      msg.className = 'info err';
      msg.textContent = '基线与复测不能是同一份报告。';
      return;
    }
    const { pairs, error } = this.collectPairsOrError();
    if (error) {
      msg.className = 'info err';
      msg.textContent = error;
      return;
    }

    const payload = {
      title: document.getElementById('cmp-title').value,
      baselineReportId: this.baselineReport.id,
      retestReportId: this.retestReport.id,
      pairs
    };
    try {
      let result;
      if (this.mode === 'create') {
        result = await API.createComparison(payload);
      } else {
        result = await API.updateComparison(this.editingId, { ...payload, version: this.loadedVersion });
      }
      location.hash = `#/comparison/${result.id}`;
    } catch (e) {
      if (e.status === 409) {
        msg.className = 'info err';
        msg.textContent = `${e.message} 请返回报告列表重新打开该比较记录后再修改。`;
      } else {
        msg.className = 'info err';
        msg.textContent = e.message;
      }
    }
  },

  // ---------- 详情 ----------

  async showDetail(id) {
    document.getElementById('view-reports').classList.add('hidden');
    document.getElementById('view-report-detail').classList.add('hidden');
    document.getElementById('view-compare-edit').classList.add('hidden');
    document.getElementById('view-compare-detail').classList.remove('hidden');

    let r;
    try {
      r = await API.getComparison(id);
    } catch (e) {
      alert(e.message);
      location.hash = '#/reports';
      return;
    }

    document.getElementById('cmpd-title').textContent = r.title;
    document.getElementById('cmpd-meta').innerHTML =
      `比较记录版本：<b>v${r.version}</b>（修改需携带此版本号，过期修改会被拒绝）<br>` +
      `创建于 ${r.createdAt} · 保存于 ${r.updatedAt}<br>` +
      `基线：<b>${this.esc(r.baseline.title)}</b>（${r.baseline.filename}，${r.baseline.createdAt}）` +
      ` · 1 px = ${r.baseline.calib.scale.toFixed(6)} μm<br>` +
      `复测：<b>${this.esc(r.retest.title)}</b>（${r.retest.filename}，${r.retest.createdAt}）` +
      ` · 1 px = ${r.retest.calib.scale.toFixed(6)} μm<br>` +
      `<span class="muted">数值取自两份报告发布时冻结的定标与测量结果；草稿后续改动或另发报告不影响本记录。</span>`;

    const pairedRows = r.paired.map((p) => `
      <tr>
        <td>${this.esc(p.baseName)}</td>
        <td>${this.esc(p.retestName)}</td>
        <td>${this.fmt(p.baseAreaUm2)}</td>
        <td>${this.fmt(p.retestAreaUm2)}</td>
        <td class="${this.deltaCls(p.areaDelta)}">${this.signed(p.areaDelta)}</td>
        <td class="${this.deltaCls(p.areaRate)}">${this.rate(p.areaRate)}</td>
        <td>${this.fmt(p.basePerimeterUm)}</td>
        <td>${this.fmt(p.retestPerimeterUm)}</td>
        <td class="${this.deltaCls(p.perimeterDelta)}">${this.signed(p.perimeterDelta)}</td>
        <td class="${this.deltaCls(p.perimeterRate)}">${this.rate(p.perimeterRate)}</td>
      </tr>`).join('');

    document.getElementById('cmpd-paired-wrap').innerHTML = r.paired.length ? `
      <table class="measure cmp-table">
        <thead><tr>
          <th>基线细胞</th><th>复测细胞</th>
          <th>基线净面积 μm²</th><th>复测净面积 μm²</th><th>差值 μm²</th><th>变化率</th>
          <th>基线周长 μm</th><th>复测周长 μm</th><th>差值 μm</th><th>变化率</th>
        </tr></thead>
        <tbody>${pairedRows}</tbody>
      </table>` : '<p class="muted">本记录没有配对细胞（全部细胞列于下方未配对区）。</p>';

    const unpairedRows = (cells) => cells.map((c) => `
      <tr>
        <td>${this.esc(c.name)}</td>
        <td>${c.holes}</td>
        <td>${this.fmt(c.areaUm2)}</td>
        <td>${this.fmt(c.perimeterUm)}</td>
      </tr>`).join('');

    document.getElementById('cmpd-unpaired-wrap').innerHTML = `
      <div class="cmp-unpaired-col">
        <h4>基线未配对（${r.unpairedBaseline.length}）</h4>
        ${r.unpairedBaseline.length ? `
        <table class="measure">
          <thead><tr><th>细胞</th><th>孔洞</th><th>净面积 μm²</th><th>总周长 μm</th></tr></thead>
          <tbody>${unpairedRows(r.unpairedBaseline)}</tbody>
        </table>` : '<p class="muted">无</p>'}
      </div>
      <div class="cmp-unpaired-col">
        <h4>复测未配对（${r.unpairedRetest.length}）</h4>
        ${r.unpairedRetest.length ? `
        <table class="measure">
          <thead><tr><th>细胞</th><th>孔洞</th><th>净面积 μm²</th><th>总周长 μm</th></tr></thead>
          <tbody>${unpairedRows(r.unpairedRetest)}</tbody>
        </table>` : '<p class="muted">无</p>'}
      </div>`;

    const csvLink = document.getElementById('cmpd-csv-link');
    csvLink.href = API.comparisonCsvUrl(r.id);
    csvLink.setAttribute('download', `${r.id}_comparison.csv`);
    document.getElementById('cmpd-edit-link').href = `#/comparison/${r.id}/edit`;
  },

  // ---------- 格式化 ----------

  fmt(v) {
    if (v === null || v === undefined) return '—';
    if (v !== 0 && Math.abs(v) < 0.001) return v.toExponential(3);
    return (Math.round(v * 1000) / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 });
  },

  signed(v) {
    if (v === null || v === undefined) return '—';
    const n = Math.round(v * 1000) / 1000;
    return (n > 0 ? '+' : '') + n.toLocaleString('zh-CN', { maximumFractionDigits: 3 });
  },

  rate(v) {
    if (v === null || v === undefined) return '不可计算';
    return `${v > 0 ? '+' : ''}${v}%`;
  },

  deltaCls(v) {
    if (v === null || v === undefined || v === 0) return '';
    return v > 0 ? 'cmp-up' : 'cmp-down';
  },

  esc(s) {
    return String(s).replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }
};

window.Compare = Compare;
