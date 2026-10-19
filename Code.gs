/**
 * 환자 수용 요청 — Google Apps Script 웹앱 (서버)
 *
 * 경찰관이 보낸 수용 요청을 참여 병원 전체에 보여주고,
 * 병원의 수용 가능/불가 응답을 경찰관 화면으로 돌려준다.
 * 데이터는 스프레드시트 없이 스크립트 임시 저장소에만 두고 자동 삭제한다.
 */

const CONFIG = {
  REQUEST_TTL_MIN: 60, // 응답 대기 중인 요청은 60분 후 자동 삭제
  DONE_KEEP_MIN: 10,   // 종료된 요청은 10분 동안 결과만 표시 후 삭제
  TYPES: ['주취자', '정신응급', '일반응급', '외상', '기타'],
  REGIONS: ['서울', '인천', '경기', '기타'],
  STATUSES: ['accept', 'reject', 'call'], // 수용 가능 / 수용 불가 / 전화 확인 필요
  // 화면이 꺼져도 오는 알림: 병원 Gmail로 메일 발송 (무료 계정 하루 100통 한도)
  REMIND_EVERY_MIN: 5,  // 수용 가능/불가 응답 전까지 이 간격으로 다시 알림
  MAX_PUSHES: 3,        // 요청 1건당 병원별 최대 알림 횟수 (첫 알림 + 재알림 2회)
  MAIL_RESERVE: 5,      // 하루 남은 발송량이 이보다 적으면 재알림은 보내지 않음
  CALL_SNOOZE_MIN: 2,   // '전화 확인' 응답 후 알림을 멈추는 시간
  HOSPITAL_KEEP_DAYS: 30, // 이 기간 접속하지 않은 병원은 알림 대상에서 제외
};

const CACHE_KEY = 'state_v1';
const CODE_CACHE_KEY = 'access_code_v1';
const PREFIX = 'req_';
const CACHE_SEC = 21600; // CacheService 최대 보관 시간(6시간)
const HOSPITALS_KEY = 'hospitals';
const PUSHLOG_KEY = 'pushlog_v1';

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('환자 수용 요청')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ---------- 화면에서 호출하는 함수 (google.script.run) ---------- */

function getConfig() {
  return { needsCode: !!accessCode_(), types: CONFIG.TYPES, regions: CONFIG.REGIONS };
}

function verifyCode(code) {
  checkCode_(code);
  return true;
}

function createRequest(code, data) {
  checkCode_(code);
  const req = {
    id: newId_(),
    createdAt: Date.now(),
    status: 'open',
    type: pick_(data.type, CONFIG.TYPES),
    region: pick_(data.region, CONFIG.REGIONS),
    condition: clean_(data.condition, 300),
    officer: clean_(data.officer, 40),
    contact: clean_(data.contact, 30),
    responses: {},
  };
  mutate_((state, changed) => {
    state[req.id] = req;
    changed.push(req.id);
  });
  pushPending_([req]);
  return req;
}

/** 병원 화면에 들어올 때 호출: 알림 받을 Gmail 주소와 함께 알림 대상에 등록한다. */
function registerHospital(code, name, regions, email) {
  checkCode_(code);
  name = clean_(name, 40);
  if (!name) throw new Error('병원명을 입력하세요.');
  regions = (regions || []).filter((r) => CONFIG.REGIONS.indexOf(r) >= 0);
  email = clean_(email, 100);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('이메일 주소 형식이 올바르지 않습니다.');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const props = PropertiesService.getScriptProperties();
    const hospitals = JSON.parse(props.getProperty(HOSPITALS_KEY) || '{}');
    const cutoff = Date.now() - CONFIG.HOSPITAL_KEEP_DAYS * 86400000;
    Object.keys(hospitals).forEach((h) => { if (hospitals[h].seen < cutoff) delete hospitals[h]; });
    hospitals[name] = { regions: regions, email: email, seen: Date.now() };
    props.setProperty(HOSPITALS_KEY, JSON.stringify(hospitals));
    return { email: email };
  } finally {
    lock.releaseLock();
  }
}

function respond(code, id, hospital, status, note) {
  checkCode_(code);
  hospital = clean_(hospital, 40);
  if (!hospital) throw new Error('병원명을 입력하세요.');
  if (CONFIG.STATUSES.indexOf(status) < 0) throw new Error('잘못된 응답입니다.');
  return mutate_((state, changed) => {
    const req = state[id];
    if (!req) throw new Error('이미 종료되었거나 삭제된 요청입니다.');
    if (req.status !== 'open') throw new Error('이미 종료된 요청입니다.');
    req.responses[hospital] = { status: status, note: clean_(note, 100), at: Date.now() };
    changed.push(id);
    return true;
  });
}

