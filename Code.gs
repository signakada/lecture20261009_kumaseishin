/**
 * ============================================================
 * 地震後の災害精神医学講演会
 * 申込受付メール自動送信スクリプト
 * ・現地30名／オンライン300名の定員管理
 * ・受付完了メールにカレンダーファイル(.ics)を添付
 *   → 参加者自身のカレンダーが前日・当日17時に通知するため、
 *     事務局からのリマインドメールは送りません
 * ・1日の送信上限に達した分は退避し、翌日以降に自動で再送
 * ============================================================
 * フォーム編集画面の「︙（その他）」→「スクリプト エディタ」から
 * 開いたプロジェクトに、このファイルの内容を貼り付けて使用します。
 * ============================================================
 */

// ------------------------------------------------------------
// 設定
// ------------------------------------------------------------
const CONFIG = {
  eventName: '地震後の災害精神医学講演会',
  eventDateLabel: '令和8年10月9日（金）',
  eventTimeLabel: '19:00〜',
  venue: 'くまもと県民交流会館パレア10階　会議室7',

  // カレンダー登録用の日時（日本時間で指定）
  eventDate:  { year: 2026, month: 10, day: 9 }, // monthは1-12
  eventStart: { hour: 19, minute: 0 },
  eventEnd:   { hour: 21, minute: 0 },

  // ★定員（実人数。同一メールアドレスの重複申込は1名として数えます）
  capacity: {
    onsite: 30,
    online: 300,
  },

  // 定員に達したときにフォーム側も自動更新するか
  autoUpdateForm: true,
  closedMessage: '定員に達したため、受付を終了いたしました。たくさんのお申し込みをありがとうございました。',

  // ↓↓↓ オンライン設定が確定したら、ここを本番の値に差し替えてください ↓↓↓
  online: {
    url: 'https://us02web.zoom.us/j/86346306878?pwd=XE869FSpajBVW8txBBW6n7LzlTe3Ap.1',   // テストURL
    meetingId: '863 4630 6878',              // テスト ミーティングID
    passcode: '20261009',                     // テスト パスコード
  },

  fromName: '熊本県精神神経科診療所協会 事務局',
  replyTo: 'office@kumaseishin.com',

  // ★キャンセルされた方のメールアドレス
  // ここに追記すると、その方は定員のカウントから外れます（回答記録は残ります）。
  // 追記して保存したあと promoteWaitlist を実行すると、
  // 繰り上がった方に受付完了メールが自動で送られます。
  cancelledEmails: [
    // 'cancelled-person@example.com',
  ],

  // ★テスト用アドレス（定員のカウントに含めません）
  // ここに登録したアドレスは、満席かどうかに関わらず常に受付完了メールが届き、
  // 席を1つも消費しません。本番開始後も動作確認に使えます。
  testEmails: [
    // 'your-address@example.com',
  ],

  // 送信上限に達したときの通知先
  adminEmail: 'office@kumaseishin.com',
  // 上限ぎりぎりまで使い切らず、この件数は事務局への通知用に残します
  quotaReserve: 3,
  // 未送信分を再送する時刻（毎日この時間帯に自動実行）
  retryHour: 9,
};

// フォームの質問タイトル（実際のフォームの文言と完全に一致している必要があります）
const FIELD = {
  name: '氏名',
  affiliation: '所属',
  jobType: '職種',
  participation: '参加方法',
  email: 'メールアドレス',
};

// 「参加方法」の選択肢の文言（フォームの表記と完全一致させてください）
const PARTICIPATION_ONLINE = 'オンラインでの参加';
const PARTICIPATION_ONSITE = '現地で参加';

// スクリプトプロパティのキー
const PROP_PENDING = 'PENDING_EMAILS';
const PROP_ALERT_DATE = 'QUOTA_ALERT_DATE';
const PROP_NOTIFIED_ACCEPTED = 'NOTIFIED_ACCEPTED'; // 受付完了メールを送信済みの宛先
const PROP_NOTIFIED_WAITLIST = 'NOTIFIED_WAITLIST'; // キャンセル待ちメールを送信済みの宛先


