/**
 * 텔레그램 "폴링" 방식으로 메시지를 받아서 "한글=영어" 형식을 파싱해
 * 구글 시트의 "표현목록" 탭에 저장하는 스크립트.
 *
 * ===== 웹훅 대신 폴링을 쓰는 이유 =====
 * Google Apps Script 웹 앱은 모든 응답이 내부적으로 302 리다이렉트를
 * 거치는데, 텔레그램이 이걸 가끔 "실패"로 오인해서 같은 메시지를
 * 무한 재시도하며 뒤의 메시지들을 아예 막아버리는 문제가 있었음.
 * 이 문제를 근본적으로 피하기 위해, 텔레그램이 우리를 부르는 웹훅 대신
 * 우리가 1분마다 먼저 텔레그램에 "새 메시지 있어?"라고 물어보는
 * 폴링(getUpdates) 방식으로 전환함. 더 이상 웹 앱 배포 자체가 필요 없음.
 *
 * ===== 사용 전 준비 =====
 * 1. 이 코드를 구글 시트의 [확장 프로그램 > Apps Script]에 붙여넣기
 * 2. 왼쪽 톱니바퀴(프로젝트 설정) > 스크립트 속성에 추가
 *      키: TELEGRAM_TOKEN   값: <봇 토큰>
 *      키: ANTHROPIC_API_KEY   값: <Claude API 키> (console.anthropic.com에서 발급)
 *      (AI 번역 기능은 이 키가 있어야 동작함. 없으면 "=" 형식만 인식하고,
 *       구분자 없는 순수 한글 입력은 번역 실패로 처리됨)
 * 3. 기존에 등록해둔 웹훅이 있다면 반드시 삭제 (폴링과 웹훅은 동시에 못 씀)
 *    브라우저에서 딱 한 번 실행:
 *      https://api.telegram.org/bot<토큰>/deleteWebhook?drop_pending_updates=true
 * 3-1. 그룹에서 이 봇을 관리자로 승격할 때 "메시지 고정(Pin messages)" 권한도
 *    꼭 켜주세요 (안 켜도 공지 전송은 되지만, 상단 고정만 실패함).
 *    코드 상단의 ANNOUNCEMENT_TEXT 내용도 실제 원하는 공지 문구로 바꿔두세요.
 * 4. Apps Script 왼쪽 시계 아이콘(트리거) 클릭 > 트리거 추가
 *      - 실행할 함수: pollUpdates
 *      - 이벤트 소스: 시간 기반
 *      - 유형: 분 단위 타이머 -> 1분마다
 *    저장 (권한 승인 화면 뜨면 Advanced -> 계속 진행)
 * 5. PWA API 용도로만 웹 앱 배포 필요 (텔레그램 폴링과는 무관, 둘 다 같이 돌아감):
 *    [배포 > 새 배포] > 유형: 웹 앱 > 실행 계정: 나 > 액세스 권한: 모든 사용자
 *    배포 후 나오는 URL을 PWA의 index.html 안 API_BASE 값에 붙여넣기
 * 6. 개인복습기록은 프라이버시를 위해 완전히 별도의 구글 시트 파일에 저장됨
 *    (표현목록 시트 링크를 아는 사람이 이 기록을 볼 수 없게 하기 위함).
 *    준비: 구글 드라이브에서 새 빈 스프레드시트를 하나 만들고, 그 URL의
 *    /d/ 와 /edit 사이 긴 문자열(스프레드시트 ID)을 복사해서 스크립트 속성에 추가:
 *      키: REVIEW_SPREADSHEET_ID   값: <새로 만든 시트의 ID>
 * 7. PWA 구글 로그인용 준비:
 *    - console.cloud.google.com 에서 프로젝트 생성 > OAuth 동의 화면 설정
 *      (범위는 기본 email/profile만 쓰므로, "게시 상태"를 프로덕션으로 전환해도
 *      보통 구글의 별도 심사 없이 가능함 -> 이러면 텔레그램 방과 무관하게
 *      구글 계정만 있으면 누구나 로그인 시도 가능해짐. 원치 않는 사람은
 *      "차단된사용자" 탭에 이메일을 추가하면 그 사람만 콕 집어 막을 수 있음)
 *    - 사용자 인증 정보 > OAuth 클라이언트 ID 생성 (웹 애플리케이션,
 *      승인된 자바스크립트 원본에 GitHub Pages 주소 등록)
 *    - 발급받은 클라이언트 ID를 스크립트 속성에 추가:
 *      키: GOOGLE_CLIENT_ID   값: <발급받은 클라이언트 ID>
 *    - 같은 클라이언트 ID를 PWA index.html 안 GOOGLE_CLIENT_ID 상수에도 넣기
 * 8. PWA 웹푸시 알림용 준비 (선택 - 안 해도 나머지 기능은 다 정상 동작):
 *    - 터미널에서 `npx web-push generate-vapid-keys` 실행해서 VAPID 키 쌍 발급
 *    - 아무 긴 랜덤 문자열(예: `openssl rand -hex 32`)을 하나 정해서 스크립트 속성에 추가:
 *      키: PUSH_RELAY_SECRET   값: <정한 랜덤 문자열>
 *    - 알림을 실제로 발송하는 Cloudflare Worker(레포지토리의 worker/ 폴더 참고)를
 *      배포하고, 거기에 VAPID 키 쌍 + 이 PUSH_RELAY_SECRET(동일한 값) + 이 웹 앱의
 *      배포 URL을 시크릿으로 등록
 */

const SHEET_NAME = '표현목록';
const REVIEW_SHEET_NAME = '개인복습기록'; // 별도 스프레드시트 안의 탭 이름
const WORD_LIST_SHEET_NAME = '단어목록'; // 별도 스프레드시트 안, 표현목록의 최신 사본이 저장되는 탭
const SOURCE_LIST_SHEET_NAME = '소스목록'; // 별도 스프레드시트 안, PWA가 고를 수 있는 공부 소스 목록
const USER_STATS_SHEET_NAME = '사용자통계'; // 별도 스프레드시트 안, 스트릭/누적 학습 기록
const BANNED_USERS_SHEET_NAME = '차단된사용자'; // 별도 스프레드시트 안, 로그인 차단 이메일 목록 탭
const PUSH_SUB_SHEET_NAME = '푸시구독'; // 별도 스프레드시트 안, 웹푸시 구독 정보 탭 (PWA 알림 기능용)
const BOX_INTERVALS_DAYS = { 1: 0, 2: 1, 3: 3, 4: 7, 5: 14, 6: 30 }; // Leitner box별 다음 복습까지 걸리는 일수

// 한글=영어 파싱용 구분자: =, :, -> 를 허용 (단독 "-"는 제외 -> spoon-fed 같은 하이픈 단어와 충돌 방지)
const PATTERN = /^(.+?)\s*(?:=|:|->)\s*(.+)$/;
const EXAMPLE_PATTERN = /^(.*?)"(.+)"\s*$/;
const HANGUL_REGEX = /[가-힣]/;

const OFFSET_KEY = 'LAST_UPDATE_ID'; // 마지막으로 처리한 update_id 기억용

/**
 * 한글/영어 자동 순서 판별.
 * 양쪽 다 한글이거나 양쪽 다 한글이 아닌 애매한 경우(예: night-night)는
 * 잘못 추측해서 저장하지 않도록 null을 반환한다.
 */
function orderKoreanEnglish(left, right) {
  const leftHasKorean = HANGUL_REGEX.test(left);
  const rightHasKorean = HANGUL_REGEX.test(right);

  if (leftHasKorean && !rightHasKorean) {
    return { korean: left, english: right };
  }
  if (!leftHasKorean && rightHasKorean) {
    return { korean: right, english: left };
  }
  return null; // 애매한 경우 -> 실패 처리로 넘김
}

// 한 조각(뜻 또는 표현) 텍스트에서 큰따옴표로 감싼 예문을 분리해낸다.
// 따옴표가 없으면 그냥 통째로 text로, example은 빈 문자열로 반환.
// (korean/english 어느 쪽에 예문이 붙어도 각자 알아서 뽑아낼 수 있게 하기 위한 공통 헬퍼)
function extractMeaningAndExample(raw) {
  const m = String(raw).match(EXAMPLE_PATTERN);
  if (m) {
    return { text: m[1].trim(), example: m[2].trim() };
  }
  return { text: String(raw).trim(), example: '' };
}

/**
 * 시간 기반 트리거(1분마다)로 실행되는 폴링 함수.
 * 텔레그램에 새 메시지가 있는지 직접 물어보고, 있으면 처리한다.
 */
