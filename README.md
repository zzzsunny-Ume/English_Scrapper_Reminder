# 영어표현 복습 PWA

텔레그램 스터디방에서 모은 영어 표현(공동 DB 또는 개인 DB)을 다양한 방식으로
복습할 수 있는 PWA입니다. 표현 수집은 기존 Google Apps Script 텔레그램 봇이
그대로 담당하고, **PWA는 Apps Script/구글 시트를 요청마다 직접 부르지 않고
Cloudflare KV에 미리 동기화된 데이터만 읽고 씁니다** — 그래서 응답이 즉각적입니다.

## 이 저장소가 담당하는 것 / 담당하지 않는 것

| 구분 | 위치 | 이 저장소에 포함? |
|---|---|---|
| 텔레그램 수집 봇, 표현 등록/삭제, AI 예문·풀이 생성 | 기존 Apps Script 프로젝트 (`Code.gs`) | ❌ 그대로 유지, 로직 안 건드림 |
| 표현 목록을 Cloudflare KV로 밀어넣는 동기화 | 기존 Apps Script 프로젝트에 **추가 패치** | ✅ `backend/Code.full.gs`(전체 붙여넣기용) |
| PWA가 실제로 호출하는 API (읽기/쓰기 전부) | Cloudflare Worker + KV | ✅ `worker-api/` |
| 복습 PWA (다양한 복습 모드, 통계, 알림 토글) | GitHub Pages 등 정적 호스팅 | ✅ `docs/` |
| 웹푸시 실제 발송 (cron) | Cloudflare Worker | ✅ `worker/` |

## 아키텍처

```
[텔레그램 그룹] --(폴링)--> [Code.gs: 콜렉터 + 개인/공동 시트]
                                    │
                                    ├─ (기존 그대로) 표현목록_* 시트 미러링
                                    │
                                    └─ (신규) sync 호출 ───────────┐
                                                                    ▼
                                                      [worker-api: Cloudflare KV]
                                                       wordlist:* / sources / banned
                                                       review:<user> / stats:<user> / push:<user>
                                                                    ▲          ▲
                                                        KV read/write        pushTargets (secret 인증)
                                                                    │          │
      [PWA (GitHub Pages)] ──────────────────────────────────────┘   [worker(push relay): cron으로 매일 실행]
      구글 로그인 토큰은 worker-api가 로컬에서 직접 검증               web-push로 VAPID 서명해서
      (구글 서버 왕복 없음), 복습 모드, 알림 구독                      실제 브라우저에 푸시 발송
```

**왜 이렇게 바꿨나:** 처음엔 PWA가 Apps Script의 `doGet` API를 직접 불렀는데,
Apps Script는 자동화 스크립트용이라 요청마다 1~3초대 지연이 구조적으로 깔려있고
(콜드스타트 + 스프레드시트 오픈 오버헤드), 아무리 캐싱을 해도 이 바닥을 벗어날
수 없었습니다. 복습기록/통계/푸시구독은 애초에 Apps Script가 읽거나 쓸 일이
없는, 순수하게 PWA 전용 데이터라서 아예 구글 시트에 두지 않고 Cloudflare KV에만
저장하도록 옮겼습니다. 표현 목록(단어목록)만 Apps Script가 계속 소유하고, 갱신될
때마다(텔레그램 폴링 주기와 동일하게 최대 1분 간격) KV로 밀어넣습니다.

## 복습 모드

두 가지만 씁니다 (전에는 6개 모드를 박스 단계별로 자동 전환하는 적응형
시스템이었는데, 더 단순하고 확실한 쪽으로 정리했습니다):

- **단어** (`kr2en`, 기본값): 한글 뜻을 보고 영어를 타이핑. 네이티브 입력창 대신
  테마에 맞춘 자체 화면 키보드를 화면 하단에 띄워서 입력받습니다(폰 기본
  키보드는 안 뜸).
- **문장 나열** (`exampleScramble`): 그 표현이 들어간 예문을 단어 단위로 섞어서
  보여주고, 순서대로 눌러 원래 문장을 복원.