// ------------------------------------------------------------
// ① フォーム送信時：受付完了 または キャンセル待ちメールを送信
// ------------------------------------------------------------
function onFormSubmitHandler(e) {
  // この関数はフォーム送信トリガー専用です。
  // エディタから手動実行すると引数 e が空になるため、案内を出して終了します。
  if (!e || !e.response) {
    Logger.log(
      'この関数はフォームが送信されたときに自動で動くものです。手動では実行できません。\n' +
      '申込状況を確認したい場合は showCurrentCounts を選んで実行してください。'
    );
    return;
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000); // 同時申込による定員の数え間違いを防ぐ
  } catch (err) {
    Logger.log('ロック取得に失敗しました: ' + err);
  }

  try {
    const submitted = extractAnswers(e.response);
    const email = submitted[FIELD.email] || '';
    if (!email) return;

    const roster = buildRoster();
    const record = roster.byEmail[email];
    if (!record) return;

    sendRegistrationMail(record, roster.counts);
    updateFormAvailability(roster.counts);
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}

/** 受付完了／キャンセル待ちメールを組み立てて送信します */
function sendRegistrationMail(record, counts) {
  if (record.status === 'accepted') {
    const subject = `【受付完了】${CONFIG.eventName}のお申し込みについて`;
    const body = buildConfirmationBody(record.name, record.affiliation, record.isOnline);
    const ics = buildCalendarBlob(record.isOnline);
    const ok = sendMail(record.email, subject, body, [ics]);
    if (ok) markNotified(PROP_NOTIFIED_ACCEPTED, record.email);
    return ok;
  } else {
    const subject = `【キャンセル待ち】${CONFIG.eventName}のお申し込みについて`;
    const body = buildWaitlistBody(record.name, record.affiliation, record.isOnline, counts);
    const ok = sendMail(record.email, subject, body);
    if (ok) markNotified(PROP_NOTIFIED_WAITLIST, record.email);
    return ok;
  }
}


// ------------------------------------------------------------
// ② 名簿の作成（受付済み／キャンセル待ちの判定）
// ------------------------------------------------------------
/**
 * 全回答を、メールアドレス単位の実人数に集約します。
 * ・同一アドレスの複数回申込は1名として扱い、内容は「最新の回答」を採用
 * ・受付順は「最初に申し込んだ時刻」で判定するので、
 *   途中で内容を修正して再送信しても順番が後ろに下がることはありません
 */
function buildRoster() {
  const responses = FormApp.getActiveForm().getResponses();

  const map = {};
  responses.forEach(response => {
    const answers = extractAnswers(response);
    const email = answers[FIELD.email];
    if (!email) return;
    if (isCancelled(email)) return; // キャンセル済みは集計から除外

    if (map[email]) {
      map[email].answers = answers; // 最新の内容で上書き
    } else {
      map[email] = { email: email, answers: answers, firstTime: response.getTimestamp().getTime() };
    }
  });

  const entries = Object.keys(map).map(email => map[email]);
  entries.sort((a, b) => a.firstTime - b.firstTime); // 申込が早い順

  const counts = { onsite: 0, online: 0 };
  const waitCounts = { onsite: 0, online: 0 };
  const byEmail = {};
  const accepted = [];
  const waitlist = [];
  const testers = [];

  entries.forEach(entry => {
    const isOnline = entry.answers[FIELD.participation] === PARTICIPATION_ONLINE;
    const key = isOnline ? 'online' : 'onsite';
    const limit = isOnline ? CONFIG.capacity.online : CONFIG.capacity.onsite;

    const record = {
      email: entry.email,
      name: entry.answers[FIELD.name] || '',
      affiliation: entry.answers[FIELD.affiliation] || '',
      isOnline: isOnline,
      status: '',
      isTest: isTestEmail(entry.email),
    };

    if (record.isTest) {
      // テスト用アドレスは席を消費せず、常に受付完了扱い
      record.status = 'accepted';
      testers.push(record);
    } else if (counts[key] < limit) {
      counts[key]++;
      record.status = 'accepted';
      accepted.push(record);
    } else {
      waitCounts[key]++;
      record.status = 'waitlist';
      waitlist.push(record);
    }
    byEmail[entry.email] = record;
  });

  return {
    counts: counts,
    waitCounts: waitCounts,
    byEmail: byEmail,
    accepted: accepted,
    waitlist: waitlist,
    testers: testers,
  };
}

