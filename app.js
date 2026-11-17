'use strict';

// 학생용 Apps Script 웹 앱 주소
const DEFAULT_ENDPOINT =
  'https://script.google.com/macros/s/AKfycbzvgkCylMEZmkDvj0aqk5Zqq0QUO-b_wZwf9pvzOfJU2lv378MmzUnr6TNRXWbIR_SX/exec';

const PREFIX = 'student-timetable.v1.';
const CLASS_NAMES = ['1-1반', '1-2반', '1-3반', '2-1반', '2-2반', '2-3반', '3-1반', '3-2반', '3-3반'];
const $ = (id) => document.getElementById(id);

const store = {
  get(key) {
    try {
      return localStorage.getItem(PREFIX + key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, value);
    } catch {
      $('status').textContent = '기기 저장 공간을 사용할 수 없습니다. 이번 실행에서만 사용할 수 있습니다.';
    }
  },
};

let teacher = store.get('teacher') || '';
const endpoint = DEFAULT_ENDPOINT;
let weekOffset = 0;
let requestVersion = 0;
let installPrompt;
let midnightTimer;

function koreaParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  const n = (type) => Number(parts.find((x) => x.type === type).value);
  return { year: n('year'), month: n('month'), day: n('day') };
}

function weekInfo(offset = 0, now = new Date()) {
  const p = koreaParts(now);
  const today = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const mon = new Date(today);
  mon.setUTCDate(mon.getUTCDate() - ((mon.getUTCDay() + 6) % 7) + offset * 7);
  const fri = new Date(mon);
  fri.setUTCDate(fri.getUTCDate() + 4);
  const fmt = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return {
    sheetName: `${fmt(mon)}~${fmt(fri)}`,
    monday: mon.toISOString().slice(0, 10),
    year: mon.getUTCFullYear(),
    todayIndex: offset === 0 ? (today.getUTCDay() + 6) % 7 : -1,
  };
}

function cacheKey(info) {
  return 'cache.' + JSON.stringify([endpoint, teacher, info.monday]);
}

function readCache(info) {
  try {
    return JSON.parse(store.get(cacheKey(info)));
  } catch {
    return null;
  }
}

function renderMessage(title, body) {
  const box = document.createElement('div');
  box.className = 'notice';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const text = document.createElement('div');
  text.textContent = body;
  box.append(heading, text);
  $('schedule').replaceChildren(box);
}

function renderTable(data, info) {
  const grid = document.createElement('div');
  grid.className = 'table';
  grid.setAttribute('role', 'table');
  grid.setAttribute('aria-label', teacher + ' ' + info.sheetName + ' 시간표');
  const headers = ['교시', '월', '화', '수', '목', '금'];

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 6; c++) {
      const el = document.createElement('div');
      el.className = 'cell';
      el.setAttribute('role', r === 0 ? 'columnheader' : c === 0 ? 'rowheader' : 'cell');

      if (r === 0) {
        el.classList.add('head');
        el.textContent = headers[c];
      } else if (c === 0) {
        el.classList.add('period');
        el.textContent = r + '교시';
      } else {
        const value = data.schedule[r - 1][c - 1];
        el.textContent = value || '—';
        if (!value) el.classList.add('empty-cell');
      }

      if (c > 0 && c - 1 === info.todayIndex) el.classList.add('today');
      grid.append(el);
    }
  }
  $('schedule').replaceChildren(grid);
}

function stamp(value) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

// 방법 1: 로그인 쿠키를 보내지 않는 fetch 요청
async function fetchJson(url, params) {
  const requestUrl = new URL(url);
  Object.entries(params).forEach(([key, value]) => requestUrl.searchParams.set(key, value));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(requestUrl.href, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('서버 응답을 확인해 주세요.');
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// 방법 2: 기존 script 태그 방식 (fetch 실패 시 대비)
function jsonp(url, params) {
  return new Promise((resolve, reject) => {
    const callback = 'timetable_cb_' + Date.now() + '_' + Math.floor(Math.random() * 1e8);
    const script = document.createElement('script');
    let timer;

    const cleanup = () => {
      clearTimeout(timer);
      script.remove();
      delete window[callback];
    };

    window[callback] = (data) => {
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error('연결에 실패했습니다. 배포 주소와 웹 앱 접근 권한을 확인하세요.'));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('응답 시간이 초과되었습니다. 잠시 후 다시 시도하세요.'));
    }, 25000);

    const u = new URL(url);
    Object.entries({ ...params, callback }).forEach(([key, value]) => u.searchParams.set(key, value));
    script.src = u.href;
    document.head.append(script);
  });
}

