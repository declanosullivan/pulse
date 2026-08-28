import { CFG } from './config.js';
import { $, downloadBlob, escapeHtml } from './utils.js';

const logHistory = [];
let logTableDirty = false;
let logLastRenderTime = 0;

export function logParamChange(source, target, param, detail) {
  const now = new Date();
  const ts =
    now.toLocaleTimeString('en', { hour12: false }) +
    '.' +
    String(now.getMilliseconds()).padStart(3, '0');
  logHistory.push({ time: ts, source, target, param, detail });
  if (logHistory.length > CFG.LOG_MAX_ENTRIES) logHistory.shift();
  logTableDirty = true;
}

export function clearLog() {
  logHistory.length = 0;
  renderLogTable();
}

export function renderLogTable() {
  const tbody = $('log-tbody');
  const badge = $('log-count-badge');
  if (!tbody) return;
  if (badge) badge.textContent = `${logHistory.length} events`;

  tbody.replaceChildren();

  if (logHistory.length === 0) {
    const empty = document.createElement('tr');
    empty.className = 'log-empty';
    empty.innerHTML =
      '<td colspan="5">No activity yet. Start playback or enable Var Engine / Conductor.</td>';
    tbody.appendChild(empty);
    logTableDirty = false;
    return;
  }

  const frag = document.createDocumentFragment();
  const start = Math.max(0, logHistory.length - CFG.LOG_VISIBLE_ROWS);
  for (let i = logHistory.length - 1; i >= start; i--) {
    const e = logHistory[i];
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="muted">${escapeHtml(e.time)}</td>` +
      `<td>${escapeHtml(e.source)}</td>` +
      `<td>${escapeHtml(e.target)}</td>` +
      `<td class="accent">${escapeHtml(e.param)}</td>` +
      `<td>${escapeHtml(e.detail)}</td>`;
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  logTableDirty = false;

  if ($('log-autoscroll')?.checked) {
    const container = $('log-table-container');
    if (container) container.scrollTop = 0;
  }
}

export function maybeRenderLog(time) {
  if (logTableDirty && time - logLastRenderTime > CFG.LOG_RENDER_MS) {
    renderLogTable();
    logLastRenderTime = time;
  }
}

export function exportLogCsv() {
  if (logHistory.length === 0) return;
  const header = 'Time,Source,Target,Parameter,Detail\n';
  const rows = logHistory
    .map(
      (e) =>
        `"${e.time}","${e.source}","${e.target}","${e.param}","${e.detail}"`,
    )
    .join('\n');
  downloadBlob(new Blob([header + rows], { type: 'text/csv' }), `pulseforge-log-${Date.now()}.csv`);
}
