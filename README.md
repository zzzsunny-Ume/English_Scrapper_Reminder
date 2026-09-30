# 영어표현 복습 PWA

텔레그램 스터디방에서 모은 영어 표현(공동 DB 또는 개인 DB)을 다양한 방식으로
복습할 수 있는 PWA입니다. 기존에 운영 중인 Google Apps Script 백엔드(텔레그램
수집 봇 + 개인/공동 시트 + 로그인 API)를 그대로 사용하고, 이 저장소는 그 위에
얹는 **복습 클라이언트 + 알림 발송 서버**만 담당합니다.

## 이 저장소가 담당하는 것 / 담당하지 않는 것

| 구분 | 위치 | 이 저장소에 포함? |
|---|---|---|
| 텔레그램 수집 봇, 표현 등록/삭제, AI 예문·풀이 생성 | 기존 Apps Script 프로젝트 (`Code.gs`) | ❌ 그대로 유지, 안 건드림 |
| 로그인 검증, `dueReviews`/`submitReview`/`sources` API | 기존 Apps Script 프로젝트 | ❌ 그대로 유지 |
| 푸시 구독 저장, `pushTargets` API | 기존 Apps Script 프로젝트에 **추가 패치** | ✅ `backend/code-gs-additions.md`에 패치 코드 제공 |
| 복습 PWA (다양한 복습 모드, 통계, 알림 토글) | GitHub Pages 등 정적 호스팅 | ✅ `docs/` |
| 웹푸시 실제 발송 (cron) | Cloudflare Worker | ✅ `worker/` |

## 아키텍처

```
[텔레그램 그룹] --(폴링)--> [Code.gs: 콜렉터 + 개인/공동 시트]
                                    │ (단방향 미러링)
                                    ▼
                         [개인복습 스프레드시트]
                          단어목록 / 개인복습기록 / 사용자통계 / 푸시구독
                                    ▲          ▲
                         doGet API  │          │ pushTargets (secret 인증)
                                    │          │
      [PWA (GitHub Pages)] ─────────┘   [Cloudflare Worker: cron으로 매일 실행]
      구글 로그인, 복습 모드,                 web-push로 VAPID 서명해서
      알림 구독(PushManager)                 실제 브라우저에 푸시 발송
```

## 복습 모드 (망각곡선 기반 적응형 난이도)

Leitner box(기존 백엔드의 `개인복습기록` 박스 단계, 1~6)가 낮을수록(막 등록됐거나
방금 틀린 단어) **인지하기만 하면 되는 쉬운 방식**으로, 박스가 높을수록(여러 번
맞혀서 장기기억에 가까워진 단어) **직접 만들어내야 하는 어려운 방식**으로 자동
전환됩니다. 이는 "시험 효과(testing effect)"와 "바람직한 어려움(desirable
difficulty)" 원칙 — 쉬운 걸 계속 우려먹기보다, 기억이 실제로 굳어질수록 더 힘든
인출을 시켜야 장기기억으로 잘 넘어간다는 인지심리학 원칙을 그대로 반영한 설계입니다.

| 박스 단계 | 난이도 | 모드 |
|---|---|---|
| 0~1 (신규/방금 오답) | 인지(recognition) | 객관식: 한글→영어 / 영어→한글 |
| 2~3 | 단서 회상(cued recall) | 영영풀이 보고 영어 맞히기, 예문 속 빈칸 채우기 |
| 4~5 | 자유 회상(free recall) | 한글 뜻 보고 영어 타이핑, 예문 단어 배열하기 |
| 6 (유지) | 혼합 | 위 자유 회상 모드들을 랜덤 로테이션 |

박스 정보(`box` 필드)는 `backend/code-gs-additions.md`의 STEP 3(선택)을 적용해야
내려옵니다. 패치하지 않아도 앱은 정상 동작하며, 이 경우 6개 모드 중 완전 랜덤으로
출제됩니다. 홈 화면의 "복습 방식" 토글로 사용자가 직접 "전체 랜덤"으로 바꿀 수도
있습니다.

타이핑 정답 채점은 대소문자/구두점 차이를 무시하고, 짧은 오타 1~2글자는
허용합니다(Levenshtein 거리 기반). 예문 단어 배열 모드는 선택형이라 오타 허용이
필요 없습니다.

## 설정 가이드

### 1. Apps Script 패치 적용

`backend/code-gs-additions.md`를 따라 기존 `Code.gs`에 푸시 구독 저장 기능을
추가하고 재배포하세요. (텔레그램 봇/등록/삭제 로직은 전혀 안 건드립니다)

### 2. PWA 배포 (GitHub Pages 예시)

