const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const project = path.dirname(root);
const logs = path.join(project, 'Logs');
fs.mkdirSync(logs, { recursive: true });
const children = [];
let ending = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function json(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(2500) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
function start(name, args, cwd, env = {}) {
  const logStream = fs.createWriteStream(path.join(logs, `phone-${name}.log`), { flags: 'a' });
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (child.stdout) child.stdout.pipe(logStream);
  if (child.stderr) child.stderr.pipe(logStream);

  children.push(child);
  child.on('error', error => { console.error(`${name}: ${error.message}`); shutdown(1); });
  child.on('exit', code => {
    if (!ending) { console.error(`${name} da dung (${code}). Xem Logs/phone-${name}.log`); shutdown(1); }
  });
}
function shutdown(code = 0) {
  if (ending) return;
  ending = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill();
  }
  process.exit(code);
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
function killPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout;
      if (!out) return;
      const lines = out.split('\n').filter(l => l.includes(`:${port} `) && l.includes('LISTENING'));
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0' && pid !== String(process.pid)) {
          spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        }
      }
    }
  } catch {}
}
async function free(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
  });
}
async function waitFor(check, description) {
  for (let i = 0; i < 90; i++) {
    if (ending) throw new Error('Da dung');
    try { const value = await check(); if (value) return value; } catch {}
    if (i % 10 === 0) console.log(`Dang doi ${description}...`);
    await delay(1000);
  }
  throw new Error(`${description} chua san sang. Xem thu muc Logs.`);
}
function qr(url) {
  const cells = require('toqr').toQR(url), size = Math.sqrt(cells.length), margin = 4;
  const dark = (x, y) => x >= 0 && y >= 0 && x < size && y < size && cells[y * size + x];
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size + 8} ${size + 8}" width="330" height="330"><rect width="100%" height="100%" fill="white"/>`;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (dark(x, y)) svg += `<rect x="${x + margin}" y="${y + margin}" width="1" height="1"/>`;
  svg += '</svg>';
  fs.writeFileSync(path.join(logs, 'phone-qr.svg'), svg);
  for (let y = -margin; y < size + margin; y++) {
    let row = '';
    for (let x = -margin; x < size + margin; x++) row += dark(x, y) ? '██' : '  ';
    console.log('\x1b[47m\x1b[30m' + row + '\x1b[0m');
  }
}
async function main() {
  const interfaces = Object.entries(os.networkInterfaces());
  const addresses = interfaces.filter(([name]) => /wi-?fi|wireless|wlan/i.test(name)).flatMap(([, entries]) => entries || []);
  const host = process.env.REACT_NATIVE_PACKAGER_HOSTNAME || addresses.find(a => a.family === 'IPv4' && !a.internal)?.address;
  if (!host || !net.isIPv4(host)) throw new Error('Khong tim thay IP Wi-Fi. Ket noi may tinh voi Wi-Fi/diem phat song dien thoai.');
  console.log(`MemoryWeaver - ket noi dien thoai qua ${host}`);
  if (!fs.existsSync(path.join(project, 'Server/.env'))) throw new Error('Chay Cau-hinh-Gemini.cmd de nhap Gemini API key truoc.');
  let health;
  try { health = await json('http://127.0.0.1:8787/health'); } catch {}
  const configuredModel = require('node:util').parseEnv(fs.readFileSync(path.join(project, 'Server/.env'), 'utf8')).GEMINI_MODEL || 'gemini-flash-lite-latest';
  if (health && (health.provider !== 'gemini' || health.model !== configuredModel)) {
    console.log('Khoi dong lai server AI de cap nhat cau hinh moi...');
    killPort(8787);
    await delay(1000);
    health = null;
  }
  if (!health) {
    if (!await free(8787)) {
      killPort(8787);
      await delay(1000);
    }
    start('api', ['--env-file=.env', 'server.mjs'], path.join(project, 'Server'));
    health = await waitFor(() => json('http://127.0.0.1:8787/health'), 'server AI');
  }
  if (!health.ok || !health.configured) throw new Error('Chay Cau-hinh-Gemini.cmd de nhap khoa Gemini, roi mo lai Chay-Expo.cmd.');
  console.log('1/3 Server AI da san sang (chua kiem tra goi Gemini that).');
  const built = spawnSync(process.execPath, ['scripts/build-viewer.cjs'], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (built.status !== 0) throw new Error('Khong dong goi duoc 3D viewer.');
  const headers = { 'expo-platform': 'android', Accept: 'application/expo+json' };
  let port, manifest;
  for (const candidate of [8081, 8082]) {
    try {
      const existing = await json(`http://127.0.0.1:${candidate}/`, headers);
      if (existing.extra?.expoClient?.slug === 'memoryweaver-expo') {
        console.log(`Don dep Expo cu tren cong ${candidate}...`);
        killPort(candidate);
        await delay(1000);
      }
    } catch {}
  }
  if (!manifest) {
    for (const candidate of [8081, 8082]) if (await free(candidate)) { port = candidate; break; }
    if (!port) throw new Error('Ca hai cong 8081/8082 dang ban. Dong cua so Expo cu roi thu lai.');
    start('expo', ['node_modules/expo/bin/cli', 'start', '--go', '--lan', '--clear', '--no-dev', '--minify', '--port', String(port)], root,
      { CI: '1', REACT_NATIVE_PACKAGER_HOSTNAME: host });
    manifest = await waitFor(() => json(`http://127.0.0.1:${port}/`, headers), 'Expo');
  }
  const bundle = new URL(manifest.launchAsset.url);
  if (bundle.hostname !== host) throw new Error('Expo cu dang dung IP khac. Dong cua so Expo cu roi mo lai file nay.');
  bundle.hostname = '127.0.0.1';
  console.log('2/3 Dang tai va kiem tra bundle Android. Lan dau co the mat 1-2 phut...');
  const response = await fetch(bundle, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Bundle HTTP ${response.status}. Dong cua so Expo cu va chay lai. Xem Logs/phone-expo.log.`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength < 1000) throw new Error('Bundle khong day du.');
  const status = await fetch(`http://${host}:${port}/status`, { signal: AbortSignal.timeout(5000) });
  if (!status.ok || !(await status.text()).includes('packager-status:running')) throw new Error('Khong truy cap duoc Expo qua IP Wi-Fi.');
  console.log(`3/3 SAN SANG - bundle ${(bytes.byteLength / 1e6).toFixed(1)} MB. Expo Go phai ho tro SDK ${manifest.extra.expoClient.sdkVersion}.`);
  const url = `exp://${host}:${port}`;
  qr(url);
  const envData = require('node:util').parseEnv(fs.readFileSync(path.join(project, 'Server/.env'), 'utf8'));
  const token = envData.APP_ACCESS_TOKEN || '';
  console.log(`\n======================================================`);
  console.log(`  MÃ TRUY CẬP APP (nhập vào mục Cài đặt trên điện thoại):`);
  console.log(`  ${token}`);
  console.log(`  ĐỊA CHỈ SERVER AI: http://${host}:8787`);
  console.log(`======================================================\n`);
  console.log(`Mo bang Expo Go: ${url}\nKiem tra tren Chrome DIEN THOAI: http://${host}:${port}/status`);
  console.log('Neu Chrome dien thoai khong mo duoc /status: kiem tra tuong lua va diem phat song.');
  console.log('GIU CUA SO NAY MO. Nhan Ctrl+C de dung. QR cung luu tai Logs/phone-qr.svg.');
  setInterval(async () => {
    try {
      const h = await json('http://127.0.0.1:8787/health');
      if (!h || !h.ok) throw new Error();
    } catch {
      console.log('Server AI mat ket noi, dang tu dong khoi dong lai...');
      killPort(8787);
      await delay(500);
      start('api', ['--env-file=.env', 'server.mjs'], path.join(project, 'Server'));
    }
  }, 10000);
}
main().catch(error => { console.error('CHUA SAN SANG: ' + error.message); shutdown(1); });
