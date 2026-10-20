import * as vscode from 'vscode';
import { CreditUsage, ModelUsage, UsageResponse } from './api';
import { AccountsState } from './accountStore';

// Blue palette, one shade per model (by index).
const PALETTE = ['#2563eb', '#3b82f6', '#4f46e5', '#60a5fa', '#1d4ed8', '#6366f1', '#818cf8', '#93c5fd'];

function pct(usage: number): number {
  return Math.round(usage * 100);
}

function colorFor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

function segmentsHtml(models: ModelUsage[], usage: number): string {
  if (!models.length) {
    return '<div class="bar"></div>';
  }
  const total = models.reduce((s, m) => s + m.request_count, 0);
  if (!total) {
    return '<div class="bar"></div>';
  }
  const fillWidth = usage * 100; // filled portion = window usage %
  const segs = models.map((m, i) => {
    const w = (m.request_count / total) * fillWidth;
    return `<div class="seg" style="width:${w}%;background:${colorFor(i)}" data-name="${escapeHtml(m.name)}" data-count="${m.request_count.toLocaleString()}"></div>`;
  }).join('');
  return `<div class="bar">${segs}</div>`;
}

function countdownHtml(resetIso: string | undefined): string {
  if (!resetIso) {
    return '';
  }
  return `<div class="reset">Resets in <span data-reset="${escapeHtml(resetIso)}">…</span>.</div>`;
}

function rowHtml(label: string, usage: number, models: ModelUsage[], resetIso: string | undefined): string {
  return `<div class="row">
    <div class="row-head">
      <span class="row-label">${label}</span>
      <span class="row-pct">${pct(usage)}% used</span>
    </div>
    ${segmentsHtml(models, usage)}
    ${countdownHtml(resetIso)}
  </div>`;
}

function creditsRowHtml(credits: CreditUsage): string {
  return `<div class="row">
    <div class="row-head">
      <span class="row-label">Included credits</span>
      <span class="row-pct">$${credits.balance_usd.toFixed(2)} of $${credits.allowance_usd.toFixed(2)} left</span>
    </div>
    ${segmentsHtml(credits.models, credits.usage)}
    ${countdownHtml(credits.period.until)}
  </div>`;
}

function modelListHtml(models: ModelUsage[]): string {
  if (!models.length) {
    return '<div class="empty">No model requests</div>';
  }
  return models.map((m, i) =>
    `<div class="model">
      <span class="dot" style="color:${colorFor(i)}">●</span>
      <span class="model-name">${escapeHtml(m.name)}</span>
      <span class="model-count">${m.request_count.toLocaleString()} requests</span>
    </div>`,
  ).join('');
}

function modelGroupHtml(label: string, models: ModelUsage[]): string {
  return `<div class="group">
      <div class="group-label">${label}</div>
      <div class="models">${modelListHtml(models)}</div>
    </div>`;
}

