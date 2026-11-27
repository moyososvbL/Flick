// Flick for Windows: the Flick window + the built-in remote (helper.js) in one app.
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, session, screen, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');

const SITE = 'https://flickvs.netlify.app/';
const ICON = path.join(__dirname, 'build', 'icon.png');
const hidden = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('app.flick.windows');

// Retire the earlier background-only Flick.exe if it's still installed.
try { execSync('reg delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v Flick /f', { stdio: 'ignore' }); } catch {}
try { execSync(`powershell -NoProfile -WindowStyle Hidden -Command "Get-Process Flick -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\\AppData\\Local\\Flick\\Flick.exe' } | Stop-Process -Force"`, { stdio: 'ignore', windowsHide: true }); } catch {}

let win, tray, quitting = false;
function show() { if (!win) createWindow(); win.show(); win.focus(); }
function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 760, minHeight: 560, show: false, backgroundColor: '#000000', icon: ICON, title: 'Flick',
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#000000', symbolColor: '#9aa3b2', height: 36 },
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  });
  win.loadURL(SITE).catch(() => win.loadURL('data:text/html,' + encodeURIComponent(
    '<body style="background:#000;color:#9aa3b2;font:15px Segoe UI;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">You’re offline. Flick will connect when the internet is back.<script>setTimeout(()=>location.href="' + SITE + '",8000)</script></body>')));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(SITE) && !url.startsWith('data:')) { e.preventDefault(); shell.openExternal(url); } });
  win.once('ready-to-show', () => { if (!hidden) win.show(); });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
}

// ---------- Edge Drop: a thin strip on the right edge of the screen ----------
let edge, edgeOn = true;
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', mp4: 'video/mp4', mov: 'video/quicktime', pdf: 'application/pdf', txt: 'text/plain', zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', mp3: 'audio/mpeg' };
function edgeBounds(open) {
  const wa = screen.getPrimaryDisplay().workArea, h = Math.round(wa.height * 0.6), w = open ? 300 : 3;
  return { x: wa.x + wa.width - w, y: wa.y + Math.round((wa.height - h) / 2), width: w, height: h };
}
function createEdge() {
  if (edge || !edgeOn) return;
  edge = new BrowserWindow({ ...edgeBounds(false), frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false,
    webPreferences: { contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'edge-preload.js') } });
  edge.setAlwaysOnTop(true, 'floating'); edge.setVisibleOnAllWorkspaces(true);
  edge.loadFile(path.join(__dirname, 'edge.html'));
  edge.once('ready-to-show', () => edge.showInactive());
  edge.on('closed', () => (edge = null));
}
ipcMain.on('edge-open', (_e, on) => edge?.setBounds(edgeBounds(on)));
ipcMain.on('edge-target', (_e, t) => edge?.webContents.send('target', t));
ipcMain.on('edge-result', (_e, ok) => edge?.webContents.send('result', ok));
ipcMain.on('edge-drop', (_e, paths) => {
  const list = [];
  for (const p of paths) {
    try { const st = fs.statSync(p); if (!st.isFile() || st.size > 1024 * 1024 * 1024) continue;
      list.push({ name: path.basename(p), type: MIME[path.extname(p).slice(1).toLowerCase()] || '', data: fs.readFileSync(p) }); } catch {}
  }
  if (list.length && win) win.webContents.send('edge-files', list);
});

app.on('second-instance', show);
app.whenReady().then(() => {
  // Received files go straight to Downloads\Flick
  session.defaultSession.on('will-download', (_e, item) => {
    item.setSavePath(path.join(app.getPath('downloads'), 'Flick', item.getFilename()));
  });
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'media'].includes(perm)));

  if (!app.getLoginItemSettings().openAtLogin && !require('node:fs').existsSync(path.join(app.getPath('userData'), '.set'))) {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
    require('node:fs').writeFileSync(path.join(app.getPath('userData'), '.set'), '1');
  }
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Flick');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Open Flick', click: show },
    { label: 'Open received files', click: () => shell.openPath(path.join(app.getPath('downloads'), 'Flick')) },
    { type: 'separator' },
    { label: 'Edge Drop (right side of screen)', type: 'checkbox', checked: edgeOn, click: (i) => { edgeOn = i.checked; if (edgeOn) createEdge(); else edge?.close(); } },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked, args: ['--hidden'] }) },
    { type: 'separator' },
    { label: 'Quit Flick', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu()); tray.on('click', show); tray.on('right-click', () => tray.setContextMenu(menu()));
  createWindow();
  createEdge();
  screen.on('display-metrics-changed', () => edge?.setBounds(edgeBounds(false)));
  require('./helper.js'); // the remote: pairing, encrypted commands, battery, screenshot, media, power…
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', (e) => e.preventDefault());