// fetch를 먼저 시도하고, 연결 단계에서 실패하면 기존 방식으로 다시 시도
async function requestTimetable(params) {
  try {
    return await fetchJson(endpoint, params);
  } catch {
    return await jsonp(endpoint, params);
  }
}

function validEndpoint(value) {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      u.hostname === 'script.google.com' &&
      /^\/(?:macros\/s|a\/macros\/[^/]+\/s)\/[^/]+\/exec$/.test(u.pathname) &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}

async function loadWeek() {
  const id = ++requestVersion;
  const info = weekInfo(weekOffset);
  
  $('weekTitle').textContent = `${info.year} · ${info.sheetName}`;
  $('previous').disabled = weekOffset === 0;
  $('relative').textContent =
    weekOffset === 0 ? '이번 주' : weekOffset === 1 ? '다음 주' : `${weekOffset}주 후`;
  $('status').textContent = '';

  if (!teacher) {
    renderMessage('학급을 선택해 주세요', '한 번 선택하면 이 기기에 저장됩니다.');
    return;
  }
  if (!validEndpoint(endpoint)) {
    renderMessage('시간표 연결 준비 중입니다', '관리자가 app.js의 DEFAULT_ENDPOINT에 웹 앱 주소를 설정해야 합니다.');
    return;
  }

  const cached = readCache(info);
  if (cached) renderTable(cached, info);
  else renderMessage('시간표를 불러오는 중입니다', teacher + ' · ' + info.sheetName);

  if (!navigator.onLine) {
    if (cached) $('status').textContent = '오프라인 · 저장본 갱신 ' + stamp(cached.fetchedAt);
    else renderMessage('오프라인입니다', '이 학급·주간의 저장된 시간표가 없습니다.');
    return;
  }

  $('status').textContent = cached ? '저장본 표시 중 · 최신 시간표 확인 중…' : '원본 시트를 확인하는 중…';

  try {
    const result = await requestTimetable({ className: teacher, sheet: info.sheetName });
    if (id !== requestVersion) return;

    if (!result.ok) {
      if (result.code === 'SHEET_NOT_FOUND') {
        try {
          localStorage.removeItem(PREFIX + cacheKey(info));
        } catch {}
        renderMessage('해당 주 시간표가 없습니다', info.sheetName + ' 시트가 아직 등록되지 않았습니다.');
        $('status').textContent = '다른 주로 이동할 수 있습니다.';
        return;
      }
      throw new Error(result.message || '데이터를 읽지 못했습니다.');
    }

    if (
      !Array.isArray(result.schedule) ||
      result.schedule.length !== 7 ||
      result.schedule.some((row) => !Array.isArray(row) || row.length !== 5)
    ) {
      throw new Error('응답 데이터 형식을 확인해 주세요.');
    }

    result.fetchedAt = new Date().toISOString();
    store.set(cacheKey(info), JSON.stringify(result));
    renderTable(result, info);
    $('status').textContent =
      `${teacher} · 갱신 ${stamp(result.fetchedAt)}` +
      (result.matches === 0 ? ' · 일치하는 수업이 없습니다. 학급을 확인하세요.' : '');
  } catch (error) {
    if (id !== requestVersion) return;
    if (cached) {
      $('status').textContent = `최신 조회 실패 · 저장본 ${stamp(cached.fetchedAt)} · ${error.message}`;
    } else {
      renderMessage('시간표를 불러오지 못했습니다', error.message);
      $('status').textContent = '인터넷 상태를 확인한 후 새로고침하세요. 문제가 계속되면 관리자에게 문의하세요.';
    }
  }
}

// 이번 주보다 과거로는 이동하지 않음
function move(delta) {
  const next = Math.max(0, weekOffset + delta);
  if (next !== weekOffset) {
    weekOffset = next;
    loadWeek();
  }
}

if (!CLASS_NAMES.includes(teacher)) teacher = '';
$('teacher').value = teacher;

$('teacher').addEventListener('change', () => {
  teacher = $('teacher').value;
  store.set('teacher', teacher);
  loadWeek();
});