function pollUpdates() {
  const token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_TOKEN');
  const props = PropertiesService.getScriptProperties();
  const lastUpdateId = Number(props.getProperty(OFFSET_KEY) || '0');

  const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=0`;

  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const data = JSON.parse(response.getContentText());

  if (!data.ok || !data.result || data.result.length === 0) {
    return; // 새 메시지 없음
  }

  let maxUpdateId = lastUpdateId;

  // 채팅방(chatId)별로 결과를 모아뒀다가, 이번 폴링이 끝나면 한 번에 답장을 보낸다.
  const resultsByChat = {}; // { chatId: { saved: [], updated: [], failed: [], deleted: [], ambiguous: [] } }

  data.result.forEach(update => {
    try {
      processUpdate(update, resultsByChat);
    } catch (err) {
      debugLog('처리 중 에러: ' + err + ' / update: ' + JSON.stringify(update));
    }
    if (update.update_id > maxUpdateId) {
      maxUpdateId = update.update_id;
    }
  });

  // 채팅방별로 모아둔 결과를 하나의 메시지로 합쳐서 전송
  Object.keys(resultsByChat).forEach(chatId => {
    const r = resultsByChat[chatId];
    const parts = [];
    if (r.saved.length > 0) {
      parts.push(`✅ 저장됨:\n${r.saved.join('\n')}`);
    }
    if (r.updated.length > 0) {
      parts.push(`🔄 업데이트됨:\n${r.updated.join('\n')}`);
    }
    if (r.deleted.length > 0) {
      parts.push(`🗑️ 삭제됨:\n${r.deleted.join('\n')}`);
    }
    if (r.ambiguous.length > 0) {
      parts.push(r.ambiguous.join('\n\n'));
    }
    if (r.failed.length > 0) {
      parts.push(`⚠️ 형식을 인식 못했어요 (예: 한글=영어):\n${r.failed.join('\n')}`);
    }
    if (parts.length > 0) {
      sendTelegramMessage(chatId, parts.join('\n\n'));
    }
  });

  // 마지막으로 처리한 update_id 저장 (다음 폴링 때 이 이후 것만 받아옴)
  props.setProperty(OFFSET_KEY, String(maxUpdateId));

  // 개인복습 시트의 "단어목록"을 표현목록 최신 상태로 통째로 갱신
  // (콜렉터 -> 개인복습 시트 방향으로만 데이터가 흐름, 반대 방향은 없음)
  try {
    refreshWordListToReviewSheet();
  } catch (err) {
    debugLog('단어목록 리프레시 실패: ' + err);
  }
}

/**
 * 업데이트 하나를 파싱해서 시트에 저장하고, 결과를 resultsByChat에 모아둔다.
 * (답장은 여기서 바로 보내지 않고, pollUpdates가 끝날 때 한 번에 보냄)
 */
function processUpdate(update, resultsByChat) {
  const message = update.message;
  if (!message) {
    return;
  }

  // 새 멤버가 그룹에 들어왔을 때 -> 공지 재전송 + 상단 고정
  // (봇 여부 체크보다 먼저 처리 - 이 이벤트 자체는 사람의 행동으로 발생하는 것)
  if (message.new_chat_members && message.new_chat_members.length > 0) {
    sendAndPinAnnouncement(message.chat.id, message.new_chat_members);
    return;
  }

  // 봇이 보낸 메시지는 무조건 무시 (이 콜렉터봇 자신의 "저장됨" 답장 등).
  // 이걸 빼먹으면 콜렉터봇이 자기 답장을 스스로 다시 읽어서 무한 루프에 빠질 수 있음.
  if (message.from && message.from.is_bot) {
    return;
  }

  // 만약을 위한 이중 방어: 같은 update_id를 두 번 처리하는 것 방지
  const cache = CacheService.getScriptCache();
  const updateIdKey = String(update.update_id);
  if (cache.get(updateIdKey)) {
    debugLog('중복으로 스킵됨(2차 방어) - update_id: ' + updateIdKey);
    return;
  }
  cache.put(updateIdKey, 'done', 21600);

  if (!message.text) {
    return;
  }

  const chatId = message.chat.id;
  // 아이폰/갤럭시 자동완성이 " 를 곡선 따옴표(" ")로 바꿔버리는 경우가 있어서,
  // 파싱 전에 전부 일반 따옴표로 통일해준다 (안 하면 예문이 통째로 뜻에 섞여버림)
  let text = message.text.trim().replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const sender = (message.from.first_name || '') + (message.from.last_name ? ' ' + message.from.last_name : '');

  debugLog('받은 텍스트: ' + JSON.stringify(text) + ' / update_id: ' + update.update_id);

  // 우리 명령어(delete, chat, greeting)는 "/명령어"처럼 슬래시를 앞에 써도 인식되게,
  // "delete/", "chat/", "greeting" 형태로 미리 바꿔준다. (텔레그램 진짜 슬래시 명령어와
  // 안 겹치도록 이 세 단어일 때만 예외적으로 허용하고, 그 외 "/"로 시작하는 메시지는 그대로 무시)
  const slashCommandMatch = text.match(/^\/(delete|chat|greeting)\b\s*/i);
  if (slashCommandMatch) {
    const cmd = slashCommandMatch[1].toLowerCase();
    const rest = text.slice(slashCommandMatch[0].length);
    text = cmd === 'greeting' ? ('greeting ' + rest).trim() : `${cmd}/${rest}`;
  }

  if (text.startsWith('/')) {
    return;
  }

  // "chat/" 접두사 -> 이 메시지는 그냥 잡담/사담이니 아무 처리도 하지 말고 완전히 무시
  // (에러 답장도 안 보냄 - "형식을 인식 못했어요" 같은 반응조차 안 나가게 하기 위함)
  if (text.toLowerCase().startsWith('chat/')) {
    return;
  }

  // "greeting/" 명령어 -> 놓친 입장 이벤트가 있을 때 등, 무조건 한 번 공지 재전송+고정
  // (누구나 사용 가능, 방장 전용 아님 - 그냥 공지를 다시 띄우는 것뿐이라 위험 없음)
  const normalizedCmd = text.toLowerCase();
  if (normalizedCmd.startsWith('greeting')) {
    postAndPinAnnouncement(chatId);
    return;
  }

  if (!resultsByChat[chatId]) {
    resultsByChat[chatId] = { saved: [], updated: [], failed: [], deleted: [], ambiguous: [] };
  }
  const result = resultsByChat[chatId];

  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  const entries = [];
  // 예문(큰따옴표) 없이 등록된 항목들을 순서대로 대기시켜두는 큐.
  // 이후 줄에 "예문만 있는 줄"이 나오면 이 큐의 맨 앞(가장 먼저 등록된, 아직 예문 없는 뜻)에 채워짐.
  // "/"로 여러 뜻이 한 번에 나뉜 경우, 예문 줄이 여러 개 이어지면 순서대로 각각 다른 뜻에 붙고,
  // 예문이 부족하게 오면 나머지는 나중에 AI가 자동으로 채운다.
  const pendingExampleQueue = [];

  function pushEntry(entryObj) {
    entries.push(entryObj);
    if (!entryObj.example && !entryObj.isDeleteRequest) {
      pendingExampleQueue.push(entryObj);
    }
  }

  lines.forEach(line => {
    // "delete/" 접두사가 있으면 삭제 요청으로 표시하고 접두사 제거
    // "*" 접두사는 AI 번역 요청 표시 (자유 대화와 겹치지 않도록, 명시적으로 *를 붙였을 때만 번역 시도)
    // "delete/#7"처럼 "#숫자"가 바로 붙으면, 후보가 여러 개일 때 그중 정확히 이 id를 지정하는 것
    let isDeleteRequest = false;
    let isAiRequest = false;
    let explicitId = null;
    let workingLine = line;
    if (/^delete\//i.test(workingLine)) {
      isDeleteRequest = true;
      workingLine = workingLine.replace(/^delete\//i, '').trim();
    } else if (/^\*/.test(workingLine)) {
      isAiRequest = true;
      workingLine = workingLine.replace(/^\*/, '').trim();
    }

    if (isDeleteRequest) {
      const idMatch = workingLine.match(/^#(\d+)\s*/);
      if (idMatch) {
        explicitId = Number(idMatch[1]);
        workingLine = workingLine.slice(idMatch[0].length).trim();
      }
    }

    // 등록 의도가 명확한지 판별: 알려진 접두사를 썼거나, 구분자(=, :, ->)가 실제로 들어있으면
    // "등록하려다 형식이 틀린 것"으로 보고 실패 안내를 함. 그 외(순수 잡담)는 조용히 무시.
    const hasKnownPrefix = isDeleteRequest || isAiRequest;
    const hasDelimiterHint = /=|:|->/.test(workingLine);
    const looksLikeRegistrationAttempt = hasKnownPrefix || hasDelimiterHint || explicitId !== null;

    // 실제 등록 구분자(=, :, ->)가 있는 "일반 등록 시도" 줄인지 먼저 확인한다.
    // "/"는 구분자 앞쪽(먼저 오는 쪽)이든 뒤쪽이든 어느 쪽에 있어도 "여러 개의 뜻/표현"으로
    // 나뉘도록 처리한다. 예문(따옴표)도 "/"로 나뉜 조각 각각에서 따로 추출해야
    // example1/example2가 서로 안 섞인다.
    const delimiterMatchForRegistration = !isDeleteRequest && !isAiRequest ? workingLine.match(PATTERN) : null;

    if (delimiterMatchForRegistration) {
      const rawLeft = delimiterMatchForRegistration[1].trim();
      const rawRight = delimiterMatchForRegistration[2].trim();

      // 양쪽 다 "/"로 쪼개보고, 실제로 여러 조각이 나온 쪽을 기준으로 반복한다.
      // 콤마(,)는 여전히 구분자가 아니라 뜻/표현 텍스트의 일부로 남는다.
      const leftSegments = rawLeft.split('/').map(s => s.trim()).filter(s => s.length > 0);
      const rightSegments = rawRight.split('/').map(s => s.trim()).filter(s => s.length > 0);
      const segmentCount = Math.max(leftSegments.length, rightSegments.length, 1);

      let anyFailed = false;
      for (let i = 0; i < segmentCount; i++) {
        // 한쪽만 "/"로 나뉜 경우, 나뉘지 않은 쪽은 모든 조각에 그대로 재사용됨
        const leftPart = leftSegments.length > 1 ? leftSegments[i] : (leftSegments[0] !== undefined ? leftSegments[0] : rawLeft);
        const rightPart = rightSegments.length > 1 ? rightSegments[i] : (rightSegments[0] !== undefined ? rightSegments[0] : rawRight);
        if (leftPart === undefined || rightPart === undefined) continue;

        // 예문(따옴표)은 korean/english 어느 쪽에 붙어있든 각자 알아서 추출
        const leftInfo = extractMeaningAndExample(leftPart);
        const rightInfo = extractMeaningAndExample(rightPart);
        const ordered = orderKoreanEnglish(leftInfo.text, rightInfo.text);
        if (!ordered) {
          anyFailed = true;
          continue;
        }
        pushEntry({
          korean: ordered.korean,
          english: ordered.english.toLowerCase(), // 영문 컬럼은 항상 소문자로 통일
          example: leftInfo.example || rightInfo.example, // 없으면 아래에서 큐/AI가 채움
          isDeleteRequest: false,
          explicitId: null
        });
      }
      if (anyFailed) {
        result.failed.push(line + ' 🤔 (한글/영어 구분 불가)');
      }
      return;
    }

    const quoteOnlyMatch = workingLine.match(EXAMPLE_PATTERN);
    if (quoteOnlyMatch && quoteOnlyMatch[1].trim() === '') {
      const example = quoteOnlyMatch[2].trim();
      if (example && pendingExampleQueue.length > 0) {
        const target = pendingExampleQueue.shift(); // 큐의 맨 앞(가장 먼저 예문이 비어있던 뜻)에 채움
        target.example = example;
      } else if (looksLikeRegistrationAttempt) {
        result.failed.push(line);
      }
      // 아니면(붙일 대상도 없고 등록 시도도 아니면) 그냥 잡담으로 보고 조용히 무시
      return;
    }

    let mainPart = workingLine;
    let inlineExample = '';
    if (quoteOnlyMatch) {
      mainPart = quoteOnlyMatch[1].trim();
      inlineExample = quoteOnlyMatch[2].trim();
    }

    if (isAiRequest && mainPart.trim()) {
      // "*한글" 또는 "*영어" 둘 다 지원. 어느 언어인지 감지해서 AI에게 반대쪽 언어 + 예문을 요청
      const rawText = mainPart.trim();
      const isKoreanInput = HANGUL_REGEX.test(rawText);

      if (isKoreanInput) {
        // "*한글" -> AI가 영어 표현 + 예문 생성
        const aiResult = translateWithAI(rawText);
        if (aiResult) {
          pushEntry({
            korean: rawText,
            english: aiResult.english.toLowerCase(), // 영문 컬럼은 항상 소문자로 통일
            example: inlineExample || aiResult.example,
            isDeleteRequest: false,
            aiTranslated: true
          });
        } else {
          result.failed.push(line + ' ❌ (자동 번역 실패, 직접 =로 보내주세요)');
        }
      } else {
        // "*영어" -> AI가 한글 뜻 + 예문 생성
        const aiResult = translateEnglishWithAI(rawText);
        if (aiResult) {
          pushEntry({
            korean: aiResult.korean,
            english: rawText.toLowerCase(), // 영문 컬럼은 항상 소문자로 통일
            example: inlineExample || aiResult.example,
            isDeleteRequest: false,
            aiTranslated: true
          });
        } else {
          result.failed.push(line + ' ❌ (자동 번역 실패, 직접 =로 보내주세요)');
        }
      }
      return;
    }

    // 여기부터는 delete/#id, delete/영어(구분자 없는 삭제), 혹은 위에서 구분자를 못 찾은
    // 예외적인 경우만 남는다. (일반 등록 + "/"-다중 뜻 분리는 위에서 이미 처리 후 return됨)
    const match = mainPart.match(PATTERN);
    if (match) {
      const ordered = orderKoreanEnglish(match[1].trim(), match[2].trim());
      if (ordered) {
        pushEntry({
          korean: ordered.korean,
          english: ordered.english.toLowerCase(), // 영문 컬럼은 항상 소문자로 통일
          example: inlineExample, // 없으면 아래에서 AI가 자동으로 채움
          isDeleteRequest: isDeleteRequest,
          explicitId: explicitId
        });
      } else {
        result.failed.push(line + ' 🤔 (한글/영어 구분 불가)');
      }
    } else if (isDeleteRequest && mainPart.trim()) {
      // 삭제 요청은 "한글=영어" 구분자 없이 영어 또는 한글만으로도 대상 지정 가능
      // (한글로 지정하면 한글 뜻 기준으로, 영어로 지정하면 영어 표현 기준으로 내 개인 시트에서 찾음)
      const deleteQuery = mainPart.trim();
      const isKoreanQuery = HANGUL_REGEX.test(deleteQuery);
      entries.push({
        korean: isKoreanQuery ? deleteQuery : '',
        english: isKoreanQuery ? '' : deleteQuery,
        example: '',
        isDeleteRequest: true,
        explicitId: explicitId
      });
    } else if (isDeleteRequest && explicitId !== null) {
      // "delete/#7"처럼 id만 지정하고 영어는 안 준 경우 (id로 바로 특정 가능하니 충분함)
      entries.push({
        korean: '',
        english: '',
        example: '',
        isDeleteRequest: true,
        explicitId: explicitId
      });
    } else if (looksLikeRegistrationAttempt) {
      // 접두사를 쓰거나 구분자가 있었는데도 파싱에 실패한 경우만 실패 안내
      result.failed.push(line);
    }
    // 그 외(구분자도 없고 접두사도 없는 순수 텍스트)는 잡담으로 보고 조용히 무시 (답장 안 함)
  });

  // 예문/영영풀이를 직접 안 붙인 항목들은, AI로 자동 생성해서 채워줌 (삭제 요청은 제외)
  entries.forEach(entry => {
    if (entry.isDeleteRequest) return;

    // 예문: 직접 안 붙였고, AI 번역으로 이미 받지도 않은 경우에만 생성
    if (!entry.example && !entry.aiTranslated) {
      const generated = generateExampleWithAI(entry.english, entry.korean);
      if (generated) {
        entry.example = generated;
        entry.aiExample = true; // 결과 메시지에 "(AI 예문)" 표시용
      }
    }

    // 영영풀이: 영어가 있고 아직 풀이가 없으면 항상 생성 (AI 번역 항목도 풀이는 따로 없으므로 포함)
    if (entry.english && !entry.definition) {
      const def = generateDefinitionWithAI(entry.english, entry.korean);
      if (def) {
        entry.definition = def;
        entry.aiDefinition = true; // 결과 메시지에 "(AI 풀이)" 표시용
      }
    }
  });

  // 이 사람의 개인/공동 조합키 집합만 미리 읽어둔다 (일반 등록/재등록 판단용).
  // delete는 후보가 여러 개일 수 있어서 그때그때 새로 조회한다.
  const personalCompositeSet = getPersonalCompositeSet(sender); // 한글+영어 조합 기준 (일반 등록용)
  const commonCompositeSet = getCommonCompositeSet(); // 한글+영어 조합 기준 (일반 등록용)

  entries.forEach(entry => {
    // "delete/" 삭제 요청
    if (entry.isDeleteRequest) {
      handleDeleteEntry(entry, sender, result);
      return;
    }

    // ===== 일반 등록/재등록 =====
    // 이제 키는 "영어"만이 아니라 "한글+영어" 조합. 같은 영어라도 뜻(한글)이 다르면
    // 완전히 별도의 표현으로 취급해서 새 행으로 추가한다 (예: tell on의 두 가지 뜻).
    const compositeKey = buildCompositeKey(entry.korean, entry.english);

    if (personalCompositeSet.has(compositeKey)) {
      // 한글+영어가 완전히 똑같은 게 이미 개인 시트에 있음 -> 예문/풀이만 갱신, 공동은 손대지 않음
      updatePersonalSheetExampleByComposite(sender, entry.korean, entry.english, entry.definition, entry.example);
      result.updated.push(`${entry.korean} = ${entry.english}`);
      return;
    }

    // 개인 시트에 이 조합이 없음 (같은 영어의 다른 뜻이거나, 완전히 새로운 표현) -> 새 행으로 추가
    appendToPersonalSheet(sender, entry.korean, entry.english, entry.definition, entry.example);
    personalCompositeSet.add(compositeKey);

    // 공동 시트에도 같은 조합이 없을 때만 새로 추가 (이미 있으면 그대로 둠)
    if (!commonCompositeSet.has(compositeKey)) {
      appendExpression(entry.korean, entry.english, sender, entry.definition, entry.example);
      commonCompositeSet.add(compositeKey);
    }

    // 같은 영어에 이미 등록된 다른 뜻이 있으면 같이 안내 (내 개인 시트 기준, 방금 추가한 것 자신은 제외)
    // 공동 시트는 그저 개인 시트들을 모아 보여주는 뷰일 뿐이라, "기존에 뭐가 있었는지"는
    // 내 개인 시트를 기준으로 판단해야 함.
    const otherMeanings = getPersonalMatchesByEnglish(sender, normalizeForDup(entry.english))
      .map(m => m.korean)
      .filter(k => normalizeForDup(k) !== normalizeForDup(entry.korean));
    const uniqueOtherMeanings = [...new Set(otherMeanings)];

    let line = `${entry.korean} = ${entry.english}`;
    if (uniqueOtherMeanings.length > 0) {
      line += `\n   ↳ 📚 기존 뜻: ${uniqueOtherMeanings.join(', ')}`;
    }
    result.saved.push(line);
  });

  debugLog('처리 결과 - saved: ' + result.saved.length + ', updated: ' + result.updated.length + ', deleted: ' + result.deleted.length + ', ambiguous: ' + result.ambiguous.length + ', failed: ' + result.failed.length);
}

// 영어 표현을 소문자로 바꾸고 공백/기호를 다 제거해서 비교용 키로 만듦
// (예: "I Love Coffee!" 와 "i love coffee" 를 같은 것으로 인식)
function normalizeForDup(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
}

// 한글+영어를 합친 조합키. "같은 영어라도 뜻(한글)이 다르면 다른 표현"으로 구분하기 위함
// (예: tell on=고자질하다 와 tell on=영향을 미치다 는 서로 다른 키가 됨)
function buildCompositeKey(korean, english) {
  return normalizeForDup(korean) + '|||' + normalizeForDup(english);
}

// 개인 시트에 이미 있는 (한글+영어) 조합들을 Set으로 가져옴 (일반 등록/재등록 시 사용)
function getPersonalCompositeSet(sender) {
  const sheet = getOrCreatePersonalSheet(sender);
  const lastRow = sheet.getLastRow();
  const set = new Set();
  if (lastRow < 2) return set;

  const values = sheet.getRange(2, 4, lastRow - 1, 2).getValues(); // D:E = 한글,영어
  values.forEach(row => {
    if (row[1]) set.add(buildCompositeKey(row[0], row[1]));
  });
  return set;
}

// 공동 시트에 이미 있는 (한글+영어) 조합들을 Set으로 가져옴
function getCommonCompositeSet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const lastRow = sheet.getLastRow();
  const set = new Set();
  if (lastRow < 2) return set;

  const values = sheet.getRange(2, 4, lastRow - 1, 2).getValues(); // D:E = 한글,영어
  values.forEach(row => {
    if (row[1]) set.add(buildCompositeKey(row[0], row[1]));
  });
  return set;
}

// 개인 시트 안에서 (한글+영어)가 정확히 일치하는 행 번호를 찾음 (없으면 -1)
function findPersonalSheetRowByComposite(sheet, korean, english) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  const targetKey = buildCompositeKey(korean, english);
  const values = sheet.getRange(2, 4, lastRow - 1, 2).getValues(); // D:E
  for (let i = 0; i < values.length; i++) {
    if (buildCompositeKey(values[i][0], values[i][1]) === targetKey) {
      return i + 2;
    }
  }
  return -1;
}

// 이미 (한글+영어)가 완전히 똑같은 게 개인 시트에 있을 때 -> 예문만 갱신 (없으면 새로 추가)
function updatePersonalSheetExampleByComposite(sender, korean, english, definition, example) {
  const sheet = getOrCreatePersonalSheet(sender);
  const rowIndex = findPersonalSheetRowByComposite(sheet, korean, english);
  if (rowIndex === -1) {
    appendToPersonalSheet(sender, korean, english, definition, example);
    return;
  }
  // 새 값이 있으면 새 값으로, 없으면 기존 값 유지 (재전송 때 기존 내용이 지워지지 않게)
  const currentDefinition = sheet.getRange(rowIndex, 6).getValue(); // F열 = 영영풀이
  const currentExample = sheet.getRange(rowIndex, 7).getValue();    // G열 = 예문
  const newDefinition = definition || currentDefinition;
  const newExample = example || currentExample;
  sheet.getRange(rowIndex, 6, 1, 2).setValues([[newDefinition, newExample]]); // F:G
}

// 시트에 이미 저장된 표현들을 정규화된 영어를 키로 하는 맵으로 가져옴
// value에 등록자 정보까지 포함해서, 본인 표현인지 판별할 수 있게 함
function getExistingEntriesMap() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const lastRow = sheet.getLastRow();
  const map = {};
  if (lastRow < 2) return map; // 헤더만 있고 데이터 없음

  const values = sheet.getRange(2, 1, lastRow - 1, 7).getValues(); // A:G, 2행부터
  values.forEach((row, idx) => {
    const rowNumber = idx + 2; // 실제 시트 행 번호
    const [, , rowSender, rowKorean, rowEnglish, rowDefinition, rowExample] = row;
    if (rowEnglish) {
      map[normalizeForDup(rowEnglish)] = {
        rowNumber: rowNumber,
        sender: rowSender,
        korean: rowKorean,
        english: rowEnglish,
        definition: rowDefinition,
        example: rowExample
      };
    }
  });
  return map;
}

function appendExpression(korean, english, sender, definition, example) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const lastRow = sheet.getLastRow();
  const id = lastRow;
  const now = new Date();
  sheet.appendRow([id, now, sender, korean, english, definition || '', example || '']);
  return lastRow + 1; // 방금 추가된 행 번호
}

// ===================================================================
// ===== 개인별 표현목록 시트 (표현목록_이름) - 공동 시트와 별개로 계속 미러링 =====
// ===================================================================

// 사람 이름으로 시트 이름을 만듦 (공백은 언더스코어로): "Sarah Lee" -> "표현목록_Sarah_Lee"
function getPersonalSheetName(sender) {
  const safeName = String(sender).trim().replace(/\s+/g, '_');
  return `표현목록_${safeName}`;
}

// 그 사람의 개인 시트를 가져옴 (처음 보는 사람이면 자동 생성)
function getOrCreatePersonalSheet(sender) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const name = getPersonalSheetName(sender);
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(['id', '등록일', '등록자', '한글', '영어', '영영풀이', '예문']);
  }
  return sheet;
}

// 개인 시트 안에서 특정 영어 표현이 있는 행 번호를 찾음 (없으면 -1)
function findPersonalSheetRow(sheet, english) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  const key = normalizeForDup(english);
  const values = sheet.getRange(2, 5, lastRow - 1, 1).getValues(); // E열(영어)
  for (let i = 0; i < values.length; i++) {
    if (normalizeForDup(values[i][0]) === key) {
      return i + 2;
    }
  }
  return -1;
}

// 그 사람의 개인 시트에서, 정규화된 영어와 일치하는 모든 행을 찾음 (같은 영어라도
// 뜻이 여러 개면 여러 개가 나옴). [{id, rowIndex, korean, english, example}, ...]
function getPersonalMatchesByEnglish(sender, englishNorm) {
  const sheet = getOrCreatePersonalSheet(sender);
  const lastRow = sheet.getLastRow();
  const matches = [];
  if (lastRow < 2) return matches;

  const values = sheet.getRange(2, 1, lastRow - 1, 7).getValues(); // id,등록일,등록자,한글,영어,영영풀이,예문
  values.forEach((row, idx) => {
    const english = row[4];
    if (english && normalizeForDup(english) === englishNorm) {
      matches.push({ id: row[0], rowIndex: idx + 2, korean: row[3], english: english, definition: row[5], example: row[6] });
    }
  });
  return matches;
}

// 공동 시트에서, 정규화된 영어와 일치하는 모든 행을 찾음.
// [{id, rowNumber, sender, korean, english, example}, ...]
function getCommonMatchesByEnglish(englishNorm) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const lastRow = sheet.getLastRow();
  const matches = [];
  if (lastRow < 2) return matches;

  const values = sheet.getRange(2, 1, lastRow - 1, 7).getValues(); // id,등록일,등록자,한글,영어,영영풀이,예문
  values.forEach((row, idx) => {
    const english = row[4];
    if (english && normalizeForDup(english) === englishNorm) {
      matches.push({ id: row[0], rowNumber: idx + 2, sender: row[2], korean: row[3], english: english, definition: row[5], example: row[6] });
    }
  });
  return matches;
}

// 그 사람의 개인 시트에서, 정규화된 한글 뜻과 일치하는 모든 행을 찾음
// (delete/한글 형태로 지울 때 사용 - 영어 버전인 getPersonalMatchesByEnglish와 대칭)
function getPersonalMatchesByKorean(sender, koreanNorm) {
  const sheet = getOrCreatePersonalSheet(sender);
  const lastRow = sheet.getLastRow();
  const matches = [];
  if (lastRow < 2) return matches;

  const values = sheet.getRange(2, 1, lastRow - 1, 7).getValues(); // id,등록일,등록자,한글,영어,영영풀이,예문
  values.forEach((row, idx) => {
    const korean = row[3];
    if (korean && normalizeForDup(korean) === koreanNorm) {
      matches.push({ id: row[0], rowIndex: idx + 2, korean: korean, english: row[4], definition: row[5], example: row[6] });
    }
  });
  return matches;
}

// 공동 시트에서, 정규화된 한글 뜻과 일치하는 모든 행을 찾음 (delete/한글용)
function getCommonMatchesByKorean(koreanNorm) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const lastRow = sheet.getLastRow();
  const matches = [];
  if (lastRow < 2) return matches;

  const values = sheet.getRange(2, 1, lastRow - 1, 7).getValues(); // id,등록일,등록자,한글,영어,영영풀이,예문
  values.forEach((row, idx) => {
    const korean = row[3];
    if (korean && normalizeForDup(korean) === koreanNorm) {
      matches.push({ id: row[0], rowNumber: idx + 2, sender: row[2], korean: korean, english: row[4], definition: row[5], example: row[6] });
    }
  });
  return matches;
}

// 개인 시트에서 정확히 이 id(개인 시트 자체 id)를 가진 행을 찾음 (없으면 null)
function getPersonalRowById(sender, id) {
  const sheet = getOrCreatePersonalSheet(sender);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const values = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
  for (let i = 0; i < values.length; i++) {
    if (Number(values[i][0]) === Number(id)) {
      return { id: values[i][0], rowIndex: i + 2, korean: values[i][3], english: values[i][4], definition: values[i][5], example: values[i][6] };
    }
  }
  return null;
}

// 공동 시트에서 정확히 이 id(공동 시트 자체 id)를 가진 행을 찾음 (없으면 null)
function getCommonRowById(id) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const values = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
  for (let i = 0; i < values.length; i++) {
    if (Number(values[i][0]) === Number(id)) {
      return { id: values[i][0], rowNumber: i + 2, sender: values[i][2], korean: values[i][3], english: values[i][4], definition: values[i][5], example: values[i][6] };
    }
  }
  return null;
}

// 개인 시트 행 하나를 직접 rowIndex로 업데이트
function updatePersonalSheetRowAt(sender, rowIndex, korean, english, definition, example) {
  const sheet = getOrCreatePersonalSheet(sender);
  sheet.getRange(rowIndex, 4, 1, 4).setValues([[korean, english, definition || '', example || '']]); // D:G
}

// 개인 시트 행 하나를 직접 rowIndex로 삭제
function deletePersonalSheetRowAt(sender, rowIndex) {
  const sheet = getOrCreatePersonalSheet(sender);
  sheet.deleteRow(rowIndex);
}

// 개인 시트에 새 표현 추가. 새로 추가된 행 번호를 반환 (개인 시트 자체 id 계산)
function appendToPersonalSheet(sender, korean, english, definition, example) {
  const sheet = getOrCreatePersonalSheet(sender);
  const lastRow = sheet.getLastRow();
  const id = lastRow;
  sheet.appendRow([id, new Date(), sender, korean, english, definition || '', example || '']);
  return lastRow + 1;
}

// 개인 시트에서 기존 표현(oldEnglish로 찾음)을 새 내용으로 갱신.
// 혹시 개인 시트에 아직 없는 경우는 새로 추가함.
function updatePersonalSheetRow(sender, oldEnglish, korean, english, definition, example) {
  const sheet = getOrCreatePersonalSheet(sender);
  const rowIndex = findPersonalSheetRow(sheet, oldEnglish);
  if (rowIndex === -1) {
    appendToPersonalSheet(sender, korean, english, definition, example);
  } else {
    sheet.getRange(rowIndex, 4, 1, 4).setValues([[korean, english, definition || '', example || '']]); // D:G
  }
}

// 개인 시트에서 해당 표현 삭제 (없으면 조용히 무시)
function deleteFromPersonalSheet(sender, english) {
  const sheet = getOrCreatePersonalSheet(sender);
  const rowIndex = findPersonalSheetRow(sheet, english);
  if (rowIndex !== -1) {
    sheet.deleteRow(rowIndex);
  }
}

// 기존 행의 한글/영어/예문 내용을 덮어씀 (본인이 재등록해서 업데이트하는 경우 사용)
function updateExpressionRow(rowNumber, korean, english, definition, example) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  sheet.getRange(rowNumber, 4, 1, 4).setValues([[korean, english, definition || '', example || '']]); // D:G 열
}

// 표현목록에서 해당 행을 실제로 삭제 (빈 행이 남지 않게)
function deleteExpressionRow(rowNumber) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  sheet.deleteRow(rowNumber);
}

// 후보 여러 개를 사람이 읽기 좋은 목록으로 만듦 (id와 함께)
function formatCandidateList(matches) {
  const lines = matches.map(m => `🔹 [id ${m.id}] ${m.korean} = ${m.english}`);
  return `❓ 내가 등록한 표현 중에 일치하는 게 여러 개예요. id를 지정해서 다시 삭제해주세요:\n${lines.join('\n')}\n\n예) delete/#${matches[0].id}`;
}

