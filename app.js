'use strict';
const DEFAULT_ENDPOINT = 'https://script.google.com/macros/s/AKfycbynCSzhbbBGJprBo73ssyEUWw_hmurxSm1aaC0vs_DkgmsTHCYsOYeStmZJVenlnsqT/exec';
const STUDENT_ENDPOINT = 'https://script.google.com/macros/s/AKfycbzvgkCylMEZmkDvj0aqk5Zqq0QUO-b_wZwf9pvzOfJU2lv378MmzUnr6TNRXWbIR_SX/exec';
const PREFIX = 'teacher-timetable.v1.';
const APP_VERSION = 'teacher-mobile-request-v2';
const $ = id => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(PREFIX + k); } catch { return null; } },
  set(k,v) { try { localStorage.setItem(PREFIX+k,v); } catch { console.warn('저장 공간을 사용할 수 없습니다.'); } }
};
let teacher = store.get('teacher') || '';
const endpoint = DEFAULT_ENDPOINT;
let weekOffset=0, requestVersion=0, installPrompt=null, midnightTimer;

function koreaParts(now=new Date()) {
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Seoul',year:'numeric',month:'numeric',day:'numeric'}).formatToParts(now);
  const n=t=>Number(parts.find(x=>x.type===t).value);
  return {year:n('year'),month:n('month'),day:n('day')};
}

function weekInfo(offset=0,now=new Date()) {
  const p=koreaParts(now),today=new Date(Date.UTC(p.year,p.month-1,p.day));
  const mon=new Date(today);mon.setUTCDate(mon.getUTCDate()-(mon.getUTCDay()+6)%7+offset*7);
  const fri=new Date(mon);fri.setUTCDate(fri.getUTCDate()+4);
  const fmt=d=>`${d.getUTCMonth()+1}/${d.getUTCDate()}`;
  return {sheetName:`${fmt(mon)}~${fmt(fri)}`,monday:mon.toISOString().slice(0,10),year:mon.getUTCFullYear(),todayIndex:offset===0?(today.getUTCDay()+6)%7:-1};
}

function cacheKey(info){return 'cache.'+JSON.stringify([endpoint,teacher,info.monday]);}
function validSchedule(d){return d && Array.isArray(d.schedule) && d.schedule.length===7 && d.schedule.every(r=>Array.isArray(r)&&r.length===5);}
function readCache(info){try{const d=JSON.parse(store.get(cacheKey(info)));return validSchedule(d)?d:null;}catch{return null;}}
function renderMessage(title,body){const box=document.createElement('div');box.className='notice';const h=document.createElement('strong'),p=document.createElement('div');h.textContent=title;p.textContent=body;box.append(h,p);$('schedule').replaceChildren(box);}

function renderTable(data,info){
  const grid=document.createElement('div');grid.className='table';grid.setAttribute('role','table');grid.setAttribute('aria-label',teacher+' '+info.sheetName+' 시간표');
  const headers=['교시','월','화','수','목','금'];
  for(let r=0;r<8;r++)for(let c=0;c<6;c++){
    const el=document.createElement('div');el.className='cell';el.setAttribute('role',r===0?'columnheader':c===0?'rowheader':'cell');
    if(r===0){el.classList.add('head');el.textContent=headers[c];}
    else if(c===0){el.classList.add('period');el.textContent=r;}
    else {const value=data.schedule[r-1][c-1];el.textContent=value||'—';if(!value)el.classList.add('empty-cell');}
    if(c>0&&c-1===info.todayIndex)el.classList.add('today');grid.append(el);
  }
  $('schedule').replaceChildren(grid);
}

function stamp(value){const d=new Date(value);return Number.isNaN(d.getTime())?'시각 미상':new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(d);}
function requestUrl(baseUrl,params){const u=new URL(baseUrl);Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,v));u.searchParams.set('_ts',String(Date.now()));return u;}

async function fetchJson(params, baseUrl=endpoint){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  try {
    const response=await fetch(requestUrl(baseUrl,params).href,{method:'GET',credentials:'omit',redirect:'follow',cache:'no-store',signal:controller.signal});
    if(!response.ok)throw new Error('HTTP '+response.status);
    return await response.json();
  }finally{clearTimeout(timer);}
}

