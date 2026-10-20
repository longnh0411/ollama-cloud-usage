import * as vscode from 'vscode';
import { UsageTreeProvider } from './usageTreeProvider';
import { UsagePanel } from './webviewViewProvider';
import { AccountStore } from './accountStore';

const REFRESH_INTERVAL_MS = 60 * 1000;
const TOOLTIP_TICK_MS = 1000;

let refreshTimer: NodeJS.Timeout | undefined;
let tooltipTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const store = new AccountStore(context.secrets);
  const provider = new UsageTreeProvider(store);
  const panel = new UsagePanel();

  const usageBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  usageBar.name = 'Ollama Cloud Usage';
  usageBar.tooltip = 'Click to open detail panel';
  usageBar.command = 'ollamaCloud.openPanel';
  usageBar.show();

  context.subscriptions.push(
    usageBar,
    provider.onDidChangeStatus(({ text, tooltip, backgroundColor }) => {
      usageBar.text = text;
      usageBar.tooltip = tooltip;
      usageBar.backgroundColor = backgroundColor;
      usageBar.color = undefined;
    }),
    provider.onDidChangeData(({ usage, error, loading, accounts }) => {
      panel.render(usage, error, loading, accounts);
    }),
    vscode.commands.registerCommand('ollamaCloud.openPanel', () => {
      const d = provider.getData();
      panel.show(d.usage, d.error, d.loading, d.accounts);
    }),
    vscode.commands.registerCommand('ollamaCloud.refresh', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Refreshing Ollama Cloud usage' },
        () => provider.refresh(),
      );
    }),
    vscode.commands.registerCommand('ollamaCloud.addAccount', async () => {
      const label = await vscode.window.showInputBox({
        prompt: 'Account label (e.g. work, personal)',
        ignoreFocusOut: true,
        validateInput: (v) => v.trim() ? undefined : 'Label cannot be empty.',
      });
      if (label === undefined) {
        return;
      }
      const apiKey = await vscode.window.showInputBox({
        prompt: 'Enter Ollama API key',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => v.trim() ? undefined : 'API key cannot be empty.',
      });
      if (apiKey === undefined) {
        return;
      }
      await store.add(label, apiKey);
      await provider.refresh();
    }),
    vscode.commands.registerCommand('ollamaCloud.removeAccount', async () => {
      const state = await provider.getAccounts();
      if (!state.accounts.length) {
        return;
      }
      const items = state.accounts.map((a) => ({
        label: a.label,
        id: a.id,
      } as vscode.QuickPickItem & { id: string }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select account to remove',
        ignoreFocusOut: true,
      });
      if (!picked) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `Remove account "${picked.label}"?`,
        { modal: true },
        'Remove',
      );
      if (answer !== 'Remove') {
        return;
      }
      await store.remove((picked as vscode.QuickPickItem & { id: string }).id);
      await provider.refresh();
    }),
    vscode.commands.registerCommand('ollamaCloud.switchAccount', async (id: string) => {
      await store.setActive(id);
      await provider.refresh();
    }),
  );

  void provider.refresh();
  refreshTimer = setInterval(() => void provider.refresh(), REFRESH_INTERVAL_MS);
  tooltipTimer = setInterval(() => {
    if (provider.getUsage()) {
      usageBar.tooltip = provider.buildTooltip();
    }
  }, TOOLTIP_TICK_MS);
}

export function deactivate(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
  if (tooltipTimer) {
    clearInterval(tooltipTimer);
    tooltipTimer = undefined;
  }
}