/**
 * "delete/" 처리. 본인이 자기 개인 시트에 등록한 것만 삭제할 수 있다
 * (남의 것을 지우는 개념 자체가 없음 - 승인 절차도 없음).
 * 영어(delete/영어)로도, 한글 뜻(delete/한글)으로도 대상을 지정할 수 있다.
 * 후보가 여러 개면 id 목록을 보여주고, delete/#id로 다시 보내면 정확히 그 하나만 지워진다.
 */
function handleDeleteEntry(entry, sender, result) {
  // ---- id로 직접 지정한 경우 ----
  if (entry.explicitId !== null) {
    const personalRow = getPersonalRowById(sender, entry.explicitId);
    if (!personalRow) {
      result.failed.push(`❌ #${entry.explicitId} (본인이 등록한 표현 중에서 해당 id를 찾을 수 없음)`);
      return;
    }
    deletePersonalSheetRowAt(sender, personalRow.rowIndex);
    // 공동 시트에도 같은 (한글+영어) 조합으로 내가 등록한 게 있으면 같이 삭제
    const commonMatches = getCommonMatchesByEnglish(normalizeForDup(personalRow.english));
    const mine = commonMatches.find(m => m.sender === sender && buildCompositeKey(m.korean, m.english) === buildCompositeKey(personalRow.korean, personalRow.english));
    if (mine) {
      deleteExpressionRow(mine.rowNumber);
    }
    result.deleted.push(`${personalRow.korean} = ${personalRow.english}`);
    return;
  }

  // ---- 한글 또는 영어로 찾는 경우 (내 개인 시트 안에서만) ----
  const isKoreanQuery = !!entry.korean;
  const personalMatches = isKoreanQuery
    ? getPersonalMatchesByKorean(sender, normalizeForDup(entry.korean))
    : getPersonalMatchesByEnglish(sender, normalizeForDup(entry.english));

  if (personalMatches.length > 1) {
    result.ambiguous.push(formatCandidateList(personalMatches));
    return;
  }

  if (personalMatches.length === 1) {
    const m = personalMatches[0];
    deletePersonalSheetRowAt(sender, m.rowIndex);
    const commonMatches = isKoreanQuery
      ? getCommonMatchesByKorean(normalizeForDup(m.korean))
      : getCommonMatchesByEnglish(normalizeForDup(m.english));
    const mine = commonMatches.find(c => c.sender === sender && buildCompositeKey(c.korean, c.english) === buildCompositeKey(m.korean, m.english));
    if (mine) {
      deleteExpressionRow(mine.rowNumber);
    }
    result.deleted.push(`${m.korean} = ${m.english}`);
    return;
  }

  const label = entry.korean || entry.english;
  result.failed.push(`❌ ${label} (본인이 등록한 표현 중에서 찾을 수 없음 - 본인 것만 삭제할 수 있어요)`);
}

