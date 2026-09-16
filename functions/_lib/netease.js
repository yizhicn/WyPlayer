/**
 * NetEase Cloud Music helpers for Cloudflare Workers / Pages Functions.
 * Site Cookie: KV key NETEASE_COOKIE only (binding name KV). No Secret fallback.
 * Per-visitor Cookie: optional override from request (browser localStorage), never written to KV.
 */

const COOKIE_KV_KEY = 'NETEASE_COOKIE';

const NETEASE_MODULUS =
  '157794750267131502212476817800345498121872783333389747424011531025366277535262539913701806290766479189477533597854989606803194253978660329941980786072432806427833685472618792592200595694346872951301770580765135349259590167490536138082469680638514416594216629258349130257685001248172188325316586707301643237607';
const NETEASE_PUBKEY = 65537n;
const NETEASE_NONCE = '0CoJUm6Qyw8W8jud';
const NETEASE_IV = '0102030405060708';
const NETEASE_EAPI_KEY = 'e82ckenh8dichen8';
const NETEASE_EAPI_SALT = '36cd479b6b5';
const NETEASE_EAPI_UA =
  'NeteaseMusic/8.9.70.230820154231(9008070);Dalvik/2.1.0 (Linux; U; Android 13; Pixel 6 Build/TQ3A.230805.001)';
const NETEASE_WEAPI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const encoder = new TextEncoder();

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeCookie(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (!/MUSIC_U\s*=/i.test(text) && !text.includes('=')) {
    return `MUSIC_U=${text}`;
  }
  return text;
}

function getKv(env) {
  return env.KV || env.NETEASE_KV || null;
}

/**
 * Resolve cookie for API calls.
 * @param {string} [override] - visitor cookie from request header (local cache only)
 */
export async function getCookie(env, override = '') {
  const fromClient = normalizeCookie(override);
  if (fromClient && /MUSIC_U\s*=/i.test(fromClient)) return fromClient;

  const kv = getKv(env);
  if (kv) {
    try {
      const fromKv = await kv.get(COOKIE_KV_KEY);
      const normalized = normalizeCookie(fromKv);
      if (normalized) return normalized;
    } catch (error) {
      console.warn('读取 KV Cookie 失败:', error?.message || error);
    }
  }

  throw new ApiError(503, '未配置网易云 Cookie：请在 KV 写入键 NETEASE_COOKIE，或管理页扫码登录');
}

function randomHex(length) {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex.slice(0, length);
}

function randomIp() {
  // 常见国内段，降低网易云对海外/机房 IP 的风控
  const a = 116;
  const b = 25 + Math.floor(Math.random() * 70);
  const c = 1 + Math.floor(Math.random() * 254);
  const d = 1 + Math.floor(Math.random() * 254);
  return `${a}.${b}.${c}.${d}`;
}

function pkcs7Pad(bytes, blockSize) {
  const remainder = bytes.length % blockSize;
  const padding = remainder === 0 ? blockSize : blockSize - remainder;
  const output = new Uint8Array(bytes.length + padding);
  output.set(bytes);
  output.fill(padding, bytes.length);
  return output;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToHexLower(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToHexUpper(bytes) {
  return bytesToHexLower(bytes).toUpperCase();
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  let current = base % modulus;
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = (result * current) % modulus;
    current = (current * current) % modulus;
    power >>= 1n;
  }
  return result;
}

function rsaEncryptSecretKey(secretKey) {
  const reversed = secretKey.split('').reverse().join('');
  let hex = '';
  for (const char of reversed) hex += char.charCodeAt(0).toString(16).padStart(2, '0');
  const encrypted = modPow(BigInt(`0x${hex}`), NETEASE_PUBKEY, BigInt(NETEASE_MODULUS));
  return encrypted.toString(16).padStart(256, '0');
}

async function aesCbcEncryptBase64(text, keyText) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(keyText),
    { name: 'AES-CBC' },
    false,
    ['encrypt']
  );
  const payload = pkcs7Pad(encoder.encode(text), 16);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: encoder.encode(NETEASE_IV) },
    cryptoKey,
    payload
  );
  return bytesToBase64(new Uint8Array(encrypted));
}

