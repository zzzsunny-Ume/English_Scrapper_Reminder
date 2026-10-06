# Code.gs 추가 패치 (기존 코드는 그대로, 추가/최소 수정만)

> **⚠️ 안내:** PWA 아키텍처가 바뀌어서, 이제 PWA는 Apps Script의 `doGet` API를
> 전혀 호출하지 않고 Cloudflare Worker(`worker-api/`) + KV만 봅니다. 그래서
> 아래 STEP 1~3.5(웹푸시 구독 저장/`pushTargets`/`box` 필드/응답 속도 최적화)는
> **더 이상 필요 없습니다** — 만들어도 아무도 안 부르는 죽은 코드가 될 뿐입니다.
> 실제로 필요한 건 맨 아래 **STEP 6 (Cloudflare KV 동기화)** 하나뿐입니다.
>
> 이 문서를 처음부터 하나하나 따라하기보다는, **`backend/Code.full.gs`를 열어서
> 전체를 그대로 복사해 기존 Code.gs에 덮어쓰는 걸 권장합니다** (STEP 6까지 이미
> 다 반영되어 있음). 아래 STEP 1~5는 예전 아키텍처(PWA가 Apps Script를 직접
> 호출하던 방식)를 diff로 적용하고 싶은 경우에만 참고하세요.

이 문서는 기존에 운영 중인 `Code.gs`를 다시 쓰지 않고, PWA의 새 기능을 위해
**추가하거나 아주 조금만 고치면 되는 부분**만 정리한 것입니다. 기존 텔레그램
폴링/등록/삭제 로직은 전혀 건드리지 않습니다.

적용 순서:

1. [레거시] STEP 1 — 웹푸시 구독 저장 기능 추가
2. [레거시] STEP 2 — 발송 서버가 호출할 `pushTargets` 엔드포인트 추가
3. [레거시] STEP 3 — `dueReviews` 응답에 박스 단계(`box`)를 포함
4. [레거시] STEP 3.5 — 응답 속도 최적화 (스프레드시트 중복 오픈 제거, 토큰 검증 캐싱)
5. [레거시] STEP 4 — 스크립트 속성 추가
6. [레거시] STEP 5 — 재배포
7. **[필수, 현재 아키텍처] STEP 6 — Cloudflare KV 동기화**

---

## STEP 1. 웹푸시 구독 저장 (파일 맨 아래에 통째로 추가)

기존 함수를 하나도 바꾸지 않고, 파일 맨 아래에 아래 블록을 그대로 붙여넣으세요.

```js
// ===================================================================
// ===== 웹푸시 구독 저장/조회 (PWA 알림 기능용 - 신규 추가분) =====
// ===================================================================

const PUSH_SUB_SHEET_NAME = '푸시구독'; // 개인복습 스프레드시트 안에 자동 생성되는 탭

function getPushSubSheet() {
  const reviewSs = getReviewSpreadsheet();
  let sheet = reviewSs.getSheetByName(PUSH_SUB_SHEET_NAME);
  if (!sheet) {
    sheet = reviewSs.insertSheet(PUSH_SUB_SHEET_NAME);
    sheet.appendRow(['user_id', 'endpoint', 'p256dh', 'auth', '등록일']);
  }
  return sheet;
}

// 같은 사용자+같은 기기(endpoint)가 이미 구독 중이면 중복 추가하지 않음
function savePushSubscription(sender, endpoint, p256dh, authKey) {
  const sheet = getPushSubSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    for (let i = 0; i < values.length; i++) {
      if (values[i][0] === sender && values[i][1] === endpoint) {
        return { ok: true, alreadyExists: true };
      }
    }
  }
  sheet.appendRow([sender, endpoint, p256dh, authKey, new Date()]);
  return { ok: true };
}

// endpoint를 안 주면 그 사용자의 모든 기기 구독을 해제
function deletePushSubscription(sender, endpoint) {
  const sheet = getPushSubSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true };
  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i][0] === sender && (!endpoint || values[i][1] === endpoint)) {
      sheet.deleteRow(i + 2);
    }
  }
  return { ok: true };
}
```

## STEP 2. `pushTargets` 발송 대상 조회 (파일 맨 아래, STEP 1 아래에 이어서 추가)

Cloudflare Worker가 하루에 한 번(또는 정한 주기로) 이 액션을 호출해서 "오늘 알림을
보내야 할 사용자+기기+복습할 개수" 목록을 받아갑니다. 로그인 세션이 아니라 서버 대
서버 호출이라, 구글 idToken 대신 **비밀 문자열(secret)**로 인증합니다.

