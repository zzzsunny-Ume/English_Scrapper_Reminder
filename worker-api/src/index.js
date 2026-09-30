// PWA의 유일한 백엔드. Apps Script나 구글 시트를 요청마다 직접 부르지 않고,
// Cloudflare KV에 미리 동기화된 데이터만 읽고 쓴다 - 그래서 매번 빠르다.
//
// 데이터 흐름:
//   [Code.gs, 1분마다] --sync(POST)--> [KV: wordlist:*, sources, banned]
//   [PWA] <----------즉시 응답(KV read/write만)----------> [이 Worker]
//
// 복습기록/통계/푸시구독은 원래 Apps Script가 읽거나 쓸 일이 없던, 순수하게
// PWA 전용인 데이터라서 구글 시트에는 전혀 손대지 않고 KV에만 저장한다.
// (그래서 서비스 계정도, Sheets API 권한도 전혀 필요 없음)

const CORS_HEADERS = { 'access-control-allow-origin': '*' };
const DEFAULT_SOURCES = [{ id: 'common', label: '🌐 공동 (다같이 모은 표현)' }];
const BOX_INTERVALS_DAYS = { 1: 0, 2: 1, 3: 3, 4: 7, 5: 14, 6: 30 };
const KST_OFFSET_MS = 9 * 60 * 60 * 1000; // 한국시간 고정 (서머타임 없음)

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const action = url.searchParams.get('action');

      // Apps Script가 표현목록을 갱신할 때마다 호출 - 로그인 사용자가 아니라
      // 서버 대 서버 호출이므로 idToken이 아니라 별도 시크릿 헤더로 인증한다.
      if (action === 'sync') {
        if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
        return await handleSync(request, env);
      }

      // 웹푸시 발송 Worker(cron)가 호출 - 마찬가지로 서버 대 서버, 시크릿 인증
      if (action === 'pushTargets') {
        return json(await getPushTargets(env, url.searchParams.get('secret') || ''));
      }

      const idToken = url.searchParams.get('idToken') || '';
      const auth = await verifyGoogleIdToken(idToken, env);
      if (!auth) return json({ error: 'unauthorized' });

      const banned = await kvGetJson(env, 'banned', []);
      if (banned.includes(auth.email.toLowerCase())) return json({ error: 'banned' });

      const sender = auth.email;

      if (action === 'sources') {
        return json({ sources: await kvGetJson(env, 'sources', DEFAULT_SOURCES) });
      }
      if (action === 'dueReviews') {
        return json(await getDueReviews(env, sender, url.searchParams.get('source') || 'common'));
      }
      if (action === 'submitReview') {
        const key = url.searchParams.get('key') || '';
        const correct = url.searchParams.get('correct') === 'true';
        if (!key) return json({ error: 'missing key' });
        return json(await submitReview(env, sender, key, correct));
      }
      if (action === 'subscribePush') {
        const endpoint = url.searchParams.get('endpoint') || '';
        const p256dh = url.searchParams.get('p256dh') || '';
        const authKey = url.searchParams.get('auth') || '';
        if (!endpoint || !p256dh || !authKey) return json({ error: 'missing params' });
        return json(await savePushSubscription(env, sender, endpoint, p256dh, authKey));
      }
      if (action === 'unsubscribePush') {
        return json(await deletePushSubscription(env, sender, url.searchParams.get('endpoint') || ''));
      }

      return json({ error: 'unknown action', action });
    } catch (err) {
      return json({ error: String((err && err.message) || err) });
    }
  },
};

// ============================================================
// ===== KV 헬퍼 =====
// ============================================================
async function kvGetJson(env, key, fallback) {
  const raw = await env.KV.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}
async function kvPutJson(env, key, value) {
  await env.KV.put(key, JSON.stringify(value));
}