// ===== 여기에 실제 공지 문구를 넣어주세요 (그룹에 고정해두고 싶은 공지와 동일하게) =====
const ANNOUNCEMENT_TEXT =
`📌 영어표현 공유방 공지

🏠 이 방은 뭐하는 곳인가요?
스터디원들이 새로 알게 된 영어 표현을 자유롭게 공유하는 곳이에요. 여기 올리면 자동으로 내 개인 시트 + 공동 데이터베이스에 쌓이고, PWA 앱에서 다 같이 복습하는 데 쓰입니다.

🤖 표현 등록은 이렇게

✅ 기본 형식
ex) 전반적으로 = overall
(영어 한글 순서는 상관 없어요, 구분자는 =, :, -> 다 인식돼요)

+) 예문은 안 붙여도 AI가 알아서 만들어줘요. 직접 붙이고 싶으면 큰따옴표로
ex) 사랑 = love "I love you"

+) 한글만 보내도 OK, 영어만 보내도 OK — AI가 반대쪽 언어 + 예문까지 자동 완성
ex) *행운을 빌다        (한글 → 영어 자동 완성)
ex) *hit the road       (영어 → 한글 자동 완성)
(꼭 앞에 *를 붙여주세요)

+) 뜻이나 표현이 여러 개면 "/"로 구분해서 한 번에 등록 (양쪽 어디에 써도 OK)
ex) tell on = 고자질하다/영향을 미치다
ex) 그리워하다 = miss/long for
(콤마 ,는 구분자가 아니라 그냥 뜻의 일부로 들어가요)

⚙️ 뜻을 고치거나 새 뜻을 추가하고 싶어요
그냥 같은 형식으로 다시 보내기만 하면 돼요. 별도 명령어 필요 없어요!
• 내 시트에 이미 있는 표현(한글+영어가 똑같은 것)이면 → 예문만 갱신
ex) love = 사랑 "새 예문"
• 내 시트에 없던 새 표현/새로운 뜻이면 → 새 줄로 추가 (기존 건 그대로 유지)
ex) love = 애정

🗑️ 잘못 올려서 삭제하고 싶어요
본인이 등록한 표현만 삭제할 수 있어요. 영어로도, 한글 뜻으로도 지정 가능해요.
ex) delete/love  또는  /delete love  (둘 다 OK)
ex) delete/사랑  또는  /delete 사랑
(찾는 말로 등록된 뜻이 여러 개면 후보 id 목록을 보여드려요 → delete/#3 처럼 id로 정확히 지정)

💬 그냥 잡담하고 싶어요
앞에 chat/ (또는 /chat) 을 붙여주세요. 봇이 아예 무시해서 등록 시도로 안 잡혀요.
ex) chat/ 오늘 다들 뭐하세요?

📱 복습은 PWA 앱에서!
🔗 https://zzzsunny-ume.github.io/EnglishExpressionsReminder/
구글 계정으로 로그인하면 끝 (별도 회원가입 없음)
📚 홈 화면에서 "공동 시트" 또는 특정 멤버의 개인 시트를 골라서 그것만 복습할 수도 있어요
📅 망각곡선(Leitner box)에 따라 복습할 타이밍이 된 표현만 골라서 보여줌
🇰🇷 한글 뜻을 보여주면 → 🇺🇸 영어로 답해보는 방식
🔥 연속 학습일(스트릭), 🏆 누적 정복 개수도 홈 화면에서 확인 가능

✅ 이외 DB 활용, 건의사항 등은 PM 부탁드립니다`;
// ================================================================================

