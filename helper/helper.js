// Flick for Windows
// Lets paired phones control this laptop: status, screenshot, power, media, slides, apps, trackpad, keyboard.
// Security: phones pair with a code you confirm on this laptop. Each phone gets its own key (ECDH),
// every command is encrypted + signed (AES-GCM), timestamped and never accepted twice.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, exec, execSync } = require('node:child_process');
const { WebSocketServer } = require('ws');
const mqtt = require('mqtt');

let isSea = false; try { isSea = require('node:sea').isSea(); } catch {}
if (isSea) { console.log = () => {}; console.error = () => {}; } // no console window when installed
const DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Flick');
const CONF = path.join(DIR, 'config.json');
const LOG = path.join(DIR, 'flick.log');
const EXE_NAME = 'Flick.exe';
const LOCAL_PORT = 4041;
const T = 'flickapp/v1';
const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
fs.mkdirSync(DIR, { recursive: true });
const log = (...a) => { const line = `[${new Date().toISOString()}] ${a.join(' ')}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n'); } catch {} };

// ---------- PowerShell helpers ----------
const enc = (s) => Buffer.from(s, 'utf16le').toString('base64');
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden'];
function ps(script) {
  return new Promise((ok) => {
    const p = spawn('powershell.exe', [...PS, '-EncodedCommand', enc(script)], { windowsHide: true });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.on('close', () => ok(out.trim())); p.on('error', () => ok(''));
  });
}
const q = (s) => String(s).replace(/'/g, "''");
function toast(title, body) {
  spawn('powershell.exe', [...PS, '-EncodedCommand', enc(`[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $x.GetElementsByTagName('text'); $t[0].AppendChild($x.CreateTextNode('${q(title)}')) > $null; $t[1].AppendChild($x.CreateTextNode('${q(body)}')) > $null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))`)], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
}
function askYesNo(text) { // a normal, always-on-top Windows box (wscript has no console window to hide)
  const vbs = path.join(DIR, 'ask.vbs');
  const lines = text.split('\n').map((l) => '"' + l.replace(/"/g, '""') + '"').join(' & vbCrLf & ');
  fs.writeFileSync(vbs, `r = MsgBox(${lines}, vbYesNo + vbQuestion + vbSystemModal + vbDefaultButton2, "Flick")\r\nWScript.Quit r\r\n`);
  return new Promise((ok) => {
    const p = spawn('wscript.exe', ['//nologo', vbs]);
    const t = setTimeout(() => { try { p.kill(); } catch {} ok(false); }, 120000);
    p.on('exit', (code) => { clearTimeout(t); ok(code === 6); });
    p.on('error', (e) => { clearTimeout(t); log('popup failed', e.message); ok(false); });
  });
}

// ---------- install / autostart (only when running as Flick.exe) ----------
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
if (isSea && process.platform === 'win32') {
  const target = path.join(DIR, EXE_NAME);
  if (process.argv.includes('--uninstall')) {
    try { execSync(`reg delete ${RUN_KEY} /v Flick /f`, { stdio: 'ignore' }); } catch {}
    try { execSync(`taskkill /IM ${EXE_NAME} /F /FI "PID ne ${process.pid}"`, { stdio: 'ignore' }); } catch {}
    toast('Flick removed', 'Flick will no longer start with Windows.');
    process.exit(0);
  }
  if (path.resolve(process.execPath).toLowerCase() !== target.toLowerCase()) {
    try { execSync(`taskkill /IM ${EXE_NAME} /F /FI "PID ne ${process.pid}"`, { stdio: 'ignore' }); } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
    fs.copyFileSync(process.execPath, target);
    execSync(`reg add ${RUN_KEY} /v Flick /t REG_SZ /d "\\"${target}\\"" /f`, { stdio: 'ignore' });
    spawn(target, [], { detached: true, stdio: 'ignore' }).unref();
    toast('Flick is installed', 'It starts with Windows. Pair from your phone: Devices.');
    process.exit(0);
  }
}

// ---------- identity ----------
const conf = (() => { try { return JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch { return {}; } })();
const save = () => fs.writeFileSync(CONF, JSON.stringify(conf, null, 2));
conf.id ||= crypto.randomBytes(6).toString('hex');
conf.name ||= `${os.userInfo().username.replace(/^./, (c) => c.toUpperCase())}'s laptop`;
conf.trusted ||= {}; // phoneId -> { name, key (base64), model }
save();
let model = conf.model || 'Windows PC';
ps(`$c = Get-CimInstance Win32_ComputerSystem; $p = Get-CimInstance Win32_ComputerSystemProduct
if ($c.Manufacturer -match 'LENOVO') { "$($c.Manufacturer)|$($p.Version)" } else { "$($c.Manufacturer)|$($c.Model)" }`).then((r) => {
  const [m, n] = r.split('|').map((x) => (x || '').trim());
  const brand = (m || '').replace(/hewlett-packard/i, 'HP').replace(/\b(inc|corporation|corp|co|ltd|technologies|technology|computer|international)\b/gi, '').replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
  if (n && !/system product name|to be filled/i.test(n)) { model = n.toLowerCase().startsWith(brand.toLowerCase()) ? n : `${brand} ${n}`.trim(); conf.model = model; save(); }
});