function kstTodayMidnightMs() {
  const now = new Date();
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  return Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - KST_OFFSET_MS;
}
function kstDateStr(ms) {
  const kst = new Date(ms + KST_OFFSET_MS);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ============================================================
// ===== 동기화 (Apps Script -> KV) =====
// ============================================================
// body: { sources: [{id,label}], banned: ["a@b.com"], wordlists: { common: [...], <sourceId>: [...] } }
async function handleSync(request, env) {
  const secret = request.headers.get('x-sync-secret') || '';
  if (!env.SYNC_SECRET || secret !== env.SYNC_SECRET) return json({ error: 'unauthorized' }, 401);

  const body = await request.json();
  const writes = [];
  if (body.sources) writes.push(kvPutJson(env, 'sources', body.sources));
  if (body.banned) writes.push(kvPutJson(env, 'banned', body.banned.map((e) => String(e).trim().toLowerCase())));
  if (body.wordlists) {
    Object.keys(body.wordlists).forEach((sourceId) => {
      writes.push(kvPutJson(env, `wordlist:${sourceId}`, body.wordlists[sourceId]));
    });
  }
  await Promise.all(writes);
  return json({ ok: true, synced: Object.keys(body.wordlists || {}).length });
}

// ============================================================
// ===== 복습 로직 =====
// ============================================================
async function getDueReviews(env, sender, source) {
  const all = await kvGetJson(env, `wordlist:${source || 'common'}`, []);
  const reviewMap = await kvGetJson(env, `review:${sender}`, {});
  const stats = await kvGetJson(env, `stats:${sender}`, { streak: 0, bestStreak: 0, lastStudyDate: '' });

  const todayDateStr = kstDateStr(kstTodayMidnightMs());
  const due = [];
  all.forEach((word) => {
    const rec = reviewMap[word.key];
    if (!rec) {
      due.push(word);
      return;
    }
    // "yyyy-MM-dd" 문자열은 그대로 사전식 비교해도 날짜 순서와 일치한다.
    // new Date(dateStr)로 파싱하면 UTC 자정으로 해석되는데 여기 기준은 KST라서
    // 최대 9시간 어긋나 "오늘 다시 봐야 할" 박스1 단어가 하루 늦게 잡히는 버그가 있었음.
    if (rec.nextDue <= todayDateStr) due.push(word);
  });

  const boxSummary = { notStarted: 0, shortTerm: 0, longTerm: 0 };
  all.forEach((word) => {
    const rec = reviewMap[word.key];
    if (!rec || !rec.box) boxSummary.notStarted++;
    else if (rec.box <= 3) boxSummary.shortTerm++;
    else boxSummary.longTerm++;
  });

  return {
    total: all.length,
    studied: all.filter((w) => reviewMap[w.key]).length,
    globalStudied: Object.keys(reviewMap).length,
    dueCount: due.length,
    due: due.map((w) => ({
      korean: w.korean,
      english: w.english,
      definition: w.definition,
      example: w.example,
      key: w.key,
      box: reviewMap[w.key] ? reviewMap[w.key].box : 0,
    })),
    boxSummary,
    stats,
  };
}

async function submitReview(env, sender, key, correct) {
  const reviewMap = await kvGetJson(env, `review:${sender}`, {});
  const currentBox = reviewMap[key] ? reviewMap[key].box : 0;
  const newBox = correct ? Math.min((currentBox || 0) + 1, 6) : 1;
  const intervalDays = BOX_INTERVALS_DAYS[newBox] !== undefined ? BOX_INTERVALS_DAYS[newBox] : 30;

  const todayMs = kstTodayMidnightMs();
  const todayStr = kstDateStr(todayMs);
  const nextDueStr = kstDateStr(todayMs + intervalDays * 86400000);

  reviewMap[key] = { box: newBox, nextDue: nextDueStr };

  const stats = await kvGetJson(env, `stats:${sender}`, { streak: 0, bestStreak: 0, lastStudyDate: '' });
  const yesterdayStr = kstDateStr(todayMs - 86400000);
  if (stats.lastStudyDate !== todayStr) {
    stats.streak = stats.lastStudyDate === yesterdayStr ? (stats.streak || 0) + 1 : 1;
    stats.lastStudyDate = todayStr;
    stats.bestStreak = Math.max(stats.bestStreak || 0, stats.streak);
  }

  await Promise.all([kvPutJson(env, `review:${sender}`, reviewMap), kvPutJson(env, `stats:${sender}`, stats)]);

  return { ok: true, box: newBox, nextDue: nextDueStr, stats };
}

// ============================================================
// ===== 웹푸시 구독 =====
// ============================================================
async function savePushSubscription(env, sender, endpoint, p256dh, authKey) {
  const subs = await kvGetJson(env, `push:${sender}`, []);
  if (subs.some((s) => s.endpoint === endpoint)) return { ok: true, alreadyExists: true };
  subs.push({ endpoint, p256dh, auth: authKey });
  await kvPutJson(env, `push:${sender}`, subs);
  return { ok: true };
}

async function deletePushSubscription(env, sender, endpoint) {
  const subs = await kvGetJson(env, `push:${sender}`, []);
  const filtered = endpoint ? subs.filter((s) => s.endpoint !== endpoint) : [];
  await kvPutJson(env, `push:${sender}`, filtered);
  return { ok: true };
}

// 웹푸시 발송 Worker(cron)가 매일 호출. "공동" 소스 기준으로 due 개수를 계산한다
// (기존 Apps Script 버전과 동일한 단순화 - 개인 소스별 알림은 지원하지 않음).
async function getPushTargets(env, secret) {
  if (!env.PUSH_RELAY_SECRET || secret !== env.PUSH_RELAY_SECRET) return { error: 'unauthorized' };

  const list = await env.KV.list({ prefix: 'push:' });
  const allWords = await kvGetJson(env, 'wordlist:common', []);
  const todayDateStr = kstDateStr(kstTodayMidnightMs());

  const targets = [];
  for (const k of list.keys) {
    const sender = k.name.slice('push:'.length);
    const subs = await kvGetJson(env, k.name, []);
    if (subs.length === 0) continue;

    const reviewMap = await kvGetJson(env, `review:${sender}`, {});
    let due = 0;
    allWords.forEach((w) => {
      const rec = reviewMap[w.key];
      if (!rec) {
        due++;
        return;
      }
      if (rec.nextDue <= todayDateStr) due++;
    });

    if (due > 0) {
      subs.forEach((s) => targets.push({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth, dueCount: due }));
    }
  }
  return { targets };
}

// ============================================================
// ===== 구글 idToken 로컬 검증 =====
// ============================================================
// 구글 tokeninfo 엔드포인트에 매번 네트워크로 묻는 대신, 구글의 공개키(JWKS, 1시간
// 캐시)로 서명을 직접 검증한다. Workers는 WebCrypto를 기본 제공하므로 외부
// 라이브러리 없이도 가능 - 외부 네트워크 호출이 사실상 없어져서 이 부분이 훨씬 빠르다.
let jwksCache = null;
async function getGoogleJwks() {
  if (jwksCache && jwksCache.expiry > Date.now()) return jwksCache.keys;
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  const data = await res.json();
  jwksCache = { keys: data.keys, expiry: Date.now() + 3600 * 1000 };
  return jwksCache.keys;
}

function base64UrlDecodeToUint8(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function verifyGoogleIdToken(idToken, env) {
  if (!idToken) return null;
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    const [encHeader, encPayload, encSig] = parts;
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecodeToUint8(encHeader)));
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecodeToUint8(encPayload)));

    if (payload.aud !== env.GOOGLE_CLIENT_ID) return null;
    if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') return null;
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    if (!payload.email || (payload.email_verified !== true && payload.email_verified !== 'true')) return null;

    const jwks = await getGoogleJwks();
    const jwk = jwks.find((k) => k.kid === header.kid);
    if (!jwk) return null;

    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
      'verify',
    ]);
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      base64UrlDecodeToUint8(encSig),
      new TextEncoder().encode(`${encHeader}.${encPayload}`)
    );
    if (!ok) return null;

    return { email: payload.email, name: payload.name || payload.email };
  } catch (e) {
    return null;
  }
}
