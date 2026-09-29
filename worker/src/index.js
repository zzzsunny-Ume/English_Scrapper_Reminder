// Cloudflare Worker: 웹푸시 발송 릴레이.
//
// Apps Script(Code.gs)는 VAPID 서명에 필요한 타원곡선 암호화를 지원하지 않기 때문에,
// "오늘 복습할 표현이 있는 사용자에게 실제로 푸시를 쏘는" 역할만 이 Worker가 맡는다.
// 데이터(누가 뭘 구독했는지, 오늘 몇 개나 밀렸는지)는 전부 Apps Script의
// `pushTargets` 액션에서 가져오고, 이 Worker는 상태를 갖지 않는다(stateless relay).
//
// 매일 cron 트리거(wrangler.toml)로 자동 실행되며, /trigger 경로로 수동 테스트도 가능.

import webpush from 'web-push';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDueReviewPushes(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/trigger') {
      const summary = await sendDueReviewPushes(env);
      return new Response(JSON.stringify(summary, null, 2), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('English Review Push Relay is running. Use /trigger for a manual test run.');
  },
};

async function sendDueReviewPushes(env) {
  requireEnv(env, ['VAPID_SUBJECT', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'APPS_SCRIPT_URL', 'APPS_SCRIPT_SECRET']);

  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

  const apiUrl = new URL(env.APPS_SCRIPT_URL);
  apiUrl.searchParams.set('action', 'pushTargets');
  apiUrl.searchParams.set('secret', env.APPS_SCRIPT_SECRET);

  const res = await fetch(apiUrl.toString());
  const data = await res.json();

  if (data.error) {
    console.error('pushTargets 조회 실패:', data.error);
    return { ok: false, error: data.error };
  }

  const targets = data.targets || [];
  console.log(`발송 대상 ${targets.length}건`);

  const results = await Promise.allSettled(targets.map((t) => sendOne(t)));

  let sent = 0;
  let expired = 0;
  let failed = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      if (r.value === 'expired') expired++;
      else sent++;
    } else {
      failed++;
      console.error('발송 실패:', targets[i].endpoint, r.reason && r.reason.message);
    }
  });

  const summary = { ok: true, total: targets.length, sent, expired, failed };
  console.log('발송 요약:', JSON.stringify(summary));
  return summary;
}

async function sendOne(target) {
  const subscription = {
    endpoint: target.endpoint,
    keys: { p256dh: target.p256dh, auth: target.auth },
  };
  const payload = JSON.stringify({
    title: '오늘 복습할 표현이 있어요 📚',
    body: `${target.dueCount}개가 복습을 기다리고 있어요. 지금 열어서 확인해보세요!`,
    url: './index.html',
  });

  try {
    await webpush.sendNotification(subscription, payload);
    return 'sent';
  } catch (err) {
    // 410 Gone / 404 Not Found = 사용자가 알림을 끄거나 앱을 지워서 구독이 더 이상
    // 유효하지 않은 것. 에러가 아니라 정상적인 상황이므로 그냥 건너뛴다.
    // (구독 테이블 정리는 Apps Script 쪽에서 별도로 처리하지 않으므로, 필요하면
    // 이 부분에서 Apps Script에 삭제 요청을 보내는 로직을 추가해도 됨)
    if (err && (err.statusCode === 404 || err.statusCode === 410)) {
      return 'expired';
    }
    throw err;
  }
}

function requireEnv(env, keys) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Worker 환경변수/시크릿이 설정되지 않음: ${missing.join(', ')}`);
  }
}