$('teacherForm').addEventListener('submit', (event) => {
  event.preventDefault();
  teacher = $('teacher').value.trim();
  store.set('teacher', teacher);
  loadWeek();
});

// 주간 이동 버튼이 없어도 오류가 나지 않도록 처리
const previousButton = $('previous');
const nextButton = $('next');
const thisWeekButton = $('thisWeek');
if (previousButton) previousButton.onclick = () => move(-1);
if (nextButton) nextButton.onclick = () => move(1);
if (thisWeekButton) {
  thisWeekButton.onclick = () => {
    weekOffset = 0;
    loadWeek();
  };
}

$('refresh').onclick = async () => {
  const button = $('refresh');
  button.disabled = true;
  try {
    await loadWeek();
  } finally {
    button.disabled = false;
  }
};

// 주간 시간표 좌우 스와이프 (왼쪽으로 밀면 다음 주, 오른쪽으로 밀면 이전 주)
let start;
$('surface').addEventListener('pointerdown', (e) => {
  if (e.isPrimary && e.button === 0) {
    start = { x: e.clientX, y: e.clientY, time: Date.now(), id: e.pointerId };
  }
});
$('surface').addEventListener('pointercancel', () => {
  start = null;
});
$('surface').addEventListener('pointerup', (e) => {
  if (!start || e.pointerId !== start.id) return;
  const dx = e.clientX - start.x;
  const dy = e.clientY - start.y;
  const elapsed = Date.now() - start.time;
  start = null;
  if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.6 && elapsed < 1200) {
    move(dx < 0 ? 1 : -1);
  }
});

window.addEventListener('online', loadWeek);
window.addEventListener('offline', loadWeek);

function armDateRefresh() {
  clearTimeout(midnightTimer);
  const now = new Date();
  const p = koreaParts(now);
  const next = Date.UTC(p.year, p.month - 1, p.day + 1) - 9 * 3600000;
  midnightTimer = setTimeout(() => {
    loadWeek();
    armDateRefresh();
  }, Math.max(1000, next - now.getTime() + 1000));
}

let lastDay = JSON.stringify(koreaParts());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const day = JSON.stringify(koreaParts());
    if (day !== lastDay) {
      lastDay = day;
      loadWeek();
    }
    armDateRefresh();
  }
});

// iPhone / iPad에서는 Safari의 수동 설치 방법을 안내합니다.
const installButton = $('install');
const isAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standaloneMedia = window.matchMedia('(display-mode: standalone)');
const isStandalone = () => standaloneMedia.matches || navigator.standalone === true;

function updateInstallButton() {
  if (!installButton) return;
  const installed = isStandalone();
  installButton.hidden = installed;
  installButton.style.display = installed ? 'none' : 'block';
  installButton.disabled = installed || (!isAppleMobile && !installPrompt);
  installButton.textContent = isAppleMobile ? '아이폰·아이패드 설치 안내' : '앱 설치';
  installButton.title = isAppleMobile
    ? '홈 화면에 추가하는 방법을 확인합니다.'
    : installPrompt ? '시간표 앱을 설치합니다.' : '이 브라우저에서 설치가 준비되면 활성화됩니다.';
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  updateInstallButton();
});

if (installButton) {
  installButton.onclick = async () => {
    if (isAppleMobile) {
      window.alert(
        '여강고 학급 시간표 설치 안내\n\n' +
        '1. Safari에서 이 시간표 주소를 여세요.\n' +
        '2. 공유 버튼(네모 위로 화살표)을 누르세요.\n' +
        '   공유 버튼이 보이지 않으면 메뉴(…)에서 찾아보세요.\n' +
        '3. “홈 화면에 추가”를 선택하세요.\n' +
        '   항목이 보이지 않으면 공유 메뉴를 아래로 내려보세요.\n' +
        '4. “웹 앱으로 열기”가 보이면 켜고 “추가”를 누르세요.\n\n' +
        '이 버튼은 자동 설치 대신 설치 방법을 안내합니다.\n'
      );
      return;
    }
    if (!installPrompt) return;
    const prompt = installPrompt;
    installPrompt = null;
    updateInstallButton();
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch (error) {
      console.warn('설치 창을 열지 못했습니다.', error);
    }
  };
}
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  if (installButton) {
    installButton.hidden = true;
    installButton.style.display = 'none';
  }
});
if (standaloneMedia.addEventListener) {
  standaloneMedia.addEventListener('change', updateInstallButton);
}
window.addEventListener('pageshow', updateInstallButton);
updateInstallButton();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    $('status').textContent += ' · 오프라인 파일 등록 실패';
  });
}