/** chosen: 이송할 병원명. 빈 값이면 요청 취소. */
function closeRequest(code, id, chosen) {
  checkCode_(code);
  chosen = clean_(chosen, 40);
  mutate_((state, changed) => {
    const req = state[id];
    if (!req) return;
    req.status = 'done';
    req.chosen = chosen;
    req.doneAt = Date.now();
    changed.push(id);
  });
  if (chosen) {
    const h = hospitals_()[chosen];
    if (h && h.email) sendMails_([mail_(h.email, `🚑 [이송 결정] 요청 ${id} — 귀 병원으로 이송됩니다`, '환자가 귀 병원으로 이송됩니다.')]);
  }
  return true;
}

/* ---------- 알림 메일 (Gmail) ---------- */

/** 1회만 편집기에서 실행: 메일 발송 권한 승인 + 1분마다 재알림 트리거 설치 */
function setup() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'remind')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('remind').timeBased().everyMinutes(1).create();
  Logger.log('설정 완료: 오늘 남은 메일 발송량 %s통. 응답 전까지 %s분마다 최대 %s회 알립니다.',
    MailApp.getRemainingDailyQuota(), CONFIG.REMIND_EVERY_MIN, CONFIG.MAX_PUSHES);
}

/** 트리거가 1분마다 실행: 아직 수용 가능/불가로 답하지 않은 병원에 다시 알림 */
function remind() {
  const state = load_();
  const open = Object.keys(state).map((id) => state[id]).filter((r) => r.status === 'open');
  if (open.length) pushPending_(open);
}

function pushPending_(reqs) {
  const hospitals = hospitals_();
  const names = Object.keys(hospitals).filter((n) => hospitals[n].email);
  if (!names.length) return;
  const cache = CacheService.getScriptCache();
  const log = JSON.parse(cache.get(PUSHLOG_KEY) || '{}');
  const now = Date.now();
  const out = [];
  reqs.forEach((r) => {
    names.forEach((name) => {
      const h = hospitals[name];
      if (h.regions.length && h.regions.indexOf(r.region) < 0) return;
      const resp = r.responses[name];
      if (resp && !(resp.status === 'call' && now - resp.at > CONFIG.CALL_SNOOZE_MIN * 60000)) return;
      const key = r.id + '|' + name;
      const prev = log[key] || { n: 0, at: 0 };
      if (prev.n >= CONFIG.MAX_PUSHES || now - prev.at < CONFIG.REMIND_EVERY_MIN * 60000 - 10000) return;
      log[key] = { n: prev.n + 1, at: now, first: !prev.n };
      // 환자 상태 문구는 메일에 담지 않는다.
      out.push(Object.assign(mail_(h.email,
        `🚨 [수용 요청] ${r.region} · ${r.type} — 요청 ${r.id}` + (prev.n ? ` (재알림 ${prev.n})` : ''),
        '앱을 열어 수용 가능/불가를 눌러 주세요. 응답할 때까지 다시 알림이 옵니다.'), { key: key }));
    });
  });
  if (!out.length) return;
  // 하루 발송 한도가 얼마 남지 않으면 첫 알림만 보내고 재알림은 건너뛴다.
  const firstOnly = MailApp.getRemainingDailyQuota() - out.length < CONFIG.MAIL_RESERVE;
  const send = firstOnly ? out.filter((m) => log[m.key].first) : out;
  Object.keys(log).forEach((k) => { if (now - log[k].at > CONFIG.REQUEST_TTL_MIN * 60000) delete log[k]; });
  cache.put(PUSHLOG_KEY, JSON.stringify(log), CACHE_SEC);
  sendMails_(send);
}

function mail_(to, subject, text) {
  const url = ScriptApp.getService().getUrl() || '';
  return {
    to: to,
    subject: subject,
    body: text + (url ? '\n\n' + url : ''),
    htmlBody: `<p style="font-size:16px">${text}</p>` +
      (url ? `<p><a href="${url}" style="display:inline-block;padding:12px 20px;background:#c8322b;color:#fff;` +
        `border-radius:8px;text-decoration:none;font-weight:bold">앱 열기</a></p>` : ''),
    name: '환자 수용 요청',
  };
}

function sendMails_(mails) {
  mails.forEach((m) => {
    try {
      MailApp.sendEmail({ to: m.to, subject: m.subject, body: m.body, htmlBody: m.htmlBody, name: m.name });
    } catch (e) {
      // 메일 실패가 요청 등록·응답을 막지 않도록 기록만 남긴다.
      console.error('mail failed: ' + m.to + ' ' + e);
    }
  });
}

function hospitals_() {
  return JSON.parse(PropertiesService.getScriptProperties().getProperty(HOSPITALS_KEY) || '{}');
}