홈 화면의 "복습 방식" 토글에서 "한→영 타이핑(기본)"이면 항상 단어 모드만,
"모드 랜덤"이면 단어/문장 나열을 섞어서 냅니다. 예문이 3단어 미만이라 문장
나열이 불가능한 단어는 자동으로 단어 모드로 대체됩니다.

타이핑 정답 채점은 대소문자/구두점 차이를 무시하고, 짧은 오타 1~2글자는
허용합니다(Levenshtein 거리 기반). 예문 단어 배열 모드는 선택형이라 오타 허용이
필요 없습니다.

## 설정 가이드

### 1. `worker-api` 배포 (PWA가 실제로 호출할 API)

```bash
cd worker-api
npm install
npx wrangler login

# KV 네임스페이스 생성 - 출력에 나오는 id를 wrangler.toml의 id = "..." 자리에 붙여넣기
npx wrangler kv namespace create KV

npx wrangler secret put GOOGLE_CLIENT_ID      # PWA에도 넣을 동일한 OAuth 클라이언트 ID
npx wrangler secret put SYNC_SECRET           # Apps Script가 sync 호출할 때 쓸 임의의 긴 랜덤 문자열
npx wrangler secret put PUSH_RELAY_SECRET     # 웹푸시 발송 Worker가 pushTargets 부를 때 쓸 임의의 긴 랜덤 문자열

npx wrangler deploy
```

배포 후 나오는 주소(`https://english-review-api.<계정>.workers.dev`)를 기억해두세요 — 3, 4단계에서 씁니다.

### 2. `backend/Code.full.gs`를 기존 Code.gs에 통째로 붙여넣기

GitHub에서 `backend/Code.full.gs`를 열어 전체 복사 → Apps Script 편집기의
기존 코드를 전부 지우고 붙여넣기. 텔레그램 봇/등록/삭제 로직은 전혀 안 바뀌고,
표현 목록을 Cloudflare로도 보내는 부분만 추가됩니다.

스크립트 속성에 아래 2개 추가:

| 키 | 값 |
|---|---|
| `CLOUDFLARE_API_URL` | 1단계에서 나온 worker-api 주소 |
| `CLOUDFLARE_SYNC_SECRET` | 1단계의 `SYNC_SECRET`과 **동일한 값** |

저장 → 배포 → 배포 관리 → 기존 배포 연필 아이콘 → 새 버전 → 배포.
(재배포해도 URL은 그대로 유지됩니다. 이제 PWA는 이 URL을 더 이상 안 부르지만,
텔레그램 봇 자체는 계속 이 배포로 동작하므로 없애면 안 됩니다.)

재배포 후, Apps Script 편집기에서 `refreshWordListToReviewSheet` 함수를 한 번
수동 실행(▶)하거나 텔레그램에 아무 메시지나 하나 보내서 폴링이 한 번 돌게
하면, 그 시점부터 KV에 데이터가 채워집니다. "디버그" 탭에서
`Cloudflare 동기화 응답: 200 ...`이 찍히는지 확인하세요.

### 3. PWA 배포 (GitHub Pages)

저장소 Settings → Pages → Source를 "Deploy from a branch"로, 브랜치는 이
브랜치, 폴더는 `/docs`로 지정하세요. 배포되는 주소가
`https://<계정>.github.io/<저장소>/` 형태가 됩니다.

### 4. `docs/index.html` 상단 설정값 채우기

```js
const API_BASE = '1단계에서 배포한 worker-api 주소 (Apps Script URL 아님!)';
const GOOGLE_CLIENT_ID = '기존에 발급받은 OAuth 클라이언트 ID';
const VAPID_PUBLIC_KEY = '아래 5단계에서 생성한 VAPID 공개키';
```

`GOOGLE_CLIENT_ID`는 Google Cloud 프로젝트의 "승인된 자바스크립트 원본"에
GitHub Pages 주소(`https://<계정>.github.io`)가 등록되어 있어야 로그인이 동작합니다.

### 5. VAPID 키 생성

