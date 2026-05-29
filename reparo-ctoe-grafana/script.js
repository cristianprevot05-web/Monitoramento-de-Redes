(() => {
  const root = document.getElementById('ctoShell');
  const $ = (id) => root?.querySelector(`#${id}`) || document.getElementById(id);

  const SETOR_IDS = new Set(['8']);
  const ASSUNTO_IDS = new Set(['103']);
  const CACHE_KEY = 'reparo_ctoe_last_valid_rows_v4';
  const MEMORY_KEY = '__reparoCtoeLastValidRowsV4';
  const CACHE_TTL_MS = 30 * 60 * 1000;

  const state = {
    search: '',
    expanded: new Set(),
    selectedKey: '',
    scopedRows: [],
    visibleRows: [],
    usingCache: false,
    dataUnstable: false
  };

  function kpi(name) {
    const map = {
      total: ['ctoKTotal', 'kTotal'],
      open: ['ctoKOpen', 'kOpen'],
      exec: ['ctoKExec', 'kExec']
    };

    for (const id of map[name] || []) {
      const node = root?.querySelector(`#${id}`);
      if (node) return node;
    }

    return null;
  }

  function safeString(value) {
    if (value == null) return '';
    return String(value).trim();
  }

  function normalizeText(value) {
    return safeString(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function normalizeId(value) {
    const raw = safeString(value);
    if (!raw) return '';

    const compact = raw.replace(/\s+/g, '').replace(',', '.');

    if (/^\d+(\.\d+)?$/.test(compact)) {
      return String(Math.trunc(Number(compact)));
    }

    const match = compact.match(/\d+/);
    return match ? match[0] : '';
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
    try {
      if (!values) return [];
      if (Array.isArray(values)) return values;
      if (typeof values.toArray === 'function') return values.toArray();
      if (Array.isArray(values.buffer)) return values.buffer;
      if (typeof values.length === 'number') return Array.from(values);
      return [];
    } catch (e) {
      return [];
    }
  }

  function parseDateMs(value) {
    const text = safeString(value);
    if (!text) return 0;
    if (text === '0000-00-00' || text === '0000-00-00 00:00:00') return 0;

    const parsed = Date.parse(text.replace(' ', 'T'));
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  function fmtDateTime(value) {
    const ms = parseDateMs(value);
    if (!ms) return '--';
    return new Date(ms).toLocaleString('pt-BR');
  }

  function fmtAge(value) {
    const ms = parseDateMs(value);
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

  function statusLabel(code) {
    const value = safeString(code).toUpperCase();
    const map = {
      A: 'Aberta',
      AG: 'Agendada',
      AN: 'Em análise',
      AS: 'Assumida',
      EX: 'Execução',
      F: 'Finalizada',
      C: 'Cancelada',
      E: 'Encaminhada'
    };
    return map[value] || (value || 'Sem status');
  }

  function statusClass(code) {
    const value = safeString(code).toUpperCase();

    if (value === 'F') return 'done';
    if (value === 'EX') return 'exec';
    if (['A', 'AG', 'AN', 'AS', 'E'].includes(value)) return 'open';

    return 'other';
  }

  function sortRank(row) {
    const cls = statusClass(row.statusCode);
    if (cls === 'open') return 0;
    if (cls === 'exec') return 1;
    if (cls === 'done') return 2;
    return 3;
  }

  function compactText() {
    return Array.from(arguments)
      .map((value) => safeString(value))
      .filter(Boolean)
      .filter((value, index, arr) => arr.indexOf(value) === index)
      .join('\n');
  }

  function firstUsefulValue() {
    for (const value of arguments) {
      const text = safeString(value);
      if (!text) continue;
      if (text === '0000-00-00') continue;
      if (text === '0000-00-00 00:00:00') continue;
      return text;
    }
    return '';
  }

  function extractTopicFromMessage(message, assunto, idAssunto) {
    const text = safeString(message);
    const match = text.match(/Processo:\s*(.+?)\.\s*Tarefa:\s*(.+?)(?:\r?\n|$)/i);

    if (match) return `${match[1]} • ${match[2]}`;
    if (safeString(assunto)) return safeString(assunto);
    if (safeString(idAssunto)) return `Assunto #${idAssunto}`;
    return 'ORDEM DE SERVIÇO';
  }

  function cleanMessageBody(message, messageResponse) {
    const response = safeString(messageResponse);
    if (response) return response;

    let text = safeString(message);
    if (!text) return '';

    text = text.replace(/Processo:\s*.+?\.\s*Tarefa:\s*.+?(?:\r?\n|$)/i, '').trim();
    return text;
  }

  function normalizeFrame(frame) {
    try {
      if (Array.isArray(frame?.fields)) {
        return {
          fields: frame.fields.map((field) => ({
            name: safeString(field?.name),
            values: toArray(field?.values)
          }))
        };
      }

      if (Array.isArray(frame?.schema?.fields) && Array.isArray(frame?.data?.values)) {
        return {
          fields: frame.schema.fields.map((field, i) => ({
            name: safeString(field?.name),
            values: toArray(frame.data.values[i])
          }))
        };
      }
    } catch (e) { }

    return null;
  }

  function getFrames() {
    const grafanaContext = typeof context === 'undefined' ? {} : context;

    return [
      ...(Array.isArray(grafanaContext?.panelData?.series) ? grafanaContext.panelData.series : []),
      ...(Array.isArray(grafanaContext?.data) ? grafanaContext.data : [])
    ]
      .map(normalizeFrame)
      .filter(Boolean);
  }

  function parseMaybeJson(value) {
    const text = safeString(value);
    if (!text) return null;
    if (!text.startsWith('{') && !text.startsWith('[')) return null;

    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function readObjectRows(frames) {
    const out = [];

    for (const frame of frames) {
      for (const field of frame.fields) {
        for (const value of field.values) {
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            out.push(value);
            continue;
          }

          const parsed = parseMaybeJson(value);

          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (item && typeof item === 'object' && !Array.isArray(item)) out.push(item);
            }
            continue;
          }

          if (parsed && typeof parsed === 'object' && Array.isArray(parsed.registros)) {
            for (const item of parsed.registros) {
              if (item && typeof item === 'object' && !Array.isArray(item)) out.push(item);
            }
          }
        }
      }
    }

    return out;
  }

  function pickField(fields, patterns) {
    return fields.find((field) => {
      const name = normalizeText(field?.name);
      return patterns.some((pattern) => pattern.test(name));
    });
  }

  function findValue(fields, patterns, index) {
    const field = pickField(fields, patterns);
    if (!field || !Array.isArray(field.values)) return '';
    return safeString(field.values[index]);
  }

  function readTabularRows(frames) {
    const rows = [];

    for (const frame of frames) {
      const fields = Array.isArray(frame?.fields) ? frame.fields : [];
      if (!fields.length) continue;

      const hasUsefulFields =
        pickField(fields, [/^id$/, /id_os/, /su_oss_chamado\.id/]) ||
        pickField(fields, [/id_assunto/]) ||
        pickField(fields, [/^setor$/, /id_setor/]) ||
        pickField(fields, [/^mensagem$/, /mensagem/]);

      if (!hasUsefulFields) continue;

      const size = Math.max(...fields.map((field) => Array.isArray(field.values) ? field.values.length : 0), 0);
      if (!size) continue;

      for (let i = 0; i < size; i++) {
        rows.push({
          id: findValue(fields, [/^id$/, /id_os/, /su_oss_chamado\.id/], i),
          status: findValue(fields, [/^status$/, /status_os/], i),
          assunto: findValue(fields, [/^assunto$/, /titulo/, /title/], i),
          id_assunto: findValue(fields, [/id_assunto/], i),
          setor: findValue(fields, [/^setor$/, /id_setor/, /departamento/], i),
          cidade: findValue(fields, [/^cidade$/], i),
          id_cidade: findValue(fields, [/id_cidade/], i),
          colaborador: findValue(fields, [/^colaborador$/, /funcionario/, /responsavel/, /responsável/], i),
          id_tecnico: findValue(fields, [/id_tecnico/], i),
          cliente: findValue(fields, [/^cliente$/, /nome_cliente/, /razao/], i),
          id_cliente: findValue(fields, [/id_cliente/], i),
          mensagem: findValue(fields, [/^mensagem$/, /mensagem/], i),
          mensagem_resposta: findValue(fields, [/mensagem_resposta/], i),
          endereco: findValue(fields, [/^endereco$/, /logradouro/, /rua/, /local/], i),
          bairro: findValue(fields, [/^bairro$/], i),
          referencia: findValue(fields, [/referencia/, /referência/], i),
          complemento: findValue(fields, [/complemento/], i),
          protocolo: findValue(fields, [/protocolo/], i),
          ultima_atualizacao: findValue(fields, [/ultima_atualizacao/], i),
          data_abertura: findValue(fields, [/data_abertura/], i),
          data_hora_analise: findValue(fields, [/data_hora_analise/], i),
          data_hora_encaminhado: findValue(fields, [/data_hora_encaminhado/], i),
          data_hora_execucao: findValue(fields, [/data_hora_execucao/], i),
          data_inicio: findValue(fields, [/data_inicio/], i),
          id_ticket: findValue(fields, [/id_ticket/], i)
        });
      }
    }

    return rows;
  }

  function normalizeFromItem(item) {
    const get = (...keys) => {
      for (const key of keys) {
        if (item?.[key] != null && String(item[key]).trim() !== '') return safeString(item[key]);
      }
      return '';
    };

    const idCliente = get('id_cliente', 'idCliente');
    const idTecnico = get('id_tecnico', 'idTecnico');
    const idAssunto = get('id_assunto', 'idAssunto');
    const mensagem = get('mensagem');
    const mensagemResposta = get('mensagem_resposta', 'mensagemResposta');

    const cliente =
      get('cliente', 'nome_cliente', 'razao') ||
      (idCliente ? `Cliente #${idCliente}` : '') ||
      'Cliente não informado';

    const colaborador =
      get('colaborador', 'funcionario', 'responsavel', 'responsável') ||
      (idTecnico && idTecnico !== '0' ? `Técnico #${idTecnico}` : '') ||
      cliente;

    const abertura = firstUsefulValue(
      get('data_abertura', 'dataAbertura'),
      get('data_hora_encaminhado', 'dataEncaminhado'),
      get('data_hora_analise', 'dataAnalise'),
      get('data_hora_execucao', 'dataExecucao'),
      get('data_inicio', 'dataInicio'),
      get('ultima_atualizacao', 'ultimaAtualizacao')
    ) || '--';

    const updatedAt = firstUsefulValue(get('ultima_atualizacao', 'ultimaAtualizacao'), abertura);

    return {
      key: [get('id', 'id_os') || '--', get('status', 'status_os'), updatedAt, get('protocolo')].join('|'),
      id: get('id', 'id_os') || '--',
      statusCode: get('status', 'status_os'),
      status: statusLabel(get('status', 'status_os')),
      cliente,
      colaborador,
      assunto: get('assunto', 'titulo', 'title'),
      idAssunto,
      setor: get('setor', 'id_setor', 'departamento'),
      cidade: get('cidade') || (get('id_cidade') ? `Cidade #${get('id_cidade')}` : ''),
      abertura,
      updatedAt,
      sortMs: parseDateMs(updatedAt),
      location: compactText(
        get('endereco', 'logradouro', 'rua', 'local'),
        get('bairro'),
        get('referencia', 'referência'),
        get('complemento')
      ),
      topic: extractTopicFromMessage(mensagem, get('assunto', 'titulo', 'title'), idAssunto),
      message: cleanMessageBody(mensagem, mensagemResposta),
      rawMessage: mensagem,
      protocolo: get('protocolo'),
      ticket: get('id_ticket', 'ticket')
    };
  }

  function normalizeRows() {
    const frames = getFrames();
    const source = [...readObjectRows(frames), ...readTabularRows(frames)];
    const deduped = new Map();

    for (const item of source) {
      const row = normalizeFromItem(item);

      const looksEmpty =
        row.id === '--' &&
        !row.topic &&
        !row.message &&
        !row.rawMessage &&
        !row.location &&
        !row.idAssunto &&
        !row.setor;

      if (looksEmpty) continue;
      if (!deduped.has(row.key)) deduped.set(row.key, row);
    }

    return Array.from(deduped.values());
  }

  function rowMatchesScope(row) {
    const setor = normalizeId(row.setor);
    const assunto = normalizeId(row.idAssunto || row.id_assunto);
    return SETOR_IDS.has(setor) && ASSUNTO_IDS.has(assunto);
  }

  function rowMatchesSearch(row) {
    if (!state.search) return true;

    const hay = normalizeText([
      row.id,
      row.status,
      row.cliente,
      row.assunto,
      row.idAssunto,
      row.setor,
      row.cidade,
      row.colaborador,
      row.location,
      row.topic,
      row.message,
      row.rawMessage,
      row.protocolo,
      row.ticket
    ].join(' '));

    return hay.includes(state.search);
  }

  function buildScopedRows(allRows) {
    return allRows
      .filter(rowMatchesScope)
      .sort((a, b) => {
        const rank = sortRank(a) - sortRank(b);
        if (rank !== 0) return rank;
        return b.sortMs - a.sortMs;
      });
  }

  function readCache() {
    const now = Date.now();
    const memoryPayload = window[MEMORY_KEY];

    if (
      memoryPayload &&
      Array.isArray(memoryPayload.rows) &&
      memoryPayload.rows.length &&
      now - Number(memoryPayload.savedAt || 0) < CACHE_TTL_MS
    ) {
      return memoryPayload.rows;
    }

    for (const storage of [localStorage, sessionStorage]) {
      try {
        const payload = JSON.parse(storage.getItem(CACHE_KEY) || '{}');

        if (
          Array.isArray(payload.rows) &&
          payload.rows.length &&
          now - Number(payload.savedAt || 0) < CACHE_TTL_MS
        ) {
          window[MEMORY_KEY] = payload;
          return payload.rows;
        }
      } catch (e) { }
    }

    return [];
  }

  function writeCache(rows) {
    if (!Array.isArray(rows) || !rows.length) return;

    const payload = {
      savedAt: Date.now(),
      rows
    };

    window[MEMORY_KEY] = payload;

    for (const storage of [localStorage, sessionStorage]) {
      try {
        storage.setItem(CACHE_KEY, JSON.stringify(payload));
      } catch (e) { }
    }
  }

  function updateSelectedKey() {
    if (!state.visibleRows.length) {
      state.selectedKey = '';
      return;
    }

    const exists = state.visibleRows.some((row) => row.key === state.selectedKey);
    if (!exists) state.selectedKey = state.visibleRows[0].key;
  }

  function setKpis() {
    if (state.dataUnstable && !state.scopedRows.length) {
      if (kpi('total')) kpi('total').textContent = '--';
      if (kpi('open')) kpi('open').textContent = '--';
      if (kpi('exec')) kpi('exec').textContent = '--';
      return;
    }

    const openRows = state.scopedRows.filter((row) => statusClass(row.statusCode) === 'open');
    const execRows = state.scopedRows.filter((row) => statusClass(row.statusCode) === 'exec');

    if (kpi('total')) kpi('total').textContent = String(state.scopedRows.length);
    if (kpi('open')) kpi('open').textContent = String(openRows.length);
    if (kpi('exec')) kpi('exec').textContent = String(execRows.length);
  }

  function showToast(text) {
    const toast = $('ctoToast');
    if (!toast) return;

    toast.textContent = text;
    toast.classList.add('is-visible');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => toast.classList.remove('is-visible'), 1600);
  }

  async function copyText(text) {
    const value = safeString(text);
    if (!value) return;

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const area = document.createElement('textarea');
        area.value = value;
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      showToast(`OS ${value} copiada`);
    } catch (e) {
      showToast('Não foi possível copiar');
    }
  }

  function animateRefresh() {
    const shellEl = $('ctoShell');
    if (!shellEl) return;

    shellEl.classList.add('is-refreshing');
    clearTimeout(animateRefresh._timer);
    animateRefresh._timer = setTimeout(() => shellEl.classList.remove('is-refreshing'), 180);
  }

  function renderFeed() {
    const feed = $('ctoFeed');
    if (!feed) return;

    if (state.dataUnstable && !state.scopedRows.length) {
      feed.innerHTML = `
        <div class="cto-empty">
          <strong>Aguardando dados do sistema</strong>
          <span>A última atualização veio vazia. O painel ignorou essa leitura para não zerar os indicadores.</span>
        </div>
      `;
      return;
    }

    if (!state.scopedRows.length) {
      feed.innerHTML = `
        <div class="cto-empty">
          <strong>Nenhuma O.S. encontrada</strong>
          <span>A query trouxe dados, mas nenhuma linha bateu com Infraestrutura e Reparo CTOE ao mesmo tempo.</span>
        </div>
      `;
      return;
    }

    if (!state.visibleRows.length) {
      feed.innerHTML = `
        <div class="cto-empty">
          <strong>Nenhum resultado para a busca atual</strong>
          <span>Existe base para Infraestrutura e Reparo CTOE, mas a busca atual zerou a lista.</span>
        </div>
      `;
      return;
    }

    feed.innerHTML = state.visibleRows.map((row) => {
      const expanded = state.expanded.has(row.key);
      const tone = statusClass(row.statusCode);
      const message = row.message || row.rawMessage || 'Sem mensagem detalhada cadastrada na ordem de serviço.';
      const isLong = message.length > 260 || message.includes('\n');

      return `
        <article class="cto-card cto-card--${tone} ${expanded ? 'is-expanded' : ''} ${row.key === state.selectedKey ? 'is-active' : ''}" data-row-key="${esc(row.key)}">
          <div class="cto-card__top">
            <div class="cto-card__author">${esc(row.colaborador || row.cliente)}</div>
            <div class="cto-card__actions">
              <span class="cto-pill">OS #${esc(row.id)}</span>
              <button type="button" class="cto-copy" data-copy="${esc(row.id)}">Copiar OS</button>
            </div>
          </div>

          <div class="cto-card__title">${esc(row.topic || 'ORDEM DE SERVIÇO')}</div>
          <div class="cto-card__location">${esc(row.location || 'LOCALIZAÇÃO NÃO INFORMADA')}</div>
          <div class="cto-card__message">${esc(message)}</div>

          ${isLong ? `<button type="button" class="cto-expand" data-expand="${esc(row.key)}">${expanded ? 'Mostrar menos' : 'Ler mais'}</button>` : ''}

          <div class="cto-card__footer">
            <div class="cto-card__badges">
              <span class="cto-badge ${tone}">${esc(row.status)}</span>
              ${row.cidade ? `<span class="cto-badge city">${esc(row.cidade)}</span>` : ''}
              ${row.protocolo ? `<span class="cto-badge meta">Protocolo ${esc(row.protocolo)}</span>` : ''}
              <span class="cto-badge meta">${esc(fmtAge(row.updatedAt))}</span>
            </div>
            <div class="cto-time">${esc(fmtDateTime(row.updatedAt))}</div>
          </div>
        </article>
      `;
    }).join('');
  }

  function updateHeaders() {
    const openCount = state.scopedRows.filter((row) => statusClass(row.statusCode) === 'open').length;
    const execCount = state.scopedRows.filter((row) => statusClass(row.statusCode) === 'exec').length;
    const latestRow = state.scopedRows[0];

    if ($('ctoStamp')) {
      if (state.usingCache) {
        $('ctoStamp').textContent = `Leitura instável em ${new Date().toLocaleString('pt-BR')} • mantendo último dado válido`;
      } else if (state.dataUnstable) {
        $('ctoStamp').textContent = `Aguardando dados válidos em ${new Date().toLocaleString('pt-BR')}`;
      } else {
        $('ctoStamp').textContent = `Atualizado em ${new Date().toLocaleString('pt-BR')}`;
      }
    }

    if ($('ctoScope')) {
      $('ctoScope').textContent = state.usingCache
        ? 'Infraestrutura • Reparo CTOE • último dado válido'
        : 'Infraestrutura • Reparo CTOE';
    }

    if ($('ctoSubtitle')) {
      if (state.usingCache) {
        $('ctoSubtitle').textContent = `${state.scopedRows.length} O.S. • ${openCount} abertas • ${execCount} em execução • último dado válido`;
      } else if (state.dataUnstable) {
        $('ctoSubtitle').textContent = 'Aguardando leitura válida do sistema';
      } else if (!state.scopedRows.length) {
        $('ctoSubtitle').textContent = 'Nenhuma O.S. encontrada no intervalo atual';
      } else if (state.search) {
        $('ctoSubtitle').textContent = `${state.visibleRows.length} resultado(s) filtrados • ${openCount} abertas • ${execCount} em execução`;
      } else {
        $('ctoSubtitle').textContent = `${state.scopedRows.length} O.S. • ${openCount} abertas • ${execCount} em execução`;
      }
    }

    if ($('ctoPanelTitle')) $('ctoPanelTitle').textContent = 'Fila operacional';

    if ($('ctoPanelMeta')) {
      $('ctoPanelMeta').textContent = state.usingCache
        ? 'Último dado válido mantido durante atualização instável'
        : state.search
          ? `${state.visibleRows.length} registro(s) na busca atual`
          : 'Ordenada por prioridade e última atualização';
    }

    if ($('ctoQuickVisible')) {
      $('ctoQuickVisible').textContent = state.dataUnstable && !state.scopedRows.length
        ? '-- O.S.'
        : `${state.visibleRows.length} O.S. visíveis`;
    }

    if ($('ctoQuickActivity')) {
      $('ctoQuickActivity').textContent = latestRow
        ? `Última atividade ${fmtAge(latestRow.updatedAt)}`
        : 'Última atividade --';
    }
  }

  function applyData() {
    const allRows = normalizeRows();
    const freshScopedRows = buildScopedRows(allRows);
    const cachedRows = readCache();

    if (freshScopedRows.length) {
      state.scopedRows = freshScopedRows;
      state.usingCache = false;
      state.dataUnstable = false;
      writeCache(freshScopedRows);
    } else if (cachedRows.length) {
      state.scopedRows = cachedRows;
      state.usingCache = true;
      state.dataUnstable = false;
    } else {
      state.scopedRows = [];
      state.usingCache = false;
      state.dataUnstable = allRows.length === 0;
    }

    state.visibleRows = state.scopedRows.filter(rowMatchesSearch);
  }

  function render() {
    applyData();
    updateSelectedKey();
    setKpis();
    updateHeaders();
    renderFeed();
    animateRefresh();
  }

  function forceRestoreIfZeroed() {
    const total = safeString(kpi('total')?.textContent);
    const open = safeString(kpi('open')?.textContent);
    const cachedRows = readCache();

    if (total === '0' && open === '0' && cachedRows.length) {
      state.scopedRows = cachedRows;
      state.visibleRows = state.scopedRows.filter(rowMatchesSearch);
      state.usingCache = true;
      state.dataUnstable = false;

      updateSelectedKey();
      setKpis();
      updateHeaders();
      renderFeed();
    }
  }

  function selectRow(key) {
    state.selectedKey = key;
    render();
  }

  const currentSearch = $('ctoSearch');
  if (currentSearch) {
    state.search = normalizeText(currentSearch.value);
    currentSearch.oninput = (event) => {
      state.search = normalizeText(event?.target?.value);
      render();
    };
  }

  const clearSearch = $('ctoClearSearch');
  if (clearSearch) {
    clearSearch.onclick = () => {
      state.search = '';
      if ($('ctoSearch')) $('ctoSearch').value = '';
      render();
    };
  }

  const feed = $('ctoFeed');
  if (feed) {
    feed.onclick = async (event) => {
      const copyBtn = event.target.closest('[data-copy]');
      if (copyBtn) {
        event.stopPropagation();
        await copyText(copyBtn.getAttribute('data-copy'));
        return;
      }

      const expandBtn = event.target.closest('[data-expand]');
      if (expandBtn) {
        event.stopPropagation();
        const key = expandBtn.getAttribute('data-expand');
        if (state.expanded.has(key)) state.expanded.delete(key);
        else state.expanded.add(key);
        render();
        return;
      }

      const card = event.target.closest('[data-row-key]');
      if (card) selectRow(card.getAttribute('data-row-key'));
    };
  }

  render();
  forceRestoreIfZeroed();

  if (root) {
    new MutationObserver(forceRestoreIfZeroed).observe(root, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  setInterval(forceRestoreIfZeroed, 1000);
})();