/**
 * view.role === 'police'   → view.ids 에 해당하는 내 요청 + 모든 병원 응답
 * view.role === 'hospital' → 담당 지역의 요청 + 내 병원 응답과 응답 집계만
 */
function listRequests(code, view) {
  checkCode_(code);
  let state = load_();
  if (needsPrune_(state)) state = mutate_((s) => s);

  const items = Object.keys(state).map((id) => state[id]);
  let result;
  if (view.role === 'police') {
    const mine = view.ids || [];
    result = items.filter((r) => mine.indexOf(r.id) >= 0);
  } else {
    const regions = view.regions || [];
    const me = clean_(view.name, 40);
    result = items
      .filter((r) => !regions.length || regions.indexOf(r.region) >= 0)
      .map((r) => {
        const counts = { accept: 0, reject: 0, call: 0 };
        Object.keys(r.responses).forEach((h) => counts[r.responses[h].status]++);
        const copy = Object.assign({}, r, { responses: undefined, counts: counts, mine: r.responses[me] || null });
        // 다른 병원으로 이송이 결정된 경우 병원명은 감춘다.
        if (r.status === 'done') copy.chosenIsMe = !!r.chosen && r.chosen === me;
        delete copy.chosen;
        return copy;
      });
  }
  result.sort((a, b) => b.createdAt - a.createdAt);
  return { now: Date.now(), items: result };
}

/* ---------- 내부 함수 ---------- */

function accessCode_() {
  const cache = CacheService.getScriptCache();
  let code = cache.get(CODE_CACHE_KEY);
  if (code === null) {
    code = PropertiesService.getScriptProperties().getProperty('ACCESS_CODE') || '';
    cache.put(CODE_CACHE_KEY, code, 600);
  }
  return code;
}

function checkCode_(code) {
  const expected = accessCode_();
  if (expected && String(code || '') !== expected) throw new Error('접속 코드가 올바르지 않습니다.');
}

function load_() {
  const json = CacheService.getScriptCache().get(CACHE_KEY);
  if (json) return JSON.parse(json);
  // 캐시가 비었을 때만 보관본에서 다시 읽는다 (읽기 할당량 절약).
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return loadFromProps_();
  } finally {
    lock.releaseLock();
  }
}

function loadFromProps_() {
  const cache = CacheService.getScriptCache();
  const json = cache.get(CACHE_KEY);
  if (json) return JSON.parse(json);
  const props = PropertiesService.getScriptProperties().getProperties();
  const state = {};
  Object.keys(props).forEach((k) => {
    if (k.indexOf(PREFIX) === 0) state[k.slice(PREFIX.length)] = JSON.parse(props[k]);
  });
  putCache_(state);
  return state;
}

function putCache_(state) {
  try {
    CacheService.getScriptCache().put(CACHE_KEY, JSON.stringify(state), CACHE_SEC);
  } catch (e) {
    // 100KB 초과 등으로 실패하면 다음 읽기에서 보관본을 사용한다.
    CacheService.getScriptCache().remove(CACHE_KEY);
  }
}

function mutate_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const state = loadFromProps_();
    const changed = prune_(state);
    const result = fn(state, changed);
    if (changed.length) {
      const props = PropertiesService.getScriptProperties();
      changed.forEach((id) => {
        if (state[id]) props.setProperty(PREFIX + id, JSON.stringify(state[id]));
        else props.deleteProperty(PREFIX + id);
      });
      putCache_(state);
    }
    return result === undefined ? state : result;
  } finally {
    lock.releaseLock();
  }
}

function isExpired_(req, now) {
  if (req.status === 'open') return now - req.createdAt > CONFIG.REQUEST_TTL_MIN * 60000;
  return now - req.doneAt > CONFIG.DONE_KEEP_MIN * 60000;
}

function needsPrune_(state) {
  const now = Date.now();
  return Object.keys(state).some((id) => isExpired_(state[id], now));
}

function prune_(state) {
  const now = Date.now();
  const removed = [];
  Object.keys(state).forEach((id) => {
    if (isExpired_(state[id], now)) {
      delete state[id];
      removed.push(id);
    }
  });
  return removed;
}

function newId_() {
  const t = Utilities.formatDate(new Date(), 'Asia/Seoul', 'HHmm');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 3; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return t + '-' + s;
}

function clean_(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function pick_(v, list) {
  return list.indexOf(v) >= 0 ? v : list[list.length - 1];
}

/** 모든 요청을 즉시 삭제 (편집기에서 수동 실행용) */
function clearAll() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const props = PropertiesService.getScriptProperties();
    Object.keys(props.getProperties()).forEach((k) => {
      if (k.indexOf(PREFIX) === 0) props.deleteProperty(k);
    });
    CacheService.getScriptCache().remove(CACHE_KEY);
  } finally {
    lock.releaseLock();
  }
}
