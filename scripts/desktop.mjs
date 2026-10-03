import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

// While a document is hidden — a background tab, or a window behind another app — Figma Desktop
// does not load pages for plugins: page.loadAsync() and setCurrentPageAsync() fail after ten
// seconds with a connection error. The same pages load at once when the tab is visible.
export const BACKGROUND_LOAD = /Unable to establish connection to Figma/i;

export function desktopSettingsPath(platform = process.platform, env = process.env, home = homedir()) {
  if (env.FIGMA_DESKTOP_SETTINGS) return env.FIGMA_DESKTOP_SETTINGS;
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Figma', 'settings.json');
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Figma', 'settings.json');
  return null;
}

// Tab paths look like /file/KEY, /design/KEY/slug or /design/KEY/branch/BRANCH_KEY.
export function fileKeyFromPath(path) {
  const match = /^\/(?:file|design|board|proto|slides)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?/.exec(String(path ?? ''));
  return match ? match[2] ?? match[1] : null;
}

export function openTabs(settings) {
  const tabs = [];
  for (const window of Array.isArray(settings?.windows) ? settings.windows : []) {
    for (const tab of Array.isArray(window?.tabs) ? window.tabs : []) {
      const fileKey = fileKeyFromPath(tab?.path);
      if (fileKey && typeof tab.title === 'string') tabs.push({ title: tab.title, fileKey });
    }
  }
  return tabs;
}

// The plugin API gives fileKey only to private plugins, so the open tab is found by file name.
export function resolveTab(tabs, fileName) {
  const keys = [...new Set(tabs.filter(tab => tab.title === fileName).map(tab => tab.fileKey))];
  if (keys.length === 1) return { fileKey: keys[0] };
  if (!keys.length) return { reason: `No open Figma Desktop tab is named "${fileName}".` };
  return { reason: `Several open Figma Desktop tabs are named "${fileName}"; bring the right one to front manually.` };
}

export async function findFileKey(fileName, path = desktopSettingsPath()) {
  if (!path) return { reason: 'Figma Desktop tab state is available only on macOS and Windows.' };
  let settings;
  try { settings = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { return { reason: `Figma Desktop tab state is unreadable: ${error.message}` }; }
  return resolveTab(openTabs(settings), fileName);
}

export function figmaURL(fileKey, nodeId) {
  if (!/^[A-Za-z0-9]+$/.test(fileKey)) throw new Error('Invalid Figma file key.');
  const url = new URL(`figma://file/${fileKey}`);
  if (nodeId) url.searchParams.set('node-id', String(nodeId).replace(':', '-'));
  return url.href;
}

const run = promisify(execFile);
export async function openInDesktop(url, platform = process.platform) {
  if (!url.startsWith('figma://file/')) throw new Error('Only figma://file links are opened.');
  if (platform === 'darwin') await run('open', [url]);
  else if (platform === 'win32') await run('cmd', ['/c', 'start', '""', url]);
  else throw new Error('Bringing a Figma Desktop tab to front is supported on macOS and Windows.');
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Plugins built before visibility reporting leave it unknown (null).
export async function sessionVisibility(api, session) {
  try {
    const sessions = (await api.status?.())?.sessions ?? [];
    const match = session ? sessions.find(item => item.id === session) : sessions.length === 1 ? sessions[0] : undefined;
    return typeof match?.visible === 'boolean' ? match.visible : null;
  } catch { return null; }
}

// Brings the session's file tab to front on the target page and waits until the editor shows it.
export async function bringToFront(api, session, target, { timeoutMs = 30000, find = findFileKey, open = openInDesktop, sleep = pause } = {}) {
  const context = (await api.rpc('context', {}, session, 10000)).result;
  const located = context.fileKey ? { fileKey: context.fileKey } : await find(context.fileName);
  if (!located.fileKey) {
    const error = new Error(`${located.reason} Open the file tab in Figma Desktop and retry.`);
    error.code = 'TAB_NOT_FOUND';
    throw error;
  }
  const url = figmaURL(located.fileKey, target.nodeId ?? target.pageId);
  await open(url);
  // A node link opens the node's page, which is unknown here: wait for any page change, briefly.
  const deadline = Date.now() + (target.pageId ? timeoutMs : Math.min(timeoutMs, 5000));
  let page = context.page;
  while (Date.now() < deadline) {
    await sleep(500);
    page = (await api.rpc('context', {}, session, 10000)).result.page;
    if (target.pageId ? page.id === target.pageId : page.id !== context.page.id) return { url, page };
  }
  if (target.pageId) {
    const hidden = await sessionVisibility(api, session) === false;
    const error = new Error(hidden
      ? `Figma Desktop received the link, but the file stays hidden (macOS keeps another app in front), so page ${target.pageId} did not load. Bring the Figma window forward and retry.`
      : `Figma Desktop did not open page ${target.pageId} within ${Math.round(timeoutMs / 1000)} s. Bring the Figma window forward and retry.`);
    error.code = 'PAGE_UNAVAILABLE';
    throw error;
  }
  return { url, page };
}