/**
 * 새 멤버가 입장했을 때 호출. 봇 자기 자신이 초대되는 경우는 건너뛰고,
 * 사람이 하나라도 있으면 공지 전송+고정을 실행한다.
 */
function sendAndPinAnnouncement(chatId, newMembers) {
  const token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_TOKEN');
  const botId = token ? Number(token.split(':')[0]) : null;

  const humanMembers = newMembers.filter(m => m.id !== botId);
  if (humanMembers.length === 0) return; // 봇 자신이 초대된 경우

  postAndPinAnnouncement(chatId);
}

/**
 * 공지 메시지를 보내고 상단에 고정(pin)하는 핵심 로직.
 * 입장 이벤트든, "greeting/" 수동 명령이든 여기로 모인다.
 * 이전에 우리가 고정해뒀던 공지가 있으면 먼저 그것만 콕 집어서 해제하고
 * (다른 사람이 고정한 다른 메시지는 안 건드림), 새 공지를 고정한다.
 * 고정에는 이 봇에게 "메시지 고정" 관리자 권한이 있어야 함.
 */
function postAndPinAnnouncement(chatId) {
  const token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_TOKEN');
  const props = PropertiesService.getScriptProperties();
  const lastPinnedKey = 'LAST_ANNOUNCEMENT_MSG_' + chatId;

  // 1. 공지 메시지 전송
  const sendUrl = `https://api.telegram.org/bot${token}/sendMessage`;
  const sendRes = UrlFetchApp.fetch(sendUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: chatId, text: ANNOUNCEMENT_TEXT }),
    muteHttpExceptions: true
  });
  const sendData = JSON.parse(sendRes.getContentText());

  if (!sendData.ok) {
    debugLog('공지 전송 실패: ' + sendRes.getContentText());
    return;
  }

  const messageId = sendData.result.message_id;

  // 2. 이전에 우리가 고정해뒀던 공지가 있으면 먼저 고정 해제
  const previousMessageId = props.getProperty(lastPinnedKey);
  if (previousMessageId) {
    const unpinUrl = `https://api.telegram.org/bot${token}/unpinChatMessage`;
    UrlFetchApp.fetch(unpinUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chatId, message_id: Number(previousMessageId) }),
      muteHttpExceptions: true
    });
    // 실패해도(이미 지워졌거나 이미 고정 해제된 경우 등) 무시하고 계속 진행
  }

  // 3. 방금 보낸 새 메시지를 상단에 고정
  const pinUrl = `https://api.telegram.org/bot${token}/pinChatMessage`;
  const pinRes = UrlFetchApp.fetch(pinUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      disable_notification: true
    }),
    muteHttpExceptions: true
  });
  const pinData = JSON.parse(pinRes.getContentText());

  if (!pinData.ok) {
    // 대부분 "봇에게 메시지 고정 권한이 없음"이 원인
    debugLog('메시지 고정 실패: ' + pinRes.getContentText());
    return;
  }

  // 4. 다음번에 이걸 풀 수 있도록 이번에 고정한 메시지 id 기억해두기
  props.setProperty(lastPinnedKey, String(messageId));
}

function sendTelegramMessage(chatId, text) {
  const token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_TOKEN');
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: chatId, text: text }),
    muteHttpExceptions: true
  });
}

/**
 * 한글=영어는 이미 있는데 예문(큰따옴표)이 없을 때, 그 영어 표현에 맞는
 * 짧고 자연스러운 예문을 AI에게 생성 요청. 실패하거나 키가 없으면 빈 문자열 반환.
 */