```js
// Cloudflare Worker(발송 서버)가 매일 정해진 시각에 호출.
// idToken 대신 스크립트 속성의 PUSH_RELAY_SECRET과 대조해서 인증한다.
function getPushTargets(secret) {
  const expected = PropertiesService.getScriptProperties().getProperty('PUSH_RELAY_SECRET');
  if (!expected || secret !== expected) {
    return { error: 'unauthorized' };
  }

  const subSheet = getPushSubSheet();
  const lastRow = subSheet.getLastRow();
  if (lastRow < 2) return { targets: [] };

  const subs = subSheet.getRange(2, 1, lastRow - 1, 4).getValues();
  const allWords = getWordListFromReviewSheet('common'); // 공동 시트 기준으로 due 개수 계산
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dueCountCache = {}; // 같은 사용자가 기기 여러 대로 구독 중일 수 있어서 캐시

  const targets = subs
    .map(row => {
      const sender = row[0];
      if (dueCountCache[sender] === undefined) {
        const reviewMap = getReviewMapForUser(sender);
        let due = 0;
        allWords.forEach(word => {
          const rec = reviewMap[word.key];
          if (!rec) { due++; return; }
          const nextDue = new Date(rec.nextDue);
          nextDue.setHours(0, 0, 0, 0);
          if (nextDue <= today) due++;
        });
        dueCountCache[sender] = due;
      }
      return { endpoint: row[1], p256dh: row[2], auth: row[3], dueCount: dueCountCache[sender] };
    })
    .filter(t => t.dueCount > 0); // 오늘 복습할 게 없는 사람에게는 알림 안 보냄

  return { targets: targets };
}
```

### `doGet` 함수 수정 (이 부분만 기존 함수를 고쳐야 함)

`pushTargets`는 로그인 사용자가 아니라 발송 서버가 부르는 것이라, 기존처럼
`idToken`을 검증하기 **전에** 먼저 처리해야 합니다. 또 `subscribePush` /
`unsubscribePush`는 로그인 사용자가 부르는 일반 액션이라 기존 액션들 옆에
추가합니다.

**기존 코드:**
```js
function doGet(e) {
  try {
    const action = e.parameter.action;
    const idToken = e.parameter.idToken || '';

    const auth = verifyGoogleToken(idToken);
```

**아래처럼 바꾸기 (idToken 검증 위에 pushTargets 분기만 추가):**
```js
function doGet(e) {
  try {
    const action = e.parameter.action;

    // 발송 서버(Cloudflare Worker) 전용 - 로그인 세션이 아니므로 idToken 검증 이전에 처리
    if (action === 'pushTargets') {
      return jsonResponse(getPushTargets(e.parameter.secret || ''));
    }

    const idToken = e.parameter.idToken || '';

    const auth = verifyGoogleToken(idToken);
```

**기존 `submitReview` 분기 바로 아래에 이 두 블록 추가:**
```js
    if (action === 'submitReview') {
      const key = e.parameter.key || '';
      const correct = e.parameter.correct === 'true';
      return jsonResponse(submitReview(sender, key, correct));
    }

    // ↓↓↓ 여기부터 신규 추가 ↓↓↓
    if (action === 'subscribePush') {
      const endpoint = e.parameter.endpoint || '';
      const p256dh = e.parameter.p256dh || '';
      const authKey = e.parameter.auth || '';
      if (!endpoint || !p256dh || !authKey) return jsonResponse({ error: 'missing params' });
      return jsonResponse(savePushSubscription(sender, endpoint, p256dh, authKey));
    }
    if (action === 'unsubscribePush') {
      return jsonResponse(deletePushSubscription(sender, e.parameter.endpoint || ''));
    }
    // ↑↑↑ 여기까지 신규 추가 ↑↑↑

    return jsonResponse({ error: 'unknown action', action: action });
```

---

## STEP 3 (선택, 권장). `getDueReviews`에 박스 단계 포함시키기

이 패치를 하면 PWA가 "이 단어가 지금 몇 번째 복습 단계인지"를 알 수 있어서,
갓 등록된/방금 틀린 단어는 쉬운 객관식으로, 여러 번 맞혀서 박스가 높아진 단어는
빈칸 채우기·문장 재배열 같은 어려운(하지만 장기기억에 훨씬 효과적인) 방식으로
자동 전환합니다. 건너뛰어도 앱은 정상 동작하고, 대신 복습 모드가 완전 랜덤으로만
섞입니다.

**기존 코드 (`getDueReviews` 함수 안, 맨 마지막 return 부분):**
```js
  return {
    total: all.length,
    studied: studiedInSource,
    globalStudied: globalStudied,
    dueCount: due.length,
    due: due.map(w => ({ korean: w.korean, english: w.english, definition: w.definition, example: w.example, key: w.key })),
    stats: getUserStats(sender)
  };
```

