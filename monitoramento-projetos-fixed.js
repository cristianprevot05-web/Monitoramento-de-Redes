(() => {
  const $ = (id) => document.getElementById(id);
  const MODE_KEY = 'monitoramento_projetos_mode_v6';
  const DATA_CACHE_KEY = 'monitoramento_projetos_rows_cache_v8';
  const WINDOW_CACHE_KEY = '__monitoramentoProjetosRowsCacheV8';
  const DATA_CACHE_TTL_MS = 15 * 60 * 1000;

  const MODE_LABEL = {
    recent: 'Problemas recentes',
    incidents: 'Incidentes abertos',
    history: 'Histórico'
  };

  const state = {
    mode: 'recent',
    selectedKey: '',
    cacheModes: {
      recent: false,
      incidents: false,
      history: false
    },
    unstableModes: {
      recent: false,
      incidents: false,
      history: false
    },
    rowsByMode: {
      recent: [],
      incidents: [],
      history: []
    }
  };

  function safeString(value) {
    if (value == null) return '';
    return String(value).trim();
  }

  function esc(text) {
    return safeString(text)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function toArray(values) {
    if (!values) return [];
    if (Array.isArray(values)) return values;
    if (typeof values.toArray === 'function') return values.toArray();
    if (Array.isArray(values.buffer)) return values.buffer;
    if (typeof values.length === 'number') return Array.from(values);
    return [];
  }

  function toMs(value) {
    if (value == null || value === '') return 0;

    const n = Number(value);
    if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;

    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }

  function fmtTime(ms) {
    if (!ms) return '--';
    return new Date(ms).toLocaleTimeString('pt-BR');
  }

  function fmtDate(ms) {
    if (!ms) return '--';
    return new Date(ms).toLocaleDateString('pt-BR');
  }

  function fmtDateTime(ms) {
    if (!ms) return '--';
    return new Date(ms).toLocaleString('pt-BR');
  }

  function fmtAge(ms) {
    if (!ms) return '--';

    let diff = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    const days = Math.floor(diff / 86400);
    diff -= days * 86400;
    const hours = Math.floor(diff / 3600);
    diff -= hours * 3600;
    const mins = Math.floor(diff / 60);
    const secs = diff - mins * 60;

    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }

  function severityMeta(value) {
    const map = {
      '0': { label: 'Nao class.', cls: 'sev-0' },
      '1': { label: 'Info', cls: 'sev-1' },
      '2': { label: 'Media', cls: 'sev-2' },
      '3': { label: 'Atencao', cls: 'sev-3' },
      '4': { label: 'Alta', cls: 'sev-4' },
      '5': { label: 'Desastre', cls: 'sev-5' }
    };

    return map[safeString(value)] || { label: 'N/A', cls: 'sev-0' };
  }

  function resolveStatus(item) {
    if (safeString(item?.value) === '0') return 'resolvido';

    const raw = safeString(item?.status || item?.state).toLowerCase();

    if (
      raw.includes('resolved') ||
      raw.includes('resolvido') ||
      raw.includes('ok') ||
      raw.includes('closed') ||
      raw.includes('fechado')
    ) {
      return 'resolvido';
    }

    return 'incidente';
  }

  function extractProblem(item) {
    return safeString(item?.name || item?.description || item?.problem || item?.problema || 'Sem descricao');
  }

  function extractHost(item) {
    return safeString(
      item?.hosts?.[0]?.name ||
      item?.hosts?.[0]?.host ||
      item?.host ||
      item?.hostname ||
      item?.host_name
    );
  }

  function extractPort(problem) {
    const value = safeString(problem);

    const patterns = [
      /\b(gpon[_\-/]\d+\/\d+\/\d+)\b/i,
      /\b(epon[_\-/]\d+\/\d+\/\d+)\b/i,
      /\b(pon[_\-/]\d+\/\d+\/\d+)\b/i,
      /\b(xgpon[_\-/]\d+\/\d+\/\d+)\b/i,
      /\b(slot[_\-/]\d+\/\d+\/\d+)\b/i,
      /\b(porta\s+[A-Za-z0-9._\-\/]+)\b/i,
      /\b(port\s+[A-Za-z0-9._\-\/]+)\b/i
    ];

    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (match) return match[1];
    }

    const tail = value.match(/:\s*([A-Za-z]+[_\-/]?\d+\/\d+\/\d+)\s*$/i);
    if (tail) return tail[1];

    return '--';
  }

  function isOltHost(host) {
    const value = safeString(host).toLowerCase();
    if (!value) return false;

    const patterns = [
      /^olt\b/,
      /^olt[_\-.]/,
      /\bolt\b/,
      /\bolt[_\-.]/,
      /\bolt\d+/
    ];

    return patterns.some((pattern) => pattern.test(value));
  }

  function normalizeFieldKey(name) {
    const value = safeString(name)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

    if (['host', 'hosts', 'hostname', 'host_name', 'nome_do_host'].includes(value)) return 'host';
    if (['problem', 'problema', 'name', 'description', 'descricao'].includes(value)) return 'name';
    if (['eventid', 'event_id', 'evento', 'id_evento'].includes(value)) return 'eventid';
    if (['triggerid', 'trigger_id'].includes(value)) return 'triggerid';
    if (['timestamp', 'time', 'clock', 'hora', 'data_hora'].includes(value)) return 'clock';
    if (['lastchange', 'last_change', 'ultima_mudanca'].includes(value)) return 'lastchange';
    if (['severity', 'severidade', 'priority', 'prioridade'].includes(value)) return 'severity';
    if (['ack', 'acknowledged', 'reconhecido'].includes(value)) return 'acknowledged';
    if (['status', 'state', 'estado'].includes(value)) return 'status';
    if (['value', 'valor'].includes(value)) return 'value';

    return value;
  }

  function normalizeFrame(frame, fallbackRef) {
    if (Array.isArray(frame?.fields)) {
      return {
        refId: safeString(frame?.refId || fallbackRef).toUpperCase(),
        fields: frame.fields.map((field) => ({
          name: safeString(field?.name),
          values: toArray(field?.values)
        }))
      };
    }

    if (Array.isArray(frame?.schema?.fields) && Array.isArray(frame?.data?.values)) {
      return {
        refId: safeString(frame?.refId || frame?.schema?.refId || fallbackRef).toUpperCase(),
        fields: frame.schema.fields.map((field, i) => ({
          name: safeString(field?.name),
          values: toArray(frame.data.values[i])
        }))
      };
    }

    return null;
  }

  function getGrafanaContext() {
    if (typeof context === 'undefined' || !context) return {};
    return context;
  }

  function getFrames() {
    const grafanaContext = getGrafanaContext();
    const raw = [
      ...(Array.isArray(grafanaContext?.panelData?.series) ? grafanaContext.panelData.series : []),
      ...(Array.isArray(grafanaContext?.data) ? grafanaContext.data : [])
    ];

    return raw
      .map((frame, index) => normalizeFrame(frame, ['A', 'B', 'C'][index] || ''))
      .filter(Boolean);
  }

  function frameToObjects(frame) {
    const objectField =
      frame.fields.find((f) => /^problems$/i.test(f.name)) ||
      frame.fields.find((f) => f.values.some((v) => v && typeof v === 'object'));

    if (objectField) {
      return objectField.values.filter((value) => value && typeof value === 'object');
    }

    const rowCount = Math.max(0, ...frame.fields.map((field) => field.values.length));
    const rows = [];

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const item = {};

      for (const field of frame.fields) {
        const value = field.values[rowIndex];
        if (value == null || value === '') continue;

        item[normalizeFieldKey(field.name)] = value;
      }

      if (Object.keys(item).length) {
        rows.push(item);
      }
    }

    return rows;
  }

  function extractObjectsByRef() {
    const out = { A: [], B: [], C: [] };

    for (const frame of getFrames()) {
      const ref = ['A', 'B', 'C'].includes(frame.refId) ? frame.refId : 'A';
      out[ref].push(...frameToObjects(frame));
    }

    return out;
  }

  function dedupe(items) {
    const map = new Map();

    for (const item of items) {
      const key = [
        safeString(item?.triggerid),
        safeString(item?.eventid),
        safeString(item?.timestamp || item?.lastchange || item?.clock),
        safeString(item?.name || item?.description || item?.problem)
      ].join('|');

      if (!map.has(key)) {
        map.set(key, item);
      }
    }

    return Array.from(map.values());
  }

  function dedupeRows(rows) {
    const map = new Map();

    for (const row of rows) {
      if (!map.has(row.key)) {
        map.set(row.key, row);
      }
    }

    return Array.from(map.values()).sort((a, b) => b.changedMs - a.changedMs);
  }

  function buildRows(items) {
    return dedupe(items)
      .map((item) => {
        const changedMs = toMs(item?.timestamp || item?.lastchange || item?.clock || 0);
        const severity = severityMeta(item?.severity ?? item?.priority);
        const ackRaw = safeString(item?.acknowledged || '0');
        const problem = extractProblem(item);
        const host = extractHost(item);
        const port = extractPort(problem);
        const status = resolveStatus(item);

        return {
          key: [
            safeString(item?.eventid || item?.triggerid),
            changedMs,
            host,
            problem
          ].join('|'),
          host,
          port,
          problem,
          severityLabel: severity.label,
          severityClass: severity.cls,
          status,
          ackRaw,
          acknowledged: ackRaw === '1' ? 'Reconhecido' : 'Nao reconhecido',
          changedMs,
          timeLabel: fmtTime(changedMs),
          dateLabel: fmtDate(changedMs),
          dateTimeLabel: fmtDateTime(changedMs),
          ageLabel: fmtAge(changedMs)
        };
      })
      .filter((row) => row.problem)
      .filter((row) => isOltHost(row.host))
      .sort((a, b) => b.changedMs - a.changedMs);
  }

  function getWindowCache() {
    try {
      window[WINDOW_CACHE_KEY] = window[WINDOW_CACHE_KEY] || { modes: {} };
      return window[WINDOW_CACHE_KEY].modes || {};
    } catch (e) {
      return {};
    }
  }

  function setWindowCache(modes) {
    try {
      window[WINDOW_CACHE_KEY] = { modes };
    } catch (e) { }
  }

  function readRowsCache() {
    const memoryCache = getWindowCache();
    let storageCache = {};

    try {
      const payload = JSON.parse(localStorage.getItem(DATA_CACHE_KEY) || '{}');
      storageCache = payload && payload.modes ? payload.modes : {};
    } catch (e) { }

    return { ...storageCache, ...memoryCache };
  }

  function writeRowsCache(modes) {
    setWindowCache(modes);

    try {
      localStorage.setItem(DATA_CACHE_KEY, JSON.stringify({ modes }));
    } catch (e) { }
  }

  function applyRowsCache(rowsByMode) {
    const now = Date.now();
    const cache = readRowsCache();
    const nextCache = { ...cache };
    const merged = {};
    const cacheModes = {};
    const unstableModes = {};

    for (const mode of Object.keys(MODE_LABEL)) {
      const freshRows = rowsByMode[mode] || [];
      const cachedMode = cache[mode];
      const cachedRows = Array.isArray(cachedMode?.rows) ? cachedMode.rows : [];
      const cachedAt = Number(cachedMode?.savedAt || 0);
      const cacheIsValid = cachedRows.length > 0 && now - cachedAt < DATA_CACHE_TTL_MS;

      if (freshRows.length > 0) {
        merged[mode] = freshRows;
        cacheModes[mode] = false;
        unstableModes[mode] = false;
        nextCache[mode] = { savedAt: now, rows: freshRows };
      } else if (cacheIsValid) {
        merged[mode] = cachedRows;
        cacheModes[mode] = true;
        unstableModes[mode] = false;
      } else {
        merged[mode] = [];
        cacheModes[mode] = false;
        unstableModes[mode] = true;
        delete nextCache[mode];
      }
    }

    writeRowsCache(nextCache);
    return { rowsByMode: merged, cacheModes, unstableModes };
  }

  function readSavedMode() {
    try {
      const saved = localStorage.getItem(MODE_KEY);
      if (saved && MODE_LABEL[saved]) return saved;
    } catch (e) { }
    return 'recent';
  }

  function saveMode(mode) {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch (e) { }
  }

  function moveTabIndicator() {
    const switchEl = $('opsSwitch');
    const indicator = $('opsTabIndicator');
    const active = switchEl?.querySelector('.ops-switch__btn.is-active');

    if (!switchEl || !indicator || !active) return;

    const switchRect = switchEl.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();

    indicator.style.width = `${activeRect.width}px`;
    indicator.style.transform = `translateX(${activeRect.left - switchRect.left}px)`;
  }

  function setActiveButton(mode) {
    document.querySelectorAll('.ops-switch__btn').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.mode === mode);
    });
    requestAnimationFrame(moveTabIndicator);
  }

  function updateSelectedKey(rows) {
    if (!rows.length) {
      state.selectedKey = '';
      return;
    }

    const exists = rows.some((row) => row.key === state.selectedKey);
    if (!exists) {
      state.selectedKey = rows[0].key;
    }
  }

  function setKpis(rows, unstable) {
    if (unstable) {
      if ($('kTotal')) $('kTotal').textContent = '--';
      if ($('kOpen')) $('kOpen').textContent = '--';
      if ($('kResolved')) $('kResolved').textContent = '--';
      if ($('kUnack')) $('kUnack').textContent = '--';
      return;
    }

    const openRows = rows.filter((row) => row.status === 'incidente');
    const resolvedRows = rows.filter((row) => row.status === 'resolvido');
    const unackRows = rows.filter((row) => row.ackRaw !== '1');

    if ($('kTotal')) $('kTotal').textContent = String(rows.length);
    if ($('kOpen')) $('kOpen').textContent = String(openRows.length);
    if ($('kResolved')) $('kResolved').textContent = String(resolvedRows.length);
    if ($('kUnack')) $('kUnack').textContent = String(unackRows.length);
  }

  function renderTable(rows, mode, unstable) {
    const body = $('opsRows');
    if (!body) return;

    if (unstable) {
      body.innerHTML = '<tr><td colspan="7">Aguardando dados do Zabbix. A última leitura veio vazia e foi ignorada.</td></tr>';
      return;
    }

    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="7">Nenhum evento de OLT encontrado em ${MODE_LABEL[mode].toLowerCase()}.</td></tr>`;
      return;
    }

    body.innerHTML = rows.slice(0, 40).map((row) => `
      <tr class="${row.key === state.selectedKey ? 'is-active' : ''}" data-row-key="${esc(row.key)}">
        <td>
          <div class="time-cell">
            <strong>${esc(row.timeLabel)}</strong>
            <span>${esc(row.dateLabel)}</span>
          </div>
        </td>
        <td><span class="sev-badge ${esc(row.severityClass)}">${esc(row.severityLabel)}</span></td>
        <td><span class="host-text">${esc(row.host)}</span></td>
        <td><span class="port-pill ${row.port === '--' ? 'empty' : ''}">${esc(row.port === '--' ? 'Sem porta' : row.port)}</span></td>
        <td>
          <div class="problem-text">${esc(row.problem)}</div>
          <div class="meta-text">
            <span class="status-text ${esc(row.status)}">${row.status === 'incidente' ? 'INCIDENTE' : 'RESOLVIDO'}</span>
          </div>
        </td>
        <td>${esc(row.ageLabel)}</td>
        <td><span class="ack-pill ${row.ackRaw === '1' ? 'ack' : 'unack'}">${esc(row.acknowledged)}</span></td>
      </tr>
    `).join('');
  }

  function renderSide(rows, mode, unstable) {
    const side = $('sideList');
    if (!side) return;

    if (unstable) {
      side.innerHTML = '<div class="ops-empty">Aguardando uma leitura válida do Zabbix...</div>';
      return;
    }

    const openRows = rows.filter((row) => row.status === 'incidente');
    const source = openRows.length ? openRows : rows;

    if (!source.length) {
      side.innerHTML = `<div class="ops-empty">Nenhum evento de OLT encontrado em ${MODE_LABEL[mode].toLowerCase()}.</div>`;
      return;
    }

    side.innerHTML = source.slice(0, 8).map((row) => `
      <div class="ops-card ${row.key === state.selectedKey ? 'is-active' : ''}" data-row-key="${esc(row.key)}">
        <div class="ops-card__top">
          <span class="ops-card__host">${esc(row.host)}</span>
          <span class="ops-card__port">${esc(row.port === '--' ? 'Sem porta' : row.port)}</span>
        </div>
        <span class="ops-card__problem">${esc(row.problem)}</span>
        <span class="ops-card__meta">${esc(row.severityLabel)} • ${esc(row.dateTimeLabel)} • ${esc(row.ageLabel)} • ${esc(row.acknowledged)}</span>
      </div>
    `).join('');
  }

  function animateSwitch() {
    const shell = $('opsShell');
    if (!shell) return;

    shell.classList.add('is-switching');
    clearTimeout(animateSwitch._timer);
    animateSwitch._timer = setTimeout(() => {
      shell.classList.remove('is-switching');
    }, 180);
  }

  function render(mode = state.mode) {
    const rows = state.rowsByMode[mode] || [];
    const usingCache = Boolean(state.cacheModes[mode]);
    const unstable = Boolean(state.unstableModes[mode]);

    state.mode = mode;
    saveMode(mode);
    updateSelectedKey(rows);

    if ($('opsStamp')) {
      if (unstable) {
        $('opsStamp').textContent = `Aguardando dados válidos em ${new Date().toLocaleString('pt-BR')}`;
      } else if (usingCache) {
        $('opsStamp').textContent = `Leitura instável em ${new Date().toLocaleString('pt-BR')} • mantendo último dado válido`;
      } else {
        $('opsStamp').textContent = `Atualizado em ${new Date().toLocaleString('pt-BR')}`;
      }
    }

    if ($('opsChip')) {
      if (unstable) {
        $('opsChip').textContent = 'Aguardando dados do Zabbix...';
      } else {
        $('opsChip').textContent = rows.length
          ? `${rows.length} evento(s) em ${MODE_LABEL[mode].toLowerCase()}${usingCache ? ' • último dado válido' : ''}`
          : `Sem dados em ${MODE_LABEL[mode].toLowerCase()}`;
      }
    }

    if ($('sideTitle')) {
      $('sideTitle').textContent = MODE_LABEL[mode];
    }

    setActiveButton(mode);
    setKpis(rows, unstable);
    renderTable(rows, mode, unstable);
    renderSide(rows, mode, unstable);
    animateSwitch();
  }

  function switchMode(mode) {
    if (!MODE_LABEL[mode]) return;
    render(mode);
  }

  function selectRow(key) {
    state.selectedKey = key;
    render(state.mode);
  }

  function scrollTableRowIntoView(key) {
    const row = Array.from(document.querySelectorAll('#opsRows tr[data-row-key]'))
      .find((el) => el.getAttribute('data-row-key') === key);

    if (row) {
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function bindEvents() {
    document.querySelectorAll('.ops-switch__btn').forEach((btn) => {
      btn.onclick = () => switchMode(btn.dataset.mode);
    });

    const rowsEl = $('opsRows');
    if (rowsEl) {
      rowsEl.onclick = (event) => {
        const row = event.target.closest('[data-row-key]');
        if (!row) return;
        selectRow(row.getAttribute('data-row-key'));
      };
    }

    const sideEl = $('sideList');
    if (sideEl) {
      sideEl.onclick = (event) => {
        const card = event.target.closest('[data-row-key]');
        if (!card) return;

        const key = card.getAttribute('data-row-key');
        selectRow(key);
        requestAnimationFrame(() => scrollTableRowIntoView(key));
      };
    }

    window.addEventListener('resize', moveTabIndicator);
  }

  const grouped = extractObjectsByRef();
  const recentRows = buildRows(grouped.A);
  const incidentRows = buildRows(grouped.B).filter((row) => row.status === 'incidente');
  const historyRows = buildRows(grouped.C);
  const combinedRows = dedupeRows([...recentRows, ...incidentRows, ...historyRows]);

  const freshRowsByMode = {
    recent: recentRows.length ? recentRows : combinedRows,
    incidents: incidentRows.length ? incidentRows : dedupeRows(recentRows.filter((row) => row.status === 'incidente')),
    history: historyRows.length ? historyRows : combinedRows
  };

  const cachedData = applyRowsCache(freshRowsByMode);

  state.rowsByMode = cachedData.rowsByMode;
  state.cacheModes = cachedData.cacheModes;
  state.unstableModes = cachedData.unstableModes;
  state.mode = readSavedMode();

  bindEvents();
  render(state.mode);
})();
