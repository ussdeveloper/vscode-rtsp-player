import * as vscode from 'vscode';
import { log, redact } from './log';import {
  describeStreamLabel,
  getRecentUrls,
  onDidChangeRecent,
  removeRecentUrl,
} from './streams';

export interface ActionNode {
  kind: 'action';
  id: string;
  label: string;
  description: string;
  icon: string;
}

export interface RecentNode {
  kind: 'recent';
  url: string;
}

export type RecentTreeNode = ActionNode | RecentNode;

/** TreeItem carrying the source URL, so inline actions work with either shape. */
interface StreamTreeItem extends vscode.TreeItem {
  url?: string;
}

const ACTIONS: ActionNode[] = [
  {
    kind: 'action',
    id: 'rtspPlayer.open',
    label: 'Open Stream…',
    description: 'pick from history or enter a URL',
    icon: 'add',
  },
  {
    kind: 'action',
    id: 'rtspPlayer.openUrl',
    label: 'Open from Clipboard',
    description: 'paste an RTSP URL',
    icon: 'clippy',
  },
];

/**
 * Activity bar view listing recent streams. Items only ever show a label
 * without credentials; the full URL stays in the command argument.
 */
export class RecentStreamsProvider implements vscode.TreeDataProvider<RecentTreeNode> {  private readonly emitter = new vscode.EventEmitter<RecentTreeNode | undefined>();
  private readonly observer: vscode.Disposable;

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.observer = onDidChangeRecent(() => this.refresh());
  }

  refresh(): void {
    try {
      this.emitter.fire(undefined);
      log('recent view: refresh requested');
    } catch (err) {
      // Rendering errors must not propagate into the caller (e.g. play()).
      log(`recent view: refresh failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  dispose(): void {
    this.observer.dispose();
    this.emitter.dispose();
  }

  getTreeItem(node: RecentTreeNode): vscode.TreeItem {
    if (node.kind === 'action') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.description = node.description;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.command = { command: node.id, title: node.label };
      item.contextValue = 'rtspPlayerAction';
      return item;
    }

    const item: StreamTreeItem = new vscode.TreeItem(
      describeStreamLabel(node.url),
      vscode.TreeItemCollapsibleState.None,
    );
    item.url = node.url;
    item.description = 'recent';
    item.tooltip = redact(node.url);
    item.iconPath = new vscode.ThemeIcon('device-camera-video');
    item.command = {
      command: 'rtspPlayer.open',
      title: 'Open stream',
      arguments: [node.url],
    };
    item.contextValue = 'rtspPlayerRecent';
    return item;
  }

  getChildren(node?: RecentTreeNode): RecentTreeNode[] {
    if (node) {
      return [];
    }
    const recent = getRecentUrls(this.context).map<RecentNode>((url) => ({ kind: 'recent', url }));
    log(`recent view: getChildren -> ${recent.length} recent + ${ACTIONS.length} actions`);
    return [...ACTIONS, ...recent];
  }

  getParent(): undefined {
    return undefined;
  }

  /** Resolves the URL behind a context-menu/inline command argument. */
  static urlOf(argument: unknown): string | undefined {
    if (typeof argument === 'string') {
      return argument;
    }
    if (argument && typeof argument === 'object') {
      const candidate = argument as { url?: unknown; kind?: unknown };
      if (typeof candidate.url === 'string') {
        return candidate.url;
      }
    }
    return undefined;
  }
}

export async function removeRecentCommand(
  context: vscode.ExtensionContext,
  provider: RecentStreamsProvider,
  argument: unknown,
): Promise<void> {
  const url = RecentStreamsProvider.urlOf(argument);
  if (!url) {
    return;
  }
  await removeRecentUrl(context, url);
  log(`recent list: removed ${redact(url)}`);
  provider.refresh();
}