**이렇게 교체:**
```js
  let boxNotStarted = 0;
  let boxShortTerm = 0;
  let boxLongTerm = 0;
  all.forEach(word => {
    const rec = reviewMap[word.key];
    if (!rec || !rec.box) {
      boxNotStarted++;
    } else if (rec.box <= 3) {
      boxShortTerm++;
    } else {
      boxLongTerm++;
    }
  });

  return {
    total: all.length,
    studied: studiedInSource,
    globalStudied: globalStudied,
    dueCount: due.length,
    due: due.map(w => {
      const rec = reviewMap[w.key];
      return { korean: w.korean, english: w.english, definition: w.definition, example: w.example, key: w.key, box: rec ? rec.box : 0 };
    }),
    boxSummary: { notStarted: boxNotStarted, shortTerm: boxShortTerm, longTerm: boxLongTerm },
    stats: getUserStats(sender)
  };
```

(`reviewMap`은 이 함수 위쪽에서 이미 `const reviewMap = getReviewMapForUser(sender);`로
선언되어 있으므로 그대로 재사용하면 됩니다. `boxSummary`는 홈 화면의 "복습 현황"
그래프에 쓰이는 값으로, 소스 안의 단어를 미학습/단기기억(박스 1~3)/장기기억(박스
4~6) 세 구간으로 나눠 센 개수입니다.)

---

## STEP 3.5 (권장). 응답 속도 최적화

API 호출(특히 복습 세션 중 문제마다 불리는 `submitReview`)이 느리게 느껴진다면
아래 두 함수를 고치세요. 둘 다 동작은 그대로고, 같은 일을 반복하지 않게만 바꾸는
겁니다.

**`getReviewSpreadsheet` 함수를 이렇게 교체** (요청 한 번 처리하는 동안 스프레드시트를
여러 번 다시 여는 걸 막음 — `dueReviews` 하나가 단어목록/복습기록/통계를 각각
읽으면서 패치 전에는 같은 시트를 3번씩 열고 있었음):
```js
let _reviewSsCache = null;
function getReviewSpreadsheet() {
  if (_reviewSsCache) return _reviewSsCache;
  const id = PropertiesService.getScriptProperties().getProperty('REVIEW_SPREADSHEET_ID');
  if (!id) {
    throw new Error('REVIEW_SPREADSHEET_ID가 스크립트 속성에 설정되지 않았습니다.');
  }
  _reviewSsCache = SpreadsheetApp.openById(id);
  return _reviewSsCache;
}
```

**`verifyGoogleToken` 함수를 이렇게 교체** (구글 idToken 검증을 매 요청마다 구글
서버에 물어보는 대신, 5분간 캐시해서 재사용 — 복습 세션 중 문제 하나 풀 때마다
`submitReview`가 불리는데, 그때마다 외부 네트워크 왕복이 있었던 게 체감 속도
저하의 가장 큰 원인이었음):
```js
function verifyGoogleToken(idToken) {
  if (!idToken) return null;

  const cache = CacheService.getScriptCache();
  const cacheKey = 'gtok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, idToken)
  );
  const cached = cache.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const clientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID');
  if (!clientId) {
    debugLog('GOOGLE_CLIENT_ID가 스크립트 속성에 설정되지 않음');
    return null;
  }

  try {
    const url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken);
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const data = JSON.parse(res.getContentText());

    if (data.error || !data.email) return null;
    if (data.aud !== clientId) return null;
    if (data.email_verified !== 'true' && data.email_verified !== true) return null;

    const result = { email: data.email, name: data.name || data.email };
    cache.put(cacheKey, JSON.stringify(result), 300);
    return result;
  } catch (err) {
    debugLog('구글 토큰 검증 에러: ' + err);
    return null;
  }
}
```

---

## STEP 4. 스크립트 속성 추가

프로젝트 설정 > 스크립트 속성에 아래 키를 추가하세요 (기존 `TELEGRAM_TOKEN`,
`ANTHROPIC_API_KEY`, `REVIEW_SPREADSHEET_ID`, `GOOGLE_CLIENT_ID` 옆에 같이):

| 키 | 값 |
|---|---|
| `PUSH_RELAY_SECRET` | 아무 긴 랜덤 문자열 (예: `openssl rand -hex 32`로 생성). Cloudflare Worker의 `APPS_SCRIPT_SECRET` 환경변수에도 **동일한 값**을 넣어야 함 |

## STEP 5. 재배포

Apps Script는 코드를 저장하는 것만으로는 이미 배포된 웹 앱 URL에 반영되지 않습니다.
[배포 > 배포 관리 > 기존 배포 연필 아이콘 > 버전: 새 버전 > 배포]로 다시 배포해야
변경사항이 실제 API에 반영됩니다. (URL은 그대로 유지됨)

---

## STEP 6 (필수, 현재 아키텍처). Cloudflare KV 동기화