// ---------- crypto ----------
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const sas = (a, b) => String(sha(Buffer.concat([a, b])).readUInt32BE(0) % 10000).padStart(4, '0');
function seal(keyB64, obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj)), c.final(), c.getAuthTag()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64') };
}
function open(keyB64, { iv, ct }) {
  const buf = Buffer.from(ct, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), Buffer.from(iv, 'base64'));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString());
}
const seen = new Map(); // nonce -> time (replay guard)

// ---------- input (one hidden PowerShell that moves the mouse and presses keys) ----------
let input;
function startInput() {
  input = spawn('powershell.exe', [...PS, '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  input.stdin.write(`Add-Type @"
using System; using System.Runtime.InteropServices;
public class W { [DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e);
[DllImport("user32.dll")] public static extern void keybd_event(byte v,byte s,int f,int e); }
"@
Add-Type -AssemblyName System.Windows.Forms
while ($true) { $l = [Console]::In.ReadLine(); if ($l -eq $null) { break }; $a = $l.Split(' ')
 switch ($a[0]) {
  'm' { [W]::mouse_event(1,[int]$a[1],[int]$a[2],0,0) }
  'c' { [W]::mouse_event(2,0,0,0,0); [W]::mouse_event(4,0,0,0,0) }
  'r' { [W]::mouse_event(8,0,0,0,0); [W]::mouse_event(16,0,0,0,0) }
  's' { [W]::mouse_event(0x800,0,0,[int]$a[1],0) }
  'v' { $k=[byte][int]$a[1]; [W]::keybd_event($k,0,0,0); [W]::keybd_event($k,0,2,0) }
  'w' { $k=[byte][int]$a[1]; [W]::keybd_event(0x5B,0,0,0); [W]::keybd_event($k,0,0,0); [W]::keybd_event($k,0,2,0); [W]::keybd_event(0x5B,0,2,0) }
  't' { [System.Windows.Forms.SendKeys]::SendWait([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($a[1]))) }
 } }
`);
  input.on('exit', () => setTimeout(startInput, 1000));
}
const send = (line) => { try { input.stdin.write(line + '\n'); } catch {} };
const sendKeysText = (t) => String(t).replace(/[+^%~(){}[\]]/g, '{$&}').replace(/\r?\n/g, '{ENTER}');

// ---------- actions (the only things a phone can do) ----------
const APPS = { chrome: 'chrome', edge: 'msedge', files: 'explorer', notepad: 'notepad', word: 'winword', excel: 'excel', powerpoint: 'powerpnt', vscode: 'code', spotify: 'spotify:', settings: 'ms-settings:', calculator: 'calc', whatsapp: 'whatsapp:', youtube: 'https://youtube.com' };
const VK = { next: 0x27, prev: 0x25, slideshow: 0x74, endshow: 0x1B, play: 0xB3, track_next: 0xB0, track_prev: 0xB1, volup: 0xAF, voldown: 0xAE, mute: 0xAD, enter: 0x0D, backspace: 0x08 };
async function status() {
  const r = await ps(`$b = Get-CimInstance Win32_Battery | Select-Object -First 1; if ($b) { "$($b.EstimatedChargeRemaining)|$($b.BatteryStatus)" } else { "|" }`);
  const [pct, st] = r.split('|');
  return { r: 'status', name: conf.name, model, battery: pct ? +pct : null, charging: ['2', '6', '7', '8', '9'].includes(st), up: Math.round(os.uptime() / 60) };
}
async function screenshot() {
  return ps(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type 'using System.Runtime.InteropServices; public class D { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'; [D]::SetProcessDPIAware() > $null
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
[System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$w = 1100; $h = [int]($b.Height * $w / $b.Width); $s = New-Object System.Drawing.Bitmap $bmp, $w, $h
$e = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$p = New-Object System.Drawing.Imaging.EncoderParameters 1; $p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]55)
$m = New-Object IO.MemoryStream; $s.Save($m, $e, $p); [Convert]::ToBase64String($m.ToArray())`);
}
const announced = new Map();
function notice(phone, what) { // show the laptop owner who is in control, at most once a minute per phone
  const k = phone + what; if (Date.now() - (announced.get(k) || 0) < 60000) return; announced.set(k, Date.now());
  toast('Flick', `${conf.trusted[phone]?.name || 'A phone'} ${what}`);
}
async function run(phone, m, reply) {
  const a = m.a, arg = m.arg;
  if (a === 'status') return reply(await status());
  if (a === 'shot') { notice(phone, 'took a screenshot'); const b64 = await screenshot(); const id = crypto.randomBytes(3).toString('hex'), CH = 45000, n = Math.ceil(b64.length / CH) || 1;
    for (let i = 0; i < n; i++) reply({ r: 'shot', id, i, n, d: b64.slice(i * CH, (i + 1) * CH) }); return; }
  if (VK[a]) { notice(phone, 'is using the remote'); return send('v ' + VK[a]); }
  if (a === 'desktop') return send('w 68');
  if (a === 'move') return send(`m ${Math.round(+arg[0] || 0)} ${Math.round(+arg[1] || 0)}`);
  if (a === 'click') { notice(phone, 'is using the trackpad'); return send('c'); }
  if (a === 'rclick') return send('r');
  if (a === 'scroll') return send('s ' + Math.round(+arg || 0));
  if (a === 'type') { notice(phone, 'is typing'); return send('t ' + Buffer.from(sendKeysText(String(arg).slice(0, 2000))).toString('base64')); }
  if (a === 'open') { notice(phone, 'opened ' + arg);
    if (/^https?:\/\//i.test(arg)) return exec(`start "" "${String(arg).replace(/["&|<>^]/g, '')}"`);
    if (APPS[arg]) return exec(`start "" ${APPS[arg]}`); return; }
  if (a === 'lock') { toast('Flick', `Locked by ${conf.trusted[phone]?.name}`); return exec('rundll32.exe user32.dll,LockWorkStation'); }
  if (a === 'sleep') { toast('Flick', `Sleeping · ${conf.trusted[phone]?.name}`); return ps('Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState("Suspend", $false, $false)'); }
  if (a === 'restart') { toast('Flick', `Restarting in 10 seconds · ${conf.trusted[phone]?.name}`); return exec('shutdown /r /t 10'); }
  if (a === 'shutdown') { toast('Flick', `Shutting down in 10 seconds · ${conf.trusted[phone]?.name}`); return exec('shutdown /s /t 10'); }
  if (a === 'cancel') { toast('Flick', 'Shutdown cancelled'); return exec('shutdown /a'); }
}

// ---------- network ----------
let mq, room;
const pub = (topic, msg) => mq?.connected && mq.publish(topic, JSON.stringify({ ...msg, from: conf.id, name: conf.name, kind: 'desk', model, helper: true }));
const toDev = (id, msg) => pub(`${T}/dev/${id}`, msg);
function hello() { if (room) pub(`${T}/room/${room}`, { type: 'hello' }); for (const id in conf.trusted) toDev(id, { type: 'hello' }); }
async function publicIp() {
  return new Promise((ok) => http.get('http://api.ipify.org', (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => ok(d.trim())); }).on('error', () => ok('unknown')));
}
async function connect(i = 0) {
  room = sha('flick:' + (await publicIp())).toString('hex').slice(0, 20);
  mq = mqtt.connect(BROKERS[i % BROKERS.length], { clientId: 'flh_' + conf.id + '_' + crypto.randomBytes(2).toString('hex'), clean: true, connectTimeout: 8000, reconnectPeriod: 4000 });
  let ok = false;
  mq.on('connect', () => { ok = true; mq.subscribe([`${T}/room/${room}`, `${T}/dev/${conf.id}`]); hello(); log('online as', conf.name, '·', model); });
  mq.on('message', (_t, buf) => { let m; try { m = JSON.parse(buf); } catch { return; } onMessage(m).catch((e) => log('error', e.message)); });
  setTimeout(() => { if (!ok) { mq.end(true); connect(i + 1); } }, 9000);
}
setInterval(hello, 5000);
setInterval(async () => { const r = sha('flick:' + (await publicIp())).toString('hex').slice(0, 20); if (r !== room && mq?.connected) { mq.unsubscribe(`${T}/room/${room}`); room = r; mq.subscribe(`${T}/room/${room}`); } }, 60000);

const pairing = new Map(); // phoneId -> { ecdh, phonePub, code }
const sightings = new Set();
async function onMessage(m) {
  if (!m.from || m.from === conf.id) return;
  if (!sightings.has(m.from)) { sightings.add(m.from); log('sees', m.name || '?', m.model || '', m.type); }
  if (m.type === 'pair-req' && m.pub) {
    log('pair request from', m.name, m.model || '');
    if (pairing.has(m.from)) return;
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    const phonePub = Buffer.from(m.pub, 'base64'), myPub = ecdh.getPublicKey();
    const code = sas(phonePub, myPub);
    pairing.set(m.from, { ecdh, phonePub, code });
    toDev(m.from, { type: 'pair-key', pub: myPub.toString('base64') });
    const yes = await askYesNo(`${m.name} (${m.model || 'phone'}) wants to connect to this laptop.\n\nCode on the phone: ${code}\n\nOnly allow it if the code matches and it's your phone.`);
    pairing.delete(m.from);
    log('pair answer:', yes ? 'yes' : 'no');
    if (!yes) return toDev(m.from, { type: 'pair-no' });
    const key = sha(ecdh.computeSecret(phonePub)).toString('base64');
    conf.trusted[m.from] = { name: m.name, model: m.model || '', key, avatar: m.avatar || '' }; save();
    toDev(m.from, { type: 'pair-ok', ...seal(key, { ok: true }) });
    local({ t: 'trusted', id: m.from, name: m.name, avatar: m.avatar || '' });
    toast('Flick', `${m.name} can now control this laptop`);
    log('paired', m.name);
    return;
  }
  if (m.type === 'cmd' && conf.trusted[m.from]) {
    const t = conf.trusted[m.from]; let c;
    try { c = open(t.key, m); } catch { return log('rejected: bad key from', m.from); }
    if (Math.abs(Date.now() - c.ts) > 60000 || seen.has(c.n)) return log('rejected: old or repeated command');
    seen.set(c.n, Date.now()); for (const [k, v] of seen) if (Date.now() - v > 120000) seen.delete(k);
    if (m.name && m.name !== t.name) { t.name = m.name; save(); }
    await run(m.from, c, (res) => toDev(m.from, { type: 'res', ...seal(t.key, { ...res, re: c.n }) }));
  }
  if (m.type === 'unpair' && conf.trusted[m.from]) { try { open(conf.trusted[m.from].key, m); } catch { return; } delete conf.trusted[m.from]; save(); local({ t: 'untrusted', id: m.from }); }
}

// ---------- link to the Flick app open on this laptop (same identity, shared trust) ----------
const ALLOWED = /^(https:\/\/[a-z0-9-]+\.netlify\.app|http:\/\/localhost(:\d+)?)$/i;
const locals = new Set();
const local = (m) => { const s = JSON.stringify(m); locals.forEach((w) => w.readyState === 1 && w.send(s)); };
const wss = new WebSocketServer({ host: '127.0.0.1', port: LOCAL_PORT, verifyClient: ({ origin }) => ALLOWED.test(origin || '') });
wss.on('error', (e) => { if (e.code === 'EADDRINUSE') { log('Flick is already running'); process.exit(0); } });
wss.on('listening', () => { startInput(); connect(); log('Flick started'); });
wss.on('connection', (ws) => {
  locals.add(ws);
  ws.send(JSON.stringify({ t: 'hi', id: conf.id, name: conf.name, model, trusted: Object.fromEntries(Object.entries(conf.trusted).map(([k, v]) => [k, { name: v.name, avatar: v.avatar }])) }));
  ws.on('message', (raw) => { let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'rename' && m.name) { conf.name = String(m.name).slice(0, 24); save(); hello(); }
    if (m.t === 'forget' && conf.trusted[m.id]) { delete conf.trusted[m.id]; save(); }
  });
  ws.on('close', () => locals.delete(ws));
});
process.on('uncaughtException', (e) => log('error', e.message));
