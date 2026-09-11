/** Locale dictionaries for remote-host UI. */

export const zh = {
  'nav': '远程主机',
  'add.project': '添加远程项目',
  'add.machine': '添加主机',
  'field.label': '名称',
  'field.target': '地址',
  'field.auth': '凭证',
  'field.auth.hint': '可选，默认 Tailscale 同网段免凭证',
  'field.path': '目录路径',
  'field.path.hint': '该机器上的绝对路径，例如 C:\\Users\\ricar\\ComfyUI',
  'field.target.hint': '另一台 DSH 的地址，例如 http://127.0.0.1:3081 或 http://gpu.tailnet.ts.net:3080',
  'field.machine': '机器',
  'field.projectName': '项目名称',
  'action.probe': '测试连接',
  'action.remove': '移除',
  'action.cancel': '取消',
  'action.open': '添加',
  'action.select': '使用此文件夹',
  'empty': '还没有远程主机。先添加一台同一台电脑或 Tailscale 局域网里的 DSH。',
  'error': '无法完成该操作。',
  'dialog.title': '从远程机器添加项目',
  'dialog.close': '关闭',
  'card.title': '远程主机',
  'card.desc': '使用同一台电脑或 Tailscale 局域网里另一台 DSH 上的项目。',
  'browse.current': '当前文件夹',
  'browse.parent': '上级目录',
  'browse.loading': '加载中…',
  'browse.empty': '此目录没有子目录。',
} as const

export const en = {
  'nav': 'Remote hosts',
  'add.project': 'Add remote project',
  'add.machine': 'Add host',
  'field.label': 'Name',
  'field.target': 'Address',
  'field.auth': 'Credential',
  'field.auth.hint': 'Optional, Tailscale peers need no credential by default',
  'field.path': 'Directory path',
  'field.path.hint': 'Absolute folder on that machine, for example C:\\Users\\ricar\\ComfyUI',
  'field.target.hint': 'Another DSH address, for example http://127.0.0.1:3081 or http://gpu.tailnet.ts.net:3080',
  'field.machine': 'Machine',
  'field.projectName': 'Project name',
  'action.probe': 'Test connection',
  'action.remove': 'Remove',
  'action.cancel': 'Cancel',
  'action.open': 'Add',
  'action.select': 'Use this folder',
  'empty': 'No remote hosts yet. Add a DSH on this machine or the Tailscale LAN.',
  'error': 'Could not complete that action.',
  'dialog.title': 'Add a project from a remote machine',
  'dialog.close': 'Close',
  'card.title': 'Remote hosts',
  'card.desc': 'Work on projects that live on another DSH on this machine or the Tailscale LAN.',
  'browse.current': 'Current folder',
  'browse.parent': 'Parent directory',
  'browse.loading': 'Loading…',
  'browse.empty': 'This directory has no subdirectories.',
} as const satisfies Record<keyof typeof zh, string>

export type RemoteHostKey = keyof typeof zh

export const NS = 'remoteHosts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    remoteHosts: RemoteHostKey
  }
}