function generateExampleWithAI(english, korean) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) {
    debugLog('AI 예문 생성 실패: ANTHROPIC_API_KEY가 설정되지 않음');
    return '';
  }

  try {
    const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 60,
        messages: [
          {
            role: 'user',
            content: `Write one short, natural example sentence that a native English speaker would actually say or write in everyday conversation, correctly using the expression "${english}" (Korean meaning for context: "${korean}"). Keep it casual and realistic, not textbook-stiff. Respond with ONLY the example sentence - no quotes, no explanation, no extra text.`
          }
        ]
      }),
      muteHttpExceptions: true
    });

    const data = JSON.parse(response.getContentText());
    if (data.content && data.content[0] && data.content[0].text) {
      const example = data.content[0].text.trim();
      debugLog('AI 예문 생성 성공: ' + english + ' -> ' + example);
      return example;
    }
    debugLog('AI 예문 생성 실패: 예상치 못한 응답 - ' + response.getContentText());
    return '';
  } catch (err) {
    debugLog('AI 예문 생성 에러: ' + err);
    return '';
  }
}

/**
 * 영어 표현의 "영영 사전식 풀이"(짧은 영어 정의)를 AI에게 생성 요청.
 * 예문과는 별개로, 영어->영어 뜻풀이 한 줄을 만들어 예문 앞 열(F)에 저장한다.
 * 실패하거나 키가 없으면 빈 문자열 반환.
 */
function generateDefinitionWithAI(english, korean) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) {
    debugLog('AI 영영풀이 생성 실패: ANTHROPIC_API_KEY가 설정되지 않음');
    return '';
  }

  try {
    const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        messages: [
          {
            role: 'user',
            content: `Write a concise English-English definition for the expression "${english}" (Korean meaning for context: "${korean}"), using plain, everyday words a normal native speaker would use to explain it to a friend - NOT formal/clinical/dictionary-academic wording. Give ONLY the definition itself - one short phrase or sentence. No example sentence, no part-of-speech label, no quotes, no extra text.`
          }
        ]
      }),
      muteHttpExceptions: true
    });

    const data = JSON.parse(response.getContentText());
    if (data.content && data.content[0] && data.content[0].text) {
      const def = data.content[0].text.trim();
      debugLog('AI 영영풀이 생성 성공: ' + english + ' -> ' + def);
      return def;
    }
    debugLog('AI 영영풀이 생성 실패: 예상치 못한 응답 - ' + response.getContentText());
    return '';
  } catch (err) {
    debugLog('AI 영영풀이 생성 에러: ' + err);
    return '';
  }
}

/**
 * "=" 구분자 없이 한글만 왔을 때, Claude API로 자연스러운 영어 표현과 예문을 함께 물어봄.
 * 성공하면 { english, example } 객체를, 실패하거나 API 키가 없으면 null을 반환.
 *
 * 사용 전 준비: 스크립트 속성에 ANTHROPIC_API_KEY 추가 필요
 *   (console.anthropic.com 에서 API 키 발급)
 */
function translateWithAI(koreanText) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) {
    debugLog('AI 번역 실패: ANTHROPIC_API_KEY가 설정되지 않음');
    return null;
  }

  try {
    const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        messages: [
          {
            role: 'user',
            content: `Translate the Korean word or phrase "${koreanText}" into the way a native English speaker would ACTUALLY say it in real, everyday conversation - a common word, casual phrase, or idiom real people use, NOT a stiff/formal/scientific/dictionary/academic term. For example, "식곤증" should become something like "food coma" or "post-lunch slump", never a clinical term like "postprandial somnolence". If there's no single word, use a short natural phrase. Then write one short, natural example sentence using it the way people actually talk.\n\nRespond in EXACTLY this format, nothing else, no labels, no extra text:\n<english translation>|||<example sentence>`
          }
        ]
      }),
      muteHttpExceptions: true
    });

    const data = JSON.parse(response.getContentText());
    if (data.content && data.content[0] && data.content[0].text) {
      const raw = data.content[0].text.trim();
      const parts = raw.split('|||');
      const english = (parts[0] || '').trim();
      const example = (parts[1] || '').trim();

      if (!english) {
        debugLog('AI 번역 실패: 영어 번역이 비어있음 - ' + raw);
        return null;
      }

      debugLog('AI 번역 성공: ' + koreanText + ' -> ' + english + ' / 예문: ' + example);
      return { english: english, example: example };
    }
    debugLog('AI 번역 실패: 예상치 못한 응답 - ' + response.getContentText());
    return null;
  } catch (err) {
    debugLog('AI 번역 에러: ' + err);
    return null;
  }
}

/**
 * "*영어" 형식일 때 사용. 영어 표현을 받아서 자연스러운 한글 뜻과 예문을 함께 물어봄.
 * 성공하면 { korean, example } 객체를, 실패하거나 API 키가 없으면 null을 반환.
 */
function translateEnglishWithAI(englishText) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) {
    debugLog('AI 번역 실패: ANTHROPIC_API_KEY가 설정되지 않음');
    return null;
  }

  try {
    const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        messages: [
          {
            role: 'user',
            content: `Translate the English word or phrase "${englishText}" into the single most natural, commonly used Korean meaning (how a Korean speaker would actually say it, not a stiff/literal dictionary translation), and write one short, casual, natural example sentence a native speaker would really say, using "${englishText}".\n\nRespond in EXACTLY this format, nothing else, no labels, no extra text:\n<korean meaning>|||<example sentence>`
          }
        ]
      }),
      muteHttpExceptions: true
    });

    const data = JSON.parse(response.getContentText());
    if (data.content && data.content[0] && data.content[0].text) {
      const raw = data.content[0].text.trim();
      const parts = raw.split('|||');
      const korean = (parts[0] || '').trim();
      const example = (parts[1] || '').trim();

      if (!korean) {
        debugLog('AI 번역 실패: 한글 번역이 비어있음 - ' + raw);
        return null;
      }

      debugLog('AI 번역 성공: ' + englishText + ' -> ' + korean + ' / 예문: ' + example);
      return { korean: korean, example: example };
    }
    debugLog('AI 번역 실패: 예상치 못한 응답 - ' + response.getContentText());
    return null;
  } catch (err) {
    debugLog('AI 번역 에러: ' + err);
    return null;
  }
}

function debugLog(message) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName('디버그');
    if (!sheet) {
      sheet = ss.insertSheet('디버그');
      sheet.appendRow(['시각', '내용']);
    }
    sheet.appendRow([new Date(), message]);
  } catch (e) {
    // 무시
  }
}

function testAppend() {
  appendExpression('테스트한글', 'test english', '테스트유저', 'a short test definition', 'This is a test example sentence.');
}

/**
 * [일회성 마이그레이션 - 딱 한 번만 실행] 기존 시트들(표현목록 + 표현목록_*)에
 * '영영풀이' 열을 예문 바로 앞(F열)에 끼워넣는다. 기존 예문은 자동으로 G열로 밀려난다.
 *
 * 순서: 이 코드를 저장한 뒤, 새 메시지가 들어오기 전에 편집기에서 이 함수를 먼저 실행(▶).
 * (1분 트리거가 도는 사이에 하는 게 걱정되면, 잠깐 트리거를 꺼두고 실행 후 다시 켜도 됨)
 * 헤더가 이미 '영영풀이'인 시트는 자동으로 건너뛰므로 두 번 실행해도 열이 중복 생기진 않음.
 */
function migrateAddDefinitionColumn() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.getSheets().forEach(sheet => {
    const name = sheet.getName();
    // 대상: 공동 시트 + 개인 시트(표현목록_*)만
    if (name !== SHEET_NAME && name.indexOf('표현목록_') !== 0) return;

    const header = String(sheet.getRange(1, 6).getValue()).trim();
    if (header === '영영풀이') {
      debugLog('마이그레이션 스킵(이미 됨): ' + name);
      return;
    }

    sheet.insertColumnBefore(6);              // F열 앞에 빈 열 삽입 -> 예문이 G로 밀림
    sheet.getRange(1, 6).setValue('영영풀이'); // 새 F열 헤더
    debugLog('마이그레이션 완료: ' + name);
  });
}

/**
 * [선택 - 일회성] 기존에 영영풀이가 비어있는 행들을 AI로 채워준다.
 * 반드시 migrateAddDefinitionColumn()을 먼저 실행한 뒤에 돌릴 것.
 * 행이 아주 많으면 Apps Script 6분 제한에 걸릴 수 있는데, 그럴 땐 다시 실행하면
 * 이미 채워진 건 건너뛰고 이어서 채운다. (매 행 즉시 기록하므로 중간에 멈춰도 진행분은 남음)
 */
function backfillDefinitions() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.getSheets().forEach(sheet => {
    const name = sheet.getName();
    if (name !== SHEET_NAME && name.indexOf('표현목록_') !== 0) return;

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const values = sheet.getRange(2, 4, lastRow - 1, 3).getValues(); // D:F = 한글,영어,영영풀이
    for (let i = 0; i < values.length; i++) {
      const korean = values[i][0];
      const english = values[i][1];
      const definition = values[i][2];
      if (english && !definition) {
        const def = generateDefinitionWithAI(english, korean);
        if (def) {
          sheet.getRange(i + 2, 6).setValue(def); // F열에 즉시 기록
        }
      }
    }
  });

  // 다 채운 뒤 개인복습 시트의 단어목록 사본도 최신화
  try {
    refreshWordListToReviewSheet();
  } catch (err) {
    debugLog('백필 후 단어목록 리프레시 실패: ' + err);
  }
}

/**
 * 테스트용: 편집기에서 직접 실행해서 폴링이 잘 도는지 즉시 확인할 때 사용
 */
function testPollNow() {
  pollUpdates();
}

/**
 * 테스트/수동용: 폴링이 놓친 입장 이벤트를 뒤늦게라도 수동으로 처리하고 싶을 때 사용.
 * chatId와 이름을 실제 값으로 바꾼 뒤, 편집기에서 이 함수를 직접 실행(▶)하면
 * 그 자리에서 바로 공지 전송 + 고정이 실행됨.
 */
function testSendAnnouncementNow() {
  const chatId = -1000000000000; // 실제 그룹 chat_id로 교체 (마이너스 숫자)
  const memberName = '연정언니'; // 놓친 사람 이름 (표시용, 로직에 영향 없음)
  sendAndPinAnnouncement(chatId, [{ id: 0, first_name: memberName }]);
}

// ===================================================================
// ===== 여기부터 PWA용 API (doGet) - 텔레그램 폴링과는 독립적으로 동작 =====
// ===================================================================