async function aesEcbEncrypt(text, keyText) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(keyText),
    { name: 'AES-CBC' },
    false,
    ['encrypt']
  );
  const payload = pkcs7Pad(encoder.encode(text), 16);
  const encrypted = new Uint8Array(payload.length);
  const iv = new Uint8Array(16);
  for (let offset = 0; offset < payload.length; offset += 16) {
    const block = payload.slice(offset, offset + 16);
    const encryptedBlock = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, block);
    encrypted.set(new Uint8Array(encryptedBlock).slice(0, 16), offset);
  }
  return encrypted;
}

function binaryStringToBytes(input) {
  const output = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) output[i] = input.charCodeAt(i) & 0xff;
  return output;
}

function leftRotate(value, amount) {
  return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

function md5Binary(input) {
  const message = typeof input === 'string' ? binaryStringToBytes(input) : new Uint8Array(input);
  const originalBitLength = message.length * 8;
  const withPaddingLength = (((message.length + 8) >> 6) + 1) << 6;
  const buffer = new Uint8Array(withPaddingLength);
  buffer.set(message);
  buffer[message.length] = 0x80;
  const dataView = new DataView(buffer.buffer);
  dataView.setUint32(buffer.length - 8, originalBitLength >>> 0, true);
  dataView.setUint32(buffer.length - 4, Math.floor(originalBitLength / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4,
    11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const constants = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);

  for (let offset = 0; offset < buffer.length; offset += 64) {
    const words = new Uint32Array(16);
    for (let i = 0; i < 16; i++) words[i] = dataView.getUint32(offset + i * 4, true);
    let a = a0,
      b = b0,
      c = c0,
      d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const next = d;
      d = c;
      c = b;
      b = (b + leftRotate((a + f + constants[i] + words[g]) >>> 0, shifts[i])) >>> 0;
      a = next;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const digest = new Uint8Array(16);
  const digestView = new DataView(digest.buffer);
  digestView.setUint32(0, a0, true);
  digestView.setUint32(4, b0, true);
  digestView.setUint32(8, c0, true);
  digestView.setUint32(12, d0, true);
  return digest;
}

async function createWeapiBody(body) {
  const secretKey = randomHex(16);
  const firstPass = await aesCbcEncryptBase64(JSON.stringify(body), NETEASE_NONCE);
  const secondPass = await aesCbcEncryptBase64(firstPass, secretKey);
  return { params: secondPass, encSecKey: rsaEncryptSecretKey(secretKey) };
}

async function createEapiBody(pathname, body) {
  const payload = JSON.stringify(body);
  const digestText = `nobody${pathname}use${payload}md5forencrypt`;
  const digest = bytesToHexLower(md5Binary(encoder.encode(digestText)));
  const data = `${pathname}-${NETEASE_EAPI_SALT}-${payload}-${NETEASE_EAPI_SALT}-${digest}`;
  return { params: bytesToHexUpper(await aesEcbEncrypt(data, NETEASE_EAPI_KEY)) };
}

function buildCookieHeader(cookie) {
  const parts = [`os=android`, `appver=8.9.70`, `buildver=${Math.floor(Date.now() / 1000)}`];
  if (cookie) parts.unshift(cookie);
  if (!/NMTID=/i.test(cookie || '')) parts.push(`NMTID=00${randomHex(30)}`);
  return parts.join('; ');
}

function eapiHeaders(cookie) {
  const ip = randomIp();
  return {
    Referer: 'https://music.163.com/',
    Cookie: buildCookieHeader(cookie),
    'User-Agent': NETEASE_EAPI_UA,
    'X-Real-IP': ip,
    'X-Forwarded-For': ip,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

function weapiHeaders(cookie) {
  const ip = randomIp();
  return {
    Referer: 'https://music.163.com/',
    Origin: 'https://music.163.com',
    Cookie: buildCookieHeader(cookie),
    'User-Agent': NETEASE_WEAPI_UA,
    'X-Real-IP': ip,
    'X-Forwarded-For': ip,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

async function postEapi(pathname, body, cookie) {
  const encrypted = await createEapiBody(pathname, body);
  const url = `https://music.163.com${pathname.replace('/api/', '/eapi/')}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: eapiHeaders(cookie),
    body: new URLSearchParams(encrypted).toString(),
  });
  if (!res.ok) throw new ApiError(502, `网易云上游失败: ${res.status}`);
  return res.json();
}

async function postWeapi(pathname, body, cookie) {
  const encrypted = await createWeapiBody(body);
  const res = await fetch(`https://music.163.com${pathname}`, {
    method: 'POST',
    headers: weapiHeaders(cookie),
    body: new URLSearchParams(encrypted).toString(),
  });
  if (!res.ok) throw new ApiError(502, `网易云上游失败: ${res.status}`);
  return res.json();
}

async function postWeapiFull(pathname, body, cookie = '') {
  const encrypted = await createWeapiBody(body);
  const res = await fetch(`https://music.163.com${pathname}`, {
    method: 'POST',
    headers: weapiHeaders(cookie),
    body: new URLSearchParams(encrypted).toString(),
  });
  let data = {};
  try {
    data = await res.json();
  } catch (_) {
    data = {};
  }
  let setCookies = [];
  try {
    if (typeof res.headers.getSetCookie === 'function') {
      setCookies = res.headers.getSetCookie();
    }
  } catch (_) {}
  return { ok: res.ok, status: res.status, data, setCookies };
}

async function postEapiFull(pathname, body, cookie = '') {
  const encrypted = await createEapiBody(pathname, body);
  const url = `https://interface.music.163.com${pathname.replace('/api/', '/eapi/')}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: eapiHeaders(cookie),
    body: new URLSearchParams(encrypted).toString(),
  });
  let data = {};
  try {
    data = await res.json();
  } catch (_) {
    data = {};
  }
  let setCookies = [];
  try {
    if (typeof res.headers.getSetCookie === 'function') {
      setCookies = res.headers.getSetCookie();
    }
  } catch (_) {}
  // eapi 有时 cookie 在 body
  if (typeof data?.cookie === 'string') {
    setCookies = setCookies.concat(String(data.cookie).split(';;'));
  } else if (Array.isArray(data?.cookie)) {
    setCookies = setCookies.concat(data.cookie);
  }
  return { ok: res.ok, status: res.status, data, setCookies };
}

function pickCookiePairs(setCookies = [], existing = '') {
  const jar = new Map();
  const push = (raw) => {
    String(raw || '')
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .forEach((pair) => {
        const i = pair.indexOf('=');
        if (i <= 0) return;
        const k = pair.slice(0, i).trim();
        const v = pair.slice(i + 1).trim();
        if (!k || /^(Path|Domain|Expires|Max-Age|HttpOnly|Secure|SameSite)$/i.test(k)) return;
        jar.set(k, v);
      });
  };
  push(existing);
  for (const line of setCookies) push(String(line || '').split(';')[0]);
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

const ANON_ID_XOR_KEY = '3go8&$8*3*3h0k(2)2';
const QR_SESSION_KV_PREFIX = 'QR_SESSION:';

function cloudmusicDllEncodeId(someId) {
  const raw = String(someId || '');
  let xored = '';
  for (let i = 0; i < raw.length; i++) {
    xored += String.fromCharCode(raw.charCodeAt(i) ^ ANON_ID_XOR_KEY.charCodeAt(i % ANON_ID_XOR_KEY.length));
  }
  return bytesToBase64(md5Binary(xored));
}

function anonymousUsername(deviceId) {
  const combined = `${deviceId} ${cloudmusicDllEncodeId(deviceId)}`;
  return bytesToBase64(encoder.encode(combined));
}

function generateDeviceId() {
  const hex = '0123456789ABCDEF';
  let out = '';
  for (let i = 0; i < 52; i++) out += hex[Math.floor(Math.random() * hex.length)];
  return out;
}

function generateChainId(cookie) {
  const match = String(cookie || '').match(/(?:^|;\s*)sDeviceId=([^;]+)/i);
  const deviceId = match?.[1] || `unknown-${Math.floor(Math.random() * 1e6)}`;
  return `v1_${deviceId}_web_login_${Date.now()}`;
}

function getCookieValue(cookie, name) {
  const match = String(cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`, 'i'));
  return match ? decodeURIComponent(match[1]) : '';
}

/** 游客注册，拿到 MUSIC_A，扫码前必须有，否则 check 常返回 -462 */
async function registerAnonymous() {
  const deviceId = generateDeviceId();
  const username = anonymousUsername(deviceId);
  const seedCookie = [
    `os=pc`,
    `appver=3.1.7`,
    `osver=Windows 10`,
    `deviceId=${deviceId}`,
    `sDeviceId=${deviceId}`,
    `channel=netease`,
    `NMTID=00${randomHex(30)}`,
  ].join('; ');

  // 优先 eapi（与 api-enhanced 一致），失败再试 weapi
  let result = await postEapiFull('/api/register/anonimous', { username }, seedCookie);
  if (!getCookieValue(pickCookiePairs(result.setCookies, result.data?.cookie || seedCookie), 'MUSIC_A')) {
    result = await postWeapiFull('/weapi/register/anonimous', { username }, seedCookie);
  }

  const cookie = pickCookiePairs(result.setCookies, result.data?.cookie || seedCookie);
  const merged = pickCookiePairs([], `${cookie}; deviceId=${deviceId}; sDeviceId=${deviceId}; os=pc; appver=3.1.7`);
  if (!getCookieValue(merged, 'MUSIC_A')) {
    // 没有 MUSIC_A 也能继续试 unikey，但成功率更低
    console.warn('anonimous 未返回 MUSIC_A', result.data?.code, result.data?.message);
  }
  return { cookie: merged, deviceId };
}

async function saveQrSession(env, key, cookie) {
  const kv = getKv(env);
  if (!kv) return false;
  await kv.put(`${QR_SESSION_KV_PREFIX}${key}`, cookie, { expirationTtl: 600 });
  return true;
}

async function loadQrSession(env, key) {
  const kv = getKv(env);
  if (!kv) return '';
  try {
    return String((await kv.get(`${QR_SESSION_KV_PREFIX}${key}`)) || '');
  } catch (_) {
    return '';
  }
}

/** 网易云扫码：游客 Cookie + type=3；二维码内容用 PC 版 URL（App 可识别） */
export async function createQrLogin(env) {
  const anon = await registerAnonymous();

  let ok = false;
  let data = {};
  // eapi 优先
  ({ ok, data } = await postEapiFull('/api/login/qrcode/unikey', { type: 3 }, anon.cookie));
  let unikey = data?.unikey || data?.data?.unikey;
  if (!unikey) {
    ({ ok, data } = await postWeapiFull('/weapi/login/qrcode/unikey', { type: 3 }, anon.cookie));
    unikey = data?.unikey || data?.data?.unikey;
  }
  if (!unikey) {
    throw new ApiError(502, `获取扫码 key 失败: ${data?.message || data?.code || 'unknown'}`);
  }

  const saved = await saveQrSession(env, unikey, anon.cookie);
  // PC 默认格式，不要加 chainId（chainId 是网页端，App 扫会失败）
  const qrurl = `https://music.163.com/login?codekey=${unikey}`;

  return {
    key: unikey,
    qrurl,
    session: saved ? '' : anon.cookie,
  };
}

/**
 * 轮询扫码状态。
 * 800 过期 / 801 等待扫码 / 802 待确认 / 803 成功
 * @param {{ saveToKv?: boolean, session?: string }} [options]
 */
export async function checkQrLogin(env, key, options = {}) {
  const saveToKv = options.saveToKv === true;
  const unikey = String(key || '').trim();
  if (!unikey) throw new ApiError(400, '缺少 key');

  let sessionCookie = String(options.session || '').trim();
  if (!sessionCookie) sessionCookie = await loadQrSession(env, unikey);

  let data = {};
  let setCookies = [];
  ({ data, setCookies } = await postEapiFull(
    '/api/login/qrcode/client/login',
    { key: unikey, type: 3 },
    sessionCookie
  ));
  // eapi 若被风控，回退 weapi
  if (Number(data?.code) === -462 || Number(data?.code) === 8821 || !Number.isFinite(Number(data?.code))) {
    ({ data, setCookies } = await postWeapiFull(
      '/weapi/login/qrcode/client/login',
      { key: unikey, type: 3 },
      sessionCookie
    ));
  }

  const code = Number(data?.code);
  const message = data?.message || '';

  if (code === -462 || code === 8821) {
    return {
      code,
      message: message || '网易云风控拦截（常见于 Cloudflare 出口 IP）。请改用「粘贴 Cookie」或稍后再试',
      cookieSaved: false,
      account: null,
    };
  }

  if (code === 803) {
    const cookie = pickCookiePairs(setCookies, data?.cookie || '');
    if (!cookie || !/MUSIC_U\s*=/i.test(cookie)) {
      throw new ApiError(502, '扫码成功但未拿到有效 Cookie');
    }

    let account = null;
    if (saveToKv) {
      await saveNeteaseCookie(env, cookie);
      try {
        account = await getAccount(env);
      } catch (_) {}
      return {
        code: 803,
        message: message || '授权登录成功',
        cookieSaved: true,
        account,
      };
    }

    try {
      account = await getAccount(env, cookie);
    } catch (_) {}
    return {
      code: 803,
      message: message || '授权登录成功',
      cookieSaved: false,
      cookie,
      account,
    };
  }

  return {
    code: Number.isFinite(code) ? code : 500,
    message: message || '未知状态',
    cookieSaved: false,
    account: null,
  };
}
export async function getAdminPassword(env) {
  const kv = getKv(env);
  if (kv) {
    try {
      const fromKv = String((await kv.get('ADMIN')) || '').trim();
      if (fromKv) return fromKv;
    } catch (error) {
      console.warn('读取 KV ADMIN 失败:', error?.message || error);
    }
  }
  return String(env.ADMIN || env.ACCESS_KEY || '').trim();
}

/** 公开：是否已设置 ADMIN / Cookie（不返回具体内容；Cookie 只看 KV） */
export async function getAdminBootstrap(env) {
  const kv = getKv(env);
  const admin = await getAdminPassword(env);
  let hasCookie = false;
  if (kv) {
    try {
      const cookie = String((await kv.get(COOKIE_KV_KEY)) || '').trim();
      hasCookie = Boolean(cookie);
    } catch (_) {}
  }
  return {
    hasKv: Boolean(kv),
    hasAdmin: Boolean(admin),
    hasCookie,
    needsSetup: !admin,
  };
}

/** 仅当尚未设置 ADMIN 时，写入 KV */
export async function setupAdminPassword(env, password) {
  const existing = await getAdminPassword(env);
  if (existing) {
    throw new ApiError(409, '管理密码已存在，请直接登录');
  }
  const kv = getKv(env);
  if (!kv) {
    throw new ApiError(503, '未绑定 KV（变量名须为 KV），无法设置管理密码');
  }
  const pwd = String(password || '').trim();
  if (pwd.length < 4) {
    throw new ApiError(400, '密码至少 4 位');
  }
  await kv.put('ADMIN', pwd);
  return true;
}

export async function saveNeteaseCookie(env, cookie) {
  const kv = getKv(env);
  if (!kv) throw new ApiError(503, '未绑定 KV（变量名须为 KV），无法保存 Cookie');
  const normalized = normalizeCookie(cookie);
  if (!/MUSIC_U\s*=/i.test(normalized)) {
    throw new ApiError(400, 'Cookie 无效：缺少 MUSIC_U');
  }
  await kv.put(COOKIE_KV_KEY, normalized);
  return normalized;
}

export async function getAccountStatus(env) {
  try {
    const account = await getAccount(env);
    return {
      configured: true,
      valid: true,
      expired: false,
      account,
      message: 'Cookie 有效',
    };
  } catch (error) {
    const status = error?.status || 500;
    if (status === 503) {
      return {
        configured: false,
        valid: false,
        expired: false,
        account: null,
        message: error.message || '未配置 Cookie',
      };
    }
    return {
      configured: true,
      valid: false,
      expired: true,
      account: null,
      message: error?.message || 'Cookie 已失效',
    };
  }
}

function httpsUrl(url) {
  return String(url || '').replace(/^http:/, 'https:');
}

function artistsText(song) {
  if (Array.isArray(song?.ar)) return song.ar.map((a) => a.name).filter(Boolean).join(', ');
  if (Array.isArray(song?.artists)) {
    return song.artists.map((a) => (typeof a === 'string' ? a : a.name)).filter(Boolean).join(', ');
  }
  if (typeof song?.artists === 'string') return song.artists;
  return 'Unknown';
}

function formatTrack(song) {
  return {
    id: song.id,
    name: song.name || '未知歌曲',
    artists: artistsText(song),
    artist: artistsText(song),
    album: song?.al?.name || song?.album?.name || (typeof song?.album === 'string' ? song.album : '') || '',
    picUrl: httpsUrl(song?.al?.picUrl || song?.album?.picUrl || song?.picUrl || ''),
  };
}

const LEVEL_FALLBACKS = {
  jymaster: ['jymaster', 'sky', 'jyeffect', 'hires', 'lossless', 'exhigh', 'higher', 'standard'],
  sky: ['sky', 'jyeffect', 'hires', 'lossless', 'exhigh', 'higher', 'standard'],
  jyeffect: ['jyeffect', 'hires', 'lossless', 'exhigh', 'higher', 'standard'],
  hires: ['hires', 'lossless', 'exhigh', 'higher', 'standard'],
  lossless: ['lossless', 'exhigh', 'higher', 'standard'],
  exhigh: ['exhigh', 'higher', 'standard'],
  higher: ['higher', 'standard'],
  standard: ['standard'],
};

export async function getAccount(env, cookieOverride = '') {
  const cookie = await getCookie(env, cookieOverride);
  const data = await postWeapi('/weapi/w/nuser/account/get', {}, cookie);
  const profile = data?.profile || data?.account;
  const userId = data?.profile?.userId || data?.account?.id;
  if (!userId) throw new ApiError(401, 'Cookie 无效或已过期，请重新扫码登录');
  return {
    userId,
    nickname: data?.profile?.nickname || '',
    avatarUrl: httpsUrl(data?.profile?.avatarUrl || ''),
    vipType: data?.profile?.vipType ?? null,
  };
}

export async function getUserPlaylists(env, uid, limit = 1000, offset = 0, cookieOverride = '') {
  const cookie = await getCookie(env, cookieOverride);
  const userId = uid || (await getAccount(env, cookieOverride)).userId;
  const data = await postWeapi(
    '/weapi/user/playlist',
    { uid: String(userId), limit, offset, includeVideo: true },
    cookie
  );
  const list = Array.isArray(data?.playlist) ? data.playlist : [];
  return list.map((p) => {
    const ownerId = p.userId ?? p.creator?.userId;
    const subscribed = p.subscribed === true || String(ownerId) !== String(userId);
    return {
      id: p.id,
      name: p.name || '未命名歌单',
      coverImgUrl: httpsUrl(p.coverImgUrl || ''),
      trackCount: p.trackCount || 0,
      playCount: p.playCount || 0,
      creator: p.creator?.nickname || '',
      userId: ownerId,
      specialType: p.specialType ?? 0,
      subscribed,
      // created = 我创建的；subscribed = 收藏的他人歌单
      category: subscribed ? 'subscribed' : 'created',
    };
  });
}

export async function getPlaylistDetail(env, id, cookieOverride = '') {
  const cookie = await getCookie(env, cookieOverride);
  const playlistId = String(id || '').trim();
  if (!/^\d+$/.test(playlistId)) throw new ApiError(400, '歌单 ID 必须是数字');

  const data = await postEapi(
    '/api/v6/playlist/detail',
    { id: playlistId, t: '0', n: '100000', s: '5' },
    cookie
  );
  const pl = data?.playlist;
  if (!pl) throw new ApiError(404, '歌单不存在');

  const trackIds = (Array.isArray(pl.trackIds) ? pl.trackIds : [])
    .map((t) => String(t?.id || ''))
    .filter((x) => /^\d+$/.test(x));
  const rawTracks = Array.isArray(pl.tracks) ? pl.tracks : [];
  const byId = new Map(rawTracks.map((s) => [String(s.id), formatTrack(s)]));

  const missing = trackIds.filter((tid) => !byId.has(tid));
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    const detail = await postEapi(
      '/api/v3/song/detail',
      { c: JSON.stringify(batch.map((tid) => ({ id: Number(tid) }))) },
      cookie
    );
    for (const song of detail?.songs || []) byId.set(String(song.id), formatTrack(song));
  }

  const ordered = (trackIds.length ? trackIds : rawTracks.map((s) => String(s.id)))
    .map((tid) => byId.get(tid))
    .filter(Boolean);

  return {
    id: pl.id,
    name: pl.name || '',
    coverImgUrl: httpsUrl(pl.coverImgUrl || ''),
    trackCount: ordered.length,
    tracks: ordered,
  };
}

export async function searchSongs(env, keyword, limit = 30, cookieOverride = '') {
  const cookie = await getCookie(env, cookieOverride);
  const data = await postEapi(
    '/api/cloudsearch/pc',
    { s: keyword, type: 1, limit: Number(limit) || 30, offset: 0, total: true },
    cookie
  );
  const songs = data?.result?.songs || data?.songs || [];
  return songs.map(formatTrack);
}

export async function getSongDetail(env, id, cookieOverride = '') {
  const cookie = await getCookie(env, cookieOverride);
  const songId = String(id || '').trim();
  if (!/^\d+$/.test(songId)) throw new ApiError(400, '歌曲 ID 必须是数字');
  const data = await postEapi(
    '/api/v3/song/detail',
    { c: JSON.stringify([{ id: Number(songId) }]) },
    cookie
  );
  const song = Array.isArray(data?.songs) ? data.songs[0] : null;
  if (!song) throw new ApiError(404, '歌曲不存在');
  return formatTrack(song);
}

export async function getSongUrl(env, id, level = 'jymaster', cookieOverride = '') {
  const cookie = await getCookie(env, cookieOverride);
  const songId = String(id || '').trim();
  if (!/^\d+$/.test(songId)) throw new ApiError(400, '歌曲 ID 必须是数字');

  const detailPromise = postEapi(
    '/api/v3/song/detail',
    { c: JSON.stringify([{ id: Number(songId) }]) },
    cookie
  ).catch(() => null);

  const levels = LEVEL_FALLBACKS[level] || LEVEL_FALLBACKS.exhigh;
  let last = null;
  let urlPayload = null;
  for (const lv of levels) {
    const data = await postEapi(
      '/api/song/enhance/player/url/v1',
      {
        ids: JSON.stringify([songId]),
        level: lv,
        encodeType: 'flac',
      },
      cookie
    );
    const item = Array.isArray(data?.data) ? data.data[0] : null;
    if (item) last = item;
    const url = item?.uf?.url || item?.url || '';
    if (url) {
      urlPayload = {
        id: Number(songId),
        url: httpsUrl(url),
        level: item.level || lv,
        br: item.br || 0,
        size: item.size || 0,
        type: item.type || '',
      };
      break;
    }
  }
  if (!urlPayload) {
    throw new ApiError(404, last?.code === 200 ? '暂无可用音源' : '获取播放地址失败（可能无版权或 Cookie 无效）');
  }

  const detail = await detailPromise;
  const song = Array.isArray(detail?.songs) ? detail.songs[0] : null;
  if (song) {
    const meta = formatTrack(song);
    return {
      ...urlPayload,
      name: meta.name,
      artist: meta.artist,
      artists: meta.artists,
      album: meta.album,
      picUrl: meta.picUrl,
    };
  }
  return urlPayload;
}

export async function getLyric(env, id, cookieOverride = '') {
  const cookie = await getCookie(env, cookieOverride);
  const songId = Number.parseInt(id, 10);
  if (!Number.isFinite(songId)) throw new ApiError(400, '歌曲 ID 必须是数字');
  const data = await postEapi(
    '/api/song/lyric',
    { id: songId, lv: -1, kv: -1, tv: -1, rv: -1, yv: -1 },
    cookie
  );
  return {
    lrc: data?.lrc?.lyric || '',
    tlyric: data?.tlyric?.lyric || '',
  };
}
