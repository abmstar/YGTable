'use strict';
const DEFAULT_ENDPOINT = 'https://script.google.com/macros/s/AKfycbynCSzhbbBGJprBo73ssyEUWw_hmurxSm1aaC0vs_DkgmsTHCYsOYeStmZJVenlnsqT/exec';
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
  const grid=document.createElement('div');grid.className='table';grid.setAttribute('role','table');grid.setAttribute('aria-label',teacher+' '+info.sheetName+' 時間表');
  const headers=['교시','월','화','수','목','금'];
  for(let r=0;r<8;r++)for(let c=0;c<6;c++){
    const el=document.createElement('div');el.className='cell';el.setAttribute('role',r===0?'columnheader':c===0?'rowheader':'cell');
    if(r===0){el.classList.add('head');el.textContent=headers[c];}
    else if(c===0){el.classList.add('period');el.textContent=r+'교시';}
    else {const value=data.schedule[r-1][c-1];el.textContent=value||'—';if(!value)el.classList.add('empty-cell');}
    if(c>0&&c-1===info.todayIndex)el.classList.add('today');grid.append(el);
  }
  $('schedule').replaceChildren(grid);
}
function stamp(value){const d=new Date(value);return Number.isNaN(d.getTime())?'시각 미상':new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(d);}
function requestUrl(params){const u=new URL(endpoint);Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,v));u.searchParams.set('_ts',String(Date.now()));return u;}
async function fetchJson(params){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  try {
    const response=await fetch(requestUrl(params).href,{method:'GET',credentials:'omit',redirect:'follow',cache:'no-store',signal:controller.signal});
    if(!response.ok)throw new Error('HTTP '+response.status);
    return await response.json();
  }finally{clearTimeout(timer);}
}
function jsonp(params){return new Promise((resolve,reject)=>{
  const callback='timetable_cb_'+Date.now()+'_'+Math.floor(Math.random()*1e8);
  const script=document.createElement('script');let timer;
  const cleanup=()=>{clearTimeout(timer);script.remove();window[callback]=()=>{};setTimeout(()=>{delete window[callback];},60000);};
  window[callback]=data=>{cleanup();resolve(data);};
  script.onerror=()=>{cleanup();reject(new Error('JSONP 연결 실패'));};
  timer=setTimeout(()=>{cleanup();reject(new Error('JSONP 응답 시간 초과'));},25000);
  script.referrerPolicy='no-referrer';
  script.src=requestUrl({...params,callback}).href;document.head.append(script);
});}
async function requestTimetable(params){
  try{return {data:await fetchJson(params),method:'fetch'};}
  catch(fetchError){
    console.warn('fetch 실패, JSONP 재시도',fetchError);
    try{return {data:await jsonp(params),method:'JSONP'};}
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
    $('status').textContent=`${teacher} 선생님 · 온라인 조회 ${stamp(result.fetchedAt)} · ${response.method} · ${APP_VERSION}`+(result.matches===0?' · 일치하는 수업이 없습니다.':'');
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
let start;
$('surface').addEventListener('pointerdown',e=>{if(e.isPrimary&&e.button===0)start={x:e.clientX,y:e.clientY,time:Date.now(),id:e.pointerId};});
$('surface').addEventListener('pointercancel',()=>{start=null;});
$('surface').addEventListener('pointerup',e=>{if(!start||e.pointerId!==start.id)return;const dx=e.clientX-start.x,dy=e.clientY-start.y,elapsed=Date.now()-start.time;start=null;if(Math.abs(dx)>65&&Math.abs(dx)>Math.abs(dy)*1.6&&elapsed<1200)move(dx>0?1:-1);});
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