/**
 * PWA가 fetch()로 호출하는 API 진입점.
 * CORS 문제를 피하기 위해 모든 요청을 GET으로만 받는다 (POST+JSON은
 * 브라우저가 preflight를 보내는데 Apps Script가 이를 처리 못해 막힘).
 *
 * 중요: 이 API는 표현목록(콜렉터) 시트를 전혀 읽지 않는다.
 * 오직 개인복습 스프레드시트 안의 "단어목록"(주기적으로 리프레시된 사본)과
 * "개인복습기록"만 본다. 데이터는 항상 콜렉터 -> 개인복습 시트로만 흐른다.
 *
 * 인증: sender를 클라이언트가 마음대로 주장하게 두지 않고, 매 요청마다
 * 구글이 발급한 idToken을 서버에서 직접 검증해서 이메일을 뽑아 쓴다.
 * (누가 남의 이름으로 복습 기록을 조작하는 걸 막기 위함)
 *
 * 단, `pushTargets`는 예외 — 로그인한 사람이 아니라 알림 발송 서버(Worker)가
 * 서버 대 서버로 부르는 것이라, idToken 검증 전에 먼저 갈라져서 별도의
 * 비밀 문자열(secret)로 인증한다.
 *
 * 사용 예:
 *   ?action=dueReviews&idToken=<구글 로그인 토큰>
 *   ?action=submitReview&idToken=<토큰>&key=overall&correct=true
 */
function doGet(e) {
  try {
    const action = e.parameter.action;

    // 알림 발송 서버(Cloudflare Worker) 전용 - 로그인 세션이 아니므로 idToken 검증보다 먼저 처리
    if (action === 'pushTargets') {
      return jsonResponse(getPushTargets(e.parameter.secret || ''));
    }

    const idToken = e.parameter.idToken || '';

    const auth = verifyGoogleToken(idToken);
    if (!auth) {
      return jsonResponse({ error: 'unauthorized' });
    }
    if (isBannedEmail(auth.email)) {
      return jsonResponse({ error: 'banned' });
    }
    const sender = auth.email;

    if (action === 'sources') {
      return jsonResponse({ sources: getSourceList() });
    }
    if (action === 'dueReviews') {
      const source = e.parameter.source || 'common';
      return jsonResponse(getDueReviews(sender, source));
    }
    if (action === 'submitReview') {
      const key = e.parameter.key || '';
      const correct = e.parameter.correct === 'true';
      return jsonResponse(submitReview(sender, key, correct));
    }
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

    return jsonResponse({ error: 'unknown action', action: action });
  } catch (err) {
    return jsonResponse({ error: String(err) });
  }
}

// 기본적으로 구글 로그인에 성공한 사람은 누구나 사용 가능 (텔레그램 방 여부와 무관).
// 대신 "차단된사용자" 탭에 이메일을 추가하면 그 사람만 콕 집어 차단할 수 있음.
function isBannedEmail(email) {
  const reviewSs = getReviewSpreadsheet();
  let sheet = reviewSs.getSheetByName(BANNED_USERS_SHEET_NAME);
  if (!sheet) {
    sheet = reviewSs.insertSheet(BANNED_USERS_SHEET_NAME);
    sheet.appendRow(['차단할 이메일']);
    sheet.appendRow(['(원치 않는 사용자의 구글 이메일을 여기 한 줄씩 추가하면 접근이 막힙니다)']);
    return false; // 아직 아무도 차단 안 된 상태
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const normalizedEmail = String(email).trim().toLowerCase();
  return values.some(row => String(row[0]).trim().toLowerCase() === normalizedEmail);
}

/**
 * 구글 idToken을 검증해서 { email, name }을 반환. 유효하지 않으면 null.
 * 구글의 tokeninfo 엔드포인트를 이용 (Apps Script에 JWT 암호검증 라이브러리가
 * 따로 없어서, 구글이 대신 검증해주는 이 방식이 제일 간단하고 안전함).
 */
// 같은 idToken으로 복습 세션 중 submitReview가 문제마다(수십 번) 호출되는데,
// 매번 구글 tokeninfo 엔드포인트까지 네트워크 왕복을 하면 그게 체감 속도 저하의
// 큰 원인이 된다. 토큰 자체가 어차피 시간 지나면 만료되므로, 검증 결과를 5분만
// 짧게 캐시해두고 재사용한다 (토큰의 실제 만료 시간인 1시간보다 훨씬 짧게 잡아서
// 안전하게 유지 - 캐시가 만료돼도 다음 호출에서 다시 검증하면 그만).
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
    if (data.aud !== clientId) return null; // 우리 앱이 발급한 토큰이 아니면 거부
    if (data.email_verified !== 'true' && data.email_verified !== true) return null;

    const result = { email: data.email, name: data.name || data.email };
    cache.put(cacheKey, JSON.stringify(result), 300); // 5분
    return result;
  } catch (err) {
    debugLog('구글 토큰 검증 에러: ' + err);
    return null;
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// 어느 시트든(공동/개인 공용) 한글/영어/영영풀이/예문을 읽어옴 (D:G 열 구조가 동일하다는 전제)
function getExpressionsFromSheet(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 4, lastRow - 1, 4).getValues(); // D:G = 한글,영어,영영풀이,예문
  const list = [];
  values.forEach(row => {
    const korean = row[0];
    const english = row[1];
    const definition = row[2];
    const example = row[3];
    if (english) {
      list.push({ korean: korean, english: english, definition: definition || '', example: example || '' });
    }
  });
  return list;
}

// 표현목록(공동)에서 삭제되지 않은 표현만 전부 가져옴 (기존 이름 유지, 내부적으로 공용 함수 사용)
function getAllExpressions() {
  return getExpressionsFromSheet(SHEET_NAME);
}

// 지금 존재하는 개인 시트(표현목록_이름) 전부 찾아서, 각각의 시트이름/미러탭이름/표시이름을 반환
function listPersonalSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const prefix = '표현목록_';
  return ss.getSheets()
    .map(s => s.getName())
    .filter(name => name.indexOf(prefix) === 0)
    .map(name => {
      const suffix = name.substring(prefix.length); // 예: "Sarah_Lee"
      return {
        sheetName: name,                 // 콜렉터 스프레드시트 안의 실제 개인 시트 이름
        sourceId: suffix,                // PWA가 소스 선택할 때 쓰는 id
        ownerDisplay: suffix.replace(/_/g, ' '), // 사람이 보기 좋은 이름
        mirrorName: '단어목록_' + suffix // 개인복습 스프레드시트 안에 만들 미러 탭 이름
      };
    });
}

// 개인복습 스프레드시트(표현목록과 완전히 다른 파일)를 엶
// dueReviews 한 번 처리하는 동안에도 단어목록 읽기/복습기록 읽기/통계 읽기가
// 각자 이 함수를 불러서, 패치 전에는 같은 스프레드시트를 한 요청 안에서 3번씩
// 다시 열고 있었다 (SpreadsheetApp.openById 자체가 꽤 무거운 호출). 요청 하나
// 처리하는 동안(= 이 스크립트가 살아있는 동안)에는 한 번만 열고 재사용한다.
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

// 표현 목록 하나를 개인복습 스프레드시트의 특정 탭에 통째로 덮어씀 (공용 헬퍼)
function writeWordListSheet(reviewSs, sheetName, expressions) {
  let sheet = reviewSs.getSheetByName(sheetName);
  if (!sheet) {
    sheet = reviewSs.insertSheet(sheetName);
  }
  sheet.clearContents();
  sheet.appendRow(['한글', '영어', '영영풀이', '예문', 'key']);

  if (expressions.length > 0) {
    // key는 이제 "영어"만이 아니라 "한글+영어" 조합 (같은 영어의 다른 뜻을 구분하기 위함)
    const rows = expressions.map(e => [e.korean, e.english, e.definition, e.example, buildCompositeKey(e.korean, e.english)]);
    sheet.getRange(2, 1, rows.length, 5).setValues(rows);
  }
}

// PWA가 "어떤 소스로 공부할지" 고를 수 있게, 소스 목록(공동 + 개인 시트들)을 저장
function writeSourceList(reviewSs, personalSheets) {
  let sheet = reviewSs.getSheetByName(SOURCE_LIST_SHEET_NAME);
  if (!sheet) {
    sheet = reviewSs.insertSheet(SOURCE_LIST_SHEET_NAME);
  }
  sheet.clearContents();
  sheet.appendRow(['id', 'label', 'wordListSheet']);

  const rows = [['common', '🌐 공동 (다같이 모은 표현)', WORD_LIST_SHEET_NAME]];
  personalSheets.forEach(p => {
    rows.push([p.sourceId, '👤 ' + p.ownerDisplay, p.mirrorName]);
  });
  sheet.getRange(2, 1, rows.length, 3).setValues(rows);
}

/**
 * 표현목록(공동) + 모든 개인 시트를 개인복습 스프레드시트로 각각 미러링.
 * 콜렉터 -> 개인복습 시트로만 흐르는 단방향 동기화. PWA API는 이 사본만 읽는다.
 */
function refreshWordListToReviewSheet() {
  const reviewSs = getReviewSpreadsheet();

  // 1. 공동 시트 미러
  const commonWords = getAllExpressions();
  writeWordListSheet(reviewSs, WORD_LIST_SHEET_NAME, commonWords);

  // 2. 존재하는 개인 시트들을 각각 미러
  const personalSheets = listPersonalSheets();
  const wordlists = { common: commonWords.map(toSyncWord) };
  personalSheets.forEach(p => {
    const words = getExpressionsFromSheet(p.sheetName);
    writeWordListSheet(reviewSs, p.mirrorName, words);
    wordlists[p.sourceId] = words.map(toSyncWord);
  });

  // 3. PWA가 드롭다운에 쓸 소스 목록도 최신화
  writeSourceList(reviewSs, personalSheets);

  // 4. PWA는 이제 이 시트를 직접 안 읽고 Cloudflare KV만 본다 (훨씬 빠르게 응답하기 위함).
  //    시트 미러링은 그대로 유지(백업/육안 확인용)하고, 추가로 최신 데이터를 KV에도 밀어넣는다.
  try {
    syncToCloudflare(wordlists, personalSheets);
  } catch (err) {
    debugLog('Cloudflare 동기화 실패: ' + err);
  }
}

// writeWordListSheet가 쓰는 것과 동일한 key(한글+영어 조합)를 사용해 PWA가 기대하는 형태로 변환
function toSyncWord(e) {
  return { korean: e.korean, english: e.english, definition: e.definition, example: e.example, key: buildCompositeKey(e.korean, e.english) };
}