function jsonp(params, baseUrl=endpoint){return new Promise((resolve,reject)=>{
  const callback='timetable_cb_'+Date.now()+'_'+Math.floor(Math.random()*1e8);
  const script=document.createElement('script');let timer;
  const cleanup=()=>{clearTimeout(timer);script.remove();window[callback]=()=>{};setTimeout(()=>{delete window[callback];},60000);};
  window[callback]=data=>{cleanup();resolve(data);};
  script.onerror=()=>{cleanup();reject(new Error('JSONP 연결 실패'));};
  timer=setTimeout(()=>{cleanup();reject(new Error('JSONP 응답 시간 초과'));},25000);
  script.referrerPolicy='no-referrer';
  script.src=requestUrl(baseUrl,{...params,callback}).href;document.head.append(script);
});}

async function requestTimetable(params, baseUrl=endpoint){
  try{return {data:await fetchJson(params,baseUrl),method:'fetch'};}
  catch(fetchError){
    console.warn('fetch 실패, JSONP 재시도',fetchError);
    try{return {data:await jsonp(params,baseUrl),method:'JSONP'};}
    catch(jsonpError){throw new Error('연결에 실패했습니다. API 직접 접속과 인터넷 상태를 확인하세요. ('+APP_VERSION+' · fetch/JSONP 실패)');}
  }
}

function validEndpoint(value){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='script.google.com'&&/^\/(?:macros\/s|a\/macros\/[^/]+\/s)\/[^/]+\/exec$/.test(u.pathname)&&!u.search&&!u.hash;}catch{return false;}}

async function loadWeek(){
  const id=++requestVersion,info=weekInfo(weekOffset);
  $('weekTitle').textContent=`${info.year} · ${info.sheetName}`;
  $('relative').textContent=weekOffset===0?'이번 주':weekOffset===-1?'지난주':weekOffset===1?'다음 주':`${Math.abs(weekOffset)}주 ${weekOffset<0?'전':'후'}`;
  $('status').textContent='';
  if(!teacher){renderMessage('교사명을 입력해 주세요','한 번 입력하면 이 기기에 저장됩니다.');return;}
  if(!validEndpoint(endpoint)){renderMessage('시간표 연결 준비 중입니다','app.js의 DEFAULT_ENDPOINT를 확인하세요.');return;}
  const cached=readCache(info);
  if(cached)renderTable(cached,info);else renderMessage('시간표를 불러오는 중입니다',teacher+' 선생님 · '+info.sheetName);
  if(!navigator.onLine){if(cached)$('status').textContent='오프라인 · 저장본 '+stamp(cached.fetchedAt);else renderMessage('오프라인입니다','이 교사·주간의 저장된 시간표가 없습니다.');return;}
  $('status').textContent=cached?'저장본 표시 중 · 최신 시간표 확인 중…':'원본 시트를 확인하는 중…';
  try{
    const response=await requestTimetable({teacher,sheet:info.sheetName});if(id!==requestVersion)return;
    const result=response.data;
    if(!result||!result.ok){
      if(result&&result.code==='SHEET_NOT_FOUND'){
        try{localStorage.removeItem(PREFIX+cacheKey(info));}catch{}
        renderMessage('해당 주 시간표가 없습니다',info.sheetName+' 시트가 아직 등록되지 않았습니다.');$('status').textContent='다른 주로 이동할 수 있습니다.';return;
      }
      throw new Error(result&&result.message||'서버 응답을 확인해 주세요.');
    }
    if(!validSchedule(result))throw new Error('응답 데이터 형식을 확인해 주세요.');
    result.fetchedAt=new Date().toISOString();store.set(cacheKey(info),JSON.stringify(result));renderTable(result,info);
    $('status').textContent = `${teacher} 선생님 · 갱신 ${stamp(result.fetchedAt)} \u2003 ← 다음 주 · 이전 주 →` + (result.matches === 0 ? ' · 일치하는 수업이 없습니다.' : '');
  }catch(error){
    if(id!==requestVersion)return;
    if(cached)$('status').textContent=`최신 조회 실패 · 저장본 ${stamp(cached.fetchedAt)} · ${error.message}`;
    else{renderMessage('시간표를 불러오지 못했습니다',error.message);$('status').textContent='인터넷 상태를 확인한 후 새로고침하세요.';}
  }
}

