import {
  ApiError,
  getAccount,
  getAccountStatus,
  getUserPlaylists,
  getPlaylistDetail,
  searchSongs,
  getSongUrl,
  getLyric,
  getAdminPassword,
  getAdminBootstrap,
  setupAdminPassword,
  createQrLogin,
  checkQrLogin,
  saveNeteaseCookie,
} from '../_lib/netease.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, X-API-Key, X-Admin-Password, X-Netease-Cookie, X-Qr-Session',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders,
    },
  });
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch (_) {
    return {};
  }
}

/** Visitor cookie cached in browser; never written to KV. */
function clientCookie(request) {
  return String(request.headers.get('X-Netease-Cookie') || '').trim();
}

function getProvidedAdmin(request, body = {}) {
  const url = new URL(request.url);
  return (
    body.password ||
    body.admin ||
    url.searchParams.get('password') ||
    request.headers.get('X-Admin-Password') ||
    request.headers.get('X-API-Key') ||
    request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ||
    ''
  ).trim();
}

async function requireAdmin(request, env, body = {}) {
  const admin = await getAdminPassword(env);
  if (!admin) {
    throw new ApiError(503, '未配置管理密码：请在 KV 写入键 ADMIN');
  }
  const provided = getProvidedAdmin(request, body);
  if (!provided || provided !== admin) {
    throw new ApiError(401, '管理密码错误');
  }
  return admin;
}

/** 可选的全站 API Key（环境变量），不影响 ADMIN 管理面板 */
function checkAccess(request, env) {
  const key = String(env.ACCESS_KEY || '').trim();
  if (!key) return;
  const url = new URL(request.url);
  if (url.pathname.includes('/admin') || url.pathname.includes('/qr')) return;
  const provided =
    url.searchParams.get('apikey') ||
    request.headers.get('X-API-Key') ||
    request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ||
    '';
  if (provided !== key) throw new ApiError(401, 'API Key 无效');
}

async function route(request, env, path) {
  const url = new URL(request.url);
  const q = url.searchParams;
  const method = request.method.toUpperCase();
  const cc = clientCookie(request);

  if (path === '' || path === '/' || path === '/health') {
    return json({ ok: true, service: 'wyplayer-netease-api' });
  }

  // -------- 管理面板（ADMIN）--------
  if (path === '/admin/bootstrap') {
    const data = await getAdminBootstrap(env);
    return json({ code: 200, data });
  }

  if (path === '/admin/setup' && method === 'POST') {
    const body = await readJsonBody(request);
    await setupAdminPassword(env, body.password || body.admin || '');
    return json({ code: 200, message: '管理密码已设置', data: { ok: true } });
  }

  if (path === '/admin/login' && method === 'POST') {
    const body = await readJsonBody(request);
    await requireAdmin(request, env, body);
    return json({ code: 200, message: '登录成功', data: { ok: true } });
  }

  if (path === '/admin/status') {
    await requireAdmin(request, env);
    // 始终看 KV 站点 Cookie，不受访客本机 Cookie 影响
    const status = await getAccountStatus(env);
    return json({ code: 200, data: status });
  }

  if (path === '/admin/qr/key') {
    await requireAdmin(request, env);
    const data = await createQrLogin(env);
    return json({ code: 200, data });
  }

  if (path === '/admin/qr/check') {
    await requireAdmin(request, env);
    const data = await checkQrLogin(env, q.get('key'), {
      saveToKv: true,
      session: q.get('session') || request.headers.get('X-Qr-Session') || '',
    });
    return json({ code: 200, data });
  }

  if (path === '/admin/cookie' && method === 'POST') {
    const body = await readJsonBody(request);
    await requireAdmin(request, env, body);
    await saveNeteaseCookie(env, body.cookie || body.NETEASE_COOKIE || '');
    const status = await getAccountStatus(env);
    return json({ code: 200, message: 'Cookie 已保存', data: status });
  }

  // -------- 访客扫码（只回传 Cookie，不写 KV）--------
  if (path === '/qr/key') {
    const data = await createQrLogin(env);
    return json({ code: 200, data });
  }

  if (path === '/qr/check') {
    const data = await checkQrLogin(env, q.get('key'), {
      saveToKv: false,
      session: q.get('session') || request.headers.get('X-Qr-Session') || '',
    });
    return json({ code: 200, data });
  }

  checkAccess(request, env);

  if (path === '/me' || path === '/163_account') {
    const data = await getAccount(env, cc);
    return json({
      code: 200,
      data: {
        ...data,
        source: cc ? 'local' : 'kv',
      },
    });
  }

  if (path === '/user/playlists' || path === '/163_user_playlist') {
    const uid = q.get('uid') || undefined;
    const data = await getUserPlaylists(env, uid, 1000, 0, cc);
    return json({ code: 200, data });
  }

  if (path === '/playlist' || path === '/163_playlist') {
    const id = q.get('id');
    const data = await getPlaylistDetail(env, id, cc);
    return json({ code: 200, data });
  }

  if (path === '/search' || path === '/163_search') {
    const keyword = q.get('keyword') || q.get('keywords') || q.get('s') || '';
    if (!keyword.trim()) return json({ code: 400, message: '缺少 keyword' }, 400);
    const data = await searchSongs(env, keyword.trim(), q.get('limit') || 30, cc);
    return json({ code: 200, data });
  }

  if (path === '/song' || path === '/163_music') {
    const id = q.get('id');
    const level = q.get('level') || 'jymaster';
    const data = await getSongUrl(env, id, level, cc);
    return json({ code: 200, data });
  }

  if (path === '/lyric' || path === '/163_lyric') {
    const id = q.get('id');
    const data = await getLyric(env, id, cc);
    return json({ code: 200, data });
  }

  return json({ code: 404, message: `未知接口: ${path}` }, 404);
}

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const parts = params.path;
    const path = '/' + (Array.isArray(parts) ? parts.join('/') : parts || '');
    return await route(request, env, path);
  } catch (error) {
    const status = error?.status || 500;
    const message = error?.message || '服务内部错误';
    return json({ code: status, message }, status);
  }
}