function accountsHtml(state: AccountsState): string {
  const opts = state.accounts.map((a) =>
    `<option value="${a.id}" ${a.id === state.activeId ? 'selected' : ''}>${escapeHtml(a.label)}</option>`,
  ).join('');
  return `<div class="accounts">
    <select class="account-select" data-cmd="switchAccount">${opts}</select>
    <button class="icon-btn" data-cmd="addAccount" title="Add account">＋</button>
    <button class="icon-btn" data-cmd="removeAccount" title="Remove account" ${state.accounts.length ? '' : 'disabled'}>－</button>
  </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function usageBodyHtml(usage: UsageResponse): string {
  const sections: string[] = [];

  if (usage.session) {
    sections.push(rowHtml('Session usage', usage.session.usage, usage.session.models, usage.session.resets_at));
    sections.push(modelGroupHtml('Models used this session', usage.session.models));
  }

  if (usage.weekly) {
    sections.push('<div class="spacer"></div>');
    sections.push(rowHtml('Weekly usage', usage.weekly.usage, usage.weekly.models, usage.weekly.resets_at));
    sections.push(modelGroupHtml('Models used this week', usage.weekly.models));
  }

  if (usage.credits) {
    sections.push(creditsRowHtml(usage.credits));
    sections.push(modelGroupHtml('Models used this period', usage.credits.models));
    if (usage.credits.purchased_usd !== undefined && usage.credits.purchased_usd > 0) {
      sections.push(`<div class="hint">Purchased credits: $${usage.credits.purchased_usd.toFixed(2)}</div>`);
    }
  }

  if (usage.spend) {
    const cost = usage.spend.cost_usd === undefined ? '' : `$${usage.spend.cost_usd.toFixed(2)} · `;
    const label = usage.spend.cost_usd === undefined ? 'Requests' : 'Spend';
    sections.push(`<div class="group">
      <div class="group-label">${label} (${escapeHtml(usage.spend.range)})</div>
      <div class="spend">${cost}${usage.spend.request_count.toLocaleString()} requests</div>
    </div>`);
  }

  return sections.join('\n');
}

function bodyHtml(usage: UsageResponse | undefined, error: string | undefined, loading: boolean, accounts: AccountsState): string {
  const toolbar = `<div class="toolbar">
    <h2>☁ Cloud usage</h2>
    <div class="actions">
      <button class="icon-btn" data-cmd="refresh" title="Refresh">⟳</button>
    </div>
  </div>
  ${accountsHtml(accounts)}`;

  if (loading) {
    return `${toolbar}<div class="state">Loading Ollama usage…</div>`;
  }
  if (error) {
    return `${toolbar}<div class="state error">⚠ ${escapeHtml(error)}</div>
      <button class="btn" data-cmd="addAccount">Add API Key</button>`;
  }
  if (!usage) {
    return `${toolbar}<div class="state">No data.</div>`;
  }
  return `${toolbar}${usageBodyHtml(usage)}`;
}

const CSS = `
  body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); margin: 0; max-width: 480px; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
  .toolbar h2 { margin: 0; }
  .actions { display: flex; gap: 4px; }
  .icon-btn { background: none; border: none; cursor: pointer; font-size: 15px; padding: 4px 6px; border-radius: 4px; color: var(--vscode-foreground); opacity: 0.7; line-height: 1; }
  .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .icon-btn:disabled { opacity: 0.3; cursor: default; }
  .accounts { display: flex; align-items: center; gap: 8px; margin-bottom: 18px; }
  .account-select { flex: 1; font-family: var(--vscode-font-family); font-size: 12px; padding: 4px 8px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; }
  h2 { font-size: 14px; font-weight: 600; margin: 0 0 18px 0; }
  .row { margin-bottom: 16px; }
  .row-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; gap: 12px; }
  .row-label { font-size: 13px; font-weight: 500; }
  .row-pct { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
  .reset { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; font-variant-numeric: tabular-nums; }
  .bar { background: var(--vscode-scrollbarSlider-background); border-radius: 6px; height: 6px; overflow: hidden; display: flex; }
  .seg { height: 6px; transition: width .3s ease; cursor: default; }
  #tip { display: none; position: fixed; z-index: 10; background: var(--vscode-editorHoverWidget-background); color: var(--vscode-editorHoverWidget-foreground); border: 1px solid var(--vscode-editorHoverWidget-border); border-radius: 4px; padding: 6px 8px; font-size: 12px; font-variant-numeric: tabular-nums; pointer-events: none; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
  .group { margin-top: 20px; }
  .spacer { height: 20px; }
  .group-label { font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
  .models { display: flex; flex-direction: column; gap: 6px; }
  .model { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 3px 0; }
  .dot { font-size: 10px; line-height: 1; }
  .model-name { flex: 1; }
  .model-count { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  .spend { font-size: 12px; font-variant-numeric: tabular-nums; }
  .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; }
  .empty { font-size: 12px; color: var(--vscode-descriptionForeground); }
  .state { padding: 20px 0; text-align: center; color: var(--vscode-descriptionForeground); }
  .state.error { color: #f48771; }
  .btn { margin-top: 12px; padding: 6px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
`;

export class UsagePanel {
  private panel: vscode.WebviewPanel | undefined;

  show(usage: UsageResponse | undefined, error: string | undefined, loading: boolean, accounts: AccountsState): void {
    if (this.panel) {
      this.panel.reveal();
      this.render(usage, error, loading, accounts);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'ollamaCloudUsage',
      'Ollama Cloud Usage',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg.cmd === 'refresh') {
        void vscode.commands.executeCommand('ollamaCloud.refresh');
      } else if (msg.cmd === 'addAccount') {
        void vscode.commands.executeCommand('ollamaCloud.addAccount');
      } else if (msg.cmd === 'removeAccount') {
        void vscode.commands.executeCommand('ollamaCloud.removeAccount');
      } else if (msg.cmd === 'switchAccount') {
        void vscode.commands.executeCommand('ollamaCloud.switchAccount', msg.id);
      }
    });
    this.panel.onDidDispose(() => { this.panel = undefined; });
    this.render(usage, error, loading, accounts);
  }

  render(usage: UsageResponse | undefined, error: string | undefined, loading: boolean, accounts: AccountsState): void {
    if (!this.panel) {
      return;
    }
    const script = `<script>
      const vscode = acquireVsCodeApi();
      document.body.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-cmd]');
        if (btn) { vscode.postMessage({ cmd: btn.dataset.cmd }); }
      });
      const sel = document.querySelector('select[data-cmd]');
      if (sel) { sel.addEventListener('change', (e) => { vscode.postMessage({ cmd: 'switchAccount', id: e.target.value }); }); }

      const tip = document.getElementById('tip');
      document.addEventListener('mouseover', (e) => {
        const seg = e.target.closest('.seg');
        if (!seg || !tip) { return; }
        const name = document.createElement('strong');
        name.textContent = seg.dataset.name;
        tip.replaceChildren(name, document.createElement('br'), document.createTextNode(seg.dataset.count + ' requests'));
        tip.style.display = 'block';
      });
      document.addEventListener('mousemove', (e) => {
        if (!tip || tip.style.display === 'block') { tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 12) + 'px'; }
      });
      document.addEventListener('mouseout', (e) => {
        if (e.target.closest('.seg') && tip) { tip.style.display = 'none'; }
      });

      function format(ms) {
        const s = Math.round(ms / 1000);
        const m = Math.floor(s / 60);
        const h = Math.floor(m / 60);
        const days = Math.floor(h / 24);
        if (days >= 1) { return days + ' day' + (days > 1 ? 's' : ''); }
        if (h >= 1) { return h + ' hour' + (h > 1 ? 's' : '') + (m % 60 ? ' ' + (m % 60) + ' min' : ''); }
        if (m >= 1) { return m + ' minute' + (m > 1 ? 's' : ''); }
        return s + ' second' + (s > 1 ? 's' : '');
      }
      // Reset times come from the API (/api/balance resets_at / period.until).
      function tick() {
        const now = Date.now();
        document.querySelectorAll('[data-reset]').forEach(el => {
          const resetMs = Date.parse(el.dataset.reset);
          if (!Number.isFinite(resetMs)) { el.textContent = '—'; return; }
          const remaining = resetMs - now;
          el.textContent = remaining <= 0 ? 'now' : format(remaining);
        });
      }
      tick();
      setInterval(tick, 1000);
    </script>`;
    this.panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${CSS}</style></head>
      <body>${bodyHtml(usage, error, loading, accounts)}<div id="tip"></div>${script}</body></html>`;
  }
}