loadWeek();
armDateRefresh();

// === 오늘의 중식 연동 (NEIS API + 일간표 연동 & 중식 박스 단독 스와이프) ===
const lunchController = (() => {
  const NEIS_KEY = 'd5af74fa74044241a8cf5f076434d1b4';
  const ATPT_CODE = 'J10';       // 경기도교육청
  const SCHUL_CODE = '7530586';  // 여강고등학교
  const box = document.getElementById('lunchBox');
  const dailySection = document.getElementById('dailySection');
  const dailyStatus = document.getElementById('dailyStatus');
  const weeklySurface = document.getElementById('surface');
  let lunchReqId = 0;
  let standaloneOffset = 0;

  // 수업일(평일) 기준 날짜 계산
  function schoolDate(step = 0) {
    const p = koreaParts();
    const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
    while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
    for (let i = 0; i < step; i++) {
      date.setUTCDate(date.getUTCDate() + 1);
      while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
    }
    return date;
  }

  // 학년(일간표 표시 여부)에 따라 중식 컨테이너 위치 자동 이동
  function syncPosition() {
    if (!box) return;
    if (dailySection && !dailySection.hidden && dailyStatus) {
      dailySection.insertBefore(box, dailyStatus);
    } else if (weeklySurface) {
      weeklySurface.insertAdjacentElement('afterend', box);
    }
  }

  if (dailySection) {
    const observer = new MutationObserver(syncPosition);
    observer.observe(dailySection, { attributes: true, attributeFilter: ['hidden'] });
  }
  syncPosition();

  // 지정한 날짜(UTC Date 또는 오늘 기준)의 중식 로드
  function loadForDate(targetDate) {
    if (!box) return;
    const reqId = ++lunchReqId;

    let dateObj = targetDate;
    if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) {
      standaloneOffset = 0;
      dateObj = schoolDate(0);
    }

    const year = dateObj.getUTCFullYear();
    const month = dateObj.getUTCMonth() + 1;
    const day = dateObj.getUTCDate();
    const dow = ['일', '월', '화', '수', '목', '금', '토'][dateObj.getUTCDay()];

    const ymd = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
    const label = `${month}/${day}(${dow})`;
    const cacheKey = `stdyg_lunch_${ymd}`;

    function render(menuText) {
      if (reqId !== lunchReqId) return;
      if (!menuText) {
        box.innerHTML = `<strong>🍱 ${label} 중식</strong> 식단 정보가 없습니다.`;
      } else {
        box.innerHTML = `<strong>🍱 ${label} 중식</strong> ${menuText}`;
      }
      box.hidden = false;
      syncPosition();
    }

    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        render(cached);
        return;
      }
    } catch {}

    const url = `https://open.neis.go.kr/hub/mealServiceDietInfo?KEY=${NEIS_KEY}&Type=json&ATPT_OFCDC_SC_CODE=${ATPT_CODE}&SD_SCHUL_CODE=${SCHUL_CODE}&MMEAL_SC_CODE=2&MLSV_YMD=${ymd}`;

    fetch(url)
      .then(res => res.json())
      .then(data => {
        if (reqId !== lunchReqId) return;
        const rows = data?.mealServiceDietInfo?.[1]?.row;
        if (!rows || !rows.length) {
          render('');
          return;
        }
        const cleanMenu = rows[0].DDISH_NM
          .replace(/<br\s*\/?>/gi, ', ')
          .replace(/\([0-9.]+\)/g, '')
          .replace(/\s+/g, ' ')
          .replace(/\s+,/g, ',')
          .trim();

        render(cleanMenu);
        try {
          localStorage.setItem(cacheKey, cleanMenu);
        } catch {}
      })
      .catch(() => {
        if (reqId === lunchReqId) render('');
      });
  }

  // 중식 박스 좌우 스와이프 (1학년 단독 이동: 왼쪽으로 밀면 다음 날, 오른쪽으로 밀면 이전 날)
  if (box) {
    box.style.touchAction = 'pan-y';
    box.style.userSelect = 'none';
    box.style.webkitUserSelect = 'none';
    box.style.cursor = 'grab';

    let swipeStart = null;

    function handleStep(delta) {
      if (dailySection && !dailySection.hidden) return;
      const nextOffset = Math.max(0, standaloneOffset + delta);
      if (nextOffset !== standaloneOffset) {
        standaloneOffset = nextOffset;
        loadForDate(schoolDate(standaloneOffset));
      }
    }

    box.addEventListener('pointerdown', (e) => {
      if (e.isPrimary && e.button === 0) {
        swipeStart = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
      }
    });
    box.addEventListener('pointerup', (e) => {
      if (!swipeStart || swipeStart.id !== e.pointerId) return;
      const dx = e.clientX - swipeStart.x;
      const dy = e.clientY - swipeStart.y;
      const elapsed = Date.now() - swipeStart.t;
      swipeStart = null;

      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.2 && elapsed < 1500) {
        handleStep(dx < 0 ? 1 : -1);
      }
    });
    box.addEventListener('pointercancel', () => { swipeStart = null; });
  }

  // 초기 실행: 오늘(또는 주말이면 다음 월요일) 중식 로드
  loadForDate();

  return { loadForDate, syncPosition };
})();