/** テスト用アドレスかどうか（大文字小文字・前後の空白は無視） */
function isTestEmail(email) {
  const target = String(email).trim().toLowerCase();
  return CONFIG.testEmails.some(e => String(e).trim().toLowerCase() === target);
}

/** キャンセル済みのアドレスかどうか */
function isCancelled(email) {
  const target = String(email).trim().toLowerCase();
  return CONFIG.cancelledEmails.some(e => String(e).trim().toLowerCase() === target);
}


// ------------------------------------------------------------
// ③ メール本文
// ------------------------------------------------------------
function buildConfirmationBody(name, affiliation, isOnline) {
  const salutation = `${affiliation || ''}${name ? name + '　' : ''}様`;

  let body =
`${salutation}

${CONFIG.eventName}にお申し込みいただきありがとうございます。
受付を完了しました。

【開催概要】
日時：${CONFIG.eventDateLabel}　${CONFIG.eventTimeLabel}
会場：${CONFIG.venue}

演題:災害メンタルヘルスを通して拓く精神医療・医学の未来 
～東日本大震災後15年の東北と本邦における軌跡、 
そして熊本とともに描く精神医療保健のあり方～
演者:東北大学大学院医学系研究科 精神神経学分野 教授 富田 博秋 先生

`;

  if (isOnline) {
    body +=
`
【オンライン参加に必要な情報】
※現時点ではテスト用の情報です。確定次第、改めて正式なご案内をお送りします。

URL　　　　　：${CONFIG.online.url}
ミーティングID：${CONFIG.online.meetingId}
パスコード　　：${CONFIG.online.passcode}
`;
  }

  body +=
`
【カレンダーへのご登録のお願い】
本メールに予定表ファイル（lecture-20261009.ics）を添付しております。
添付ファイルを開いてカレンダーに登録していただきますと、
前日と当日17時に、お使いの端末から自動で通知が届きます。
${isOnline ? '参加用のURLも予定の詳細欄に記載されています。\n' : ''}
なお、事務局からの当日のリマインドメールは送付いたしません。
お手数ですが、カレンダーへのご登録をお願いいたします。

ご不明な点がございましたら本メールへご返信ください。

--------------------------------------------
${CONFIG.fromName}
--------------------------------------------
`;

  return body;
}

function buildWaitlistBody(name, affiliation, isOnline, counts) {
  const salutation = `${affiliation || ''}${name ? name + '　' : ''}様`;
  const typeLabel = isOnline ? 'オンラインでのご参加' : '現地でのご参加';

  let body =
`${salutation}

${CONFIG.eventName}にお申し込みいただきありがとうございます。

誠に恐れ入りますが、${typeLabel}は定員に達しましたため、
キャンセル待ちとして承りました。
空きが出ました場合には、事務局より改めてご連絡いたします。

【開催概要】
日時：${CONFIG.eventDateLabel}　${CONFIG.eventTimeLabel}
会場：${CONFIG.venue}

演題:災害メンタルヘルスを通して拓く精神医療・医学の未来 
～東日本大震災後15年の東北と本邦における軌跡、 
そして熊本とともに描く精神医療保健のあり方～
演者:東北大学大学院医学系研究科 精神神経学分野 教授 富田 博秋 先生
`;

  // 現地が満席でオンラインに空きがある場合は、切り替えをご案内
  if (!isOnline && counts.online < CONFIG.capacity.online) {
    body +=
`
なお、オンラインでのご参加にはまだお席がございます。
オンラインでの参加をご希望の場合は、お手数ですが本メールへご返信いただくか、
申込フォームより「${PARTICIPATION_ONLINE}」を選択して再度お申し込みください。
`;
  }

  body +=
`
何卒ご理解のほどよろしくお願い申し上げます。

--------------------------------------------
${CONFIG.fromName}
--------------------------------------------
`;

  return body;
}


// ------------------------------------------------------------
// ④ カレンダーファイル(.ics)の生成
// ------------------------------------------------------------
/**
 * 前日（-P1D）と当日2時間前（-PT2H＝17時）に通知が出るよう
 * アラームを2件入れています。リマインドメールの代わりになります。
 */