function move(delta){weekOffset+=delta;loadWeek();}
$('teacher').value=teacher;
$('teacherForm').addEventListener('submit',event=>{event.preventDefault();teacher=$('teacher').value.trim();store.set('teacher',teacher);loadWeek();});
if($('previous'))$('previous').onclick=()=>move(-1);
if($('next'))$('next').onclick=()=>move(1);
if($('thisWeek'))$('thisWeek').onclick=()=>{weekOffset=0;loadWeek();};
$('refresh').onclick=()=>loadWeek();

// 교사 주간 시간표 좌우 스와이프 (왼쪽으로 밀면 다음 주, 오른쪽으로 밀면 이전 주)
let start;
$('surface').addEventListener('pointerdown',e=>{if(e.isPrimary&&e.button===0)start={x:e.clientX,y:e.clientY,time:Date.now(),id:e.pointerId};});
$('surface').addEventListener('pointercancel',()=>{start=null;});
$('surface').addEventListener('pointerup',e=>{if(!start||e.pointerId!==start.id)return;const dx=e.clientX-start.x,dy=e.clientY-start.y,elapsed=Date.now()-start.time;start=null;if(Math.abs(dx)>65&&Math.abs(dx)>Math.abs(dy)*1.6&&elapsed<1200)move(dx<0?1:-1);});

window.addEventListener('online',loadWeek);window.addEventListener('offline',loadWeek);
function armDateRefresh(){clearTimeout(midnightTimer);const now=new Date(),p=koreaParts(now),next=Date.UTC(p.year,p.month-1,p.day+1)-9*3600000;midnightTimer=setTimeout(()=>{loadWeek();armDateRefresh();},Math.max(1000,next-now.getTime()+1000));}
let lastDay=JSON.stringify(koreaParts());
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){const day=JSON.stringify(koreaParts());if(day!==lastDay){lastDay=day;loadWeek();}armDateRefresh();}});

