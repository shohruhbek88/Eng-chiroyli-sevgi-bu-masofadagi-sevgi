const express = require('express'), http = require('http'), path = require('path'), fs = require('fs'), crypto = require('crypto'), os = require('os'), https = require('https');
const { Server } = require('socket.io');
const app = express(), server = http.createServer(app);
const io = new Server({ maxHttpBufferSize: 1e5, cors: { origin: process.env.CLIENT_ORIGIN || false } });
const rooms = new Map(), ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const hash = (p, salt) => crypto.scryptSync(String(p), salt, 32).toString('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const newId = () => { let id; do id = Array.from(crypto.randomBytes(6), b => ALPHA[b % 32]).join(''); while (rooms.has(id)); return id; };
const newUser = n => ({ userId: crypto.randomUUID(), displayName: clean(n, 24) || 'Guest', avatar: (clean(n, 1) || '♡').toUpperCase(), connected: false, isMuted: true, isScreenSharing: false, isCameraOn: false });
const view = r => ({ roomId: r.roomId, roomName: r.roomName, host: r.host, hasPassword: !!r.pw, createdAt: r.createdAt, isActive: r.isActive,
  users: [...r.users.values()].map(({ socketId, wasHere, ...u }) => u) });
const setPw = (r, p) => { p = String(p || ''); if (p) { r.salt = crypto.randomBytes(8).toString('hex'); r.pw = hash(p, r.salt); } else r.pw = r.salt = null; };

app.use(express.json({ limit: '2kb' }));
// Find index.html whether it sits in ./public (intended) or next to server.js (flat extract)
const INDEX = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find(f => fs.existsSync(f));
const sendIndex = (_, res) => INDEX ? res.sendFile(INDEX) : res.status(500).send('index.html not found next to server.js or in ./public');
app.get(['/', '/index.html'], sendIndex);
app.get('/room/:id', sendIndex);
app.get('/healthz', (_, res) => res.send('ok'));

// ---- ICE servers (STUN + TURN) so people on different networks/mobile data can connect ----
const STUN = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
const OPEN_RELAY = ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp', 'turns:openrelay.metered.ca:443?transport=tcp']
  .map(urls => ({ urls, username: 'openrelayproject', credential: 'openrelayproject' }));   // free public best-effort fallback
let iceCache = { t: 0, v: null };
app.get('/api/ice', async (_, res) => {
  try {
    if (!iceCache.v || Date.now() - iceCache.t > 3600e3) {
      const e = process.env; let turn;
      if (e.TURN_URLS) turn = [{ urls: e.TURN_URLS.split(','), username: e.TURN_USERNAME, credential: e.TURN_CREDENTIAL }];
      else if (e.METERED_APP && e.METERED_API_KEY) {           // e.g. METERED_APP=yourapp.metered.live
        const r = await fetch(`https://${e.METERED_APP}/api/v1/turn/credentials?apiKey=${encodeURIComponent(e.METERED_API_KEY)}`);
        if (!r.ok) throw new Error('metered ' + r.status); turn = await r.json();
      } else turn = OPEN_RELAY;
      iceCache = { t: Date.now(), v: [...STUN, ...turn] };
    }
  } catch (err) { console.warn('ICE config:', err.message); iceCache.v = iceCache.v || [...STUN, ...OPEN_RELAY]; }
  res.set('Cache-Control', 'no-store').json({ iceServers: iceCache.v });
});
app.use(express.static(path.join(__dirname, 'public')));
app.post('/api/rooms', (req, res) => {
  const { name, roomName, password } = req.body || {};
  if (!clean(name, 24)) return res.status(400).json({ error: 'name' });
  const u = newUser(name), id = newId();
  const r = { roomId: id, roomName: clean(roomName, 40) || 'Our Room', host: u.userId, users: new Map([[u.userId, u]]), createdAt: Date.now(), isActive: true, idleSince: Date.now() };
  setPw(r, password); rooms.set(id, r);
  res.json({ roomId: id, userId: u.userId });
});
app.get('/api/rooms/:id', (req, res) => {
  const r = rooms.get(req.params.id.toUpperCase());
  if (!r) return res.status(404).json({ error: 'not-found' });
  res.json({ hasPassword: !!r.pw, full: r.users.size >= 2 });
});

io.on('connection', socket => {
  const ctx = () => { const r = rooms.get(socket.data.roomId), u = r?.users.get(socket.data.userId); return u && u.socketId === socket.id ? { r, u } : null; };
  const gone = remove => {
    const c = ctx(); if (!c) return; const { r, u } = c;
    if (remove) { r.users.delete(u.userId); if (r.host === u.userId) r.host = [...r.users.keys()][0] || null; socket.leave(r.roomId); socket.data = {}; }
    else Object.assign(u, { connected: false, isScreenSharing: false, isCameraOn: false, isMuted: true });
    if (![...r.users.values()].some(x => x.connected)) r.idleSince = Date.now();
    io.to(r.roomId).emit('user-left', { userId: u.userId, left: remove, room: view(r) });
  };

  socket.on('join-room', (d, cb) => {
    cb = typeof cb === 'function' ? cb : () => {}; d = d || {};
    const r = rooms.get(String(d.roomId || '').toUpperCase());
    if (!r) return cb({ error: 'not-found' });
    let u = r.users.get(String(d.userId || ''));
    if (!u) {                                   // brand-new person: enforce 2-person limit + password
      if (r.users.size >= 2) return cb({ error: 'full' });
      if (r.pw && !same(hash(d.password || '', r.salt), r.pw)) return cb({ error: 'password' });
      if (!clean(d.name, 24)) return cb({ error: 'name' });
      u = newUser(d.name); r.users.set(u.userId, u);
    }
    const back = !!u.wasHere; u.wasHere = true;
    Object.assign(u, { connected: true, socketId: socket.id }); r.idleSince = null;
    socket.data = { roomId: r.roomId, userId: u.userId }; socket.join(r.roomId);
    cb({ ok: true, userId: u.userId, room: view(r) });
    socket.to(r.roomId).emit('user-joined', { userId: u.userId, reconnected: back, room: view(r) });
  });
  socket.on('leave-room', () => gone(true));
  socket.on('disconnect', () => gone(false));

  // WebRTC signalling + presence relays: always socket.to() (never echoes to sender → no loops)
  const relay = {
    'webrtc-offer': d => ({ description: d.description }), 'webrtc-answer': d => ({ description: d.description }),
    'ice-candidate': d => ({ candidate: d.candidate }), 'screen-share-started': d => ({ streamId: clean(d.streamId, 80) }),
    'screen-share-stopped': () => ({}), 'camera-enabled': d => ({ streamId: clean(d.streamId, 80) }), 'camera-disabled': () => ({}), 'voice-enabled': () => ({}), 'voice-disabled': () => ({}),
  };
  for (const [ev, pick] of Object.entries(relay)) socket.on(ev, d => {
    const c = ctx(); if (!c) return; d = d && typeof d === 'object' ? d : {};
    if (ev.startsWith('screen')) c.u.isScreenSharing = ev.endsWith('started');
    if (ev.startsWith('camera')) c.u.isCameraOn = ev.endsWith('enabled');
    if (ev.startsWith('voice')) c.u.isMuted = ev === 'voice-disabled';
    socket.to(c.r.roomId).emit(ev, { from: c.u.userId, ...pick(d) });
  });

  socket.on('chat-message', d => {          // text only, sanitised, never stored
    const c = ctx(), text = clean(d?.text, 500); if (!c || !text) return;
    io.to(c.r.roomId).emit('chat-message', { id: crypto.randomUUID(), from: c.u.userId, name: c.u.displayName, text, ts: Date.now() });
  });
  socket.on('update-room', (d, cb) => {
    const c = ctx(); if (!c) return; d = d || {}; const { r, u } = c;
    if (d.roomName !== undefined) r.roomName = clean(d.roomName, 40) || r.roomName;
    if (d.displayName !== undefined) { u.displayName = clean(d.displayName, 24) || u.displayName; u.avatar = u.displayName[0].toUpperCase(); }
    if (d.password !== undefined && r.host === u.userId) setPw(r, d.password);
    io.to(r.roomId).emit('room-update', view(r)); if (typeof cb === 'function') cb({ ok: true });
  });
});

setInterval(() => { for (const [id, r] of rooms) if (r.idleSince && Date.now() - r.idleSince > 10 * 60 * 1000) rooms.delete(id); }, 60000);

// ---- HTTP (localhost) + HTTPS (LAN devices: browsers only allow camera/mic/screen-share on HTTPS or localhost) ----
const PORT = +process.env.PORT || 3000, SPORT = +process.env.HTTPS_PORT || 3443;
const lanIPs = () => Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
function tlsCreds() {
  if (process.env.SSL_KEY && process.env.SSL_CERT) return { key: fs.readFileSync(process.env.SSL_KEY), cert: fs.readFileSync(process.env.SSL_CERT) };
  const dir = path.join(__dirname, '.certs'), k = path.join(dir, 'key.pem'), c = path.join(dir, 'cert.pem'), f = path.join(dir, 'ips.txt'), ips = lanIPs();
  if ([k, c, f].every(x => fs.existsSync(x)) && fs.readFileSync(f, 'utf8') === ips.join(',')) return { key: fs.readFileSync(k), cert: fs.readFileSync(c) };
  const pems = require('selfsigned').generate([{ name: 'commonName', value: 'localhost' }], { days: 365, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map(ip => ({ type: 7, ip }))] }] });
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(k, pems.private); fs.writeFileSync(c, pems.cert); fs.writeFileSync(f, ips.join(','));
  return { key: pems.private, cert: pems.cert };
}
io.attach(server);
server.listen(PORT, '0.0.0.0', () => console.log('♡ Even From Afar (this computer) → http://localhost:' + PORT + (INDEX ? '' : '  (WARNING: index.html not found)')));
if (!process.env.RENDER && !process.env.DISABLE_HTTPS) try {
  const hs = https.createServer(tlsCreds(), app); io.attach(hs);
  hs.listen(SPORT, '0.0.0.0', () => {
    console.log('♡ Other devices on your Wi-Fi/LAN (camera, mic & screen share need HTTPS):');
    (lanIPs().length ? lanIPs() : ['localhost']).forEach(ip => console.log('   → https://' + ip + ':' + SPORT + '   (accept the one-time certificate warning)'));
  });
} catch (e) { console.warn('HTTPS disabled (' + e.message + '). Run `npm install` again.'); }