function buildCalendarBlob(isOnline) {
  const d = CONFIG.eventDate;
  const dtStart = toUtcStamp(d.year, d.month, d.day, CONFIG.eventStart.hour, CONFIG.eventStart.minute);
  const dtEnd   = toUtcStamp(d.year, d.month, d.day, CONFIG.eventEnd.hour,   CONFIG.eventEnd.minute);
  const dtStamp = Utilities.formatDate(new Date(), 'UTC', "yyyyMMdd'T'HHmmss'Z'");

  const location = isOnline ? 'オンライン（Zoom）' : CONFIG.venue;

  let description =
`演題：災害メンタルヘルスを通して拓く精神医療・医学の未来
～東日本大震災後15年の東北と本邦における軌跡、そして熊本とともに描く精神医療保健のあり方～
演者：東北大学大学院医学系研究科 精神神経学分野 教授 富田 博秋 先生`;

  if (isOnline) {
    description +=
`

【オンライン参加情報】
URL：${CONFIG.online.url}
ミーティングID：${CONFIG.online.meetingId}
パスコード：${CONFIG.online.passcode}`;
  } else {
    description += `

会場：${CONFIG.venue}`;
  }

  description += `

主催：${CONFIG.fromName}`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Kumamoto Association of Psychiatric Clinics//Lecture//JA',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:kumaseishin-20261009-${isOnline ? 'online' : 'onsite'}@kumaseishin.com`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${escapeIcsText(CONFIG.eventName)}`,
    `LOCATION:${escapeIcsText(location)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
  ];

  if (isOnline) {
    lines.push(`URL:${CONFIG.online.url}`);
  }

  lines.push(
    'STATUS:CONFIRMED',
    'BEGIN:VALARM',
    'TRIGGER:-P1D',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeIcsText('明日は' + CONFIG.eventName + 'です')}`,
    'END:VALARM',
    'BEGIN:VALARM',
    'TRIGGER:-PT2H',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeIcsText('本日19時より' + CONFIG.eventName + 'を開催します')}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  );

  const ics = foldIcsLines(lines.join('\n'));
  return Utilities.newBlob(ics, 'text/calendar; charset=UTF-8', 'lecture-20261009.ics');
}

/** 日本時間(UTC+9)の日時を、ICS用のUTC文字列に変換します */
function toUtcStamp(year, month, day, hour, minute) {
  const t = Date.UTC(year, month - 1, day, hour - 9, minute, 0);
  return Utilities.formatDate(new Date(t), 'UTC', "yyyyMMdd'T'HHmmss'Z'");
}

function escapeIcsText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** ICSの1行75オクテット制限に合わせて行を折り返します（マルチバイト対応） */
function foldIcsLines(text) {
  return text.split('\n').map(foldIcsLine).join('\r\n');
}

function foldIcsLine(line) {
  const MAX = 72;
  let result = '';
  let current = '';
  let bytes = 0;

  for (const ch of line) {
    const len = utf8ByteLength(ch);
    if (bytes + len > MAX) {
      result += (result ? '\r\n ' : '') + current;
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += len;
  }
  result += (result ? '\r\n ' : '') + current;
  return result;
}

function utf8ByteLength(ch) {
  const code = ch.codePointAt(0);
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code < 0x10000) return 3;
  return 4;
}


// ------------------------------------------------------------
// ⑤ 送信上限のガードと、未送信分の退避・再送
// ------------------------------------------------------------
/**
 * 残り送信可能数を確認してから送信します。
 * 上限に達している場合は送信せず、未送信リストに退避します。
 */
function sendMail(to, subject, body, attachments) {
  const remaining = MailApp.getRemainingDailyQuota();

  if (remaining <= CONFIG.quotaReserve) {
    enqueuePending(to);
    notifyQuotaExhausted();
    Logger.log(`送信上限のため退避しました: ${to}（残り ${remaining}）`);
    return false;
  }

  try {
    const options = {
      to: to,
      subject: subject,
      body: body,
      name: CONFIG.fromName,
      replyTo: CONFIG.replyTo,
    };
    if (attachments && attachments.length) options.attachments = attachments;
    MailApp.sendEmail(options);
    return true;
  } catch (err) {
    enqueuePending(to);
    Logger.log(`送信に失敗したため退避しました: ${to} / ${err}`);
    return false;
  }
}

