// Flick Helper for Windows
// 1) Makes this laptop show up as "Flick" in the iPhone's Screen Mirroring list (via UxPlay)
// 2) Lets the Flick app on your phone run shortcuts on this laptop
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, exec } from 'node:child_process';
import { WebSocketServer } from 'ws';

const NAME = process.env.FLICK_NAME || 'Flick';
const PORT = 4041;

// ---------- screen mirroring ----------
function findUxplay() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, path.join(os.homedir(), 'AppData', 'Local', 'Programs')].filter(Boolean);
  for (const r of roots) {
    const p = path.join(r, 'uxplay-windows', '_internal', 'bin', 'uxplay.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}
let mirror = null, mirrorState = 'off';
function startMirror() {
  const exe = findUxplay();
  if (!exe) { mirrorState = 'missing'; console.log('  Screen mirroring: UxPlay not found. See README step 2.'); return; }
  const bin = path.dirname(exe);
  const env = { ...process.env, GST_PLUGIN_PATH: path.join(bin, '..', 'lib', 'gstreamer-1.0'), PATH: bin + ';' + process.env.PATH };
  mirror = spawn(exe, ['-n', NAME, '-nh', '-pin', '-vs', 'd3d11videosink', '-vsync', 'no', '-h265', '-nohold'], { cwd: bin, env, windowsHide: true });
  mirrorState = 'on';
  console.log(`  Screen mirroring ready: on iPhone open Control Center > Screen Mirroring > ${NAME}`);
  mirror.stdout.on('data', (d) => { const t = String(d); if (/pin/i.test(t)) console.log('  ' + t.trim()); });
  mirror.on('exit', () => { mirror = null; if (mirrorState === 'on') setTimeout(startMirror, 3000); });
}
function stopMirror() { mirrorState = 'off'; mirror?.kill(); }

// ---------- shortcuts ----------
const ps = (cmd) => exec(`powershell -NoProfile -WindowStyle Hidden -Command "${cmd.replace(/"/g, '\\"')}"`);
const key = (k) => ps(`(New-Object -ComObject WScript.Shell).SendKeys('${k}')`);
const vk = (code) => ps(`$w=New-Object -ComObject WScript.Shell; $w.SendKeys([char]${code})`);
const APPS = { chrome: 'chrome', edge: 'msedge', explorer: 'explorer', notepad: 'notepad', word: 'winword', excel: 'excel', powerpoint: 'powerpnt', vscode: 'code', spotify: 'spotify:', settings: 'ms-settings:', calculator: 'calc' };
const ACTIONS = {
  next: () => key('{RIGHT}'),
  prev: () => key('{LEFT}'),
  play: () => vk(179),
  volup: () => { for (let i = 0; i < 3; i++) vk(175); },
  voldown: () => { for (let i = 0; i < 3; i++) vk(174); },
  mute: () => vk(173),
  slideshow: () => key('{F5}'),
  endshow: () => key('{ESC}'),
  desktop: () => ps('(New-Object -ComObject Shell.Application).ToggleDesktop()'),
  lock: () => exec('rundll32.exe user32.dll,LockWorkStation'),
  open: (arg) => { if (/^https?:\/\//i.test(arg)) exec(`start "" "${arg.replace(/"/g, '')}"`); else if (APPS[arg]) exec(`start "" ${APPS[arg]}`); },
};

// ---------- link to the Flick app (only on this computer) ----------
const ALLOWED = /^(https:\/\/[a-z0-9-]+\.netlify\.app|http:\/\/localhost(:\d+)?)$/i;
const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT, verifyClient: ({ origin }) => ALLOWED.test(origin || '') });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ t: 'hi', mirror: mirrorState, name: NAME }));
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'cmd' && ACTIONS[m.a]) { console.log('  Shortcut:', m.a, m.arg || ''); ACTIONS[m.a](m.arg); }
    if (m.t === 'mirror') { m.on ? (mirror || startMirror()) : stopMirror(); ws.send(JSON.stringify({ t: 'hi', mirror: mirrorState, name: NAME })); }
  });
});

console.log('\n  Flick Helper is running. Keep this window open.\n');
startMirror();
process.on('exit', stopMirror);
process.on('SIGINT', () => process.exit());