```bash
npx web-push generate-vapid-keys
```

공개키는 `docs/index.html`의 `VAPID_PUBLIC_KEY`에, 두 키 모두 6단계에서 Worker
시크릿으로 등록합니다. **비밀키는 절대 PWA(클라이언트) 코드에 넣지 마세요.**

### 6. 웹푸시 발송 Worker 배포

```bash
cd worker
npm install
npx wrangler login

npx wrangler secret put VAPID_SUBJECT        # 예: mailto:you@example.com
npx wrangler secret put VAPID_PUBLIC_KEY     # 5단계에서 생성한 공개키
npx wrangler secret put VAPID_PRIVATE_KEY    # 5단계에서 생성한 비밀키
npx wrangler secret put REVIEW_API_URL       # 1단계에서 배포한 worker-api 주소
npx wrangler secret put PUSH_RELAY_SECRET    # 1단계에서 정한 PUSH_RELAY_SECRET과 동일한 값

npx wrangler deploy
```

배포 후 `https://<워커주소>/trigger`로 접속하면 cron을 기다리지 않고 즉시 한 번
발송 테스트를 해볼 수 있습니다. `wrangler.toml`의 `crons` 값을 바꾸면 발송
시각을 조정할 수 있습니다(UTC 기준).

### 7. 전체 확인

1. PWA 접속 → 구글 로그인 → 홈 화면이 (체감상) 바로 뜨는지
2. 소스 선택 → 복습 시작이 되는지
3. 헤더의 🔕 버튼으로 알림을 켜고, 브라우저 알림 권한을 허용했는지
4. `worker`의 `/trigger`를 수동 호출해서 실제로 알림이 도착하는지

## 알려진 제한사항

- **iOS 웹푸시**: iOS 16.4 이상에서 PWA를 "홈 화면에 추가"한 상태로 열어야만
  웹푸시가 동작합니다 (Safari 브라우저 탭 상태에서는 불가). iOS/WebKit 자체의
  제약이라 이 프로젝트에서 우회할 방법이 없습니다.
- **만료된 구독 정리**: 사용자가 알림을 끄거나 앱을 지우면 다음 발송 시
  404/410으로 실패하는데, `worker`는 그냥 건너뛸 뿐 KV에서 자동으로 지우지는
  않습니다. 구독자가 많아지면 `worker/src/index.js`의 `sendOne`에서 만료 감지
  시 worker-api에 `unsubscribePush`를 호출하도록 확장하면 됩니다.
- **알림에 반영되는 복습 개수는 "공동" 소스 기준**입니다. 개인 소스만 따로
  공부하는 사람은 실제 밀린 개수와 알림 숫자가 다를 수 있습니다.
- **표현 목록 최신성은 텔레그램 폴링 주기(최대 1분)에 달려있습니다.** 누가
  방금 표현을 등록해도 다음 폴링 사이클 전까지는 PWA에 안 보일 수 있습니다
  (기존 시스템도 동일한 지연이 있었음).
- Apps Script의 예전 PWA용 `doGet` 엔드포인트(`dueReviews`/`submitReview` 등)는
  이제 아무도 호출하지 않는 죽은 코드로 `Code.full.gs`에 남아있습니다. 지워도
  텔레그램 봇에는 영향 없지만, 굳이 안 지워도 무해합니다.

## 디렉터리 구조

```
docs/                    복습 PWA (정적 파일, GitHub Pages 등에 그대로 배포)
  index.html
  manifest.json
  service-worker.js
  icons/
backend/
  Code.full.gs           기존 Code.gs를 통째로 대체하는 전체 코드 (복사-붙여넣기용)
  code-gs-additions.md   Code.full.gs 대신 기존 코드에 직접 diff를 적용하고 싶을 때 참고할 패치 문서
worker-api/               PWA가 실제로 호출하는 API (Cloudflare Worker + KV)
  src/index.js
  wrangler.toml
  package.json
worker/                  웹푸시 발송용 Cloudflare Worker (cron)
  src/index.js
  wrangler.toml
  package.json
```