// 개인복습 스프레드시트의 "차단된사용자" 탭에서 이메일 목록만 뽑아옴 (KV 동기화용)
function getBannedEmailList() {
  const reviewSs = getReviewSpreadsheet();
  const sheet = reviewSs.getSheetByName(BANNED_USERS_SHEET_NAME);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  return values.map(r => String(r[0]).trim()).filter(Boolean);
}

// Cloudflare Worker(worker-api)의 KV로 최신 표현 목록/소스 목록/차단 목록을 밀어넣는다.
// 스크립트 속성에 CLOUDFLARE_API_URL(worker-api 배포 주소)과 CLOUDFLARE_SYNC_SECRET(worker-api의
// SYNC_SECRET과 동일한 값)이 설정되어 있어야 동작한다. 둘 중 하나라도 없으면 조용히 건너뛴다
// (아직 worker-api를 안 만들었어도 텔레그램 봇/시트 미러링에는 영향 없음).
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

// source id로부터 개인복습 스프레드시트 안의 실제 단어목록 탭 이름을 찾음.
// 못 찾으면 안전하게 공동 시트로 폴백.
function resolveWordListSheetName(reviewSs, source) {
  if (!source || source === 'common') return WORD_LIST_SHEET_NAME;

  const sheet = reviewSs.getSheetByName(SOURCE_LIST_SHEET_NAME);
  if (sheet) {
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const values = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
      for (let i = 0; i < values.length; i++) {
        if (values[i][0] === source) return values[i][2];
      }
    }
  }
  return WORD_LIST_SHEET_NAME;
}

// PWA 드롭다운용 소스 목록 반환 ({id, label} 배열)
function getSourceList() {
  const reviewSs = getReviewSpreadsheet();
  const sheet = reviewSs.getSheetByName(SOURCE_LIST_SHEET_NAME);
  const fallback = [{ id: 'common', label: '🌐 공동 (다같이 모은 표현)' }];
  if (!sheet) return fallback;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return fallback;

  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  return values.map(r => ({ id: r[0], label: r[1] }));
}

// 개인복습 시트 안의 지정된 소스 단어목록(최신 사본)을 읽음. API는 항상 이 사본만 사용.
function getWordListFromReviewSheet(source) {
  const reviewSs = getReviewSpreadsheet();
  const sheetName = resolveWordListSheetName(reviewSs, source);
  const sheet = reviewSs.getSheetByName(sheetName);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  return values
    .map(row => ({ korean: row[0], english: row[1], definition: row[2] || '', example: row[3] || '', key: row[4] }))
    .filter(w => w.english);
}

// 개인복습기록 탭을 가져옴 (없으면 옵션에 따라 생성)
function getReviewSheet(createIfMissing) {
  if (createIfMissing === undefined) createIfMissing = true;
  const reviewSs = getReviewSpreadsheet();
  let sheet = reviewSs.getSheetByName(REVIEW_SHEET_NAME);
  if (!sheet) {
    if (!createIfMissing) return null;
    sheet = reviewSs.insertSheet(REVIEW_SHEET_NAME);
    sheet.appendRow(['user_id', 'key', '박스단계', '다음복습예정일', '마지막복습일']);
  }
  return sheet;
}

// 특정 사용자의 복습 기록을 { key: {rowIndex, box, nextDue} } 형태로 가져옴
// (key는 영어 표현을 정규화한 문자열 - 행 번호가 아니라서 표현이 재배치돼도 안 꼬임)
function getReviewMapForUser(sender) {
  const sheet = getReviewSheet();
  const lastRow = sheet.getLastRow();
  const map = {};
  if (lastRow < 2) return map;

  const values = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  values.forEach((row, idx) => {
    const rowNumber = idx + 2;
    const userId = row[0];
    const key = row[1];
    if (userId === sender) {
      map[key] = { rowIndex: rowNumber, box: row[2], nextDue: row[3] };
    }
  });
  return map;
}

/**
 * 오늘 복습해야 할 표현 목록 + 전체/학습 진행률 반환.
 * 아직 한 번도 학습 안 한 표현은 항상 복습 대상에 포함시켜서,
 * "DB의 모든 표현을 결국 다 배우게" 만든다.
 * source: 'common' 또는 개인 시트의 sourceId. 안 주면 공동으로 처리.
 */
function getDueReviews(sender, source) {
  const all = getWordListFromReviewSheet(source);
  const reviewMap = getReviewMapForUser(sender);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const due = [];
  all.forEach(word => {
    const rec = reviewMap[word.key];
    if (!rec) {
      due.push(word); // 신규 표현 -> 무조건 복습 대상
      return;
    }
    const nextDue = new Date(rec.nextDue);
    nextDue.setHours(0, 0, 0, 0);
    if (nextDue <= today) {
      due.push(word);
    }
  });

  // "이 소스 안에서" 학습한 개수(studied)와, 소스와 무관한 "지금까지 총 학습한 표현 수"(globalStudied)를 구분.
  // globalStudied는 어느 소스에서 공부했든 상관없이 이 사람이 지금까지 맞혀본 적 있는 전체 표현 수 -> 성취감 표시용.
  const studiedInSource = all.filter(w => reviewMap[w.key]).length;
  const globalStudied = Object.keys(reviewMap).length;

  // 홈 화면 "복습 현황" 그래프용 - 이 소스 안의 단어들을 세 구간으로 나눠서 개수를 센다.
  // notStarted: 한 번도 안 배움 / shortTerm: 박스 1~3(며칠 내 다시 봐야 함, 아직 불안정) /
  // longTerm: 박스 4~6(다음 복습까지 7일 이상 남음, 장기기억에 가까움)
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
      // box: PWA가 복습 난이도(적응형 모드)를 정할 때 씀. 아직 한 번도 안 배운 단어는 0(가장 쉬운 단계).
      return { korean: w.korean, english: w.english, definition: w.definition, example: w.example, key: w.key, box: rec ? rec.box : 0 };
    }),
    boxSummary: { notStarted: boxNotStarted, shortTerm: boxShortTerm, longTerm: boxLongTerm },
    stats: getUserStats(sender)
  };
}

/**
 * 복습 결과 제출. 정답이면 박스 단계 상승(최대 6), 오답이면 박스 1로 리셋.
 * 박스 6은 계속 30일 간격 유지 (완전히 복습을 끝내지 않음).
 */
function submitReview(sender, key, correct) {
  const sheet = getReviewSheet();
  const lastRow = sheet.getLastRow();
  let rowIndex = -1;
  let currentBox = 0;

  if (lastRow >= 2) {
    const values = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
    for (let i = 0; i < values.length; i++) {
      if (values[i][0] === sender && values[i][1] === key) {
        rowIndex = i + 2;
        currentBox = values[i][2];
        break;
      }
    }
  }

  const newBox = correct ? Math.min((currentBox || 0) + 1, 6) : 1;
  const intervalDays = BOX_INTERVALS_DAYS[newBox] !== undefined ? BOX_INTERVALS_DAYS[newBox] : 30;
  const today = new Date();
  const nextDue = new Date(today);
  nextDue.setDate(nextDue.getDate() + intervalDays);

  if (rowIndex === -1) {
    sheet.appendRow([sender, key, newBox, nextDue, today]);
  } else {
    sheet.getRange(rowIndex, 3, 1, 3).setValues([[newBox, nextDue, today]]);
  }

  // 스트릭/누적 통계 갱신 (오늘 처음 복습한 거면 스트릭 +1, 이미 오늘 했으면 유지)
  const stats = touchUserStats(sender);

  return {
    ok: true,
    box: newBox,
    nextDue: Utilities.formatDate(nextDue, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    stats: stats
  };
}

// ===================================================================
// ===== 스트릭 / 성취감 통계 (개인복습 스프레드시트 안의 "사용자통계" 탭) =====
// ===================================================================

function getUserStatsSheet(createIfMissing) {
  const reviewSs = getReviewSpreadsheet();
  let sheet = reviewSs.getSheetByName(USER_STATS_SHEET_NAME);
  if (!sheet) {
    if (createIfMissing === false) return null;
    sheet = reviewSs.insertSheet(USER_STATS_SHEET_NAME);
    sheet.appendRow(['user_id', '연속학습일', '최고연속기록', '마지막학습일']);
  }
  return sheet;
}

// 오늘 날짜 문자열 (스크립트 타임존 기준, yyyy-MM-dd)
function todayStr() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function yesterdayStr() {
  return Utilities.formatDate(new Date(Date.now() - 86400000), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// 조회만 (갱신 없음)
function getUserStats(sender) {
  const sheet = getUserStatsSheet(false);
  if (!sheet) return { streak: 0, bestStreak: 0, lastStudyDate: '' };
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { streak: 0, bestStreak: 0, lastStudyDate: '' };

  const values = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === sender) {
      return { streak: values[i][1], bestStreak: values[i][2], lastStudyDate: values[i][3] };
    }
  }
  return { streak: 0, bestStreak: 0, lastStudyDate: '' };
}

// 복습을 제출할 때마다 호출. 오늘 처음이면 스트릭을 올리고(어제 했으면 이어서, 아니면 1로 리셋),
// 오늘 이미 기록되어 있으면 그대로 둔다. 최고 기록도 같이 갱신.
function touchUserStats(sender) {
  const sheet = getUserStatsSheet(true);
  const lastRow = sheet.getLastRow();
  const today = todayStr();

  let rowIndex = -1;
  let streak = 0;
  let bestStreak = 0;
  let lastDate = '';

  if (lastRow >= 2) {
    const values = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
    for (let i = 0; i < values.length; i++) {
      if (values[i][0] === sender) {
        rowIndex = i + 2;
        streak = values[i][1] || 0;
        bestStreak = values[i][2] || 0;
        lastDate = values[i][3] || '';
        break;
      }
    }
  }

  if (lastDate !== today) {
    streak = (lastDate === yesterdayStr()) ? streak + 1 : 1;
    lastDate = today;
    bestStreak = Math.max(bestStreak, streak);
  }

  if (rowIndex === -1) {
    sheet.appendRow([sender, streak, bestStreak, lastDate]);
  } else {
    sheet.getRange(rowIndex, 2, 1, 3).setValues([[streak, bestStreak, lastDate]]);
  }

  return { streak: streak, bestStreak: bestStreak, lastStudyDate: lastDate };
}

// ===================================================================
// ===== 웹푸시 구독 저장/조회 (PWA 알림 기능용 - 신규 추가분) =====
// ===================================================================

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