/** 未送信リストへの追加（重複は追加しません） */
function enqueuePending(email) {
  const props = PropertiesService.getScriptProperties();
  const list = loadPending();
  if (list.indexOf(email) === -1) {
    list.push(email);
    props.setProperty(PROP_PENDING, JSON.stringify(list));
  }
  ensureRetryTrigger();
}

function loadPending() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_PENDING);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (err) { return []; }
}

function savePending(list) {
  PropertiesService.getScriptProperties().setProperty(PROP_PENDING, JSON.stringify(list));
}

/**
 * 未送信分の再送。毎日 CONFIG.retryHour 時台に自動実行されます。
 * 送信内容はその時点の名簿から作り直すので、
 * 退避中に受付状況が変わっていても正しい内容が届きます。
 */
function flushPendingEmails() {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); } catch (err) {}

  try {
    const pending = loadPending();
    if (!pending.length) {
      Logger.log('未送信のメールはありません。');
      return;
    }

    savePending([]); // いったん空に。送れなかった分は sendMail が再度退避します。

    const roster = buildRoster();
    let sent = 0;
    pending.forEach(email => {
      const record = roster.byEmail[email];
      if (!record) return; // 回答が削除されている場合はスキップ
      if (sendRegistrationMail(record, roster.counts)) sent++;
    });

    Logger.log(`未送信分の再送: ${sent}件送信 / ${loadPending().length}件が残っています。`);
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}

/** 上限到達を事務局に通知します（1日1回まで） */
function notifyQuotaExhausted() {
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  if (props.getProperty(PROP_ALERT_DATE) === today) return; // 本日は通知済み

  props.setProperty(PROP_ALERT_DATE, today);

  const pending = loadPending();
  const body =
`${CONFIG.eventName} 申込フォームの自動返信について

本日のメール送信上限に達したため、受付メールの送信を一時停止しました。
未送信の申込者は ${pending.length} 名です。

未送信分は翌日 ${CONFIG.retryHour} 時台に自動で再送されます。
すぐに送信する必要がある場合は、スクリプトエディタから
flushPendingEmails を手動で実行してください。

現在の未送信リスト:
${pending.join('\n')}
`;

  try {
    MailApp.sendEmail({
      to: CONFIG.adminEmail,
      subject: `【要確認】${CONFIG.eventName} 申込メールが送信上限に達しました`,
      body: body,
      name: CONFIG.fromName,
    });
  } catch (err) {
    Logger.log('上限通知の送信に失敗しました: ' + err);
  }
}

/** 再送用の日次トリガーが無ければ作成します */
function ensureRetryTrigger() {
  const exists = ScriptApp.getProjectTriggers()
    .some(t => t.getHandlerFunction() === 'flushPendingEmails');
  if (exists) return;

  ScriptApp.newTrigger('flushPendingEmails')
    .timeBased()
    .everyDays(1)
    .atHour(CONFIG.retryHour)
    .create();
}


// ------------------------------------------------------------
// ⑥ キャンセルに伴う繰り上げ処理
// ------------------------------------------------------------
/**
 * CONFIG.cancelledEmails にアドレスを追記して保存したあと、この関数を実行します。
 * 空いた席に繰り上がった方へ受付完了メール（.ics付き）を送信し、
 * 満席で閉じていたフォームがあれば再度受付可能に戻します。
 */
function promoteWaitlist() {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); } catch (err) {}

  try {
    const roster = buildRoster();
    const alreadyAccepted = loadNotified(PROP_NOTIFIED_ACCEPTED);
    const wasWaitlisted = loadNotified(PROP_NOTIFIED_WAITLIST);

    let promoted = 0;
    roster.accepted.forEach(record => {
      if (alreadyAccepted.indexOf(record.email) !== -1) return; // 送信済み

      const isPromotion = wasWaitlisted.indexOf(record.email) !== -1;
      const subject = isPromotion
        ? `【ご参加いただけます】${CONFIG.eventName}（キャンセル待ちからの繰り上げ）`
        : `【受付完了】${CONFIG.eventName}のお申し込みについて`;
      const body = isPromotion
        ? buildPromotionBody(record.name, record.affiliation, record.isOnline)
        : buildConfirmationBody(record.name, record.affiliation, record.isOnline);

      if (sendMail(record.email, subject, body, [buildCalendarBlob(record.isOnline)])) {
        markNotified(PROP_NOTIFIED_ACCEPTED, record.email);
        promoted++;
      }
    });

    updateFormAvailability(roster.counts);

    Logger.log(
      `繰り上げ処理: ${promoted}名に受付完了メールを送信しました。\n` +
      `現地 ${roster.counts.onsite}/${CONFIG.capacity.onsite}、` +
      `オンライン ${roster.counts.online}/${CONFIG.capacity.online}、` +
      `キャンセル待ち ${roster.waitlist.length}名`
    );
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}

