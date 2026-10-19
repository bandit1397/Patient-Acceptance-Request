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
};

const CACHE_KEY = 'state_v1';
const CODE_CACHE_KEY = 'access_code_v1';
const PREFIX = 'req_';
const CACHE_SEC = 21600; // CacheService 최대 보관 시간(6시간)

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
  return mutate_((state, changed) => {
    state[req.id] = req;
    changed.push(req.id);
    return req;
  });
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
  return mutate_((state, changed) => {
    const req = state[id];
    if (!req) return true;
    req.status = 'done';
    req.chosen = clean_(chosen, 40);
    req.doneAt = Date.now();
    changed.push(id);
    return true;
  });
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
