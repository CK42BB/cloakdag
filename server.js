// Zero-dependency server for Railway. Serves ./public on $PORT, plus the /admin page editor.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, 'public');
const ADMIN = path.join(__dirname, 'admin');
const INDEX = path.join(ROOT, 'index.html');
const PORT = process.env.PORT || 3000;
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const GH = {
  token: process.env.GITHUB_TOKEN,
  repo: process.env.GITHUB_REPO || 'CK42BB/cloakdag',
  branch: process.env.GITHUB_BRANCH || 'main',
  api: process.env.GITHUB_API || 'https://api.github.com',
};
const MAIL = { key: process.env.RESEND_API_KEY, from: process.env.MAIL_FROM || 'Cloak and Dagger <admin@cloakdag.com>' };
const LINK_TTL = 15 * 60 * 1000;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const START = '<!-- cms:start -->';
const END = '<!-- cms:end -->';
const PAGE = 'public/index.html';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

function send(res, status, file, headers = {}) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return notFound(res);
    const ext = path.extname(file);
    res.writeHead(status, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=604800',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      ...headers,
    });
    fs.createReadStream(file).pipe(res);
  });
}

function notFound(res) {
  res.writeHead(302, { Location: '/' });
  res.end();
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function html(res, body, headers = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
    'X-Frame-Options': 'DENY',
    ...headers,
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---- Signed tokens (magic links + session cookie) ----

const mac = (p) => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
function sign(obj) {
  const p = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${p}.${mac(p)}`;
}
function unsign(token, kind) {
  const [p, s] = String(token || '').split('.');
  if (!p || !s) return null;
  const a = Buffer.from(s);
  const b = Buffer.from(mac(p));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const o = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    return o.k === kind && o.x > Date.now() && ADMIN_EMAILS.includes(o.e) ? o : null;
  } catch { return null; }
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }));
}
const sessionOf = (req) => unsign(cookies(req).cd_admin, 'sess');
function sessionCookie(value, maxAge) {
  const secure = SITE_URL.startsWith('https:') ? '; Secure' : '';
  return `cd_admin=${value}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

const usedLinks = new Map(); // nonce -> expiry, so each emailed link signs in once
const loginHits = new Map(); // ip -> recent request times

function rateLimited(ip) {
  const now = Date.now();
  const hits = (loginHits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  hits.push(now);
  loginHits.set(ip, hits);
  for (const [n, x] of usedLinks) if (x < now) usedLinks.delete(n);
  return hits.length > 6;
}

async function sendLoginEmail(email, link) {
  if (!MAIL.key) {
    console.log(`[admin] RESEND_API_KEY not set. Sign-in link for ${email}:\n${link}`);
    return;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${MAIL.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: MAIL.from,
      to: email,
      subject: 'Your cloakdag.com sign-in link',
      text: `Sign in to edit cloakdag.com:\n\n${link}\n\nThis link works once and expires in 15 minutes. If you didn't ask for it, ignore this email.`,
      html: `<div style="font:16px/1.5 Georgia,serif;color:#2e2821;max-width:480px">
        <p>Sign in to edit <b>cloakdag.com</b>:</p>
        <p><a href="${link}" style="display:inline-block;background:#1c1b17;color:#efeadb;padding:12px 22px;text-decoration:none;font-family:'Courier New',monospace">Open the editor</a></p>
        <p style="color:#57524a;font-size:14px">This link works once and expires in 15 minutes. If you didn't ask for it, ignore this email.</p></div>`,
    }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
}

// ---- Page content: the editable region between the cms markers ----

const TITLE_RE = /<title>([\s\S]*?)<\/title>/;
const DESC_RE = /<meta name="description" content="([^"]*)">/;
const OG_TITLE_RE = /(<meta property="og:title" content=")[^"]*(">)/;
const OG_DESC_RE = /(<meta property="og:description" content=")[^"]*(">)/;
const BANNED = /<\s*\/?\s*(script|style|iframe|object|embed|link|meta|form|input|textarea|base|svg)\b|\son[a-z]+\s*=|javascript:|cms:(start|end)/i;
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function split(page) {
  const a = page.indexOf(START);
  const b = page.indexOf(END);
  if (a < 0 || b < a) return null;
  return { before: page.slice(0, a + START.length), region: page.slice(a + START.length, b), after: page.slice(b) };
}

// Changes whenever the editable content or the title/description change; used to catch overlapping edits.
function fingerprint(page) {
  const parts = split(page);
  const bits = [parts ? parts.region : '', (page.match(TITLE_RE) || [])[1], (page.match(DESC_RE) || [])[1]];
  return crypto.createHash('sha256').update(bits.join('\0')).digest('hex').slice(0, 16);
}

// title/description arrive already HTML-escaped
function setMeta(page, title, description) {
  if (title != null) page = page.replace(TITLE_RE, `<title>${title}</title>`).replace(OG_TITLE_RE, `$1${title}$2`);
  if (description != null) page = page.replace(DESC_RE, `<meta name="description" content="${description}">`).replace(OG_DESC_RE, `$1${description}$2`);
  return page;
}

async function gh(method, p, body) {
  const r = await fetch(`${GH.api}/repos/${GH.repo}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${GH.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'cloakdag-admin',
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`GitHub: ${data.message || r.status}`), { status: r.status });
  return data;
}

async function ghGet(file, ref = GH.branch) {
  const d = await gh('GET', `/contents/${file}?ref=${encodeURIComponent(ref)}`);
  return { text: Buffer.from(d.content, 'base64').toString('utf8'), sha: d.sha };
}

function ghPut(file, buf, sha, message, email) {
  return gh('PUT', `/contents/${file}`, {
    message,
    content: buf.toString('base64'),
    branch: GH.branch,
    ...(sha && { sha }),
    author: { name: email.split('@')[0], email },
  });
}

async function currentPage() {
  if (GH.token) return ghGet(PAGE);
  return { text: fs.readFileSync(INDEX, 'utf8') };
}

function writeLocal(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// Commit to GitHub (so the change survives redeploys) and write locally (so it's live right away).
async function savePage(text, sha, message, email) {
  if (GH.token) await ghPut(PAGE, Buffer.from(text), sha, message, email);
  writeLocal(INDEX, text);
}

let queue = Promise.resolve();
function exclusive(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// Restoring brings back each tag exactly as it was in the old version.
function copyMeta(page, from) {
  for (const re of [TITLE_RE, DESC_RE, OG_TITLE_RE, OG_DESC_RE]) {
    const m = from.match(re);
    if (m) page = page.replace(re, () => m[0]);
  }
  return page;
}

// ---- Admin routes ----

function editorPage(email) {
  const page = fs.readFileSync(INDEX, 'utf8');
  const boot = JSON.stringify({ base: fingerprint(page), email, github: Boolean(GH.token) }).replace(/</g, '\\u003c');
  return page
    .replace('</head>', '  <link rel="stylesheet" href="/admin/editor.css">\n</head>')
    .replace('</body>', `<script>window.CMS = ${boot};</script>\n<script src="/admin/editor.js"></script>\n</body>`);
}

const confirmPage = (token) => fs.readFileSync(path.join(ADMIN, 'login.html'), 'utf8')
  .replace('<body>', `<body data-token="${escAttr(token)}">`);

async function publish(body, email) {
  const { region, title, description, base, note, force } = body;
  if (typeof region !== 'string' || !/<main[\s>]/.test(region) || region.length > 500000) {
    return [400, { error: 'That edit looks incomplete, so it was not published.' }];
  }
  if (BANNED.test(region)) return [400, { error: 'The page contains something that is not allowed (scripts or embeds).' }];
  return exclusive(async () => {
    const cur = await currentPage();
    if (!force && fingerprint(cur.text) !== base) {
      return [409, { error: 'Someone else published changes after you opened the editor.' }];
    }
    const parts = split(cur.text);
    if (!parts) return [500, { error: 'The page is missing its editor markers.' }];
    const next = setMeta(
      parts.before + region + parts.after,
      typeof title === 'string' && title.trim() ? escAttr(title.trim()) : null,
      typeof description === 'string' ? escAttr(description.trim()) : null,
    );
    const msg = `Site edit by ${email}${note ? `: ${String(note).slice(0, 120)}` : ''}`;
    await savePage(next, cur.sha, msg, email);
    return [200, { base: fingerprint(next) }];
  });
}

async function restore(body, email) {
  if (!GH.token) return [400, { error: 'History needs GitHub connected.' }];
  if (!/^[0-9a-f]{7,40}$/.test(body.sha || '')) return [400, { error: 'Unknown version.' }];
  return exclusive(async () => {
    const old = await ghGet(PAGE, body.sha);
    const oldParts = split(old.text);
    if (!oldParts) return [400, { error: 'That version is from before the editor existed, so it cannot be restored here.' }];
    const cur = await currentPage();
    const parts = split(cur.text);
    const next = copyMeta(parts.before + oldParts.region + parts.after, old.text);
    await savePage(next, cur.sha, `Restore version ${body.sha.slice(0, 7)} (by ${email})`, email);
    return [200, { base: fingerprint(next) }];
  });
}

async function history() {
  if (!GH.token) return [200, { commits: [], github: false }];
  const list = await gh('GET', `/commits?path=${PAGE}&sha=${encodeURIComponent(GH.branch)}&per_page=30`);
  return [200, {
    github: true,
    commits: list.map((c) => ({
      sha: c.sha,
      message: c.commit.message.split('\n')[0],
      who: c.commit.author.email || c.commit.author.name,
      date: c.commit.author.date,
    })),
  }];
}

const IMAGE_TYPES = [
  ['.webp', (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'],
  ['.png', (b) => b.toString('latin1', 1, 4) === 'PNG'],
  ['.jpg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
];

async function upload(body, email) {
  const buf = Buffer.from(String(body.data || ''), 'base64');
  const type = IMAGE_TYPES.find(([, test]) => buf.length > 12 && test(buf));
  if (!type) return [400, { error: 'Please use a JPG, PNG or WebP image.' }];
  if (buf.length > 8 * 1024 * 1024) return [413, { error: 'That image is too big (8 MB max).' }];
  const rel = `img/uploads/${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}${type[0]}`;
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    if (GH.token) {
      try { await ghPut(`public/${rel}`, buf, null, `Upload image (by ${email})`, email); }
      catch (e) { if (e.status !== 422) throw e; } // 422: already in the repo
    }
    writeLocal(file, buf);
  }
  return [200, { src: `/${rel}` }];
}

const API = { publish, restore, history, upload };

async function admin(req, res, p) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const session = sessionOf(req);

  if (p === '/admin' || p === '/admin/') {
    if (req.method !== 'GET') return json(res, 405, {});
    if (!session) return html(res, fs.readFileSync(path.join(ADMIN, 'login.html'), 'utf8'));
    return html(res, editorPage(session.e));
  }

  if (p === '/admin/login' && req.method === 'POST') {
    if (rateLimited(ip)) return json(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const { email } = JSON.parse(await readBody(req, 2000) || '{}');
    const e = String(email || '').trim().toLowerCase();
    if (ADMIN_EMAILS.includes(e)) {
      const token = sign({ k: 'link', e, x: Date.now() + LINK_TTL, n: crypto.randomBytes(12).toString('hex') });
      try { await sendLoginEmail(e, `${SITE_URL}/admin/auth?t=${token}`); }
      catch (err) {
        console.error('[admin] email failed', err);
        return json(res, 502, { error: 'The sign-in email could not be sent. Tell Chris.' });
      }
    }
    return json(res, 200, { ok: true }); // same answer either way, so the form doesn't reveal who has access
  }

  // The emailed link opens a page with a button rather than signing in on GET,
  // so mail scanners that pre-open links don't use up the one-time token.
  if (p === '/admin/auth' && req.method === 'GET') {
    const t = new URL(req.url, 'http://x').searchParams.get('t') || '';
    return html(res, confirmPage(t));
  }
  if (p === '/admin/auth' && req.method === 'POST') {
    const t = new URLSearchParams(await readBody(req, 4000)).get('t');
    const link = unsign(t, 'link');
    if (!link || usedLinks.has(link.n)) {
      res.writeHead(303, { Location: '/admin?expired=1' });
      return res.end();
    }
    usedLinks.set(link.n, link.x);
    const sess = sign({ k: 'sess', e: link.e, x: Date.now() + SESSION_TTL });
    res.writeHead(303, { Location: '/admin', 'Set-Cookie': sessionCookie(sess, SESSION_TTL / 1000) });
    return res.end();
  }

  if (p === '/admin/logout' && req.method === 'POST') {
    res.writeHead(303, { Location: '/admin', 'Set-Cookie': sessionCookie('', 0) });
    return res.end();
  }

  const api = p.match(/^\/admin\/api\/(\w+)$/);
  if (api && API[api[1]]) {
    if (!session) return json(res, 401, { error: 'Your sign-in expired. Reload the page to sign in again.' });
    // custom header = only our own page's fetch() can call these (blocks cross-site form posts)
    if (req.headers['x-cms'] !== '1') return json(res, 403, { error: 'Forbidden' });
    try {
      const body = req.method === 'POST' ? JSON.parse(await readBody(req, 12 * 1024 * 1024) || '{}') : {};
      const [status, out] = await API[api[1]](body, session.e);
      return json(res, status, out);
    } catch (err) {
      console.error('[admin]', err);
      return json(res, err.status === 413 ? 413 : 500, { error: err.message || 'Something went wrong.' });
    }
  }

  if (req.method === 'GET') {
    const file = path.join(ADMIN, path.normalize(p.slice('/admin'.length)));
    if (file.startsWith(ADMIN + path.sep) && /\.(js|css)$/.test(file)) return send(res, 200, file, { 'Cache-Control': 'no-cache' });
  }
  return notFound(res);
}

http.createServer(async (req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { return notFound(res); }
  if (p === '/admin' || p.startsWith('/admin/')) {
    return admin(req, res, p).catch((err) => {
      console.error('[admin]', err);
      if (!res.headersSent) json(res, 400, { error: 'Bad request' });
    });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT + path.sep)) return notFound(res);
  if (req.method === 'HEAD') { res.writeHead(200); return res.end(); }
  send(res, 200, file);
}).listen(PORT, () => {
  console.log(`Cloak and Dagger on :${PORT}`);
  if (!ADMIN_EMAILS.length) console.log('[admin] ADMIN_EMAILS not set, so nobody can sign in to /admin');
  if (!process.env.SESSION_SECRET) console.log('[admin] SESSION_SECRET not set, so sign-ins reset on every restart');
  if (!GH.token) console.log('[admin] GITHUB_TOKEN not set, so edits are saved locally only and lost on redeploy');
});