function buildPromotionBody(name, affiliation, isOnline) {
  const salutation = `${affiliation || ''}${name ? name + '　' : ''}様`;
  const typeLabel = isOnline ? 'オンラインでのご参加' : '現地でのご参加';

  let body =
`${salutation}

先般、${CONFIG.eventName}のお申し込みにつきまして、
${typeLabel}が定員に達していたためキャンセル待ちとしてご案内しておりました。

このたび空きが出ましたので、ご参加いただけることとなりました。
お待たせいたしまして申し訳ございませんでした。

【開催概要】
日時：${CONFIG.eventDateLabel}　${CONFIG.eventTimeLabel}
会場：${CONFIG.venue}

演題:災害メンタルヘルスを通して拓く精神医療・医学の未来 
～東日本大震災後15年の東北と本邦における軌跡、 
そして熊本とともに描く精神医療保健のあり方～
演者:東北大学大学院医学系研究科 精神神経学分野 教授 富田 博秋 先生

`;

  if (isOnline) {
    body +=
`
【オンライン参加に必要な情報】
※現時点ではテスト用の情報です。確定次第、改めて正式なご案内をお送りします。

URL　　　　　：${CONFIG.online.url}
ミーティングID：${CONFIG.online.meetingId}
パスコード　　：${CONFIG.online.passcode}
`;
  }

  body +=
`
【カレンダーへのご登録のお願い】
本メールに予定表ファイル（lecture-20261009.ics）を添付しております。
添付ファイルを開いてカレンダーに登録していただきますと、
前日と当日17時に、お使いの端末から自動で通知が届きます。
${isOnline ? '参加用のURLも予定の詳細欄に記載されています。\n' : ''}
ご都合が合わなくなった場合は、恐れ入りますが本メールへご返信ください。

--------------------------------------------
${CONFIG.fromName}
--------------------------------------------
`;

  return body;
}

/** 送信済み記録の管理 */
function loadNotified(key) {
  const raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (err) { return []; }
}

function markNotified(key, email) {
  const props = PropertiesService.getScriptProperties();
  const list = loadNotified(key);
  if (list.indexOf(email) === -1) {
    list.push(email);
    props.setProperty(key, JSON.stringify(list));
  }
}


// ------------------------------------------------------------
// ⑦ 定員に達したときのフォーム側の自動更新
// ------------------------------------------------------------
function updateFormAvailability(counts) {
  if (!CONFIG.autoUpdateForm) return;

  const form = FormApp.getActiveForm();
  const onsiteFull = counts.onsite >= CONFIG.capacity.onsite;
  const onlineFull = counts.online >= CONFIG.capacity.online;

  // 両方満席 → フォーム自体を受付終了に
  if (onsiteFull && onlineFull) {
    form.setAcceptingResponses(false);
    form.setCustomClosedFormMessage(CONFIG.closedMessage);
    return;
  }

  // 空きが出た場合は受付を再開
  if (!form.isAcceptingResponses()) {
    form.setAcceptingResponses(true);
  }

  // 片方だけ満席 → 満席の選択肢をフォームから外す
  const item = findParticipationItem(form);
  if (!item) return;

  const remaining = [];
  if (!onsiteFull) remaining.push(PARTICIPATION_ONSITE);
  if (!onlineFull) remaining.push(PARTICIPATION_ONLINE);

  if (item.getChoices().length === remaining.length) return; // 変更不要

  item.setChoiceValues(remaining);
  item.setHelpText(onsiteFull
    ? '現地での参加は定員に達したため、現在オンラインのみ受付中です。'
    : 'オンラインでの参加は定員に達したため、現在現地参加のみ受付中です。');
}