이 저장소를 GitHub Pages로 배포하려면: 저장소 Settings → Pages → Source를
"Deploy from a branch"로, 브랜치는 이 브랜치, 폴더는 `/docs`로 지정하세요
(GitHub Pages는 브랜치 배포 시 루트 또는 `/docs`만 고를 수 있어서, PWA 파일이
`docs/` 폴더에 들어있습니다). 배포되는 주소가
`https://<계정>.github.io/<저장소>/` 형태가 됩니다.

### 3. `docs/index.html` 상단 설정값 채우기

```js
const API_BASE = 'https://script.google.com/macros/s/여기에_기존_웹앱_배포_ID/exec';
const GOOGLE_CLIENT_ID = '기존에 발급받은 OAuth 클라이언트 ID (Code.gs 안내 주석 7번 참고)';
const VAPID_PUBLIC_KEY = '아래 4단계에서 생성한 VAPID 공개키';
```

`GOOGLE_CLIENT_ID`는 기존 Google Cloud 프로젝트의 "승인된 자바스크립트 원본"에
GitHub Pages 주소(`https://<계정>.github.io`)가 등록되어 있어야 로그인이 동작합니다.

### 4. VAPID 키 생성

```bash
npx web-push generate-vapid-keys
```

공개키는 `index.html`의 `VAPID_PUBLIC_KEY`에, 두 키(공개/비밀) 모두 5단계에서
Worker 시크릿으로 등록합니다. **비밀키는 절대 PWA(클라이언트) 코드에 넣지 마세요.**

### 5. Cloudflare Worker 배포

```bash
cd worker
npm install
npx wrangler login

npx wrangler secret put VAPID_SUBJECT        # 예: mailto:you@example.com
npx wrangler secret put VAPID_PUBLIC_KEY     # 4단계에서 생성한 공개키
npx wrangler secret put VAPID_PRIVATE_KEY    # 4단계에서 생성한 비밀키
npx wrangler secret put APPS_SCRIPT_URL      # Code.gs 웹 앱 배포 URL (…/exec)
npx wrangler secret put APPS_SCRIPT_SECRET   # backend 패치 STEP 4에서 정한 PUSH_RELAY_SECRET과 동일한 값

npx wrangler deploy
```

배포 후 `https://<워커주소>/trigger`로 접속하면 cron을 기다리지 않고 즉시 한 번
발송 테스트를 해볼 수 있습니다 (구독자가 없으면 `total: 0`으로 응답).
`wrangler.toml`의 `crons` 값을 바꾸면 발송 시각을 조정할 수 있습니다(UTC 기준).

### 6. 전체 확인

1. PWA 접속 → 구글 로그인 → 소스 선택 → 복습 시작이 되는지
2. 헤더의 🔕 버튼으로 알림을 켜고, 브라우저 알림 권한을 허용했는지
3. Worker의 `/trigger`를 수동 호출해서 실제로 알림이 도착하는지
4. `wrangler tail`로 Worker 로그를 보면서 에러가 없는지

## 알려진 제한사항

- **iOS 웹푸시**: iOS 16.4 이상에서 PWA를 "홈 화면에 추가"한 상태로 열어야만
  웹푸시가 동작합니다 (Safari 브라우저 탭 상태에서는 불가). 이는 iOS/WebKit
  자체의 제약이라 이 프로젝트에서 우회할 방법이 없습니다.
- **만료된 구독 정리**: 사용자가 알림을 끄거나 앱을 지우면 다음 발송 시
  404/410으로 실패하는데, 이 경우 Worker는 그냥 건너뛸 뿐 Apps Script의
  `푸시구독` 시트에서 자동으로 지우지는 않습니다. 구독자가 많아지면
  `worker/src/index.js`의 `sendOne`에서 만료 감지 시 Apps Script에
  `unsubscribePush`를 호출하도록 확장하면 됩니다.
- **알림에 반영되는 복습 개수는 "공동" 소스 기준**입니다. 개인 시트만 따로
  공부하는 사람은 실제 밀린 개수와 알림 숫자가 다를 수 있습니다
  (`backend/code-gs-additions.md`의 `getPushTargets`에서 소스를 바꾸거나
  합산하도록 고칠 수 있음).

## 디렉터리 구조

```
docs/                    복습 PWA (정적 파일, GitHub Pages 등에 그대로 배포)
  index.html
  manifest.json
  service-worker.js
  icons/
backend/
  code-gs-additions.md   기존 Code.gs에 추가할 패치 코드 + 적용 가이드
worker/                  웹푸시 발송용 Cloudflare Worker
  src/index.js
  wrangler.toml
  package.json
```