// 추가: 2·3학년 1일 일간 시간표 (선택그룹 + 1반·2반·3반 + 교과실). 주간표와 독립적으로 이동합니다.
(() => {
  const section = document.getElementById('dailySection');
  const dailyTabs = document.getElementById('dailyTabs');
  const title = document.getElementById('dailyTitle');
  const body = document.getElementById('dailySchedule');
  const status = document.getElementById('dailyStatus');
  const tabs = [...document.querySelectorAll('[data-daily-offset]')];
  let offset = 0, version = 0, lastDate = '';

  function dateInfo(step) {
    const p = koreaParts();
    const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
    while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
    for (let i = 0; i < step; i++) {
      date.setUTCDate(date.getUTCDate() + 1);
      while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
    }
    const day = date.getUTCDay(), mon = new Date(date);
    mon.setUTCDate(date.getUTCDate() - (day + 6) % 7);
    const fri = new Date(mon);
    fri.setUTCDate(mon.getUTCDate() + 4);
    const fmt = d => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    return {
      date,
      day,
      sheet: `${fmt(mon)}~${fmt(fri)}`,
      label: `${fmt(date)}(${['일', '월', '화', '수', '목', '금', '토'][day]})`
    };
  }

  function render(info, headers, record, note) {
    const grid = document.createElement('div');
    grid.className = 'daily-single-table';
    grid.setAttribute('role', 'table');
    grid.setAttribute('aria-label', title.textContent);

    function cell(text, cls = '', span = 1, role = 'cell') {
      const el = document.createElement('div');
      el.className = 'cell ' + cls;
      el.textContent = text;
      el.setAttribute('role', role);
      if (span > 1) el.style.gridColumn = `span ${span}`;
      grid.append(el);
    }

    // 1행: 날짜 제목 (6열 전체 병합)
    cell(info.label + (note ? ' · ' + note : ''), 'head date-cell', 6, 'columnheader');

    // 2행: 교시 | 선택그룹 | 2-1반 | 2-2반 | 2-3반 | 교과실
    cell('교시', 'head', 1, 'columnheader');
    headers.forEach((h, idx) => cell(h, 'head' + (idx === 0 ? ' group-cell' : ''), 1, 'columnheader'));

    // 3~9행: 1교시 ~ 7교시
    for (let r = 0; r < 7; r++) {
      cell(`${r + 1}교시`, 'period', 1, 'rowheader');
      headers.forEach((_, idx) => {
        const val = record ? record.schedules[idx][r][info.day - 1] : '';
        cell(val || '—', (idx === 0 ? 'group-cell ' : '') + (!val ? 'empty-cell' : ''));
      });
    }
    body.replaceChildren(grid);
  }

  async function loadDaily() {
    const token = ++version, selected = document.getElementById('teacher').value;
    const grade = /^[23]-[123]반$/.test(selected) ? selected[0] : '';
    section.hidden = !grade;
    if (dailyTabs) dailyTabs.hidden = !grade;
    if (!grade) {
      lunchController.syncPosition();
      lunchController.loadForDate();
      return;
    }

    const info = dateInfo(offset);
    lunchController.syncPosition();
    lunchController.loadForDate(info.date);

    // 22/28(선택), 23~25/29~31(1~3반), 26/32(교과실) 조회
    const queryTargets = [`${grade}-선택`, `${grade}-1반`, `${grade}-2반`, `${grade}-3반`, `${grade}-추가`];
    const displayHeaders = ['선택그룹', `${grade}-1반`, `${grade}-2반`, `${grade}-3반`, '교과실'];

    title.textContent = `${grade}학년 · ${info.label} 시간표`;
    tabs.forEach(tab => {
      const isToday = Number(tab.dataset.dailyOffset) === 0;
      const active = isToday && offset === 0;
      tab.classList.toggle('primary', active);
      if (isToday) tab.setAttribute('aria-pressed', String(active));
      else tab.removeAttribute('aria-pressed');
    });

    const sheet = info.sheet;
    const key = 'daily-single-v2.' + JSON.stringify([endpoint, grade, sheet]);
    let record = null;
    try {
      const saved = JSON.parse(store.get(key));
      if (saved && Array.isArray(saved.schedules) && saved.schedules.length === 5) record = saved;
    } catch {}

    render(info, displayHeaders, record, !record ? (navigator.onLine ? '조회 중…' : '저장본 없음') : '');

    if (!navigator.onLine) {
      status.textContent = '오프라인 · 저장된 주간 자료만 표시합니다.';
      return;
    }

    status.textContent = '최신 시간표 확인 중…';
    try {
      const values = await Promise.all(queryTargets.map(className => requestTimetable({ className, sheet })));
      if (token !== version) return;

      if (values.some(v => !v.ok && v.code === 'SHEET_NOT_FOUND')) {
        try { localStorage.removeItem(PREFIX + key); } catch {}
        render(info, displayHeaders, null, '해당 주 시간표 없음');
        status.textContent = `${sheet} 시트 미등록`;
        return;
      }

      values.forEach(v => {
        if (!v.ok) throw new Error(v.message || '조회 실패');
        if (!Array.isArray(v.schedule) || v.schedule.length !== 7 || v.schedule.some(row => !Array.isArray(row) || row.length !== 5)) {
          throw new Error('응답 형식 오류');
        }
      });

      record = { schedules: values.map(v => v.schedule), fetchedAt: new Date().toISOString() };
      store.set(key, JSON.stringify(record));
      render(info, displayHeaders, record, '');
      status.textContent = `갱신 ${stamp(record.fetchedAt)} \u2003 ← 다음 날 · 이전 날 →`;
    } catch (error) {
      if (token !== version) return;
      render(info, displayHeaders, record, record ? '저장본' : '조회 실패');
      status.textContent = `${sheet}: ${error.message}`;
    }
  }

  function choose(value) {
    const next = Math.max(0, value);
    if (next !== offset) {
      offset = next;
      loadDaily();
    }
  }

  tabs.forEach(tab => tab.addEventListener('click', () => {
    if (Number(tab.dataset.dailyOffset) === 0) choose(0);
    else choose(offset + 1);
  }));

  // 2·3학년 일간 시간표 좌우 스와이프 (왼쪽으로 밀면 다음 날, 오른쪽으로 밀면 이전 날)
  let start;
  const surface = document.getElementById('dailySurface');
  surface.addEventListener('pointerdown', e => {
    if (e.isPrimary && e.button === 0) start = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
  });
  surface.addEventListener('pointercancel', () => { start = null; });
  surface.addEventListener('pointerup', e => {
    if (!start || start.id !== e.pointerId) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y, elapsed = Date.now() - start.t;
    start = null;
    if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.6 && elapsed < 1200) choose(offset + (dx < 0 ? 1 : -1));
  });

  document.getElementById('teacher').addEventListener('change', () => { offset = 0; loadDaily(); });
  document.getElementById('teacherForm').addEventListener('submit', loadDaily);
  document.getElementById('refresh').addEventListener('click', loadDaily);
  window.addEventListener('online', loadDaily);
  window.addEventListener('offline', loadDaily);

  function checkDate() {
    const d = JSON.stringify(koreaParts());
    if (d !== lastDate) {
      lastDate = d;
      offset = 0;
      loadDaily();
    }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkDate(); });
  setInterval(checkDate, 60000);
  lastDate = JSON.stringify(koreaParts());
  loadDaily();
})();