/** 「参加方法」の設問（ラジオボタン／プルダウン）を探します */
function findParticipationItem(form) {
  const items = form.getItems();
  for (let i = 0; i < items.length; i++) {
    if (items[i].getTitle() !== FIELD.participation) continue;
    const type = items[i].getType();
    if (type === FormApp.ItemType.MULTIPLE_CHOICE) return items[i].asMultipleChoiceItem();
    if (type === FormApp.ItemType.LIST) return items[i].asListItem();
  }
  return null;
}

/** 選択肢を元に戻したいときに手動で実行します */
function restoreParticipationChoices() {
  const form = FormApp.getActiveForm();
  const item = findParticipationItem(form);
  if (item) {
    item.setChoiceValues([PARTICIPATION_ONSITE, PARTICIPATION_ONLINE]);
    item.setHelpText('');
  }
  form.setAcceptingResponses(true);
}


// ------------------------------------------------------------
// ⑦ 状況確認（いつでも手動で実行できます）
// ------------------------------------------------------------
function showCurrentCounts() {
  const roster = buildRoster();
  const pending = loadPending();

  const lines = [
    `現地　　：${roster.counts.onsite} / ${CONFIG.capacity.onsite} 名（キャンセル待ち ${roster.waitCounts.onsite} 名）`,
    `オンライン：${roster.counts.online} / ${CONFIG.capacity.online} 名（キャンセル待ち ${roster.waitCounts.online} 名）`,
    `テスト用（定員外）：${roster.testers.length} 名`,
    `キャンセル済み：${CONFIG.cancelledEmails.length} 名`,
    `本日の残り送信可能数：${MailApp.getRemainingDailyQuota()} 件`,
    `未送信メール：${pending.length} 件`,
    '',
    '［キャンセル待ちの方］',
  ];
  roster.waitlist.forEach(r => {
    lines.push(`${r.isOnline ? 'オンライン' : '現地'}　${r.affiliation} ${r.name}　${r.email}`);
  });

  if (roster.testers.length) {
    lines.push('', '［テスト用（定員外）］');
    roster.testers.forEach(r => {
      lines.push(`${r.isOnline ? 'オンライン' : '現地'}　${r.affiliation} ${r.name}　${r.email}`);
    });
  }

  if (pending.length) {
    lines.push('', '［未送信の宛先］', pending.join('\n'));
  }
  Logger.log(lines.join('\n'));
}

/** .ics の中身を確認したいときに実行します */
function previewCalendarFile() {
  Logger.log('--- オンライン参加者向け ---\n' + buildCalendarBlob(true).getDataAsString());
  Logger.log('--- 現地参加者向け ---\n' + buildCalendarBlob(false).getDataAsString());
}


// ------------------------------------------------------------
// ⑧ セットアップ用関数
// ------------------------------------------------------------

// 8-1. フォーム送信トリガーの作成（最初に1回だけ実行）
function setupFormSubmitTrigger() {
  const form = FormApp.getActiveForm();
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'onFormSubmitHandler') {
      ScriptApp.deleteTrigger(t); // 二重登録防止
    }
  });
  ScriptApp.newTrigger('onFormSubmitHandler')
    .forForm(form)
    .onFormSubmit()
    .create();
}

// 8-2. 未送信分の再送トリガーの作成（最初に1回だけ実行）
function setupRetryTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'flushPendingEmails') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('flushPendingEmails')
    .timeBased()
    .everyDays(1)
    .atHour(CONFIG.retryHour)
    .create();
}

// 8-3. 旧・リマインドメールのトリガーを削除（1回だけ実行してください）
function removeReminderTriggers() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'sendReminderToAll') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  Logger.log(`旧リマインドトリガーを ${removed} 件削除しました。`);
}


// ------------------------------------------------------------
// ユーティリティ
// ------------------------------------------------------------
function extractAnswers(response) {
  const answers = {};
  response.getItemResponses().forEach(ir => {
    answers[ir.getItem().getTitle()] = ir.getResponse();
  });
  return answers;
}