const installButton=$('install');
const isAppleMobile=/iPhone|iPad|iPod/i.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const standaloneMedia=window.matchMedia('(display-mode: standalone)');
const isStandalone=()=>standaloneMedia.matches||navigator.standalone===true;
function updateInstallButton(){if(!installButton)return;const installed=isStandalone();installButton.hidden=installed;installButton.style.display=installed?'none':'block';installButton.disabled=installed||(!isAppleMobile&&!installPrompt);installButton.textContent=isAppleMobile?'아이폰·아이패드 설치 안내':'앱 설치';}
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;updateInstallButton();});
if(installButton)installButton.onclick=async()=>{
  if(isAppleMobile){window.alert('여강고 선생님 시간표 설치 안내\n\n1. Safari에서 이 시간표 주소를 여세요.\n2. 공유 버튼(네모 위로 화살표)을 누르세요. 메뉴(…) 안에 있을 수도 있습니다.\n3. “홈 화면에 추가”를 선택하세요.\n4. “웹 앱으로 열기”가 보이면 켜고 “추가”를 누르세요.\n\n학생용과 교사용은 각각의 주소에서 따로 추가하세요.');return;}
  if(!installPrompt)return;const prompt=installPrompt;installPrompt=null;updateInstallButton();try{await prompt.prompt();await prompt.userChoice;}catch(error){console.warn(error);}
};
window.addEventListener('appinstalled',()=>{installPrompt=null;if(installButton){installButton.hidden=true;installButton.style.display='none';}});
if(standaloneMedia.addEventListener)standaloneMedia.addEventListener('change',updateInstallButton);
window.addEventListener('pageshow',updateInstallButton);updateInstallButton();
if('serviceWorker' in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./sw.js').catch(()=>{$('status').textContent+=' · 오프라인 파일 등록 실패';});
loadWeek();armDateRefresh();

// === 전체 학급 일간 시간표(행: 1-1~3-3, 열: 1~7교시) + 중식 날짜 동기화 ===
(function initAllClassAndLunch() {
  const NEIS_KEY = 'd5af74fa74044241a8cf5f076434d1b4';
  const ATPT_CODE = 'J10';
  const SCHUL_CODE = '7530586';
  const ALL_CLASSES = ['1-1반', '1-2반', '1-3반', '2-1반', '2-2반', '2-3반', '3-1반', '3-2반', '3-3반'];
  const SHORT_CLASSES = ['1-1', '1-2', '1-3', '2-1', '2-2', '2-3', '3-1', '3-2', '3-3'];

  const scheduleEl = document.getElementById('allClassSchedule');
  const surfaceEl = document.getElementById('allClassSurface');
  const statusEl = document.getElementById('allClassStatus');
  const titleEl = document.getElementById('allClassTitle');
  const todayBtn = document.getElementById('allTodayBtn');
  const nextBtn = document.getElementById('allNextBtn');
  const lunchBox = document.getElementById('lunchBox');

  if (!scheduleEl || !surfaceEl) return;

  let dayOffset = 0;
  let allReqId = 0;
  let lunchReqId = 0;
  let lastCheckedDay = JSON.stringify(koreaParts());

  // 수업일(평일) 기준 날짜 계산
  function schoolDateInfo(step = 0) {
    const p = koreaParts();
    const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
    while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
    for (let i = 0; i < step; i++) {
      date.setUTCDate(date.getUTCDate() + 1);
      while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
    }
    const day = date.getUTCDay();
    const mon = new Date(date);
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

  // 해당 날짜 중식 로드
  function loadLunchForDate(dateObj) {
    if (!lunchBox) return;
    const reqId = ++lunchReqId;
    const year = dateObj.getUTCFullYear();
    const month = dateObj.getUTCMonth() + 1;
    const day = dateObj.getUTCDate();
    const dow = ['일', '월', '화', '수', '목', '금', '토'][dateObj.getUTCDay()];
    const ymd = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
    const label = `${month}/${day}(${dow})`;
    const cacheKey = `ygtable_lunch_${ymd}`;

    function renderLunch(menuText) {
      if (reqId !== lunchReqId) return;
      if (!menuText) {
        lunchBox.innerHTML = `<strong>🍱 ${label} 중식</strong> 식단 정보가 없습니다.`;
      } else {
        lunchBox.innerHTML = `<strong>🍱 ${label} 중식</strong> ${menuText}`;
      }
      lunchBox.hidden = false;
    }

    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        renderLunch(cached);
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
          renderLunch('');
          return;
        }
        const cleanMenu = rows[0].DDISH_NM
          .replace(/<br\s*\/?>/gi, ', ')
          .replace(/\([0-9.]+\)/g, '')
          .replace(/\s+/g, ' ')
          .replace(/\s+,/g, ',')
          .trim();

        renderLunch(cleanMenu);
        try {
          localStorage.setItem(cacheKey, cleanMenu);
        } catch {}
      })
      .catch(() => {
        if (reqId === lunchReqId) renderLunch('');
      });
  }

  // 전체 학급 일간 테이블 렌더링 (날짜 행 제거, 첫 행이 학급 | 1~7교시 헤더)
  function renderAllClassTable(info, record) {
    const grid = document.createElement('div');
    grid.className = 'all-class-table';
    grid.setAttribute('role', 'table');
    grid.setAttribute('aria-label', `일간 ${info.label} 전체 학급 시간표`);

    function cell(text, cls = '', role = 'cell') {
      const el = document.createElement('div');
      el.className = 'cell ' + cls;
      el.textContent = text;
      el.setAttribute('role', role);
      grid.append(el);
    }

    // 1행(헤더): 학급 | 1 | 2 | 3 | 4 | 5 | 6 | 7
    cell('학급', 'head', 'columnheader');
    for (let p = 1; p <= 7; p++) {
      cell(`${p}교시`, 'head', 'columnheader');
    }

    // 2~10행: 1-1반 ~ 3-3반 (행) × 1~7교시 (열)
    SHORT_CLASSES.forEach((clsName, cIdx) => {
      const divCls = (cIdx === 2 || cIdx === 5) ? ' grade-row-divider' : '';
      cell(clsName, 'period' + divCls, 'rowheader');
      for (let p = 0; p < 7; p++) {
        const val = record ? record.schedules[cIdx][p][info.day - 1] : '';
        cell(val || '—', (!val ? 'empty-cell' : '') + divCls);
      }
    });

    scheduleEl.replaceChildren(grid);
  }

  async function loadAllClass() {
    const token = ++allReqId;
    const info = schoolDateInfo(dayOffset);

    if (titleEl) titleEl.textContent = `${info.label} · 전체 시간표`;
    if (todayBtn) todayBtn.classList.toggle('primary', dayOffset === 0);

    // 날짜 이동 시 중식도 함께 동기화
    loadLunchForDate(info.date);

    const sheet = info.sheet;
    const cacheKey = 'all-class-v1.' + JSON.stringify([STUDENT_ENDPOINT, sheet]);
    let record = null;
    try {
      const saved = JSON.parse(store.get(cacheKey));
      if (saved && Array.isArray(saved.schedules) && saved.schedules.length === 9) {
        record = saved;
      }
    } catch {}

    renderAllClassTable(info, record);

    if (!navigator.onLine) {
      if (statusEl) statusEl.textContent = '오프라인 · 저장된 전체 시간표만 표시합니다.';
      return;
    }

    if (statusEl) statusEl.textContent = !record ? '전체 학급 시간표 불러오는 중…' : '전체 학급 시간표 확인 중…';

    try {
      const responses = await Promise.all(
        ALL_CLASSES.map(className => requestTimetable({ className, sheet }, STUDENT_ENDPOINT))
      );
      if (token !== allReqId) return;

      const values = responses.map(r => r.data);
      if (values.some(v => !v || (!v.ok && v.code === 'SHEET_NOT_FOUND'))) {
        try { localStorage.removeItem(PREFIX + cacheKey); } catch {}
        renderAllClassTable(info, null);
        if (titleEl) titleEl.textContent = `${info.label} · 전체 시간표 (미등록)`;
        if (statusEl) statusEl.textContent = `${sheet} 시트가 아직 등록되지 않았습니다.`;
        return;
      }

      values.forEach(v => {
        if (!v.ok) throw new Error(v.message || '조회 실패');
        if (!validSchedule(v)) throw new Error('응답 형식 오류');
      });

      record = {
        schedules: values.map(v => v.schedule),
        fetchedAt: new Date().toISOString()
      };
      store.set(cacheKey, JSON.stringify(record));
      renderAllClassTable(info, record);
      if (statusEl) statusEl.textContent = `전체 학급 갱신 ${stamp(record.fetchedAt)} \u2003 ← 다음 날 · 이전 날 →`;
    } catch (error) {
      if (token !== allReqId) return;
      renderAllClassTable(info, record);
      if (statusEl) statusEl.textContent = `${sheet}: ${error.message}`;
    }
  }

  function stepDay(delta) {
    const next = Math.max(0, dayOffset + delta);
    if (next !== dayOffset) {
      dayOffset = next;
      loadAllClass();
    }
  }

  if (todayBtn) todayBtn.addEventListener('click', () => { dayOffset = 0; loadAllClass(); });
  if (nextBtn) nextBtn.addEventListener('click', () => stepDay(1));

  // 전체 시간표와 중식 박스 모두에서 스와이프 시 함께 날짜 이동
  function attachSwipe(el) {
    if (!el) return;
    el.style.touchAction = 'pan-y';
    el.style.userSelect = 'none';
    el.style.webkitUserSelect = 'none';

    let swipeStart = null;
    el.addEventListener('pointerdown', e => {
      if (e.isPrimary && e.button === 0) {
        swipeStart = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
      }
    });
    el.addEventListener('pointerup', e => {
      if (!swipeStart || swipeStart.id !== e.pointerId) return;
      const dx = e.clientX - swipeStart.x;
      const dy = e.clientY - swipeStart.y;
      const elapsed = Date.now() - swipeStart.t;
      swipeStart = null;

      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3 && elapsed < 1500) {
        stepDay(dx < 0 ? 1 : -1);
      }
    });
    el.addEventListener('pointercancel', () => { swipeStart = null; });
  }

  attachSwipe(surfaceEl);
  attachSwipe(lunchBox);

  const refreshBtn = document.getElementById('refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', loadAllClass);
  window.addEventListener('online', loadAllClass);
  window.addEventListener('offline', loadAllClass);

  function checkDayChange() {
    const d = JSON.stringify(koreaParts());
    if (d !== lastCheckedDay) {
      lastCheckedDay = d;
      dayOffset = 0;
      loadAllClass();
    }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkDayChange(); });
  setInterval(checkDayChange, 60000);

  loadAllClass();
})();