`refreshWordListToReviewSheet` 함수를 아래처럼 바꾸고, 파일 맨 아래에 새 함수
3개(`toSyncWord`, `getBannedEmailList`, `syncToCloudflare`)를 추가하세요.
`worker-api/`를 먼저 배포해서 URL을 받아둬야 합니다 (README.md 1단계 참고).

**기존 코드:**
```js
function refreshWordListToReviewSheet() {
  const reviewSs = getReviewSpreadsheet();

  // 1. 공동 시트 미러
  writeWordListSheet(reviewSs, WORD_LIST_SHEET_NAME, getAllExpressions());

  // 2. 존재하는 개인 시트들을 각각 미러
  const personalSheets = listPersonalSheets();
  personalSheets.forEach(p => {
    writeWordListSheet(reviewSs, p.mirrorName, getExpressionsFromSheet(p.sheetName));
  });

  // 3. PWA가 드롭다운에 쓸 소스 목록도 최신화
  writeSourceList(reviewSs, personalSheets);
}
```

**이렇게 교체:**
```js
function refreshWordListToReviewSheet() {
  const reviewSs = getReviewSpreadsheet();

  const commonWords = getAllExpressions();
  writeWordListSheet(reviewSs, WORD_LIST_SHEET_NAME, commonWords);

  const personalSheets = listPersonalSheets();
  const wordlists = { common: commonWords.map(toSyncWord) };
  personalSheets.forEach(p => {
    const words = getExpressionsFromSheet(p.sheetName);
    writeWordListSheet(reviewSs, p.mirrorName, words);
    wordlists[p.sourceId] = words.map(toSyncWord);
  });

  writeSourceList(reviewSs, personalSheets);

  try {
    syncToCloudflare(wordlists, personalSheets);
  } catch (err) {
    debugLog('Cloudflare 동기화 실패: ' + err);
  }
}
```

**파일 맨 아래에 추가:**
```js
function toSyncWord(e) {
  return { korean: e.korean, english: e.english, definition: e.definition, example: e.example, key: buildCompositeKey(e.korean, e.english) };
}

function getBannedEmailList() {
  const reviewSs = getReviewSpreadsheet();
  const sheet = reviewSs.getSheetByName(BANNED_USERS_SHEET_NAME);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  return values.map(r => String(r[0]).trim()).filter(Boolean);
}

function syncToCloudflare(wordlists, personalSheets) {
  const url = PropertiesService.getScriptProperties().getProperty('CLOUDFLARE_API_URL');
  const secret = PropertiesService.getScriptProperties().getProperty('CLOUDFLARE_SYNC_SECRET');
  if (!url || !secret) {
    debugLog('CLOUDFLARE_API_URL 또는 CLOUDFLARE_SYNC_SECRET이 설정되지 않아 Cloudflare 동기화를 건너뜀');
    return;
  }

  const sources = [{ id: 'common', label: '🌐 공동 (다같이 모은 표현)' }]
    .concat(personalSheets.map(p => ({ id: p.sourceId, label: '👤 ' + p.ownerDisplay })));

  const res = UrlFetchApp.fetch(url + (url.indexOf('?') === -1 ? '?' : '&') + 'action=sync', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-sync-secret': secret },
    payload: JSON.stringify({ sources: sources, banned: getBannedEmailList(), wordlists: wordlists }),
    muteHttpExceptions: true
  });
  debugLog('Cloudflare 동기화 응답: ' + res.getResponseCode() + ' ' + res.getContentText());
}
```

**스크립트 속성 추가:**

| 키 | 값 |
|---|---|
| `CLOUDFLARE_API_URL` | worker-api 배포 주소 |
| `CLOUDFLARE_SYNC_SECRET` | worker-api의 `SYNC_SECRET`과 동일한 값 |

저장 후 재배포하고, `refreshWordListToReviewSheet`를 한 번 수동 실행하거나
텔레그램 메시지를 하나 보내 폴링이 돌게 하면 KV에 데이터가 채워집니다.

---

## STEP 7 (선택). 매일 아침 멤버별 학습 현황 텔레그램 리포트

`Code.full.gs`에 이미 반영되어 있습니다 (`processUpdate`에서 `MAIN_CHAT_ID` 자동 저장 +
`sendDailyMemberStats`/`setupDailyStatsTrigger` 함수 추가). 적용하려면:

1. `worker-api`가 STEP 6까지 배포되어 있어야 함 (멤버 통계는 Cloudflare KV에서 조회)
2. Apps Script 편집기에서 `setupDailyStatsTrigger` 함수를 **딱 한 번 수동 실행**(▶)
   → 매일 오전 9시대에 자동으로 `sendDailyMemberStats`가 돌도록 트리거 등록됨
3. 보낼 방은 자동으로 정해짐 - 텔레그램 방에서 아무 메시지나 한 번 오면 그 방의
   chatId가 스크립트 속성 `MAIN_CHAT_ID`에 자동 저장되고, 그 방으로 리포트가 감
