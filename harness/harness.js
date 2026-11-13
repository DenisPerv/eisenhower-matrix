/* The transport (#45 plan v4): the page talks to the local server by default; the web copy of this page loads harness-remote.js first,
   which sets window.HarnessTransport (getJson, postJson, events, can, stamp: what the buttons depend on, so a change renders the open panel again). can(action,session,extra) says whether a control can be carried out
   now; { ok:false, why } greys it with the hint "Run local version". Locally there is no transport object: everything works as before. */
function harnessTransport(){return window.HarnessTransport||null}
function startHarness(D,RUNS){
'use strict';
var HD=window.HarnessData;
var TRX=harnessTransport();
var canDo=function(action,s,extra){return TRX&&TRX.can?TRX.can(action,s||null,extra||null):null};
var gate=function(node,action,s,extra){return HD.gateControl(node,canDo(action,s,extra),function(t){return document.createElement(t)},action+'-'+(s?s.name:extra&&extra.scope?extra.scope.replace(/[^a-z0-9_-]/gi,'_'):'x'))};
var $=function(id){return document.getElementById(id)};
var el=function(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e};
var reduce=matchMedia('(prefers-reduced-motion: reduce)');
var TZ={timeZone:'Europe/Lisbon',hour12:false};
var fm=function(ms){return isFinite(ms)?new Date(ms).toLocaleTimeString('en-GB',Object.assign({hour:'2-digit',minute:'2-digit'},TZ)):'now'};
var fs=function(ms){return isFinite(ms)?new Date(ms).toLocaleTimeString('en-GB',Object.assign({hour:'2-digit',minute:'2-digit',second:'2-digit'},TZ)):'now'};
var num=function(n){return n==null?'not recorded':Math.round(n).toLocaleString('en-GB')};
var K=function(n){return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?Math.round(n/1e3)+'K':String(n)};
var usd=function(n){return n==null?'no price':'$'+n.toFixed(2)};
var took=function(ms){var s=Math.round(ms/1000),m=Math.floor(s/60);return m>=60?Math.floor(m/60)+'h '+(m%60)+'m':m+'m '+(s%60)+'s'};
var ROLEC={master:'#ffd9a0',mother:'#c4b5ff',plan:'#86a9ff',do:'#f5799a',eliminate:'#b4bcc8',routine:'#9fd6ff'};
var KINDS=[['input','Input'],['output','Output'],['cache_read','Cache read'],['cache_write','Cache write']];
function tokCost(t){return t.cost||0}
var TOKK=['input','output','cache_read','cache_write','requests','cost','c_input','c_output','c_cache_read','c_cache_write','c_web'];
function addTok(a,b){var o={};TOKK.forEach(function(k){o[k]=(a[k]||0)+(b[k]||0)});return o}
var ZERO={};TOKK.forEach(function(k){ZERO[k]=0});

/* ---------- static model of the run ---------- */
var S=[],byName={};
function fillSession(o,s){Object.assign(o,s);o.t0=Date.parse(s.started_at);o.t1=s.ended_at?Date.parse(s.ended_at):Infinity;
  o.per=(s.active||[]).map(function(a){return[Date.parse(a.from),Date.parse(a.to)]});
  o.num=(s.name.match(/-(\d+)$/)||[])[1];
  o.short=s.role==='master'?(s.name==='master'?'Master':'Master, successor'):s.role==='mother'?'Mother of '+nice(s.list)+(s.restart_of?', restart':''):(s.role[0].toUpperCase()+s.role.slice(1)+(o.num?' #'+o.num:' '+s.name));
  o.allTok=s.tok;o.cost=s.tok.cost;return o}
function addSession(s){var o=fillSession({notes:[],steps:null,stepsT:[]},s);S.push(o);byName[o.name]=o;return o}
function nice(l){return D.list_names[l]||String(l||'').replace(/^homeos-/,'').replace(/-/g,' ')}
D.sessions.forEach(addSession);
var MOTHERS=[],MOTHER_OF={};function noteMother(s){if(s.role==='mother'&&!s.restart_of&&!MOTHER_OF[s.list]){MOTHERS.push(s.name);MOTHER_OF[s.list]=s.name}}S.forEach(noteMother);
var MDIR=[[-1,-1,200],[1,-1,-20],[1,1,20],[-1,1,160]];
var masterS=byName.master;
var LIVE=D.live;
var PRE=30000,RT=masterS.t0-14000; /* the routine fire is inferred: the master's first record is its only trace */
function calcT1(){var e=LIVE?Date.now():0;S.forEach(function(s){e=Math.max(e,isFinite(s.t1)?s.t1:s.t0)});return Math.max(e,masterS.t0+1000)}
var T0=masterS.t0-PRE,T1=calcT1();
function childrenOf(n){return S.filter(function(s){return s.parent===n})}
function rollup(s){var own=s.allTok,ch=ZERO;childrenOf(s.name).forEach(function(c){ch=addTok(ch,rollup(c).sum)});return{own:own,children:ch,sum:addTok(own,ch)}}
function hasCard(s){if(s.role==='plan'){var m=s.report&&s.report.text.match(/(\d+) Delegate card/);return m&&+m[1]>0?'Delegate card':null}
  if(s.role==='do'){var k=TK[s.task];return k&&(k.is_check||k.check)||(s.report&&/check card/i.test(s.report.text))?'Check card':'none recorded'}return null}

/* decisions */
function decsOf(a){return a.map(function(x){var m=x.match(/^(\d\d:\d\d) ([\s\S]*)$/);return{hm:m?m[1]:'',text:m?m[2]:x,up:/passed.*up|passed #|re-raised|passed up/i.test(x)}})}
var MDEC={},MAST=[];function loadDecisions(){MDEC={};Object.keys(D.mother_decisions).forEach(function(k){MDEC[k]=decsOf(D.mother_decisions[k])});MAST=decsOf(D.master_decisions)}loadDecisions();

/* escalations: pair escalate-<list>-<n> with decision-<list>-<n>; a decision follows its escalation */
var ESC=D.escalations;
/* tasks: what the scans saw, plus tasks that sessions worked but no scan showed */
var TK={},TASKS=[];
function loadTasks(){D.tasks.forEach(function(i){var k=TK[i.ref]||(TK[i.ref]={});Object.assign(k,{ref:i.ref,list:i.list,title:i.title,pickable:i.pickable,why:i.why_not||[],num:i.num,quadrant:i.quadrant,state:i.state,hist:i.hist||[],is_check:i.is_check,check:i.check})});
  S.forEach(function(s){if(s.role==='master'||s.role==='mother')return;(s.tasks.length?s.tasks:s.task?[s.task]:[]).forEach(function(ref){if(TK[ref])return;TK[ref]={ref:ref,list:s.list,title:s.title||s.goal,pickable:false,why:[],num:+((ref.match(/#(\d+)/)||[])[1]||s.num||0),quadrant:null,state:'worked_today',hist:[]}})});
  TASKS=Object.keys(TK).map(function(k){return TK[k]}).filter(function(k){return MOTHER_OF[k.list]})}
loadTasks();

/* ---------- event stream, built only from real timestamps ---------- */
var EV=[];
function ev(t,type,o){var e=Object.assign({t:t,type:type},o||{});EV.push(e);return e}
function buildReplayEvents(){
  EV.length=0;var nowMs=Date.now();
  ev(RT,'routine.fire',{cap:'The routine fires',inferred:true});
  S.forEach(function(s){
    var end=isFinite(s.t1);
    ev(s.t0,'session.start',{s:s.name});
    s.per.forEach(function(p,i){ev(p[0],'session.work',{s:s.name});if(!(i===s.per.length-1&&!end&&nowMs-p[1]<30000))ev(p[1],'session.idle',{s:s.name})});
    s.spend.forEach(function(x){ev(x[0],'step',{s:s.name})});
    if(s.role==='mother'&&!s.restart_of)ev(s.t0+1,'task.show',{list:s.list});
    if(s.role==='plan'||s.role==='do'||s.role==='eliminate'){
      (s.tasks.length?s.tasks:s.task?[s.task]:[]).forEach(function(ref,i){ev(s.t0+2,'task.claim',{s:s.name,ref:ref,cap:s.role==='plan'&&!i?s.short+' claims its task':null});if(end)ev(s.t1-1,'task.release',{s:s.name,ref:ref,done:s.role==='do'&&s.state==='done'})});
      if(s.role==='do'){var p=byName['plan-'+s.list+'-'+s.num];if(p)ev(s.t0,'plan.handoff',{from:p.name,to:s.name,cap:'Plan #'+s.num+' handed to Do #'+s.num})}}
    if(s.parent)ev(s.t0,'link',{nature:'brief',from:s.parent,to:s.name,cap:s.role==='mother'?'Master starts the '+nice(s.list)+' mother':null});
    if(s.role!=='master'&&s.report&&end)ev(s.t1,'link',{nature:'report',from:s.name,to:s.parent,cap:s.role==='mother'?nice(s.list)+' mother reports: '+s.report.kind:null});
    if(hasCard(s)==='Delegate card'&&end)ev(s.t1,'card',{s:s.name,cap:s.short+' puts a question card on the board'});
    if(end){if(s.name!=='master')ev(s.t1,'session.end',{s:s.name}); else ev(s.t1,'session.end',{s:s.name,cap:'The day closes'})}
  });
  ESC.forEach(function(e,i){
    ev(e.t,'escalate',{esc:i,from:e.origin,via:e.mother,to:'master',cap:'#'+e.n+' climbs: '+nice(e.list)+' mother passes it up'});
    if(e.td)ev(e.td,'decide',{esc:i,from:'master',to:e.mother,cap:'Master decides #'+e.n+', sends it down'});
  });
  TASKS.forEach(function(k){k.hist.forEach(function(h){ev(Date.parse(h.at),'task.state',{ref:k.ref})})});
  (D.links||[]).forEach(function(l){if(byName[l.session]&&l.kind!=='answer')ev(Date.parse(l.at),'link',{nature:l.kind==='ask'?'brief':'decision',from:'master',to:l.session})});
  EV.sort(function(a,b){return a.t-b.t});
}
buildReplayEvents();

/* every visual reacts to applyEvent only. The stream is rebuilt from the run model whenever the server reports a change, then replayed to now. */

/* ---------- state ---------- */
var state={sel:null,t:T0,playing:false,speed:1,tab:'about',view:null,sending:false,msg:null,draft:'',hi:null,tipStar:null,climb:null,sort:{k:'cost',d:-1},cam:0,camT:0,camS:1,camST:1,camY:0,camYT:0,noRun:false};
var BASE=(T1-T0)/80000; /* 80 seconds for the whole day at 1x */
var M; /* runtime model, written only by applyEvent */
var cursor=0;
function newModel(){return{routine:false,sess:{},tasks:{},pulses:[],pings:[],spent:{},esc:0,escList:{},last:null,handoffs:[],cards:0,simCost:0}}
function sm(n){return M.sess[n]||(M.sess[n]={born:false,working:false,ended:false,from:0,work:0,steps:0})}
function applyEvent(e,live){
  modelDirty=true;
  if(live&&e.type==='task.show')teach(e.list);
  var s=e.s?byName[e.s]:null;
  switch(e.type){
    case 'routine.fire':M.routine=true;break;
    case 'session.start':sm(e.s).born=true;sm(e.s).bornT=e.t;/* a child never shows without its mother: a run's records may start a mother after her first child (2026-11-10), so the mother's system and axis come with the child */for(var up=s&&s.parent,hop=0;up&&byName[up]&&hop<8;up=byName[up].parent,hop++){var pq=sm(up);if(!pq.born){pq.born=true;pq.bornT=e.t}}break;
    case 'session.work':var w=sm(e.s);if(!w.working){w.working=true;w.from=e.t}break;
    case 'session.idle':var i=sm(e.s);if(i.working){i.working=false;i.work+=e.t-i.from}break;
    case 'session.end':var d=sm(e.s);d.ended=true;break;
    case 'step':sm(e.s).steps++;M.pings.push({s:e.s,t:e.t,say:e.say});if(M.pings.length>70)M.pings.shift();break;
    case 'task.show':TASKS.forEach(function(k){if(k.list===e.list&&!M.tasks[k.ref])M.tasks[k.ref]={t:e.t}});break;
    case 'task.claim':var k=M.tasks[e.ref]||(M.tasks[e.ref]={t:e.t});k.claimed=true;k.holder=e.s;k.tc=e.t;break;
    case 'task.release':var r=M.tasks[e.ref];if(r){if(e.done)r.done=true;r.holder=null}break;
    case 'plan.handoff':M.handoffs.push(e);M.pulses.push({n:'handoff',from:e.from,to:e.to,t:e.t,ttl:150000});break;
    case 'link':M.pulses.push({n:e.nature,from:e.from,to:e.to,t:e.t,ttl:e.nature==='report'?140000:90000});break;
    case 'escalate':M.esc++;M.escList[e.esc]=1;M.pulses.push({n:'escalate',from:e.from,to:e.via,t:e.t,ttl:60000});M.pulses.push({n:'escalate',from:e.via,to:e.to,t:e.t+50000,ttl:60000});break;
    case 'decide':M.escList[e.esc]=2;M.pulses.push({n:'decision',from:e.from,to:e.to,t:e.t,ttl:70000});break;
    case 'card':M.cards++;M.pulses.push({n:'card',from:e.s,t:e.t,ttl:140000});break;
  }
  if(e.type!=='step'&&e.type!=='tokens'&&(e.cap||/^(session\.start|escalate|decide)$/.test(e.type)))M.last=e;
  if(live&&e.cap)caption(e.cap);
}
function spentOf(s,t){if(!s.spend.length)return t>=s.t1?s.cost:0;return HD.spendAt(s.spend,t)}
function totalSpent(t){return S.reduce(function(a,s){return a+spentOf(s,t)},0)}

function rebuild(t){modelDirty=true;M=newModel();cursor=0;while(cursor<EV.length&&EV[cursor].t<=t){applyEvent(EV[cursor],false);cursor++}}
function advance(t,live){var n=0;var first=cursor;while(cursor<EV.length&&EV[cursor].t<=t){n++;cursor++}
  var quiet=n>40;for(var i=first;i<cursor;i++)applyEvent(EV[i],live&&!quiet)}
function setT(t,live){t=Math.max(T0,Math.min(T1,t));if(t<state.t)rebuild(t),state.t=t;else{state.t=t;advance(t,live)}syncTime();req()}
function tEnd(){return T1}

var taught={};function teach(l){if(reduce.matches)return;var q=TASKS.filter(function(k){return k.list===l}).map(function(k){return k.state&&k.state!=='worked_today'?k.state:'can_be_taken'});var f=null;STATES.forEach(function(x){if(!f&&!taught[x.k]&&q.indexOf(x.k)>=0)f=x});if(f){taught[f.k]=1;caption(f.m)}}
/* captions: at most 2 at once */
function caption(){}

/* ---------- states: one shape and one colour family each, same order everywhere ---------- */
var STATES=[
 {k:'can_be_taken',w:'Ready',m:'Ready: an agent may take it',c:'#eaf1ff',g:'<path d="M8 1l1.7 5.3L15 8l-5.3 1.7L8 15l-1.7-5.3L1 8l5.3-1.7z" fill="#eaf1ff"/>'},
 {k:'worked_today',w:'Taken',m:'Taken: a session has it, or had it today',c:'#ffd9a0',g:'<circle cx="8" cy="8" r="6" fill="none" stroke="#ffd9a0" stroke-width="1.6"/><circle cx="8" cy="8" r="2.6" fill="#ffd9a0"/>'},
 {k:'blocked_by_task',w:'Blocked',m:'Blocked: waits for another task',c:'#f7a8bc',g:'<rect x="2.5" y="2.5" width="11" height="11" fill="none" stroke="#f7a8bc" stroke-width="1.6"/><path d="M3 13L13 3" stroke="#f7a8bc" stroke-width="1.6"/>'},
 {k:'deferred_by_date',w:'Later',m:'Deferred: its date has not come',c:'#9fc2ff',g:'<circle cx="8" cy="8" r="6" fill="none" stroke="#9fc2ff" stroke-width="1.6"/><path d="M8 4v4.4l3 1.8" fill="none" stroke="#9fc2ff" stroke-width="1.6"/>'},
 {k:'waits_for_person',w:'You',m:'Waits for you: review, Delegate or Eliminate',c:'#f4ad4e',g:'<path d="M8 2l6.5 12h-13z" fill="#f4ad4e"/>'},
 {k:'held',w:'Held',m:'Held by a session',c:'#c4b5ff',g:'<path d="M8 1.5l6.5 6.5L8 14.5 1.5 8z" fill="none" stroke="#c4b5ff" stroke-width="1.6"/><path d="M5.5 8h5" stroke="#c4b5ff" stroke-width="1.6"/>'},
 {k:'done',w:'Done',m:'Done today: it has left the open board',c:'#59cf97',g:'<path d="M2.5 8.5l3.8 3.8L13.5 4" fill="none" stroke="#59cf97" stroke-width="2.2"/>'},
 {k:'other',w:'Other',m:'Held back: open it to see why',c:'#b4bcc8',g:'<circle cx="8" cy="8" r="2.4" fill="#b4bcc8"/><circle cx="8" cy="8" r="6" fill="none" stroke="#b4bcc8" stroke-width="1.2" stroke-dasharray="2 2"/>'}];
var STBY={};STATES.forEach(function(x){STBY[x.k]=x});
function glyph(k,sz){sz=sz||16;return'<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 16 16" aria-hidden="true">'+STBY[k].g+'</svg>'}
function taskState(k){var st=M.tasks[k.ref];if(!st)return null;if(st.done)return'done';if(st.claimed)return'worked_today';var v=HD.stateAt(k.hist,state.t,k.state);return v&&v!=='worked_today'?v:'can_be_taken'}
var LISTS=MOTHERS.map(function(n){return byName[n].list});

/* ---------- light: sprites and painted bodies ---------- */
var cv=$('core'),cx=cv.getContext('2d',{alpha:false}),bake=document.createElement('canvas'),coreSp=document.createElement('canvas'),W=0,H=0,DPR=1,sprites={},glass={};
var G={cx:0,cy:0,R:120,mob:false,compact:false};
var POS={},CHP={},VA={};
function hexa(h,a){var n=parseInt(h.slice(1),16);return'rgba('+(n>>16)+','+((n>>8)&255)+','+(n&255)+','+a+')'}
function glow(hex){if(sprites[hex])return sprites[hex];var c=document.createElement('canvas');c.width=c.height=96;var g=c.getContext('2d'),r=g.createRadialGradient(48,48,0,48,48,48);
  r.addColorStop(0,'rgba(255,255,255,1)');r.addColorStop(.09,hexa(hex,.95));r.addColorStop(.26,hexa(hex,.34));r.addColorStop(.55,hexa(hex,.08));r.addColorStop(1,hexa(hex,0));g.fillStyle=r;g.fillRect(0,0,96,96);return sprites[hex]=c}
var ZS=1;
function sp(ctx,hex,x,y,r,a){if(a<=.004)return;r*=ZS;ctx.globalAlpha=Math.min(1,a);ctx.drawImage(glow(hex),x-r,y-r,r*2,r*2);ctx.globalAlpha=1}
function rnd(seed){var x=seed;return function(){x=(x*1664525+1013904223)%4294967296;return x/4294967296}}
function glassSprite(hex){if(glass[hex])return glass[hex];var c=document.createElement('canvas');c.width=c.height=80;var g=c.getContext('2d'),r=32;
  var b=g.createRadialGradient(40-r*.35,40-r*.42,r*.04,40,40,r);b.addColorStop(0,'rgba(255,255,255,.92)');b.addColorStop(.2,hexa(hex,.62));b.addColorStop(.72,'rgba(8,14,30,.9)');b.addColorStop(.94,hexa(hex,.8));b.addColorStop(1,hexa(hex,.25));g.fillStyle=b;g.beginPath();g.arc(40,40,r,0,7);g.fill();
  var hl=g.createLinearGradient(0,10,0,38);hl.addColorStop(0,'rgba(255,255,255,.34)');hl.addColorStop(1,'rgba(255,255,255,0)');g.fillStyle=hl;g.beginPath();g.ellipse(40,24,r*.58,r*.34,0,0,7);g.fill();return glass[hex]=c}
function drawGlass(ctx,hex,x,y,r,a){r*=ZS;ctx.globalAlpha=a;ctx.drawImage(glassSprite(hex),x-r*1.25,y-r*1.25,r*2.5,r*2.5);ctx.globalAlpha=1}

/* ---------- the fixed grid: the DOM owns every position, the canvas only paints light under it ---------- */
var STAGE=$('stage'),SLOT={},CHIP={},GROUP={},GROUPL={},QMC={},LANES={};
function chainLanes(n){/* parallel branches from real overlap of started_at and ended_at; a later chain follows on a free lane */
  var kids=childrenOf(n),ch={};kids.forEach(function(s){var k=s.num||s.name;var c=ch[k]||(ch[k]={k:k,t0:s.t0,t1:s.t1,ss:[]});c.t0=Math.min(c.t0,s.t0);c.t1=Math.max(c.t1,s.t1);c.ss.push(s)});
  var arr=Object.keys(ch).map(function(k){return ch[k]}).sort(function(a,b){return a.t0-b.t0}),lanes=[];
  arr.forEach(function(c){c.ss.sort(function(a,b){return a.t0-b.t0});var l=null;for(var i=0;i<lanes.length;i++)if(lanes[i].end<=c.t0){l=lanes[i];break}if(!l){l={end:0,ss:[]};lanes.push(l)}l.end=c.t1;l.ss=l.ss.concat(c.ss)});
  return lanes}
function addSlot(s,lane){var b=el('button','slot r-'+s.role);b.type='button';b.dataset.s=s.name;b.setAttribute('aria-label',s.short+', '+nice(s.list)+', '+fm(s.t0)+' to '+fm(s.t1));b.appendChild(el('span','num','#'+s.num));
  b.onclick=function(){select(s.name,true)};b.onmouseenter=function(e){tipSession(s,e.clientX,e.clientY);hover(s.name)};b.onmouseleave=function(){hideTip();hover(null)};b.onfocus=function(){var r=b.getBoundingClientRect();tipSession(s,r.left,r.bottom);hover(s.name)};b.onblur=function(){hideTip();hover(null)};
  lane.appendChild(b);SLOT[s.name]=b;return b}
function hover(n){if(state.hi!==n){state.hi=n;req()}}
function buildStage(){
  var core=el('div','corec');core.id='corec';var rb=el('div');rb.id='ringbox';
  var rt=el('button','lab rt','Routine');rt.type='button';rt.id='lab-routine';rt.setAttribute('aria-label','Routine: what started the day');var ro=el('span','orb');ro.id='orb-routine';rt.prepend(ro);rt.onclick=renderRoutine;rt.onmouseenter=function(){hover('routine')};rt.onmouseleave=function(){hover(null)};rb.appendChild(rt);
  var ml=el('button','lab m0','Master');ml.type='button';ml.id='lab-master';ml.setAttribute('aria-label',masterS.short);ml.onclick=function(){select('master',true)};ml.onmouseenter=function(e){tipSession(masterS,e.clientX,e.clientY);hover('master')};ml.onmouseleave=function(){hideTip();hover(null)};ml.onfocus=function(){hover('master')};ml.onblur=function(){hover(null)};rb.appendChild(ml);core.appendChild(rb);
  var tb=el('table','qm');tb.id='qm';tb.appendChild(el('caption','vh','What the master could start, per list and state'));var hr=el('tr');hr.appendChild(el('th',null,''));
  STATES.forEach(function(x){var th=el('th');th.scope='col';var b=el('button','qh');b.type='button';b.innerHTML=glyph(x.k,14);b.title=x.m;b.setAttribute('aria-label',x.m+': all lists');b.onmouseenter=function(){litQueue(null,x.k)};b.onmouseleave=unlitQueue;b.onfocus=function(){litQueue(null,x.k)};b.onblur=unlitQueue;b.onclick=function(){openQueue(null,x.k)};th.appendChild(b);hr.appendChild(th)});tb.appendChild(hr);
  LISTS.forEach(function(l){addQmRow(l,tb)});
  document.body.appendChild(tb);
  MOTHERS.forEach(function(n,i){addBlock(n,i)});
  STAGE.insertBefore(core,$('q1'));placeBlocks();
    STAGE.addEventListener('scroll',function(){readPos();req()},{passive:true});
  if(window.ResizeObserver)new ResizeObserver(function(){measureStage()}).observe(STAGE);
}
function addQmRow(l,tb){var tr=el('tr');var th=el('th');th.scope='row';var mb=el('button','qhm',shortList(l));mb.type='button';mb.setAttribute('aria-label','Open mother of '+nice(l));mb.onclick=function(){select(MOTHER_OF[l],true)};th.appendChild(mb);tr.appendChild(th);
    STATES.forEach(function(x){var td=el('td');var b=el('button','qc','0');b.type='button';b.dataset.l=l;b.dataset.st=x.k;b.onmouseenter=function(){litQueue(l,x.k)};b.onmouseleave=unlitQueue;b.onfocus=function(){litQueue(l,x.k)};b.onblur=unlitQueue;b.onclick=function(){openQueue(l,x.k)};td.appendChild(b);tr.appendChild(td);QMC[l+'|'+x.k]=b});tb.appendChild(tr)}
function addBlock(n,i){var s=byName[n],q=el('section','q q'+(i%4));q.id='q'+i;q.setAttribute('aria-label',nice(s.list));
    var mh=el('div','mh');var l=el('button','lab','');l.type='button';l.id='lab-'+n;l.setAttribute('aria-label',s.short);var o=el('span','orb');o.id='orb-'+n;l.appendChild(o);l.appendChild(el('span','mn',nice(s.list)));l.onclick=function(){select(n,true)};l.onmouseenter=function(e){tipSession(s,e.clientX,e.clientY)};l.onmouseleave=hideTip;mh.appendChild(l);mh.appendChild(el('span','mst'));mh.lastChild.id='mst'+i;
    var tt=el('button','tl-t');tt.type='button';tt.innerHTML='<span class="tq4" aria-hidden="true">'+['done','waits_for_person','blocked_by_task','can_be_taken'].map(function(k){return glyph(k,9)}).join('')+'</span>';tt.title='List tasks';tt.setAttribute('aria-label','List tasks of '+nice(s.list));tt.onclick=function(){openTasks(s.list)};mh.appendChild(tt);q.appendChild(mh);
    var rails=el('div','rails');LANES[n]=[];chainLanes(n).forEach(function(lane){var d=el('div','lane');lane.ss.forEach(function(c){addSlot(c,d)});rails.appendChild(d);LANES[n].push(d)});q.appendChild(rails);var os=el('div','osys');os.id='os-'+n;q.insertBefore(os,rails);
    var tr=el('div','tray');tr.setAttribute('role','group');tr.setAttribute('aria-label','Tasks of '+nice(s.list)+', by state. Arrow keys move between tasks.');q.appendChild(tr);buildTray(s.list,tr,null);
    STAGE.appendChild(q)}
/* open mothers first, closed mothers (no work left) take the lower slots */
function motherRank(){var open=[],shut=[],ss=(typeof M!=='undefined'&&M&&M.sess)||{};MOTHERS.forEach(function(n,i){var q=ss[n]||{};(q.ended&&!q.working?shut:open).push(i)});return open.concat(shut)}
function placeBlocks(){var core=$('corec'),rk=motherRank(),SL=[[1,1],[3,1],[3,2],[1,2]];rk.forEach(function(i,r){var q=$('q'+i);if(!q)return;if(MOTHERS.length>4){var left=r%4===0||r%4===3,side=rk.slice(0,r+1).filter(function(_,j){return (j%4===0||j%4===3)===left}).length;q.style.gridColumn=left?1:3;q.style.gridRow=side}else{q.style.gridColumn=SL[r][0];q.style.gridRow=SL[r][1]}});if(MOTHERS.length>4){var nr=Math.ceil(MOTHERS.length/2);STAGE.style.gridTemplateRows='repeat('+nr+',max-content)';core.style.gridRow='1/'+(nr+1)}}
/* a new session of a list: a new lane in its block, so what is there never moves */
function placeSession(s){if(SLOT[s.name]||s.role==='master'||!s.parent||!LANES[s.parent])return;var ls=LANES[s.parent],host=null;for(var i=0;i<ls.length&&!host;i++){var lastc=ls[i].lastChild,o=lastc&&byName[lastc.dataset.s];if(o&&o.t1<=s.t0)host=ls[i]}if(!host){host=el('div','lane');var q=$('q'+MOTHERS.indexOf(s.parent));q.querySelector('.rails').appendChild(host);ls.push(host)}addSlot(s,host)}
function maxPerGroup(){var mx={},keep=M;M=newModel();var bump=function(){var c={};TASKS.forEach(function(k){var s=taskState(k);if(s){var x=k.list+'|'+s;c[x]=(c[x]||0)+1}});Object.keys(c).forEach(function(x){mx[x]=Math.max(mx[x]||0,c[x])})};
  EV.forEach(function(e){applyEvent(e,false);if(/^task\./.test(e.type))bump()});bump();M=keep;return mx}
var MAXG=null;
function buildTray(list,tr,tl){if(!MAXG)MAXG=maxPerGroup();
  STATES.forEach(function(x){if(tl){var lg=el('div','lgp');var lh=el('h4',null,'');lh.innerHTML=glyph(x.k,14);lh.appendChild(document.createTextNode(' '+x.m.split(':')[0]));lg.appendChild(lh);tl.appendChild(lg);GROUPL[list+'|'+x.k]=lg}
    if(MAXG[list+'|'+x.k])makeGroup(list,x,tr)});
  TASKS.filter(function(k){return k.list===list}).sort(function(a,b){return a.num-b.num}).forEach(function(k){addChip(k,tr)})}
/* one row per state; a state no task has reached has no row until one does */
function makeGroup(list,x,tr){var mx=MAXG[list+'|'+x.k]||1,g=el('div','tg');g.dataset.st=x.k;g.style.setProperty('--n',Math.max(1,mx));var h=el('span','tgh');h.innerHTML=glyph(x.k,13)+'<span>'+x.w+'</span>';var c=el('span','tgc','');h.appendChild(c);g.appendChild(h);var w=el('div','tgw');g.appendChild(w);var before=null;for(var i=STATES.indexOf(x)+1;i<STATES.length&&!before;i++)before=tr.querySelector('.tg[data-st="'+STATES[i].k+'"]');tr.insertBefore(g,before);GROUP[list+'|'+x.k]=w;g._c=c;return w}
function trayOf(l){var i=MOTHERS.indexOf(MOTHER_OF[l]),q=i<0?null:$('q'+i);return q?q.querySelector('.tray'):null}
function addChip(k,tr){var b=el('button','chip');b.type='button';b.dataset.ref=k.ref;b.dataset.num=k.num;b.tabIndex=-1;b.onclick=function(){openTask(k)};b.onmouseenter=function(e){tipStar(k,e.clientX,e.clientY)};b.onmouseleave=hideTip;b.onfocus=function(){var r=b.getBoundingClientRect();tipStar(k,r.left,r.bottom)};b.onblur=hideTip;
    b.onkeydown=function(e){var d=e.key==='ArrowRight'||e.key==='ArrowDown'?1:e.key==='ArrowLeft'||e.key==='ArrowUp'?-1:0;if(!d)return;e.preventDefault();var all=[].slice.call(tr.querySelectorAll('.chip.on:not(.over)'));var i=all.indexOf(b),n=all[(i+d+all.length)%all.length];if(n){b.tabIndex=-1;n.tabIndex=0;n.focus()}};CHIP[k.ref]=b;k._b=b}
function placeSorted(host,node,num){var before=null;[].some.call(host.children,function(x){if(x.dataset.num&&+x.dataset.num>num){before=x;return true}});host.insertBefore(node,before)}
/* moves a chip or row only when its own state changes: every group keeps its width, so nothing else shifts */
function syncChips(){var c={};TASKS.forEach(function(k){var st=taskState(k),b=k._b;if(!b)return;var was=b.dataset.st||'';
    if(st)c[k.list+'|'+st]=(c[k.list+'|'+st]||0)+1;
    if(st!==(was||null)){if(st){var h=GROUP[k.list+'|'+st];var foc=document.activeElement===b;if(!h){var trh=trayOf(k.list);if(trh)h=makeGroup(k.list,STBY[st],trh);capWidths()}if(h)placeSorted(h,b,k.num);if(k._r&&GROUPL[k.list+'|'+st])placeSorted(GROUPL[k.list+'|'+st],k._r,k.num);b.innerHTML=glyph(st,14);b.dataset.st=st;b.classList.add('on');b.setAttribute('aria-label','#'+k.num+' '+k.title+'. '+STBY[st].w);if(foc)b.focus({preventScroll:true});
        if(was&&!reduce.matches){b.classList.remove('moved');void b.offsetWidth;b.classList.add('moved')}}else{b.dataset.st='';b.classList.remove('on');if(b.parentNode)b.parentNode.removeChild(b);if(k._r&&k._r.parentNode)k._r.parentNode.removeChild(k._r)}posDirty=true}});
  Object.keys(QMC).forEach(function(x){var b=QMC[x],n=c[x]||0;b.textContent=n;b.classList.toggle('zero',!n);b.disabled=!n;var p=x.split('|');b.setAttribute('aria-label',nice(p[0])+', '+STBY[p[1]].w+': '+n)});
  Object.keys(GROUP).forEach(function(x){var g=GROUP[x].parentNode;g._c.textContent=c[x]?' '+c[x]:'';g.classList.toggle('empty',!c[x])});
  Object.keys(GROUPL).forEach(function(x){GROUPL[x].classList.toggle('none',!c[x])});
  [].forEach.call(STAGE.querySelectorAll('.tray'),function(tr){if(!tr.querySelector('.chip[tabindex="0"]')){var f=tr.querySelector('.chip.on');if(f)f.tabIndex=0}});
  M.queue=c;syncCaps()}
function syncSlots(){S.forEach(function(s){if(s.role==='master')return;var q=M.sess[s.name]||{},b=s.role==='mother'&&!s.restart_of?$('lab-'+s.name):SLOT[s.name];if(!b)return;b.classList.toggle('born',!!q.born);b.classList.toggle('working',!!q.working);b.classList.toggle('ended',!!q.ended&&!q.working);if(state.sel===s.name)b.setAttribute('aria-current','true');else b.removeAttribute('aria-current')});
  var shutKey='';SHUT={};MOTHERS.forEach(function(n,i){var q=M.sess[n]||{},t=$('mst'+i),sh=!!(q.ended&&!q.working),qb=$('q'+i);if(t)t.textContent=!q.born?'':q.working?'working':q.ended?'closed':'asleep';if(qb){qb.classList.toggle('qdone',sh);qb.classList.toggle('qborn',!!q.born)}if(sh)SHUT[n]=1;shutKey+=sh?1:0});
  if(shutKey!==lastShut){var first=lastShut==null;lastShut=shutKey;if(!first)setTimeout(function(){placeBlocks();measureStage()},0)}
  var mast=M.sess.master||{};if(state.sel==='master')$('lab-master').setAttribute('aria-current','true');else $('lab-master').removeAttribute('aria-current');$('lab-master').classList.toggle('born',!!mast.born);$('lab-routine').classList.toggle('born',!!M.routine);$('corec').classList.toggle('born',!!M.routine)}
var modelDirty=true,posDirty=true,lastShut=null,SHUT={};
function syncScene(){if(!modelDirty)return;modelDirty=false;syncSlots();syncChips();taskWatch();orbitSync();if(posDirty)readPos()}

function rectC(e){var r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}}
function readPos(){posDirty=false;var rb=$('ringbox');if(!rb)return;var r=rb.getBoundingClientRect();POS.master={x:r.left+r.width/2,y:r.top+r.height/2};G.cx=POS.master.x;G.cy=POS.master.y;G.R=Math.max(44,Math.min(r.width,r.height)/2-10);
  POS.routine=rectC($('orb-routine'));var OSR={};MOTHERS.forEach(function(n){var os=$('os-'+n);if(os&&os.offsetWidth&&ORB[n]){var q=os.getBoundingClientRect();POS[n]={x:q.left+q.width/2,y:q.top+q.height/2};ORB[n].sc=q.width/(2*ORB[n].R);OSR[os.id]={l:q.left,t:q.top,sc:ORB[n].sc,L:ORB[n]}}else POS[n]=rectC($('orb-'+n))});
  /* a planet's place is computed from its system (orbitPlace keeps it in L.loc), so the page is not asked for one rect per planet */
  var inSys=function(e,key){var o=e.parentNode&&OSR[e.parentNode.id],p=o&&o.L.loc&&o.L.loc[key];return p?{x:o.l+p.x*o.sc,y:o.t+p.y*o.sc}:null};
  Object.keys(ODEL).forEach(function(r){var e=ODEL[r],p=e.isConnected&&inSys(e,'t:'+r);if(p)DP[r]=p;else if(e.isConnected&&e.offsetParent)DP[r]=rectC(e);else delete DP[r]});Object.keys(SLOT).forEach(function(n){var p=inSys(SLOT[n],n);if(p)POS[n]=p;else if(SLOT[n].offsetParent)POS[n]=rectC(SLOT[n]);else delete POS[n]});TASKS.forEach(function(k){if(k._b&&k._b.classList.contains('on')&&k._b.offsetParent)CHP[k.ref]=rectC(k._b);else delete CHP[k.ref]})}
/* the stage zooms out until everything fits (CSS zoom, so every rect the canvas reads is already scaled); the person can zoom
   in or out on top of that (buttons, Ctrl or pinch + wheel), kept per viewer. Not in the phone layout or the classic view. */
var ZM={k:1,fit:1,user:1,min:1,tw:0,ft:0},ZB={l:null,r:null,t:null,b:null};try{ZM.user=Math.max(1,Math.min(4,+localStorage.getItem('eis-zoom')||1))}catch(e){}
/* the stage box between the side panels (ZB, set by the panel layout) in screen px; CSS zoom scales insets too, so each is divided by k */
function zoomBox(k){var st=STAGE.style,one=Math.abs(k-1)<.001;st.zoom=one?'':String(k);['l','r','t','b'].forEach(function(e){var v=ZB[e],p={l:'left',r:'right',t:'top',b:'bottom'}[e];if(v!=null)st[p]=(v/(one?1:k))+'px'})}
/* the sun recedes: when the lists do not fit, the master's column narrows and its ring shrinks (and dims a little), so the mothers keep
   their full size and text in front. Only the person's own zoom (buttons, Ctrl+wheel) scales everything. */
var SUN=1,sunCols=null;
function sunSet(d){var rbx=$('ringbox'),big=MOTHERS.length>4;SUN=d;
  if(d>.999){STAGE.style.gridTemplateColumns='';if(rbx){rbx.style.height=big?Math.round(Math.min(520,STAGE.clientHeight*.6))+'px':'';rbx.style.alignSelf=big?'center':''}return}
  var c=sunCols;STAGE.style.gridTemplateColumns='minmax(0,'+c[0].toFixed(3)+'fr) minmax(150px,'+(c[1]*d).toFixed(3)+'fr) minmax(0,'+c[2].toFixed(3)+'fr)';
  if(rbx){rbx.style.height=big?Math.round(Math.min(520,STAGE.clientHeight*.6)*d)+'px':Math.round(STAGE.clientHeight*.62*d)+'px';rbx.style.alignSelf='center'}}
/* fits: nothing below the fold and the lists keep their full-size marks (no csm/ccomp compaction) */
function qExtent(){var sr=STAGE.getBoundingClientRect(),t=Infinity,b=-Infinity,clip=false;[].forEach.call(STAGE.querySelectorAll('.q'),function(q){var r=q.getBoundingClientRect();if(!r.height)return;t=Math.min(t,r.top);b=Math.max(b,r.bottom);if(q.scrollHeight>q.clientHeight+2)clip=true});return{sr:sr,t:t,b:b,clip:clip}}
function compacted(){return STAGE.classList.contains('csm')||STAGE.classList.contains('ccomp')}
function sunFits(){var e=qExtent();return !e.clip&&!compacted()&&(e.t===Infinity||(e.t>=e.sr.top-1&&e.b<=e.sr.bottom+1))}
/* v3: everything fits at 100%; the person may zoom in (no upper limit worth hitting: 400%) and pan by scrolling, never below 100% */
function zoomFit(){ZM.ft=0;var zc=$('zoomc'),off=VIEW==='classic'||G.compact;if(zc)zc.hidden=off;ZM.min=1;var k=off?1:Math.max(1,Math.min(4,ZM.user)),k0=ZM.k;zoomBox(k);ZM.k=k;STAGE.style.overflow=k>1.001?'auto':'hidden';STAGE.style.scrollbarWidth='none';STAGE.classList.toggle('zoomed',k>1.001);
  var sr0=STAGE.getBoundingClientRect(),pv=ZM.piv||{x:sr0.left+sr0.width/2,y:sr0.top+sr0.height/2},sl0=STAGE.scrollLeft,stp0=STAGE.scrollTop;ZM.piv=null;
  afterZoom();if(Math.abs(k-k0)>.001){var cxp=(pv.x-sr0.left)/k0+sl0,cyp=(pv.y-sr0.top)/k0+stp0;STAGE.scrollLeft=cxp-(pv.x-sr0.left)/k;STAGE.scrollTop=cyp-(pv.y-sr0.top)/k;readPos();req()}}
function zoomTo(k){cancelAnimationFrame(ZM.tw);var k0=ZM.k;if(Math.abs(k-k0)<.004||reduce.matches){zoomBox(k);ZM.k=k;afterZoom();return}var t0=performance.now();
  (function st(){var u=Math.min(1,(performance.now()-t0)/420),e=1-Math.pow(1-u,3),z=k0+(k-k0)*e;zoomBox(z);ZM.k=z;readPos();req();if(u<1)ZM.tw=requestAnimationFrame(st);else afterZoom()})()}
function afterZoom(){layoutMothers();readPos();bakeCore();req();var l=$('zoomc');if(l){l=l.querySelector('.zl');l.textContent=Math.round(ZM.k*100)+'%';var zc2=$('zoomc'),lo=ZM.min>.999;l.title=ZM.k>1.001?'Back to 100%: everything in view':'Everything is in view';l.disabled=ZM.k<=1.001;zc2.classList.toggle('atone',ZM.k<=1.001);zc2.querySelector('[data-z="+"]').disabled=ZM.k>=3.999;zc2.querySelector('[data-z="-"]').disabled=ZM.k<=1.001}}
function fitSoon(){clearTimeout(ZM.ft);ZM.ft=setTimeout(zoomFit,160)}
function zoomUser(u,piv){ZM.user=Math.max(1,Math.min(4,u));ZM.piv=piv||null;try{localStorage.setItem('eis-zoom',String(ZM.user))}catch(e){}fitSoon()}
(function(){var zc=el('div','zoomc');zc.id='zoomc';zc.setAttribute('role','group');zc.setAttribute('aria-label','Zoom the map');
  zc.innerHTML='<button type="button" data-z="-" aria-label="Zoom out">−</button><button type="button" data-z="fit" class="zl">100%</button><button type="button" data-z="+" aria-label="Zoom in">+</button>';document.body.appendChild(zc);
  zc.onclick=function(e){var b=e.target.closest('button');if(!b||b.disabled)return;var z=b.dataset.z;zoomUser(z==='fit'?1:ZM.user*(z==='+'?1.2:1/1.2))};
  var pan=null;STAGE.addEventListener('pointerdown',function(e){if(ZM.k<=1.001||e.button!==0||e.target.closest('button,a,input,select,textarea,.slot,.odel'))return;pan={x:e.clientX,y:e.clientY,l:STAGE.scrollLeft,t:STAGE.scrollTop,id:e.pointerId};STAGE.setPointerCapture(e.pointerId);STAGE.classList.add('panning');e.preventDefault()});
  STAGE.addEventListener('pointermove',function(e){if(!pan||e.pointerId!==pan.id)return;STAGE.scrollLeft=pan.l-(e.clientX-pan.x)/ZM.k;STAGE.scrollTop=pan.t-(e.clientY-pan.y)/ZM.k});
  var panEnd=function(e){if(!pan)return;try{STAGE.releasePointerCapture(pan.id)}catch(x){}pan=null;STAGE.classList.remove('panning')};STAGE.addEventListener('pointerup',panEnd);STAGE.addEventListener('pointercancel',panEnd);
  STAGE.addEventListener('wheel',function(e){if(VIEW==='classic'||G.compact)return;e.preventDefault();zoomUser(ZM.user*Math.exp(-e.deltaY*.0015),{x:e.clientX,y:e.clientY})},{passive:false})})();
function measureStage(){var w=STAGE.clientWidth*(ZM.k||1);if(w){var c=w<520||innerWidth<900;STAGE.classList.toggle('tq',!c&&w<800);STAGE.classList.toggle('tn',!c&&w<600);G.compact=c;STAGE.classList.toggle('compact',c)}layoutMothers();readPos();bakeCore();req()}

function bakeScene(){
  bake.width=W*DPR;bake.height=H*DPR;var c=bake.getContext('2d');c.setTransform(DPR,0,0,DPR,0,0);
  var mx=W/2,my=H*.42,big=Math.max(W,H);
  c.fillStyle='#060b18';c.fillRect(0,0,W,H);
  var g=c.createRadialGradient(mx,my,0,mx,my,big*.82);g.addColorStop(0,'#241f33');g.addColorStop(.22,'#121a33');g.addColorStop(.55,'#0a1226');g.addColorStop(1,'#060b18');c.fillStyle=g;c.fillRect(0,0,W,H);
  c.globalCompositeOperation='lighter';
  [['#86a9ff',.72,.2,.42],['#f5799a',.7,.86,.34],['#c4b5ff',.26,.2,.38],['#f3cf7a',.88,.52,.24],['#9fb3d9',.1,.62,.3]].forEach(function(h){var x=h[1]*W,y=h[2]*H,R=big*h[3],q=c.createRadialGradient(x,y,0,x,y,R);q.addColorStop(0,hexa(h[0],.1));q.addColorStop(1,hexa(h[0],0));c.fillStyle=q;c.fillRect(0,0,W,H)});
  var R=rnd(7),i;for(i=0;i<(W*H/4200|0);i++){var x=R()*W,y=R()*H,d=Math.hypot(x-mx,y-my)/big,z=R();c.fillStyle='rgba(205,220,255,'+(Math.max(.04,.3-d*.26)*z)+')';var s=z>.93?1.6:.8;c.fillRect(x,y,s,s)}
  c.globalCompositeOperation='source-over';
  var v=c.createRadialGradient(mx,my,big*.34,mx,my,big*.92);v.addColorStop(0,'rgba(3,5,12,0)');v.addColorStop(1,'rgba(3,5,12,.72)');c.fillStyle=v;c.fillRect(0,0,W,H);
  var n=document.createElement('canvas');n.width=n.height=160;var nc=n.getContext('2d'),im=nc.createImageData(160,160),r3=rnd(99);for(i=0;i<im.data.length;i+=4){var q2=r3()*255;im.data[i]=im.data[i+1]=im.data[i+2]=q2;im.data[i+3]=11}nc.putImageData(im,0,0);
  c.fillStyle=c.createPattern(n,'repeat');c.fillRect(0,0,W,H);bakeCore()}
var coreR=0;
function bakeCore(){var zs0=ZS;ZS=1;try{return bakeCore0()}finally{ZS=zs0}}
function bakeCore0(){var cr=Math.round(G.R*.62);if(cr===coreR||cr<8)return;coreR=cr;var i,sz=Math.ceil(cr*7);coreSp.width=coreSp.height=sz;var k=coreSp.getContext('2d'),o=sz/2;
  k.globalCompositeOperation='lighter';sp(k,'#ffb86b',o,o,cr*2.5,.5);sp(k,'#ffd9a0',o,o,cr*1.15,.9);
  var r2=rnd(21);for(i=0;i<150;i++){var a=r2()*Math.PI*2,l0=cr*(.14+r2()*.1),l1=cr*(.32+r2()*r2()*1.05);k.beginPath();k.moveTo(o+Math.cos(a)*l0,o+Math.sin(a)*l0);k.lineTo(o+Math.cos(a)*l1,o+Math.sin(a)*l1);k.strokeStyle='rgba(255,214,160,'+(.04+r2()*.15)+')';k.lineWidth=.6;k.stroke()}
  var st=k.createLinearGradient(o-cr*3,0,o+cr*3,0);st.addColorStop(0,'rgba(255,200,140,0)');st.addColorStop(.5,'rgba(255,225,190,.5)');st.addColorStop(1,'rgba(255,200,140,0)');k.fillStyle=st;k.fillRect(o-cr*3,o-.8,cr*6,1.6);G.coreSize=sz}

function pos(n){return POS[n]||POS.master}
/* routes: straight or one right angle, so a line never wanders over text */
function route(a,b,na,nb){return[[a.x,a.y],[b.x,b.y]];var sa=byName[na],sb=byName[nb];
  if(sa&&sb&&sa.role==='mother'&&sb.parent===na)return[[a.x,a.y],[a.x,b.y],[b.x,b.y]];
  if(sb&&sa&&sb.role==='mother'&&sa.parent===nb)return[[a.x,a.y],[b.x,a.y],[b.x,b.y]];
  return[[a.x,a.y],[b.x,b.y]]}
function plen(p){var l=0;for(var i=1;i<p.length;i++)l+=Math.hypot(p[i][0]-p[i-1][0],p[i][1]-p[i-1][1]);return l}
function pat(p,u){u=Math.max(0,Math.min(1,u));var d=plen(p)*u;for(var i=1;i<p.length;i++){var s=Math.hypot(p[i][0]-p[i-1][0],p[i][1]-p[i-1][1]);if(d<=s||i===p.length-1){var f=s?d/s:0;return[p[i-1][0]+(p[i][0]-p[i-1][0])*f,p[i-1][1]+(p[i][1]-p[i-1][1])*f]}d-=s}return p[0]}
function pline(p,c,al,w){if(al<=.01)return;cx.beginPath();cx.moveTo(p[0][0],p[0][1]);for(var i=1;i<p.length;i++)cx.lineTo(p[i][0],p[i][1]);cx.strokeStyle=c;cx.globalAlpha=Math.min(1,al);cx.lineWidth=w*ZS;cx.stroke();cx.globalAlpha=1}
function filament(p,c,al,strong){pline(p,c,al*.14,strong?5:3);pline(p,c,al*.85,strong?1.3:.9)}
function star4(x,y,r,a,c){r*=ZS;cx.globalAlpha=a;cx.fillStyle=c;cx.beginPath();for(var i=0;i<8;i++){var R=i%2?r*.26:r,an=i*Math.PI/4-Math.PI/2;cx.lineTo(x+Math.cos(an)*R,y+Math.sin(an)*R)}cx.closePath();cx.fill();cx.globalAlpha=1}
function roleShape(ctx,role,x,y,r){ctx.beginPath();if(role==='do'){for(var i=0;i<6;i++){var a=i*Math.PI/3+Math.PI/6;ctx.lineTo(x+Math.cos(a)*r*1.15,y+Math.sin(a)*r*1.15)}ctx.closePath()}else if(role==='eliminate'){ctx.rect(x-r*.9,y-r*.9,r*1.8,r*1.8)}else ctx.arc(x,y,r,0,7)}
function target(key,on){var a=VA[key];if(a==null)a=VA[key]=0;var k=reduce.matches?.45:.14;var v=a+((on?1:0)-a)*k;if(Math.abs(v-(on?1:0))<.004)v=on?1:0;else unsettled=true;VA[key]=v;return v}
var unsettled=false,ringA=0;

/* ---------- ambient (lab, 2026-11-07): slow, periodic, line-coloured breathing that says "the page is alive".
   It never draws a white-cored dot that travels once (that is how data looks: a light's position = time since an event).
   Runs only on a live run, in the visible tab, without reduced motion; with any of those off the page is static as before. */
var AMB={on:true,speed:1,ring:1,dial:1,core:1,lane:1,sess:1,line:1,done:1,flare:1,twinkle:1,lane:.2,spin:1,sway:1,mrot:1,demo:false};
function ambOn(){return !!AMB.on&&(LIVE||state.playing)&&VIEW!=='classic'&&!reduce.matches}
function ambAlive(){if(!ambOn())return false;if((M.sess.master||{}).born)return true;for(var n in M.sess)if(M.sess[n].working)return true;return false}
var ambClock=0,ambWall=0;
function ambT(){var n=Date.now();if(!ambWall)ambWall=n;ambClock+=(n-ambWall)*AMB.speed;ambWall=n;return ambClock}
function wave(t,period,phase){return .5-.5*Math.cos((t/period+phase)*Math.PI*2)}
function hash01(s){var h=2166136261;for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return(h>>>0)/4294967296}
function psub(p,u0,u1){u0=Math.max(0,u0);u1=Math.min(1,u1);if(u1<=u0)return null;var L=plen(p),d0=L*u0,d1=L*u1,out=[],acc=0;
  for(var i=1;i<p.length;i++){var x0=p[i-1][0],y0=p[i-1][1],x1=p[i][0],y1=p[i][1],s=Math.hypot(x1-x0,y1-y0),a=acc,b=acc+s;
    if(s&&b>=d0&&a<=d1){var f0=Math.max(0,(d0-a)/s),f1=Math.min(1,(d1-a)/s);if(!out.length)out.push([x0+(x1-x0)*f0,y0+(y1-y0)*f0]);out.push([x0+(x1-x0)*f1,y0+(y1-y0)*f1])}acc=b}
  return out.length>1?out:null}
/* master flare: an item reaching the master (a report or escalation light arriving, or a new tick on its queue) lights the star up and widens its glow, then it settles in about 2 s */
var flV=0,flW=0,lastQN=-1;
/* task flash: a new task, or a task changing state (claimed, done, moved to its mother's planet for you, ...) flashes the star too, but at
   most once every FLASH_GAP ms; changes inside the gap are gathered into one flash when it ends. Not on the first look at a run. */
var FLASH_GAP=5000,tSig=null,tFlashAt=0,tFlashDue=false;
function taskWatch(){var cur={},ch=false;TASKS.forEach(function(t){var k=(t._b?t._b.dataset.st:'')+'/'+((M.tasks[t.ref]||{}).holder||'');cur[t.ref]=k;if(tSig&&tSig[t.ref]!==k)ch=true});if(tSig&&ch)tFlashDue=true;tSig=cur}
function ambFlare(t){var now=performance.now();if(flW)flV*=Math.exp(-(now-flW)/1100);flW=now;
  if(tFlashDue&&now-tFlashAt>=FLASH_GAP){tFlashDue=false;tFlashAt=now;flV=Math.max(flV,.9)}
  M.pulses.forEach(function(p){if(p._fl||p.to!=='master')return;if((t-p.t)/p.ttl>=.96){p._fl=1;flV=1}});
  var qn=0,q=M.queue||{};for(var k in q)qn+=q[k];if(lastQN>=0&&qn>lastQN)flV=Math.max(flV,.75);lastQN=qn;return flV*AMB.flare}
/* queue twinkle: each tick dims now and then on its own rhythm and never goes out, so the ring reads as a field of stars */
var ambNowT=0,ambQ=false,ambN=0,ambDt=0,ambLast=0;
/* a session counts as busy while it works (or, with the lab's preview switch, while it is open) */
function busy(q){return !!q&&(q.working||(AMB.demo&&q.born&&!q.ended))}
function ambCount(){var n=0;S.forEach(function(s){if(s.role!=='master'&&busy(M.sess[s.name]))n++});return n}
function fr3(a,b,c){var x=Math.sin(a*12.9898+b*78.233+c*37.719)*43758.5453;return x-Math.floor(x)}
function twinkle(i,j,k){if(!ambQ||AMB.twinkle<=0)return 1;var r=fr3(i,j,k),w=wave(ambNowT,2600+r*4200,fr3(k,i,j));return 1-Math.min(.7,.62*AMB.twinkle)*w*w*w}
var desatC={},tintC={};
/* ---------- v3 orbits (lab, 2026-11-08): each mother is a planet with satellites on orbits, joined by lines of light.
   Orbit 1: tasks that wait for a person (Delegate), no line to the mother. Orbit 2: plans, each with up to two of its Do sessions beside it.
   Orbit 3: Do sessions with no plan (and Eliminate). A plan's third Do, and anything that finds its orbit 75% full, goes one orbit out at
   the same angle. Orbit n has radius n x r1; r1 grows when orbit 1 needs room. Items are placed by angle, so the orbits can turn (Orbit spin). */
var O_DSP=15,GF={},VP={},ORB={},ODEL={},DP={},DORD={},DSEQ=0,R1S={},orbKey='',O_SP=18,O_SPD=13,O_R1=22,O_FILL=.75;
function vdc(j){var f=0,b=.5;while(j){if(j&1)f+=b;j>>=1;b/=2}return f}

/* v3 arrangement: the sun in the middle of the map, the mothers' systems round it on an ellipse, all on one screen with no zoom. Open lists take
   the upper places, closed ones the lower. If blocks overlap or leave the map, the orbits and satellites shrink in steps (text stays full size). */
var ODS=1;
function orbOff(qs){STAGE.classList.remove('orbmode');qs.forEach(function(q){if(q){q.style.left='';q.style.top=''}});var c=$('corec');if(c){c.style.left='';c.style.top='';c.style.width='';c.style.height=''}var rb=$('ringbox');if(rb){rb.style.width='';rb.style.height=''}}
/* stable: each system's centre has a fixed anchor on the ellipse; anchors and the downsizing step are recomputed only when the number of
   mothers, their open/closed order or the map size changes. A growing system keeps its centre; blocks glide when an anchor moves. */
var RPA=Math.random()*Math.PI*2;/* the start line comes from a random direction off screen, new on each load */
var OA={key:'',anch:[],sun:0,n:0,na:0},SUN_MIN=70;
function osOff(q){var os=q&&q.querySelector('.osys');return os&&os.offsetWidth?{x:os.offsetLeft+os.offsetWidth/2,y:os.offsetTop+os.offsetHeight/2}:{x:q.offsetWidth/2,y:q.offsetHeight/2}}
function orbClash(){var zk=ZM.k||1,W=STAGE.clientWidth*zk,H=STAGE.clientHeight*zk,cxm=W/2,cym=H/2,c=[],GAP=8,HEAD=30,sr=(OA.sunR||SUN_MIN)+32;
  var CA=OA.anch;MOTHERS.forEach(function(n,i){var A=CA[i],L=ORB[n];if(A&&L&&$('q'+i)&&$('q'+i).classList.contains('qborn'))c.push({x:A.x,y:A.y,r:L.R})});
  for(var i=0;i<c.length;i++){var a=c[i];if(a.x-a.r<2||a.x+a.r>W-2||a.y-a.r-HEAD<2||a.y+a.r>H-2)return true;if(Math.hypot(a.x-cxm,a.y-cym)<a.r+sr+GAP)return true;
    for(var j=i+1;j<c.length;j++){var b=c[j];if(Math.hypot(a.x-b.x,a.y-b.y)<a.r+b.r+GAP)return true}}return false}
/* a mother system never jumps: its shown centre eases (time constant 650 ms) to the target in polar coordinates round the master, so it
   travels along an arc and never through the master; a mother born after the first layout comes out of the master. A resize snaps. */
var MANIM=false;
/* critically damped spring, exact for any frame gap: o[k] moves to tgt with velocity o[k+'v']; w sets the pace (w 4: about 1.3 s), it starts
   and stops gently and never overshoots. d0 is the current distance to the target (wrapped first for angles). */
function spring(o,k,tgt,d0,h,w){var v=o[k+'v']||0,b=v+w*d0,e=Math.exp(-w*h);o[k]=tgt+(d0+b*h)*e;o[k+'v']=(v-w*b*h)*e;return Math.abs(o[k]-tgt)>1e-4||Math.abs(o[k+'v'])>1e-3}
/* a mother system glides, it never jumps: its centre follows its anchor round the master in polar coordinates (along an arc, never through
   the master) on a spring, in the unturned frame, and the swing angle th is added afterwards, so swinging is not gliding. When the system's
   block must be pushed in from the map edge (its header or task row grew), that push glides too. A resize snaps. */
function orbAnchor(qs,AN,th){AN=OA.anch||AN;th=th==null?(OA.lastTh||0):th;var zk=ZM.k||1,W=STAGE.clientWidth*zk,H=STAGE.clientHeight*zk,cxm=W/2,cym=H/2,now=performance.now(),dt=OA.alt?Math.min(120,now-OA.alt):0;OA.alt=now;
  var h=dt/1000,snap=reduce.matches||STAGE.classList.contains('noanim'),cth=Math.cos(th),sth=Math.sin(th);OA.disp=OA.disp||[];var any=false;
  var dims=qs.map(function(q){return q?{w:q.offsetWidth,h:q.offsetHeight,o:osOff(q)}:null});
  qs.forEach(function(q,i){var A=AN[i];if(!q||!A)return;var born=q.classList.contains('qborn'),ta=Math.atan2(A.y-cym,A.x-cxm),tr=Math.hypot(A.x-cxm,A.y-cym),d=OA.disp[i];
    if(!born){OA.disp[i]=null;return}any=true;
    if(!d)d=OA.disp[i]=OA.seenQ&&!snap?{a:ta,r:0}:{a:ta,r:tr};
    if(snap||!h){if(snap){d.a=ta;d.r=tr;d.av=d.rv=0}}else{var m1=spring(d,'a',ta,Math.atan2(Math.sin(d.a-ta),Math.cos(d.a-ta)),h,4),m2=spring(d,'r',tr,d.r-tr,h,4);if((m1&&Math.abs(d.a-ta)*tr>.3)||(m2&&Math.abs(d.r-tr)>.3)||Math.abs(d.av||0)*tr>2||Math.abs(d.rv||0)>2)MANIM=true}
    var X0=Math.cos(d.a)*d.r,Y0=Math.sin(d.a)*d.r,X=cxm+X0*cth-Y0*sth,Y=cym+X0*sth+Y0*cth,o=dims[i].o,wq=dims[i].w,hq=dims[i].h;
    /* the edge push, as an offset of the centre that glides */
    var px=Math.max(2,Math.min(W-wq-2,X-o.x))-(X-o.x),py=Math.max(2,Math.min(H-hq-2,Y-o.y))-(Y-o.y);if(d.px==null||snap||!h){d.px=px;d.py=py;d.pxv=d.pyv=0}else{var m3=spring(d,'px',px,d.px-px,h,5),m4=spring(d,'py',py,d.py-py,h,5);if((m3&&Math.abs(d.px-px)>.3)||(m4&&Math.abs(d.py-py)>.3))MANIM=true}
    q.style.left=(X-o.x+d.px).toFixed(1)+'px';q.style.top=(Y-o.y+d.py).toFixed(1)+'px'});
  if(any)OA.seenQ=true}
function orbArrange(qs){STAGE.classList.add('orbmode');STAGE.style.gridTemplateColumns='';
  var zk=ZM.k||1,W=STAGE.clientWidth*zk,H=STAGE.clientHeight*zk,cxm=W/2,cym=H/2,core=$('corec'),rb=$('ringbox'),N=qs.length,rk=motherRank();
  var key=N+'|'+Math.round(W)+'x'+Math.round(H)+'|'+zk.toFixed(2);
  /* a window resize snaps; the map changing size inside the page (a panel growing) and a re-pack the page asked for (OA.key cleared: a system outgrew its room or touched the edge) glides */var win=innerWidth+'x'+innerHeight,sizeOnly=!!OA.key&&key!==OA.key&&OA.n===N&&OA.win!==win;OA.win=win;if(sizeOnly){STAGE.classList.add('noanim');clearTimeout(OA.na);OA.na=setTimeout(function(){STAGE.classList.remove('noanim')},700)}OA.n=N;
  if(key!==OA.key){OA.key=key;
    /* the sun is a circle in the middle; each system is a circle (its outer orbit) with its header above; every system takes the free place
       nearest to its own direction (open lists on top), searched outward ring by ring; nothing may touch. If one does not fit, all shrink a step. */
    var zf=1/Math.sqrt(zk);/* the master is largest at 100%; zoomed in it grows less than the rest */SUN_MIN=Math.round(Math.min(70,Math.max(44,Math.min(W,H)*.13))*zf);var sunR=Math.max(SUN_MIN,Math.min(W,H)*.18*zf),GAP=14,HEAD=30,ex=Math.max(1,Math.min(1.5,W/Math.max(1,H)*.7));
    var prefs=[];for(var i=0;i<N;i++)prefs.push(-Math.PI/2+Math.PI/N+i*2*Math.PI/N);prefs.sort(function(a,b){return Math.sin(a)-Math.sin(b)||Math.cos(a)-Math.cos(b)});
    /* biggest size first (up to 1.5x on a roomy map); the biggest system is placed first, each one at the free spot nearest the master
       (searched ring by ring outward, any direction, ties broken towards its own direction); nothing may touch */
    var steps=[1.5,1.35,1.2,1.1,1,.9,.8,.72,.64,.57,.5,.44,.38,.32,.27],ok=false;
    for(var si=0;si<steps.length&&!ok;si++){var ds=steps[si];ODS=ds;O_SP=21*ds;O_SPD=14*ds;O_R1=32*ds;O_DSP=Math.max(8,15*ds);STAGE.style.setProperty('--os',Math.max(8,Math.round(15*ds))+'px');STAGE.style.setProperty('--od',Math.max(7,Math.round(12*ds))+'px');orbitLayout();var last=si===steps.length-1;
      var sr=sunR*(ds<.6?.85:1),placed=[{x:cxm,y:cym,r:sr+32}],anch=[];ok=true;
      var order=rk.slice().sort(function(p,q2){var A=ORB[MOTHERS[p]],B=ORB[MOTHERS[q2]];return(B?B.R:0)-(A?A.R:0)});
      order.forEach(function(qi){if(!ok)return;var L=ORB[MOTHERS[qi]],rad=(L?L.R:60),a0=OA.prevAng&&OA.prevAng[qi]!=null?OA.prevAng[qi]:prefs[rk.indexOf(qi)],found=null;
        for(var rho=sr+32+rad+GAP;rho<Math.max(W,H)&&!found;rho+=5){var best=null,bd=9;
          for(var k=0;k<72;k++){var an=k*Math.PI/36,x=cxm+Math.cos(an)*rho*ex,y=cym+Math.sin(an)*rho;
            if(x-rad<12||x+rad>W-12||y-rad-HEAD<12||y+rad>H-12)continue;
            if(!placed.every(function(p){var dx=p.x-x,dy=p.y-y,need=p.r+rad+GAP;if(dx*dx+dy*dy<need*need)return false;return !(p.h&&Math.abs(dx)<p.r+rad&&y+rad>p.y-p.r-HEAD-4&&y-rad<p.y-p.r)}))continue;
            var d=Math.abs(Math.atan2(Math.sin(an-a0),Math.cos(an-a0)));if(d<bd){bd=d;best={x:x,y:y}}}
          if(best)found=best}
        if(!found&&last){var bo=Infinity;for(var rh2=sr+32+rad;rh2<Math.max(W,H);rh2+=8)for(var k2=0;k2<72;k2++){var an2=k2*Math.PI/36,x2=Math.max(rad+4,Math.min(W-rad-4,cxm+Math.cos(an2)*rh2*ex)),y2=Math.max(rad+HEAD+4,Math.min(H-rad-4,cym+Math.sin(an2)*rh2)),o2=0;
          placed.forEach(function(p){var dd=p.r+rad+GAP-Math.hypot(p.x-x2,p.y-y2);if(dd>0)o2+=dd});if(o2<bo){bo=o2;found={x:x2,y:y2}}}}
        if(!found){ok=false;return}if(last)ok=ok;placed.push({x:found.x,y:found.y,r:rad,h:1});anch[qi]=found});
      OA.anch=anch;OA.sunR=sr;OA.cur=null}
    if(!ok)OA.anch=OA.anch.map(function(a){return a||{x:cxm,y:cym}});OA.prevAng=null;OA.swing=swingMax();OA.packAt=performance.now()}
  orbAnchor(qs);
  var free=Infinity;qs.forEach(function(q){if(!q)return;var l=q.offsetLeft,t=q.offsetTop,r=l+q.offsetWidth,b=t+q.offsetHeight,dx=Math.max(l-cxm,0,cxm-r),dy=Math.max(t-cym,0,cym-b);free=Math.min(free,Math.max(dx,dy))});
  var Rs=OA.sunR||SUN_MIN,Rf=Rs,cf=Math.round(2*Rf+24);
  if(Math.abs(cf-OA.sun)>6)OA.sun=cf;cf=OA.sun;if(core){core.style.left=(cxm-cf/2)+'px';core.style.top=(cym-cf/2)+'px';core.style.width=cf+'px';core.style.height=cf+'px'}if(rb){rb.style.width=cf+'px';rb.style.height=cf+'px'}
  MG=null;return true}
/* a Delegate task shows on its mother's orbit only from the replay moment the scans first saw it (bug round 2026-11-13: none at T0) */
function delSeen(t){return t.quadrant==='C'&&!!(t.hist&&t.hist.length)&&Date.parse(t.hist[0].at)<=state.t}
function orbitSync(){STAGE.classList.toggle('early',!MOTHERS.some(function(n){return(M.sess[n]||{}).born}));var k=S.filter(function(x){return(M.sess[x.name]||{}).born}).map(function(x){return x.name}).join()+'|'+TASKS.filter(delSeen).map(function(t){return t.ref}).join();if(k!==orbKey){orbKey=k;orbitLayout();OANIM=true;posDirty=true;if(STAGE.classList.contains('orbmode')){if(orbClash()){OA.key='';layoutMothers()}else{OA.swing=swingMax();orbAnchor(MOTHERS.map(function(n,i){return $('q'+i)}))}qFollow(reduce.matches?0:650)}}}
function orbitLayout(){MOTHERS.forEach(function(n){var os=$('os-'+n);if(!os)return;var ms=byName[n];
  var kids=childrenOf(n).filter(function(x){return x.role!=='eliminate'&&(M.sess[x.name]||{}).born}).sort(function(a,b){return a.t0-b.t0});
  var del=TASKS.filter(function(t){return t.list===ms.list&&delSeen(t)});/* the board's Delegate quadrant, nothing inherited (T5, runs.js delegated) */
  del.forEach(function(t){if(DORD[t.ref]==null)DORD[t.ref]=DSEQ++});del.sort(function(a,b){return DORD[a.ref]-DORD[b.ref]});var st1=R1S[n]&&R1S[n].ds===ODS?R1S[n].r:0;var D=del.length,r1=Math.max(st1,O_R1,Math.max(15,20*ODS),D*O_DSP/(2*Math.PI));R1S[n]={ds:ODS,r:r1};var occ={},cnt={},items={},maxO=D?1:0,planAt={},planKids={},un=0;
  var cap=function(o){return Math.max(6,Math.floor(2*Math.PI*o*r1/O_SP))},full=function(o){return(cnt[o]||0)>=Math.floor(cap(o)*O_FILL)};
  var take=function(o,i){var c=cap(o);i=((i%c)+c)%c;(occ[o]=occ[o]||[])[i]=1;cnt[o]=(cnt[o]||0)+1;if(o>maxO)maxO=o;return{o:o,i:i,c:c}};
  var isFree=function(o,i){var c=cap(o);return !(occ[o]||[])[((i%c)+c)%c]};
  var near=function(o,frac){for(;o<40;o++){if(full(o))continue;var c=cap(o),i0=Math.round(frac*c);for(var d=0;d<c;d++){var off=d===0?0:(d%2?(d+1)/2:-d/2);if(isFree(o,i0+off))return take(o,i0+off)}}return take(o,0)};
  var capD=Math.max(6,Math.floor(2*Math.PI*r1/O_DSP)),takeD=function(i){i=((i%capD)+capD)%capD;(occ[1]=occ[1]||[])[i]=1;if(1>maxO)maxO=1;return{o:1,i:i,c:capD}};
  del.forEach(function(t){var c1=capD,i0=Math.round(vdc(DORD[t.ref]%64)*c1);for(var d=0;d<c1;d++){var off=d===0?0:(d%2?(d+1)/2:-d/2);var ii=((i0+off)%c1+c1)%c1;if(!(occ[1]||[])[ii]){items['t:'+t.ref]=takeD(ii);break}}if(!items['t:'+t.ref])items['t:'+t.ref]=takeD(i0)});
  /* Orbit 1: delegated tasks only. From orbit 2 out: plans and Do sessions. A family is a plan with its Do sessions, or a Do with no plan;
     the families follow each other round the circle in start order, so a family's lines of light stay in its own slice and do not cross
     another family's. Each item tries orbit 2 at its angle (a child: its parent's orbit) and moves out one orbit while it would touch a
     neighbour; when an orbit is full the next one opens. Items may move between orbits as the day grows; they glide there. */
  var fams=[],famAt={};kids.forEach(function(x){VP[x.name]=n;var f=x.role==='do'&&x.num!=null?famAt[x.num]:null;
    if(f&&f.items[0].t0<=x.t0){f.items.push(x);VP[x.name]=f.items[0].name}else{f={items:[x]};fams.push(f);if(x.role==='plan')famAt[x.num]=f}});
  var seq=[];fams.forEach(function(f){f.items.forEach(function(x){seq.push(x)})});var T=Math.max(seq.length,6),onO={};
  seq.forEach(function(x,i){var frac=(i+.5)/T,par=VP[x.name]!==n?items[VP[x.name]]:null,o=par?Math.max(2,par.o):2;
    for(;o<40;o++){var g=O_SP/(o*r1)/(2*Math.PI),lst=onO[o]||(onO[o]=[]);if(lst.every(function(f2){var d=Math.abs(f2-frac);d=Math.min(d,1-d);return d>=g}))break}
    (onO[o]=onO[o]||[]).push(frac);if(o>maxO)maxO=o;items[x.name]={o:o,i:frac,c:1}});
  maxO=Math.max(2,maxO);var R=maxO*r1+10,ocnt={};Object.keys(items).forEach(function(k2){var o2=items[k2].o;ocnt[o2]=(ocnt[o2]||0)+1});var nIt=Object.keys(items).length;GF[n]=Math.max(.3,Math.min(1,1/(1+Math.max(0,nIt-8)/10+Math.max(0,maxO-2)*.15)));var pv=ORB[n];ORB[n]={r1:r1,maxO:maxO,R:R,items:items,cnt:ocnt,ph:hash01(n),cur:pv&&pv.cur,seen:pv&&pv.seen,lt:pv&&pv.lt};os.style.width=os.style.height=Math.round(2*R)+'px';
  kids.forEach(function(x){var b=SLOT[x.name];if(b&&b.parentNode!==os)os.appendChild(b)});
  /* a child not born at this replay moment leaves the orbit (it came back after rebuild() with its old place): appended again once born */
  childrenOf(n).forEach(function(x){var b=SLOT[x.name];if(b&&b.parentNode===os&&kids.indexOf(x)<0)os.removeChild(b)});
  var keep={};del.forEach(function(t){keep[t.ref]=1;if(!ODEL[t.ref]){var e=el('span','odel');e.setAttribute('aria-hidden','true');e.innerHTML=glyph('waits_for_person',9);e.title='#'+t.num+' '+t.title+' - in Delegate, waits for you';ODEL[t.ref]=e}if(ODEL[t.ref].parentNode!==os)os.appendChild(ODEL[t.ref])});
  Object.keys(ODEL).forEach(function(r){var e=ODEL[r];if(e.parentNode===os&&!keep[r])os.removeChild(e)});
  orbitPlace(n,0)})}
/* each satellite eases towards its place in polar coordinates: it slides along the orbit (shortest way round) and in or out between orbits;
   a new one starts at its mother's centre and travels out. The first layout of a system (page load) places everything directly. */
var OANIM=false;
function orbitPlace(n,t){var L=ORB[n];if(!L)return;var now=performance.now(),dt=L.lt?Math.min(120,now-L.lt):0;L.lt=now;var h=dt/1000,first=!L.seen;L.seen=true;L.cur=L.cur||{};
  Object.keys(L.items).forEach(function(key){var it=L.items[key],rot=t&&AMB.spin>0?(t*AMB.spin*Math.PI*2/(60000*Math.pow(it.o,.8)*(1+(L.cnt[it.o]||0)/6))+L.ph*7):0,ta=-Math.PI/2+it.i/it.c*Math.PI*2,tr=it.o*L.r1,c=L.cur[key];/* eased in the system's unturned frame; the spin (rot) is added when drawn */
    if(!c)c=L.cur[key]=first||reduce.matches?{a:ta,r:tr}:{a:ta,r:0,b0:now};
    if(c.b0!=null){var u=Math.min(1,(now-c.b0)/1800),ez=u<.5?4*u*u*u:1-Math.pow(-2*u+2,3)/2;c.a=ta;c.r=tr*ez;if(u>=1)delete c.b0;else OANIM=true}else{
    if(reduce.matches){c.a=ta;c.r=tr;c.av=c.rv=0}else if(h){var m1=spring(c,'a',ta,Math.atan2(Math.sin(c.a-ta),Math.cos(c.a-ta)),h,7),m2=spring(c,'r',tr,c.r-tr,h,7);if((m1&&Math.abs(c.a-ta)*tr>.3)||(m2&&Math.abs(c.r-tr)>.3)||Math.abs(c.av||0)*tr>2||Math.abs(c.rv||0)>2)OANIM=true}}
    var e=key.slice(0,2)==='t:'?ODEL[key.slice(2)]:SLOT[key];if(!e)return;var aa=c.a+rot,x=L.R+Math.cos(aa)*c.r,y=L.R+Math.sin(aa)*c.r;(L.loc||(L.loc={}))[key]={x:x,y:y};
    /* moved by transform through two custom properties: no layout, and nothing is read back from the page here */
    e.style.setProperty('--ox',x.toFixed(1)+'px');e.style.setProperty('--oy',y.toFixed(1)+'px')});
  Object.keys(L.cur).forEach(function(k){if(!L.items[k]){delete L.cur[k];if(L.loc)delete L.loc[k]}})}
var ELS={},ELS_READY=false,EFX=[];
function elimWatch(){S.forEach(function(s){if(s.role!=='eliminate')return;var q=M.sess[s.name]||{},k=q.born?(q.ended?2:1):0,was=ELS[s.name];ELS[s.name]=k;
    if(!ELS_READY||was===k||k===0)return;var L=ORB[s.parent];if(!L)return;var a=Math.PI*2*fr3(s.name.length,was||0,k),n0=k===2?2:1;
    for(var j=0;j<n0;j++)EFX.push({m:s.parent,a:a+j*.9,t0:performance.now()+j*450,c:k===2?'#b4bcc8':'#8a93a3'})});ELS_READY=true}
function drawEfx(){var now=performance.now();EFX=EFX.filter(function(e){return now-e.t0<2200});EFX.forEach(function(e){var L=ORB[e.m],p=POS[e.m];if(!L||!p||!L.sc)return;var u=(now-e.t0)/2200;if(u<0)return;
  var r0=(L.maxO*L.r1+6)*L.sc,dr=r0+u*18*L.sc,x=p.x+Math.cos(e.a)*dr,y=p.y+Math.sin(e.a)*dr+u*u*14;
  if(u<.28){var b=1-u/.28*.2;cx.globalCompositeOperation='source-over';cx.globalAlpha=b;cx.fillStyle=e.c;cx.fillRect(x-4,y-4,8,8);cx.strokeStyle='#fff';cx.lineWidth=.6;cx.strokeRect(x-4,y-4,8,8);cx.globalAlpha=1;cx.globalCompositeOperation='lighter';return}
  var v=(u-.28)/.72,R=rnd(Math.round(e.a*1000));if(v<.25)sp(cx,'#ffffff',x,y,16*(1-v*4)+4,.6*(1-v*4));cx.globalCompositeOperation='source-over';
  for(var k=0;k<9;k++){var ang=R()*Math.PI*2,sp2=(10+R()*22)*v,fx=x+Math.cos(ang)*sp2,fy=y+Math.sin(ang)*sp2+v*v*16,sz=1+R()*2.4;cx.globalAlpha=Math.max(0,1-v);cx.fillStyle=k%3?e.c:'#ffd9a0';cx.save();cx.translate(fx,fy);cx.rotate(v*6*(R()-.5));cx.fillRect(-sz/2,-sz/2,sz,sz);cx.restore()}
  cx.globalAlpha=1;cx.globalCompositeOperation='lighter'})}
function turned(th){var zk=ZM.k||1,cxm=STAGE.clientWidth*zk/2,cym=STAGE.clientHeight*zk/2,c=Math.cos(th),sn=Math.sin(th);return OA.anch.map(function(A){if(!A)return A;var dx=A.x-cxm,dy=A.y-cym;return{x:cxm+dx*c-dy*sn,y:cym+dx*sn+dy*c}})}
function edgeHit(AN){var zk=ZM.k||1,W=STAGE.clientWidth*zk,H=STAGE.clientHeight*zk;for(var i=0;i<AN.length;i++){var A=AN[i],L=ORB[MOTHERS[i]];if(!A||!L||!$('q'+i)||!$('q'+i).classList.contains('qborn'))continue;if(A.x-L.R<4||A.x+L.R>W-4||A.y-L.R-30<4||A.y+L.R>H-4)return true}return false}
/* the largest swing (up to 12 degrees each way, checked every degree) the packed systems can turn round the master without touching the
   map edge, the sun or each other; 0 when there is no room. Cheap: a few circle checks, so it is re-measured whenever the systems change. */
function swingMax(){if(!OA.anch||!OA.anch.length)return 0;var zk=ZM.k||1,W=STAGE.clientWidth*zk,H=STAGE.clientHeight*zk,cxm=W/2,cym=H/2,HEAD=30,GAP=14,sr=(OA.sunR||SUN_MIN)+32,circ=[];
  OA.anch.forEach(function(A,qi){var L=ORB[MOTHERS[qi]],q=$('q'+qi);if(A&&L&&q&&q.classList.contains('qborn'))circ.push({x:A.x,y:A.y,r:L.R})});if(!circ.length)return 0;
  var fits=function(th){var c=Math.cos(th),sn=Math.sin(th);for(var i=0;i<circ.length;i++){var p=circ[i],dx=p.x-cxm,dy=p.y-cym,x=cxm+dx*c-dy*sn,y=cym+dx*sn+dy*c;
      if(x-p.r<4||x+p.r>W-4||y-p.r-HEAD<4||y+p.r>H-4)return false;if(Math.hypot(dx,dy)<p.r+sr+GAP)return false}return true};
  var best=0;for(var dg=1;dg<=12;dg++){var t=dg*Math.PI/180;if(fits(t)&&fits(-t))best=t;else break}return best}
/* the mother systems swing together round the master and back, within the angle measured at packing (never a full turn, so they never run
   into the map edge and the map never re-packs because of the motion). "Mother orbit" sets the speed (one swing in about 4 min at 1),
   "Mother sway" the share of the room used. The map re-packs only when the systems themselves change (orbitSync), at most every 10 s here. */
function orbSway(at){if(!STAGE.classList.contains('orbmode')||!OA.anch||!OA.anch.length)return false;
  var tgt=(OA.swing||0)*Math.max(0,Math.min(1,AMB.sway)),now0=performance.now(),dta=OA.at0?Math.min(200,now0-OA.at0):0;OA.at0=now0;
  /* the room can shrink when a system grows: the swing narrows over a few seconds instead of snapping, so nothing steps */
  OA.amp=OA.amp==null||reduce.matches?tgt:OA.amp+(tgt-OA.amp)*(1-Math.exp(-dta/2500));var amp=OA.amp,sp=AMB.mrot>0?AMB.mrot:0,th=amp&&sp?amp*Math.sin(at*sp*Math.PI*2/240000+1.3):0;
  if(!th&&!OA.cur)return false;var AN=turned(th);OA.cur=AN;OA.lastTh=th;
  var now=performance.now();if(now-(OA.chk||0)>1500){OA.chk=now;if(edgeHit(AN)){OA.swing=swingMax();
    if(edgeHit(OA.anch)&&now-(OA.packAt||0)>10000){var zk=ZM.k||1,cxm=STAGE.clientWidth*zk/2,cym=STAGE.clientHeight*zk/2;OA.prevAng=AN.map(function(A){return A?Math.atan2(A.y-cym,A.x-cxm):null});STAGE.classList.add('repack');clearTimeout(OA.rpT);OA.rpT=setTimeout(function(){STAGE.classList.remove('repack')},900);OA.key='';layoutMothers();return true}}}
  orbAnchor(MOTHERS.map(function(n,i){return $('q'+i)}),null,th);return true}
function drawOrbits(amb,at){var mv=MANIM;MANIM=false;var swd=amb&&orbSway(at);if(!swd&&mv)orbAnchor(MOTHERS.map(function(n,i){return $('q'+i)}));if((swd||mv)&&!(AMB.spin>0))readPos();STAGE.classList.toggle('spinning',!!(amb&&AMB.spin>0));elimWatch();drawEfx();if((amb&&AMB.spin>0)||OANIM){OANIM=false;MOTHERS.forEach(function(n){orbitPlace(n,amb?at:0)});readPos()}
  MOTHERS.forEach(function(n){var L=ORB[n],p=POS[n];if(!L||!L.sc||!p)return;var qa=target('ob'+n,(M.sess[n]||{}).born);if(qa<=0)return;
    for(var o=1;o<=L.maxO;o++){var al=(amb?.07+.08*wave(at,13000+o*2300,hash01(n)+o*.23):.1)*qa;cx.beginPath();cx.arc(p.x,p.y,o*L.r1*L.sc,0,Math.PI*2);cx.strokeStyle='rgba(168,176,194,'+al.toFixed(3)+')';cx.lineWidth=ZS;cx.stroke()}});
  Object.keys(DP).forEach(function(r){var d=DP[r];sp(cx,'#f4ad4e',d.x,d.y,7,.32*(amb?.75+.25*wave(at,3800,hash01(r)):1))})}

function tint(hex,k){var key=hex+k;if(tintC[key])return tintC[key];var n=parseInt(hex.slice(1),16),f=function(v){return Math.round(v+(255-v)*k)};return tintC[key]='#'+((1<<24)+(f(n>>16)<<16)+(f((n>>8)&255)<<8)+f(n&255)).toString(16).slice(1)}
function desat(hex){if(desatC[hex])return desatC[hex];var n=parseInt(hex.slice(1),16),r=n>>16,g=(n>>8)&255,b=n&255,l=.3*r+.59*g+.11*b,k=.62;
  var f=function(v){return Math.round((v+(l-v)*k)*.78)};return desatC[hex]='#'+((1<<24)+(f(r)<<16)+(f(g)<<8)+f(b)).toString(16).slice(1)}
/* layer 1: residual light on the master's outer ring (a fading tail, no head dot) and a slow dial outside it */
function ambRing(m,R0,t,a){var lap=26000,h=(t/lap%1)*Math.PI*2-Math.PI/2,tail=1.15;
  if(AMB.ring>0){var g=cx.createConicGradient(h-tail,m.x,m.y),f=tail/(Math.PI*2);g.addColorStop(0,'rgba(255,217,160,0)');g.addColorStop(f*.6,'rgba(255,224,178,'+Math.min(1,.22*AMB.ring*a)+')');g.addColorStop(f,'rgba(255,240,214,'+Math.min(1,.9*AMB.ring*a)+')');g.addColorStop(Math.min(1,f+.002),'rgba(255,217,160,0)');g.addColorStop(1,'rgba(255,217,160,0)');
    cx.strokeStyle=g;cx.lineWidth=6;cx.globalAlpha=.4;cx.beginPath();cx.arc(m.x,m.y,R0,h-tail,h);cx.stroke();cx.globalAlpha=1;cx.lineWidth=1.8;cx.beginPath();cx.arc(m.x,m.y,R0,h-tail,h);cx.stroke()}
  if(AMB.dial>0){var R2=R0+9,rot=t/240000*Math.PI*2;cx.setLineDash([1.5,10.5]);cx.lineDashOffset=0;cx.save();cx.translate(m.x,m.y);cx.rotate(rot);cx.beginPath();cx.arc(0,0,R2,0,Math.PI*2);cx.strokeStyle='rgba(255,217,160,'+Math.min(1,.4*AMB.dial*a)+')';cx.lineWidth=1.3;cx.stroke();cx.restore();cx.setLineDash([])}}
/* layer 1 on the compositor: the ring light and the dial are two DOM rings over #ringbox that CSS rotates (transform) and breathes (opacity),
   so they move at the screen's own rate with no main-thread work. JS only sets their size and the activity level, and only when they change. */
var ambEl=null,ambKey='';
function ambDom(amb,mast){var root=document.documentElement,rb=$('ringbox');if(!amb||!rb||!(mast&&mast.born)){if(root.classList.contains('amb-live'))root.classList.remove('amb-live');return}
  if(!ambEl||ambEl.parentNode!==rb){ambEl=el('div','amb');ambEl.setAttribute('aria-hidden','true');ambEl.innerHTML='<div class="amb-rw"><div class="amb-ring"></div></div><div class="amb-dw"><div class="amb-dial"></div></div>';rb.insertBefore(ambEl,rb.firstChild);ambKey=''}
  var n=0;for(var k in M.sess)if(k!=='master'&&M.sess[k].working)n++;if(AMB.demo)S.forEach(function(s){var q=M.sess[s.name];if(s.role!=='master'&&q&&q.born&&!q.ended&&!q.working)n++});
  var lvl=Math.min(1,.42+(mast.working?.3:0)+Math.min(.3,n*.06)),rgb=mast.working?'255,206,150':n?'255,218,178':'255,230,204';
  var key=[Math.round(G.R),ZM.k,lvl.toFixed(2),rgb,AMB.ring,AMB.dial,AMB.speed].join('|');if(!root.classList.contains('amb-live'))root.classList.add('amb-live');if(key===ambKey)return;ambKey=key;
  var st=ambEl.style,zk=ZM.k||1;st.setProperty('--r',((G.R+6*zk)/zk+5).toFixed(1)+'px');st.setProperty('--lvl',(lvl*AMB.ring).toFixed(3));st.setProperty('--dlvl',((.45+.4*lvl)*AMB.dial).toFixed(3));st.setProperty('--rgb',rgb);
  st.setProperty('--lap',(26/AMB.speed).toFixed(2)+'s');st.setProperty('--dlap',(240/AMB.speed).toFixed(1)+'s');st.setProperty('--blap',(13/AMB.speed).toFixed(2)+'s')}
/* layer 2: a soft band of light flows from each mother down the line to every child that is still open, one child after another */
var LPH={},LACT={};
function ambLanes(t){if(AMB.lane<=0)return;var idx={};LACT={};
  S.forEach(function(s){var pm=s.parent&&byName[s.parent];if(pm&&pm.role==='mother'&&busy(M.sess[s.name]))LACT[s.parent]=(LACT[s.parent]||0)+1});
  S.forEach(function(ms){if(ms.role!=='mother')return;var mn=ms.name,a=Math.min(3,LACT[mn]||0),mw=busy(M.sess[mn])?1:0;if(LPH[mn]==null)LPH[mn]=hash01(mn);LPH[mn]+=ambDt/(7000/(1+.55*a+.3*mw))});
  S.forEach(function(s){var pm=s.parent&&byName[s.parent];if(!pm||pm.role!=='mother')return;var q=M.sess[s.name]||{},qm=M.sess[s.parent]||{};if(!q.born||(q.ended&&!q.working))return;
    var i=idx[s.parent]=(idx[s.parent]||0)+1,a=Math.min(3,LACT[s.parent]||0),k=Math.min(1,.3+.17*a+(busy(qm)?.2:0))*(busy(q)?1:.6),u=((LPH[s.parent]||0)-i*.11)%1;if(u<0)u+=1;u=u*1.25;if(u>1.18)return;
    var vp=VP[s.name]||s.parent,P=route(pos(vp),pos(s.name),vp,s.name),c=tint(ROLEC[s.role]||'#c4b5ff',.5),al=AMB.lane*k*(GF[s.parent]||1),band=.24;
    [[band,band*.6,.12],[band*.6,band*.3,.26],[band*.3,0,.45]].forEach(function(z){var seg=psub(P,u-z[0],u-z[1]);if(seg){pline(seg,c,Math.min(1,z[2]*al*1.6),2);pline(seg,c,z[2]*al*.4,7)}})})}

/* the master queue: one sector per state in fixed order, one arc per list, one tick per task */
function drawQueueRing(m){var R=G.R,n=STATES.length,gap=.07,span=Math.PI*2/n,q=M.queue||{};
  STATES.forEach(function(x,i){var a0=-Math.PI/2+i*span+gap/2,a1=a0+span-gap;
    cx.beginPath();cx.arc(m.x,m.y,R+1,a0,a0+(a1-a0)*ringA);cx.strokeStyle=hexa(x.c,.32);cx.lineWidth=ZS;cx.stroke();
    var lit=state.litQ&&state.litQ.st===x.k;
    LISTS.forEach(function(l,j){var c=q[l+'|'+x.k]||0;if(!c)return;var r=R-5*ZS-j*Math.max(4.2*ZS,R*.05),lf=lit&&(!state.litQ.l||state.litQ.l===l);var step=Math.min((a1-a0)/Math.max(c,1),.085);for(var t=0;t<c;t++){var an=a0+step*(t+.5);cx.beginPath();cx.moveTo(m.x+Math.cos(an)*(r-1.7*ZS),m.y+Math.sin(an)*(r-1.7*ZS));cx.lineTo(m.x+Math.cos(an)*(r+1.7*ZS),m.y+Math.sin(an)*(r+1.7*ZS));cx.strokeStyle=x.c;cx.globalAlpha=(lf?1:state.litQ?.3:.86*twinkle(i,j,t))*ringA;cx.lineWidth=(lf?3:2)*ZS;cx.stroke();cx.globalAlpha=1}})});
}
function draw(wall){if(VIEW==='classic'||!bake.width||!bake.height||!cv.width||!cv.height)return;
  ZS=(ZM&&ZM.k)||1;unsettled=false;var t=state.t,amb=ambAlive(),at=amb?ambT():0,fl=amb?ambFlare(t):0;ambDt=ambLast&&at>=ambLast?Math.min(250,at-ambLast):0;ambLast=at;ambNowT=at;ambQ=amb;ambN=amb?ambCount():0;
  cx.setTransform(1,0,0,1,0,0);cx.drawImage(bake,0,0);cx.setTransform(DPR,0,0,DPR,0,0);
  if(!POS.master)return;
  var sr=STAGE.getBoundingClientRect();cx.save();if(G.compact){cx.beginPath();cx.rect(sr.left,sr.top,sr.width,sr.height);cx.clip()}
  var mast=M.sess.master||{},selS=state.sel?byName[state.sel]:null,m=POS.master;
  ambDom(amb,mast);
  cx.globalCompositeOperation='lighter';
  var ra=target('routine',M.routine),rbig=Math.hypot(innerWidth,innerHeight),rp={x:m.x+Math.cos(RPA)*rbig,y:m.y+Math.sin(RPA)*rbig};
  
  var ma=target('master',mast.born),awake=target('awake',!!mast.working),live=S.reduce(function(a,s){return a+((M.sess[s.name]||{}).working?1:0)},0);
  if(ra>0&&ma<1){var u=Math.min(1,(t-RT)/14000);if(u>0)filament([[rp.x,rp.y],[rp.x+(m.x-rp.x)*u,rp.y+(m.y-rp.y)*u]],'#9fd6ff',.8*(1-ma))}
  if(ma>0&&G.coreSize){var bamp=AMB.core*(.3+.7*Math.min(1,ambN/6))*(1-.85*Math.min(1,fl)),br=amb?bamp*((wave(at,7400,0)-.5)+(wave(at,2300,.3)-.5)*.6):0,cs=G.coreSize*(.46+.42*awake+.12*Math.min(1,live/7))*(1+.11*br+.38*fl);cx.globalAlpha=Math.min(1,ma*(.5+.5*awake)*(1+.3*br)*(.72+.28*SUN)+.6*fl);cx.drawImage(coreSp,m.x-cs/2,m.y-cs/2,cs,cs);cx.globalAlpha=1;sp(cx,'#ffc98a',m.x,m.y,G.R*.26*(1+awake*.6)*(1+.12*br),ma);if(fl>.01){sp(cx,'#ffd9a0',m.x,m.y,G.R*(.75+.55*fl),.5*fl*ma);sp(cx,'#fff6e8',m.x,m.y,G.R*.3*(1+fl),.95*fl*ma)}}
  ringA=target('ring',mast.born);
  if(ringA>0){var R0=G.R+6*ZS;[[8,.035],[3,.09],[1.1,.52]].forEach(function(w){cx.beginPath();cx.arc(m.x,m.y,R0,-Math.PI/2,-Math.PI/2+Math.PI*2*ringA);cx.strokeStyle='rgba(255,217,160,'+w[1]*(.55+.45*awake)+')';cx.lineWidth=w[0]*ZS;cx.stroke()});
    if(awake>.05){var hs=((t-T0)/90000)%(Math.PI*2);sp(cx,'#ffe2b8',m.x+Math.cos(hs)*R0,m.y+Math.sin(hs)*R0,16,.9*awake*ringA)}
    cx.globalCompositeOperation='source-over';drawQueueRing(m);cx.globalCompositeOperation='lighter'}
  drawOrbits(amb,at);
  /* tree: master to mother straight; mother to lane with one right angle; along a lane straight */
  S.forEach(function(s){if(!s.parent||(s.role!=='mother'&&!POS[s.name]))return;var q=M.sess[s.name],a=target('ln'+s.name,q&&q.born);if(a<=0)return;if(s.role==='mother'&&G.compact)return;var pp=VP[s.name]||s.parent,w=q&&(q.working||(AMB.demo&&ambOn()&&q.born&&!q.ended)),en=q&&q.ended&&!w,lb=amb&&!en&&AMB.line>0?1+.32*AMB.line*(wave(at,9500,hash01(s.name))-.5)*2:1;filament(route(pos(pp),pos(s.name),pp,s.name),en&&AMB.done?desat(ROLEC[s.role]):ROLEC[s.role],a*(w?.62:(en?.12:.26))*lb*(s.role==='mother'?1:(.4+.6*(GF[s.parent]||1))))});
  if(amb)ambLanes(at);
  if(selS){var q0=selS;while(q0&&q0.parent){var p0=VP[q0.name]||q0.parent;if(!(q0.role==='mother'&&G.compact))filament(route(pos(p0),pos(q0.name),p0,q0.name),'#ffe9c9',.85,true);q0=byName[p0]}}
  /* plan handed to do: the gold seal between them, its steps open as a constellation */
  M.handoffs.forEach(function(h){var A=pos(h.from),B=pos(h.to),a=target('hf'+h.from,true),mx=(A.x+B.x)/2,my=(A.y+B.y)/2;cx.setLineDash([2,5]);pline([[A.x,A.y],[B.x,B.y]],'#f3cf7a',.5*a,1);cx.setLineDash([]);sp(cx,'#f3cf7a',mx,my,7,.9*a);
    var pl=byName[h.from],ns=pl&&pl.report&&(pl.report.text.match(/(\d+) steps/)||[])[1],fresh=(t-h.t)/150000,isSel=selS&&(selS.name===h.from||selS.name===h.to);
    if(ns&&(isSel||(fresh>=0&&fresh<1))){var c2=target('cn'+h.from,true),nn=+ns,R=rnd(nn*131),pts=[];for(var i=0;i<nn;i++){var uu=(i+1)/(nn+1);pts.push([A.x+(B.x-A.x)*uu+(R()-.5)*5,A.y+(B.y-A.y)*uu-Math.sin(uu*Math.PI)*15-R()*5])}
      cx.beginPath();pts.forEach(function(z,i){i?cx.lineTo(z[0],z[1]):cx.moveTo(z[0],z[1])});cx.strokeStyle='rgba(190,210,255,.5)';cx.lineWidth=.8;cx.globalAlpha=c2;cx.stroke();cx.globalAlpha=1;pts.forEach(function(z){sp(cx,'#c8d8ff',z[0],z[1],7,c2)})}});
  /* task light: a taken task sends a spark that orbits its session; the chip and the list row stay put */
  TASKS.forEach(function(k){var st=M.tasks[k.ref],p=CHP[k.ref]||(st&&st.holder?POS[st.holder]:null);if(!p)return;var ts=k._b.dataset.st,a=target('s'+k.ref,true);
    if(ts==='can_be_taken'&&CHP[k.ref])sp(cx,'#dfe9ff',p.x,p.y,13,.55*a);
    if(k._b.classList.contains('lit')&&CHP[k.ref])sp(cx,'#ffffff',p.x,p.y,20,.7);
    if(st&&st.holder&&POS[st.holder]){var o=POS[st.holder],fr=reduce.matches?1:Math.min(1,(t-st.tc)/60000),e=1-Math.pow(1-fr,3),an=((t-st.tc)/26000)%(Math.PI*2),ox=o.x+Math.cos(an)*15,oy=o.y+Math.sin(an)*12,x=p.x+(ox-p.x)*e,y=p.y+(oy-p.y)*e;if(CHP[k.ref]){var tb2=amb&&AMB.sess>0?AMB.sess*(wave(at,3000,hash01(k.ref))-.5):0;sp(cx,'#ffd9a0',p.x,p.y,15*(1+.18*tb2),.6*(1+.55*tb2))}if(fr<1){for(var j=1;j<7;j++){var e2=1-Math.pow(1-Math.max(0,fr-j*.03),3);sp(cx,'#ffefd0',p.x+(ox-p.x)*e2,p.y+(oy-p.y)*e2,8-j,.5-.06*j)}}sp(cx,'#fff1d6',x,y,10,a);star4(x,y,5,a,'#ffffff')}});
  M.pulses=M.pulses.filter(function(p){return t-p.t<=p.ttl});
  M.pulses.forEach(function(p){var f=(t-p.t)/p.ttl;if(f<0)return;drawPulse(p,reduce.matches?.55:f)});
  M.pings=M.pings.filter(function(q){return t-q.t<22000});
  M.pings.forEach(function(q){var f=(t-q.t)/22000,o=pos(q.s);if(byName[q.s].role==='master')return;sp(cx,q.say?'#fff4dc':ROLEC[byName[q.s].role],o.x,o.y,(q.say?26:16)*(.4+f),(1-f)*(q.say?.7:.45))});
  cx.globalCompositeOperation='source-over';
  S.forEach(function(s){if(s.role==='master')return;var q=M.sess[s.name],a=target('o'+s.name,q&&q.born),o=POS[s.name];if(a<=0||!o)return;
    var c=ROLEC[s.role],w=q&&(q.working||(AMB.demo&&ambOn()&&q.born&&!q.ended)),done=q&&q.ended&&!w,sel=state.sel===s.name,dom=s.role==='mother'&&!s.restart_of?$('lab-'+s.name):SLOT[s.name],hi=state.hi===s.name||(dom&&dom.classList.contains('lit'));
    var sl0=SLOT[s.name],inO=sl0&&sl0.parentNode&&sl0.parentNode.className==='osys',r=s.role==='mother'?12*Math.max(.7,Math.min(1.4,ODS+.2)):Math.min(10,Math.max(5.5,5+Math.sqrt(Math.max(.2,s.cost))*1.6))*(inO?.6:SHUT[s.parent]?.55:1),dim=done?(s.role==='mother'?.78:.55):1;
    if(done&&AMB.done){c=desat(c);dim*=.82}
    var pb=amb&&w&&AMB.sess>0?AMB.sess*(wave(at,3400,hash01(s.name))-.5):0;
    var gf=s.role==='mother'?1:(GF[s.parent]||1);cx.globalCompositeOperation='lighter';sp(cx,c,o.x,o.y,r*(w?5*(.55+.45*gf):2.8)*(1+.12*pb),a*(w?1:.45)*dim*(1+.5*pb)*gf);if(pb>0)sp(cx,c,o.x,o.y,r*2.4,.4*pb*a*gf);if(sel||hi)sp(cx,'#ffffff',o.x,o.y,r*3.2,.55);cx.globalCompositeOperation='source-over';
    if(s.role==='mother')drawGlass(cx,c,o.x,o.y,r,a*(done?.85:1));
    else{var rz=r*ZS;cx.globalAlpha=a*dim;var b=cx.createRadialGradient(o.x-rz*.35,o.y-rz*.4,rz*.05,o.x,o.y,rz*1.15);b.addColorStop(0,'rgba(255,255,255,.85)');b.addColorStop(.3,c);b.addColorStop(1,'rgba(8,14,30,.92)');cx.fillStyle=b;roleShape(cx,s.role,o.x,o.y,rz);cx.fill();cx.strokeStyle=c;cx.lineWidth=1;cx.stroke();cx.globalAlpha=1}
    if(sel){cx.strokeStyle='rgba(255,233,201,.95)';cx.lineWidth=1.3;cx.beginPath();cx.arc(o.x,o.y,(r+5)*ZS,0,7);cx.stroke()}});
  if($('lab-master').classList.contains('lit')||state.hi==='master'||state.sel==='master'){cx.globalCompositeOperation='lighter';sp(cx,'#ffffff',m.x,m.y,G.R*.7,.5);cx.globalCompositeOperation='source-over'}
  
  cx.restore();
}
function drawPulse(p,f){if((p.from&&p.from!=='master'&&!POS[p.from])||(p.to&&p.to!=='master'&&!POS[p.to]))return;
  var from=p.from?pos(p.from):null,to=p.to?pos(p.to):null;
  if(p.n==='card'){if(!from)return;var tb=$('hud').getBoundingClientRect(),q=pat([[from.x,from.y],[from.x,tb.top-6]],f*f);cx.globalCompositeOperation='source-over';cx.globalAlpha=Math.min(1,(1-f)*3);cx.fillStyle='#ffe9b8';cx.fillRect(q[0]-5,q[1]-3.5,10,7);cx.globalAlpha=1;cx.globalCompositeOperation='lighter';sp(cx,'#ffe9b8',q[0],q[1],14,1-f);return}
  if(!from||!to)return;var RT0=route(from,to,p.from,p.to);
  if(p.n==='brief'){var c=ROLEC[(byName[p.to]||{}).role]||'#ffe9c9';pline(RT0,c,.5*(1-f),1.2);for(var j=0;j<8;j++){var u=f-j*.02;if(u<0)continue;var qq=pat(RT0,u);sp(cx,j?c:'#ffffff',qq[0],qq[1],j?11-j:12,j?.5-.05*j:1)}}
  else if(p.n==='report'){for(var d=0;d<3;d++){var u2=f-d*.09;if(u2<0)continue;var q2=pat(RT0,u2);sp(cx,'#7fe3c0',q2[0],q2[1],8,.85)}}
  else if(p.n==='handoff'){for(var h=0;h<5;h++){var u3=f*1.3-h*.07;if(u3<0||u3>1)continue;var q3=pat(RT0,u3);sp(cx,'#f3cf7a',q3[0],q3[1],9,.9);star4(q3[0],q3[1],4,.9,'#fff')}}
  else if(p.n==='escalate'){cx.setLineDash([7,6]);cx.lineDashOffset=-state.t/2600;pline(RT0,'#ffb347',.95*(1-f*.3),2);cx.setLineDash([]);cx.lineDashOffset=0;var hd=pat(RT0,Math.min(1,f*1.25));sp(cx,'#ff9d2e',hd[0],hd[1],26,1);sp(cx,'#ffffff',hd[0],hd[1],8,1)}
  else if(p.n==='decision'){var e4=pat(RT0,Math.min(1,f*1.3));pline([RT0[0],e4],'#ffffff',.8*(1-f),2.2);sp(cx,'#ffffff',e4[0],e4[1],13,1);cx.globalCompositeOperation='source-over';cx.fillStyle='#fff';cx.beginPath();cx.moveTo(e4[0],e4[1]-5);cx.lineTo(e4[0]+5,e4[1]);cx.lineTo(e4[0],e4[1]+5);cx.lineTo(e4[0]-5,e4[1]);cx.fill();cx.globalCompositeOperation='lighter'}
}

/* light: a queue count, or a How it works stage, lights its objects; the rest steps back */
function setLit(refs,sess,extra){wfLit(sess);document.querySelectorAll('.lit:not(.wfr)').forEach(function(e){e.classList.remove('lit')});var any=false;
  (refs||[]).forEach(function(r){if(CHIP[r]){CHIP[r].classList.add('lit');any=true;var k=TK[r];if(k&&k._r)k._r.classList.add('lit')}});
  (sess||[]).forEach(function(n){var b=n==='master'?$('lab-master'):SLOT[n]||$('lab-'+n);if(b){b.classList.add('lit');any=true}});
  if(extra==='qm'){$('qm').classList.add('lit');any=true}
  STAGE.classList.toggle('lighting',any);req()}
function refsOf(l,st){return TASKS.filter(function(k){return (!l||k.list===l)&&k._b.dataset.st===st}).map(function(k){return k.ref})}
function litQueue(l,st){state.litQ={l:l,st:st};setLit(refsOf(l,st))}
function unlitQueue(){state.litQ=null;if(state.stageHi)lightStage(state.stageHi);else setLit();req()}

/* loop: draws only when something changes; pauses when hidden */
var raf=0,last=0;
/* live: the 500 ms timer applies events; while the page is visible and a light moves, frames between ticks draw at the wall clock, LIVE_FPS a second,
   with or without focus (Anastasiia, 2026-11-07). Positions come from event times, so a rebuild puts every light back where it was.
   Reduced motion or classic view: the timer alone draws. A hidden tab draws nothing (req). */
var LIVE_FPS=10,AMB_FPS=20,liveNext=0;
document.documentElement.classList.toggle('amb-done',!!AMB.done);
function liveSmooth(){return LIVE&&!state.playing&&VIEW!=='classic'&&!reduce.matches}
function liveMoving(){var m=M.sess.master||{};if(m.working||M.pulses.length||M.pings.length||ambAlive()||OANIM||MANIM||(typeof EFX!=='undefined'&&EFX.length))return true;for(var k in M.tasks)if(M.tasks[k].holder)return true;return false}
function req(){if(!raf&&!document.hidden)raf=requestAnimationFrame(frame)}
function frame(ts){raf=0;var dt=Math.min(100,ts-(last||ts));last=ts;
  if(liveSmooth()){var nw=Date.now();if(nw>state.t)state.t=nw}
  if(state.playing){var sp2=BASE*state.speed*(state.climb?state.climb.rate:1);var nt=state.t+dt*sp2;
    if(state.climb&&nt>=state.climb.stop){nt=state.climb.stop;stopPlay();state.climb.done=true}
    if(nt>=T1){nt=T1;state.t=nt;advance(nt,true);stopPlay();finished();syncTime()}
    else{state.t=nt;advance(nt,true);syncTime()}}
  syncScene();draw(ts);
  if(state.playing||unsettled)req();else if(!liveNext&&liveSmooth()&&liveMoving())liveNext=setTimeout(function(){liveNext=0;req()},1000/(ambAlive()?AMB_FPS:LIVE_FPS))}
document.addEventListener('visibilitychange',function(){if(document.hidden){if(raf){cancelAnimationFrame(raf);raf=0}}else{last=0;req()}});function finished(){$('sr').textContent='Replay finished at '+fm(T1);if(D.day_report&&!state.reportSeen&&!state.climb&&state.view!=='session'){state.reportSeen=true;openDayReport(true)}}


/* ---------- transport ---------- */
function stops(){return EV.filter(function(e){return e.cap})}
function setPlayLabel(){$('play').textContent=reduce.matches?'Next step':state.playing?'Pause':(state.t>=T1?'Replay':'Play')}
function startPlay(){if(LIVE)return;if(reduce.matches){state.stepping=true;step(1);state.stepping=false;return}state.climb=null;clearClimb();if(state.t>=T1){M=newModel();cursor=0;state.t=T0;VA={};modelDirty=true;state.reportSeen=false;}state.playing=true;last=0;setPlayLabel();syncTime();req();$('sr').textContent='Replay playing'}
function stopPlay(){state.playing=false;setPlayLabel();syncTime();$('sr').textContent='Replay paused at '+fm(state.t)}
function step(dir){var was=state.playing;if(was)stopPlay();var c=stops(),cur=state.t,tgt=null;if(!c.length){setT(dir>0?T1:T0,false);return}
  if(dir>0){if(cur>=c[c.length-1].t)tgt=c[0];else for(var i=0;i<c.length;i++)if(c[i].t>cur+500){tgt=c[i];break}}
  else for(var j=c.length-1;j>=0;j--)if(c[j].t<cur-500){tgt=c[j];break}
  if(!tgt){setT(dir>0?T1:T0,false);return}
  if(tgt.t<state.t)rebuild(tgt.t-1),state.t=tgt.t-1;setT(tgt.t+1,true);caption(tgt.cap);$('sr').textContent=fm(tgt.t)+': '+tgt.cap}
function nowLine(){var live=S.filter(function(s){return (M.sess[s.name]||{}).working}).length,mast=M.sess.master||{};
  if(state.t<RT)return 'Empty scene. Nothing has fired yet.';
  if(!mast.born)return 'The routine fired. The master is starting.';
  var parts=[live+(live===1?' session working':' sessions working')];
  if(mast.ended&&state.t>=T1)parts=['All sessions closed'];
  else parts.push(mast.working?'master awake':'master asleep, monitor.js watches for no tokens');
  return parts.join(', ')+'.'}
function syncTime(){
  syncScene();
  var end=tEnd(),u=(state.t-T0)/Math.max(1,end-T0);$('scrub').value=Math.round(u*1000);$('scrub').setAttribute('aria-valuetext','Replay at '+fm(state.t));
  $('clock').textContent=fm(Math.max(state.t,masterS.t0-60000));syncDocks();syncWf();
  
  var born=S.filter(function(s){return (M.sess[s.name]||{}).born}).length;$('n-ses').textContent=born;
  document.querySelectorAll('.head').forEach(function(h){h.style.left=((state.t-T0)/(Math.max(end,T1)-T0)*100)+'%'});
  document.querySelectorAll('.row').forEach(function(r){var q=M.sess[r.dataset.s];r.classList.toggle('fut',!(q&&q.born))});
  updatePanelLive();
  setPlayLabel();
}

/* ---------- sessions list, keyboard twin ---------- */
function rolesvg(role,sz){var c=ROLEC[role],s=sz||12,h=s/2,svg='<svg width="'+s+'" height="'+s+'" viewBox="0 0 '+s+' '+s+'" aria-hidden="true">';
  if(role==='do'){var pts=[];for(var i=0;i<6;i++){var a=i*Math.PI/3+Math.PI/6;pts.push((h+Math.cos(a)*h*.95).toFixed(1)+','+(h+Math.sin(a)*h*.95).toFixed(1))}svg+='<polygon points="'+pts.join(' ')+'" fill="'+c+'"/>'}
  else if(role==='eliminate')svg+='<rect x="1.5" y="1.5" width="'+(s-3)+'" height="'+(s-3)+'" fill="'+c+'"/>';
  else if(role==='plan')svg+='<circle cx="'+h+'" cy="'+h+'" r="'+(h-1.5)+'" fill="none" stroke="'+c+'" stroke-width="2"/>';
  else svg+='<circle cx="'+h+'" cy="'+h+'" r="'+(h-1)+'" fill="'+c+'"/>';
  return svg+'</svg>'}
function addRow(s){var tr=$('tree');var b=el('button','row '+mcOf(s));b.type='button';b.dataset.s=s.name;var nm=el('span','nm');nm.insertAdjacentHTML('beforeend',rolesvg(s.role));nm.appendChild(el('span',null,s.role==='mother'?'Mother':s.short));b.appendChild(nm);
  var bars=el('span','bars');s.per.forEach(function(p){var u=el('u');u.style.left=pc(p[0])+'%';u.style.width=(pc(p[1])-pc(p[0]))+'%';u.style.background=ROLEC[s.role];bars.appendChild(u)});bars.appendChild(el('span','head'));b.appendChild(bars);
  b.setAttribute('aria-label',s.short+(s.list&&s.role!=='mother'?', '+nice(s.list):'')+', '+s.state+', '+fm(s.t0)+' to '+fm(s.t1));
  b.onclick=function(){select(s.name,true)};
  b.onmouseenter=function(e){tipSession(s,e.clientX,e.clientY)};b.onmouseleave=hideTip;b.onfocus=function(){var r=b.getBoundingClientRect();tipSession(s,r.right-60,r.bottom)};b.onblur=hideTip;
  var after=null;if(tr.dataset.ready)document.querySelectorAll('.row').forEach(function(r){var x=byName[r.dataset.s];if(x&&(x.parent===s.parent||x.name===s.parent))after=r});if(after)after.after(b);else tr.appendChild(b)}
function pc(t){return(t-T0)/(T1-T0)*100}
function buildTree(){addRow(masterS);S.filter(function(s){return s.role==='master'&&s!==masterS}).forEach(addRow);MOTHERS.forEach(addTreeGroup);var rest=S.filter(function(s){return s.role!=='master'&&s.role!=='mother'&&MOTHERS.indexOf(s.parent)<0});if(rest.length){$('tree').appendChild(el('p','grp','Other sessions'));rest.forEach(addRow)}$('tree').dataset.ready='1'}
function addTreeGroup(n){var m=byName[n];$('tree').appendChild(el('p','grp',nice(m.list)));addRow(m);childrenOf(n).sort(function(a,b){return a.t0-b.t0}).forEach(addRow)}
function rowBars(s,b){var bars=b.querySelector('.bars'),h=bars.querySelector('.head');[].slice.call(bars.querySelectorAll('u')).forEach(function(u){u.remove()});s.per.forEach(function(p){var u=el('u');u.style.left=pc(p[0])+'%';u.style.width=(pc(p[1])-pc(p[0]))+'%';u.style.background=ROLEC[s.role];bars.insertBefore(u,h)})}

/* tooltips */
// The task title under a Plan, Do or Eliminate label: the server's, else the run's task of the same list and number
// (spawn records name a task "homeos-x#27", scans "HomeOS - X #27", so the server's lookup can miss). Shown as text only.
function tipTitle(s){if(s.role==='master'||s.role==='mother')return null;if(s.title)return s.title;var n=+s.num;if(!n||!s.list)return null;
  var k=(D.tasks||[]).filter(function(t){return t.list===s.list&&+t.num===n&&t.title})[0];return k?k.title:null}
function tipSession(s,x,y){var t=$('tip');t.textContent='';t.appendChild(el('b',null,s.short));var tt=tipTitle(s);if(tt)t.appendChild(el('div','tt-task',tt));t.appendChild(el('div',null,fs(s.t0)+' to '+fs(s.t1)));t.appendChild(el('div',null,costLabel(s)+', '+K(s.allTok.output)+' output'));posTip(x,y)}
function tipStar(k,x,y){var t=$('tip'),st=M.tasks[k.ref]||{},ts=k._b.dataset.st;t.textContent='';t.appendChild(el('b',null,k.ref.replace('HomeOS - ','')));t.appendChild(el('div',null,k.title));
  t.appendChild(el('div',null,st.holder?'Taken by '+byName[st.holder].short:ts?STBY[ts].m:''));k.why.forEach(function(w){t.appendChild(el('div',null,w))});posTip(x,y)}
function tipAt(title,txt,b){var r=b.getBoundingClientRect(),t=$('tip');t.textContent='';t.appendChild(el('b',null,title));t.appendChild(el('div',null,txt));posTip(r.left,r.bottom);setTimeout(hideTip,5000)}
function posTip(x,y){var t=$('tip');t.style.display='block';var w=t.offsetWidth,h=t.offsetHeight;t.style.left=Math.max(6,Math.min(innerWidth-w-8,x+12))+'px';t.style.top=Math.max(6,Math.min(innerHeight-h-8,y+14))+'px'}
function hideTip(){$('tip').style.display='none'}

/* a small Markdown renderer: escape first, then build. Links http and https only */
function esc(t){return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function mdInline(t){var codes=[];var s=esc(t).replace(/`([^`\n]+)`/g,function(_,c){codes.push(c);return'\u0001'+(codes.length-1)+'\u0002'});
  s=s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>').replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>');
  return s.replace(/\u0001(\d+)\u0002/g,function(_,i){return'<code>'+codes[+i]+'</code>'})}
function mdHtml(src){var L=String(src).replace(/\r/g,'').split('\n'),o=[],i=0;var cells=function(l){return l.trim().replace(/^\||\|$/g,'').split('|').map(function(c){return c.trim()})};
  while(i<L.length){var l=L[i];
    if(!l.trim()){i++;continue}
    if(/^```/.test(l)){var b=[];i++;while(i<L.length&&!/^```/.test(L[i]))b.push(L[i++]);i++;o.push('<pre class="mdc" tabindex="0"><code>'+esc(b.join('\n'))+'</code></pre>');continue}
    var h=l.match(/^(#{1,6})\s+(.*)$/);if(h){var lv=Math.min(5,h[1].length+2);o.push('<h'+lv+' class="mdh">'+mdInline(h[2])+'</h'+lv+'>');i++;continue}
    if(/^\s*\|/.test(l)&&i+1<L.length&&/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(L[i+1])){var hd=cells(l);i+=2;var rows=[];while(i<L.length&&/^\s*\|/.test(L[i]))rows.push(cells(L[i++]));o.push('<div class="tw" tabindex="0" role="region" aria-label="Table"><table class="mdt"><thead><tr>'+hd.map(function(c){return'<th scope="col">'+mdInline(c)+'</th>'}).join('')+'</tr></thead><tbody>'+rows.map(function(r){return'<tr>'+r.map(function(c){return'<td>'+mdInline(c)+'</td>'}).join('')+'</tr>'}).join('')+'</tbody></table></div>');continue}
    if(/^\s*([-*]|\d+\.)\s+/.test(l)){var ord=/^\s*\d+\./.test(l),it=[];while(i<L.length&&/^\s*([-*]|\d+\.)\s+/.test(L[i])){it.push(L[i].replace(/^\s*([-*]|\d+\.)\s+/,''));i++}var tg=ord?'ol':'ul';o.push('<'+tg+' class="mdl">'+it.map(function(x){return'<li>'+mdInline(x)+'</li>'}).join('')+'</'+tg+'>');continue}
    var p=[];while(i<L.length&&L[i].trim()&&!/^(#{1,6}\s|```|\s*\||\s*([-*]|\d+\.)\s)/.test(L[i]))p.push(L[i++]);if(!p.length)p.push(L[i++]);o.push('<p>'+mdInline(p.join(' '))+'</p>')}
  return o.join('')}
function md(src){var d=el('div','md');d.innerHTML=mdHtml(src);return d}

/* ---------- panels ---------- */
var PO=$('panel'),P=$('pc'),opener=null,SIZES={narrow:440,wide:720};
var store={get:function(){try{return sessionStorage.getItem('eisenhower-harness-panel')}catch(e){return null}},set:function(v){try{sessionStorage.setItem('eisenhower-harness-panel',v)}catch(e){}}};
state.psize=store.get()||'auto';
function panelW(){var z=state.psize;if(z==='full')return W;if(SIZES[z])return Math.min(SIZES[z],W);return Math.max(340,Math.min(W,+z||Math.round(W*.25)))}
function applySize(){if(G.mob){PO.style.width='';PO.classList.toggle('full',state.psize==='full')}else{var w=panelW();PO.style.width=w+'px';PO.classList.toggle('full',w>=W)}
  $('rz').setAttribute('aria-valuenow',Math.round(panelW()));setCam()}
function setSize(z){state.psize=z;state.prevSize=null;store.set(z);applySize()}

(function(){var rz=$('rz'),drag=false;rz.addEventListener('pointerdown',function(e){drag=true;rz.setPointerCapture(e.pointerId);e.preventDefault()});rz.addEventListener('pointermove',function(e){if(drag)setSize(String(Math.round(W-e.clientX)))});rz.addEventListener('pointerup',function(){drag=false});
  rz.addEventListener('keydown',function(e){var d=e.key==='ArrowLeft'?40:e.key==='ArrowRight'?-40:0;if(e.key==='Home'){setSize('auto');e.preventDefault()}if(e.key==='End'){setSize('full');e.preventDefault()}if(d){e.preventDefault();setSize(String(Math.max(340,Math.min(W,panelW()+d))))}})})();
function openPanel(kind){if(kind!=='run')backToRun();state.view=kind;PO.classList.add('open');applySize();document.querySelectorAll('.nv[data-v]').forEach(function(b){b.setAttribute('aria-expanded',b.dataset.v===kind?'true':'false')})}
function setCam(){if(!W)return;var o=PO.classList.contains('open'),w=o?(G.mob?0:panelW()):0,sheet=G.mob&&o,cl=VIEW==='classic';document.body.classList.toggle('sheet',sheet);
  var top=document.querySelector('.top'),hud=$('hud'),bl=$('below'),full=o&&!G.mob&&w>=W,tb=top.offsetHeight,dk=W>=900,F=dk?fit():{l:0,r:0,lRail:false,rRail:false},lw=F.l,rw=F.r,hideL=!dk||full||(o&&W-lw-w<CENTRE_MIN),L=hideL?0:lw,R=o?w:rw;
  DL.classList.toggle('off',hideL||!lw);DR.classList.toggle('off',o||!dk||!rw);DL.classList.toggle('rail',F.lRail);DR.classList.toggle('rail',F.rRail);
  DL.style.top=DR.style.top=(tb+6)+'px';DL.style.left='6px';DL.style.width=Math.max(0,lw-12)+'px';DR.style.right='6px';DR.style.width=Math.max(0,rw-12)+'px';PO.style.top=G.mob?'':tb+'px';
  [['l',lw,hideL||!lw,F.lRail],['r',rw,o||!dk||!rw,F.rRail]].forEach(function(x){var s=x[0],z=$('mz'+s),c=$('mc'+s),px=s==='l'?x[1]:W-x[1],cp=x[3]?(s==='l'?29:W-29):(s==='l'?x[1]-22:W-22);z.classList.toggle('off',x[2]);c.classList.toggle('off',x[2]);z.style.left=px+'px';c.style.left=cp+'px';z.style.top=(tb+44)+'px';c.style.top=(tb+12)+'px';z.setAttribute('aria-valuenow',x[3]?0:Math.round(x[1]));z.setAttribute('aria-valuemax',Math.round(maxW(s)));var toLeft=(s==='l')!==x[3];c.innerHTML=CHEV;c.firstChild.style.transform=toLeft?'scaleX(-1)':'';var nm=s==='l'?'left':'right',lb=(x[3]?'Expand ':'Collapse ')+nm+' menu';c.setAttribute('aria-label',lb);c.title=lb});
  var bh=0;bl.classList.toggle('off',!dk||full);if(dk&&!full&&bl.children.length){bl.style.left=(L+6)+'px';bl.style.right=(R+6)+'px';bh=bl.offsetHeight+6}
  var pad=cl&&dk?6:0;hud.style.right=(G.mob?16:(full?20:R+6))+'px';hud.style.left=(G.mob?16:L+6)+'px';var ct=cl&&dk;hud.style.top=ct?(tb+6)+'px':'';hud.style.bottom=ct?'auto':(dk?(26+bh)+'px':'');ZB.l=L+pad;ZB.r=(full?0:R)+pad;zoomBox(ZM.k);hud.classList.toggle('tight',!G.mob&&W-R-L<640);var hb=hud.getBoundingClientRect();ZB.t=ct?hb.bottom+6:tb+pad;ZB.b=ct?(26+bh):(sheet?Math.round(H*.64):Math.max(0,H-hb.top+16));zoomBox(ZM.k);fitSoon();STAGE.classList.toggle('hidden',full);
  var pf=$('prefs');if(pf.classList.contains('open')){if(dk){var cw=W-L-R,pw=Math.min(520,cw-16);pf.style.width=pw+'px';pf.style.left=(L+(cw-pw)/2)+'px';pf.style.top=(tb+8)+'px';pf.style.maxHeight=(H-tb-44)+'px'}else{pf.style.width='';pf.style.left='';pf.style.top=(tb+6)+'px';pf.style.maxHeight=(H-tb-20)+'px'}}
  measureStage();if(VIEW==='classic')splitApply();syncWf();req()}
function restoreSize(){if(state.prevSize){state.psize=state.prevSize;state.prevSize=null}PO.classList.remove('rise')}
function closePanel(){backToRun();lightRoutine(false);restoreSize();PO.classList.remove('open');state.view=null;state.climb=null;state.stageHi=null;setLit();clearClimb();if(state.sel){state.sel=null;markSel();try{history.replaceState(null,'',location.pathname+location.search)}catch(e){}}document.querySelectorAll('.nv[data-v]').forEach(function(b){b.setAttribute('aria-expanded','false')});setCam();if(opener&&opener.isConnected)opener.focus();req()}
function panelHead(title,sub){P.textContent='';var h=el('div','phead');var t=el('h2',null,title);t.id='p-title';t.tabIndex=-1;h.appendChild(t);if(sub)h.appendChild(el('p','sub',sub));P.appendChild(h);return h}
function panelBody(){var b=el('div','pbody');P.appendChild(b);return b}
/* T11: what the Configurations page (config.js) uses of this page */
var UI={el:el,$:$,panelHead:panelHead,panelBody:panelBody,openPanel:openPanel,getJson:function(u){return getJson(u)},postJson:function(u,x){return postJson(u,x)},renderLimits:function(v,m){return renderLimits(v,m)},restoreSize:restoreSize,markSel:markSel,setLit:setLit,state:state,PO:PO,canDo:canDo};
$('px').onclick=closePanel;
function toggleLegend(){if(state.view==='flow'){closePanel();return}opener=document.activeElement;openFlow();var g=$('flow-legend');if(g)g.scrollIntoView({block:'start'})}
document.addEventListener('keydown',function(e){
  if((e.key==='l'||e.key==='L')&&!e.ctrlKey&&!e.metaKey&&!/TEXTAREA|INPUT|SELECT/.test(e.target.tagName))toggleLegend()});
document.querySelectorAll('.nv[data-v]').forEach(function(b){b.onclick=function(){var v=b.dataset.v;opener=b;
  if(state.view===v){closePanel();return}
  restoreSize();state.sel=null;markSel();state.stageHi=null;setLit();({esc:renderEsc,budget:renderBudget,flow:renderFlow,decisions:renderDecisions,limits:renderLimitsPage,config:function(){if(window.renderConfigPage)window.renderConfigPage(UI)},report:function(){openDayReport(false)}})[v]();var f=$('p-title');if(f)f.focus()}});

function linkBtn(name,txt){var b=el('button','lk',txt||byName[name].short);b.type='button';b.onclick=function(){select(name,true)};return b}
function select(name,user){if(!byName[name])return;backToRun();state.lastSel=name;lightRoutine(false);restoreSize();if(name!==state.sel){state.draft=DRAFTS[name]||'';state.msg=null;state.tab='about'}state.sel=name;state.stageHi=null;setLit();if(document.activeElement&&document.activeElement.closest&&!document.activeElement.closest('#panel'))opener=document.activeElement;markSel();renderSession();openPanel('session');updatePanelLive();syncWf();
  if(user){var h='#run='+D.ts+'&s='+name;try{history.replaceState(null,'',h)}catch(e){location.hash=h}var f=$('p-title');if(f)f.focus({preventScroll:true})}req()}
function markSel(){document.querySelectorAll('.row').forEach(function(r){if(r.dataset.s===state.sel)r.setAttribute('aria-current','true');else r.removeAttribute('aria-current')});modelDirty=true;syncScene()}

/* a task on focus: every reason, its sessions */
function openTask(k,back){if(!back){opener=document.activeElement;tasksCtx=null}restoreSize();state.sel=null;markSel();var ts=(k._b&&k._b.dataset.st)||(STBY[k.state]?k.state:'other');panelHead(k.ref.replace('HomeOS - ','')+': '+k.title);var b=panelBody();if(back){var bk=el('button','lk','Back to tasks');bk.type='button';bk.id='task-back';bk.onclick=function(){openTasks(tasksCtx.l,tasksCtx.st,true)};b.appendChild(bk)}var r=el('p','stl');r.innerHTML=glyph(ts,16);r.appendChild(el('span',null,STBY[ts].m));b.appendChild(r);
  b.appendChild(el('h3',null,'Why, from the board'));var u=el('ul','mdl');(k.why.length?k.why:[k.state==='can_be_taken'?'Pickable at the scan: nothing holds it back.':'It left the open board when it was finished.']).forEach(function(w){u.appendChild(el('li',null,w))});b.appendChild(u);
  var ss=S.filter(function(s){return s.task===k.ref&&s.role!=='mother'});if(ss.length){b.appendChild(el('h3',null,'Sessions that worked it'));var ul=el('ul','links');ss.forEach(function(s){var li=el('li');li.appendChild(linkBtn(s.name));li.appendChild(el('span','nat',fm(s.t0)+' to '+fm(s.t1)));ul.appendChild(li)});b.appendChild(ul)}
  var nt=el('p','sub','Board facts come from the run’s scan, not from this moment of the replay.');nt.style.marginTop='10px';b.appendChild(nt);openPanel('task');var f=$('p-title');if(f)f.focus()}
function openQueue(l,st){openTasks(l,st)}

function replayState(s){var q=M.sess[s.name];if(!q||!q.born)return'not started';if(q.working)return'working';if(q.ended)return s.state;return s.state==='running'?'waiting':s.state}
function costLabel(s){return s.transcript_missing?'cost not recorded':usd(s.cost)+(s.no_price.length?' + no price for '+s.no_price.join(', '):' at API prices')}
function roleWord(s){return s.role[0].toUpperCase()+s.role.slice(1)}
/* steps come on demand: all sessions of a day hold thousands */
function ensureFeed(s){if(s.feedState||s.transcript_missing)return;s.feedState='loading';loadFeed(s)}
function loadFeed(s){if(s.feedBusy)return;s.feedBusy=true;getJson('/api/runs/'+D.ts+'/feed/'+s.name+(s.feedLast!=null?'?after='+s.feedLast:'')).then(function(f){var first=s.feedLast==null;var add=f.entries.filter(function(x){return x.t});s.steps=(s.steps||[]).concat(add);s.stepsT=s.steps.map(function(x){return Date.parse(x.t)});if(first&&f.entries.length>=400)s.feedCut=true;s.feedLast=f.last_index;s.feedBusy=false;s.feedState='ok';seenSteps=-1;updatePanelLive()}).catch(function(){s.feedBusy=false;s.feedState='failed';seenSteps=-1;updatePanelLive()})}
var TABS=[['about','About'],['instructions','Instructions'],['steps','Steps'],['decisions','Decisions'],['report','Report'],['tokens','Tokens']];
var ROLEP={master:'Runs the day: starts mothers and decides only what is passed up. It mostly sleeps while monitor.js, a plain script costing no tokens, watches and wakes it with a reason.',mother:'One per list. Sets first statuses, approves her children\u2019s plans, answers their questions, passes up what she may not grant.',plan:'Claims the task with a 60-minute lease and writes the plan into its description. It never approves its own plan.',do:'Verifies the approval hash, executes the plan, reports, and finishes with a check card for the person.',eliminate:'Proposes drops with a plain reason. Only the person cancels.'};
function renderSession(){var s=byName[state.sel];P.textContent='';if(state.tab==='steps')ensureFeed(s);
  var h=el('div','phead');var rl=el('p','rolel');rl.insertAdjacentHTML('beforeend',rolesvg(s.role,13));rl.appendChild(el('span',null,roleWord(s)+(s.role!=='mother'&&s.list?' in '+nice(s.list):'')));h.appendChild(rl);
  var g=el('h2','goal',s.goal);g.id='p-title';g.tabIndex=-1;h.appendChild(g);
  
  var mt=el('div','meta');var bg=el('span','badge','');bg.id='stbadge';mt.appendChild(bg);
  var who=el('span',null);who.appendChild(document.createTextNode('Raised by '));if(s.started_by&&byName[s.started_by])who.appendChild(linkBtn(s.started_by));else who.appendChild(document.createTextNode('the routine'));mt.appendChild(who);
  var tm=el('span');tm.appendChild(el('b',null,fm(s.t0)));tm.appendChild(document.createTextNode(' to '));tm.appendChild(el('b',null,fm(s.t1)));mt.appendChild(tm);
  var co=el('span');co.appendChild(el('b',null,costLabel(s)));mt.appendChild(co);h.appendChild(mt);var strip=el('div','ministrip');strip.setAttribute('role','group');strip.setAttribute('aria-label','Where it sits in the chain');CHAIN.concat(EXITS).filter(function(x){return ['master','mother','plan','approval','do','check','eliminate'].indexOf(x.id)>=0}).forEach(function(x){var b=chainBtn(x,true);if(x.id===stageOf(s))b.setAttribute('aria-current','true');strip.appendChild(b)});h.appendChild(strip);h.appendChild(cmdBlock(s,'p-'));P.appendChild(h);
  var tabs=el('div','tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Session detail');
  TABS.forEach(function(xx,i){var b=el('button',null,xx[1]);b.type='button';b.id='tab-'+xx[0];b.setAttribute('role','tab');var on=state.tab===xx[0];b.setAttribute('aria-selected',on);b.setAttribute('aria-controls','tabpanel');b.tabIndex=on?0:-1;b.onclick=function(){state.tab=xx[0];renderSession();$('tab-'+xx[0]).focus()};b.onkeydown=function(e){var d=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;if(d){e.preventDefault();state.tab=TABS[(i+d+TABS.length)%TABS.length][0];renderSession();$('tab-'+state.tab).focus()}};tabs.appendChild(b)});P.appendChild(tabs);
  var body=el('div','pbody');var tp=el('div','tabp');tp.id='tabpanel';tp.setAttribute('role','tabpanel');tp.setAttribute('aria-labelledby','tab-'+state.tab);tp.tabIndex=0;
  ({about:fillAbout,instructions:fillBrief,steps:fillSteps,decisions:fillDecisions,report:fillReport,tokens:fillTokens})[state.tab](tp,s);body.appendChild(tp);P.appendChild(body);
  P.appendChild(footer(s));updatePanelLive();
}
function talkedWith(s){var o=[];
  if(s.parent)o.push([s.parent,'brief at its start, report at its end','logged']);
  childrenOf(s.name).forEach(function(c){o.push([c.name,'brief down, report up','logged'])});
  if(s.role==='plan'){var d=byName['do-'+s.list+'-'+s.num];if(d)o.push([d.name,'plan \u2192 approval \u2192 do','inferred from timestamps'])}
  if(s.role==='do'){var p=byName['plan-'+s.list+'-'+s.num];if(p)o.push([p.name,'took this plan after approval','inferred from timestamps'])}
  ESC.forEach(function(e){if(e.origin===s.name)o.push([e.mother,'its need climbed up as an escalation','inferred from timestamps']);if(e.mother===s.name)o.push(['master','passed #'+e.n+' up, decision came down','logged']);});
  var seen={};return o.filter(function(x){if(!byName[x[0]])return false;var k=x[0]+x[1];if(seen[k])return false;seen[k]=1;return true})}
function fillAbout(tp,s){tp.appendChild(el('p',null,ROLEP[s.role]));
  var dl=el('dl','kv');var add=function(k,v){dl.appendChild(el('dt',null,k));var d=el('dd');if(typeof v==='string')d.textContent=v;else d.appendChild(v);dl.appendChild(d)};
  if(s.task&&s.role!=='mother')add('Task',s.task.replace('HomeOS - ',''));if(s.role==='mother')add('List',nice(s.list));
  add('Position',s.role==='master'?'Routine, then master':s.role==='mother'?'Routine, master, mother':'Routine, master, mother, '+s.role);
  var card=hasCard(s);if(s.role==='plan'||s.role==='do')add('Result card',card==='none recorded'?'not recorded':card==='Check card'?'yes, a check card':card?'yes, a Delegate card':'no');else add('Result card','no');
  add('Replay now',el('span',null,''));dl.lastChild.firstChild.id='atreplay';
  add('Model',s.model||'not recorded');add('Requests',num(s.allTok.requests));if(s.attempt>1)add('Attempt',String(s.attempt));if(s.context)add('Context',K(s.context));if(s.tools!=null)add('Tool calls',num(s.tools));if(s.restart_of)add('Restart of',byName[s.restart_of].short);if(s.result_of.length)add('Result of',s.result_of.map(function(x){return x.replace('HomeOS - ','')}).join(', '));
  add('Working periods',s.per.length?s.per.length+', '+fs(s.per[0][0])+' first':'none yet');
  tp.appendChild(dl);
  tp.appendChild(el('h3',null,'Who it talked to'));var ul=el('ul','links');var tw=talkedWith(s);
  if(!tw.length)ul.appendChild(el('li','sub','No link recorded.'));
  tw.forEach(function(x){var li=el('li');li.appendChild(linkBtn(x[0]));li.appendChild(el('span','nat',x[1]));if(x[2]!=='logged')li.appendChild(el('span','inf',x[2]));ul.appendChild(li)});tp.appendChild(ul)}
function fillBrief(tp,s){if(!s.brief){tp.appendChild(el('p',null,s.role==='master'?'No brief file: the routine eisenhower-master starts the master from its manifest.':'No brief recorded.'));return}
  tp.appendChild(md(s.brief))}
var seenSteps=-1;
function visibleSteps(s){var out=[],t=state.t;(s.steps||[]).forEach(function(x,i){if(s.stepsT[i]<=t)out.push(x)});return out}
function fillSteps(tp,s){var rows=visibleSteps(s);seenSteps=rows.length;
  var q=M.sess[s.name];
  if(!q||!q.born){tp.appendChild(el('p',null,'Not started at '+fm(state.t)+'. Its steps appear as it works.'))}
  if(s.feedState==='loading')tp.appendChild(el('p','sub','Loading steps\u2026'));if(s.feedState==='failed')tp.appendChild(el('p','sub','Could not load the steps.'));if(s.transcript_missing)tp.appendChild(el('p','sub','No transcript on this machine: steps not recorded.'));
  if(s.feedCut)tp.appendChild(el('p','sub','Earlier steps not loaded: the last 400 are shown.'));
  var ul=el('ul');ul.id='stepl';
  var grp=null;rows.forEach(function(x){if(x.kind==='text'){grp=null;var li=el('li','step say');li.appendChild(el('time',null,fs(Date.parse(x.t))));li.appendChild(el('span',null,x.text.split('**').join('')));ul.appendChild(li)}else{if(grp&&grp.tool===x.tool){grp.n++;grp.el.lastChild.textContent=x.tool+' \u00d7'+grp.n+': '+shorten(x.text)}else{var l2=el('li','step tl');l2.appendChild(el('time',null,fs(Date.parse(x.t))));l2.appendChild(el('span',null,(x.tool?x.tool+': ':'')+shorten(x.text)));ul.appendChild(l2);grp={tool:x.tool,n:1,el:l2}}}});
  tp.appendChild(ul)}
function shorten(t){return (t||'').replace(/^D:\\Claude\\Personal\\HomeOS\\/,'').slice(0,110)}
function fillDecisions(tp,s){var any=false;var sec=function(title,items,up){if(!items.length)return;any=true;tp.appendChild(el('h3',null,title));items.forEach(function(d){var li=el('div','dec'+(up&&up(d)?' up':''));li.appendChild(el('time',null,d.hm));var dv=el('div','md');dv.innerHTML=mdInline(d.text);li.appendChild(dv);tp.appendChild(li)})};
  if(s.role==='master')sec('Decided by the master',MAST.filter(function(d){return !/^mother-/.test(d.text)}));
  if(s.role==='mother'){sec('Taken here, and what went up',MDEC[s.name]||[],function(d){return d.up});}
  if(s.num){var mk=new RegExp('#'+s.num+'\\b');var fromM=(MDEC['mother-'+s.list]||[]).filter(function(d){return mk.test(d.text)});sec('What its mother decided about #'+s.num,fromM,function(d){return d.up});
    var fromT=MAST.filter(function(d){return !/^mother-/.test(d.text)&&mk.test(d.text)&&d.text.indexOf(s.list)===0});sec('What the master decided',fromT)}
  var esc=ESC.filter(function(e){return e.origin===s.name||(s.role==='mother'&&e.mother===s.name)});
  if(esc.length){any=true;tp.appendChild(el('h3',null,'Passed up'));esc.forEach(function(e){var b=el('button','lk','#'+e.n+': '+e.cause);b.type='button';b.onclick=function(){openEsc(ESC.indexOf(e))};var p=el('p');p.style.marginTop='5px';p.appendChild(b);tp.appendChild(p)})}
  if(!any)tp.appendChild(el('p',null,'No decision recorded for this session. '+(s.role==='plan'||s.role==='do'?'A '+s.role+' session reports up and does not grant anything by itself.':'')))}
function fillReport(tp,s){var q=M.sess[s.name];
  if(!s.report){tp.appendChild(el('p',null,s.role==='master'?'No report of its own: the master\u2019s result is its decision log. Open Decisions.':'No report yet.'));return}
  if(q&&!q.ended){tp.appendChild(el('p',null,'No report yet at '+fm(state.t)+' in this replay. Steps so far: '+q.steps+'.'));return}
  tp.appendChild(md(s.report.text))}
function tokTable(rows,tp){var tb=el('table');var hr=el('tr');[''].concat(rows.map(function(r){return r[0]})).forEach(function(x,i){var th=el('th',null,x);if(i)th.scope='col';hr.appendChild(th)});tb.appendChild(hr);
  KINDS.forEach(function(k){var tr=el('tr');tr.appendChild(el('td',null,k[1]));rows.forEach(function(r){var td=el('td');td.appendChild(document.createTextNode(K(r[1][k[0]])));td.appendChild(el('br'));td.appendChild(el('span','sub',usd(r[1]['c_'+k[0]])));tr.appendChild(td)});tb.appendChild(tr)});
  if(rows.some(function(r){return r[1].c_web})){var w=el('tr');w.appendChild(el('td',null,'Web searches'));rows.forEach(function(r){w.appendChild(el('td',null,usd(r[1].c_web)))});tb.appendChild(w)}
  var tr=el('tr','sum');tr.appendChild(el('td',null,'Cost'));rows.forEach(function(r){tr.appendChild(el('td',null,usd(r[1].cost)))});tb.appendChild(tr);tp.appendChild(tb)}
function fillTokens(tp,s){if(s.transcript_missing){tp.appendChild(el('p',null,'No transcript on this machine: tokens not recorded.'));return}var r=rollup(s);
  var rows=[['Own',r.own]];if(s.role==='mother'){rows.push(['Children',r.children]);rows.push(['Sum',r.sum])}if(s.role==='master'){rows.push(['Mothers with children',r.children]);rows.push(['Sum',r.sum])}
  tokTable(rows,tp);
  if(s.sub_requests)tp.appendChild(el('p','sub','Own includes '+s.sub_requests+' subagent requests.'));
  if(s.agents.length){tp.appendChild(el('h3',null,'Subagents'));var u=el('ul','mdl');s.agents.forEach(function(a){u.appendChild(el('li',null,a.name+' ('+a.models.join(', ')+'): '+usd(a.cost)))});tp.appendChild(u)}
  if(s.no_price.length)tp.appendChild(el('p','sub','No price for '+s.no_price.join(', ')+'.'));
  var note=el('p','sub',priceNote());note.style.marginTop='8px';tp.appendChild(note)}
var TIPS={Stop:'Stop ends the headless session. It can be continued later.'};
function footer(s){var f=el('div','pfoot'),c=s.controls;
  if(!c.stop&&!c.continue_headless){if(!c.copy)f.appendChild(el('p',null,'No session id.'));else f.appendChild(el('p','sub',s.role==='master'?'A master runs in the app: copy the command to open a copy of it.':'Finished: nothing to continue headless.'));return f}
  var w=el('div','cont');
  if(c.continue_headless){var lb=el('label',null,'Tell this session how to go on');lb.setAttribute('for','note');w.appendChild(lb);
    var ta=el('textarea');ta.id='note';ta.maxLength=1000;ta.placeholder='Optional note, for example: skip step 4 and report what you have';ta.value=state.draft;ta.setAttribute('aria-describedby','cont-exp cont-msg');if(state.sending)ta.readOnly=true;ta.oninput=function(){state.draft=ta.value;DRAFTS[state.sel]=ta.value;cnt()};ta.onblur=function(){if(state.rePanel){state.rePanel=false;setTimeout(function(){if(state.view==='session'&&state.sel)renderSession()},150)}};ta.onkeydown=function(e){if(e.ctrlKey&&e.key==='Enter'){e.preventDefault();sendAction('continue')}};w.appendChild(ta);
    var ex=el('p','explain');ex.id='cont-exp';ex.textContent='Resumes it headless, under this list\u2019s limits. Your note is added as one line to what it reads.'+(c.hint?' It may hold its task for up to 24 hours; on the command line: '+c.hint+'.':'');w.appendChild(ex)}
  var msg=el('p','msg');msg.id='cont-msg';msg.setAttribute('role','status');if(state.msg){msg.textContent=state.msg.t;msg.classList.add(state.msg.k)}w.appendChild(msg);f.appendChild(w);
  var acts=el('div','acts');
  if(c.continue_headless){var go=el('button','btn primary');go.type='button';go.id='contbtn';if(state.sending){go.appendChild(el('span','spin'));go.appendChild(document.createTextNode('Continuing\u2026'));go.disabled=true}else go.textContent='Continue headless';go.onclick=function(){sendAction('continue')};acts.appendChild(gate(go,'continue',s))}
  if(c.stop){var stop=el('button','btn','Stop');stop.id='stopbtn';stop.type='button';stop.title=TIPS.Stop;stop.disabled=state.sending;stop.onclick=function(){sendAction('stop')};acts.appendChild(gate(stop,'stop',s))}
  var count=el('span','count');count.id='cnt';acts.appendChild(count);function cnt(){if(!ta)return;var n=ta.value.length;count.textContent=n>=800?n+' of 1000':''}cnt();f.appendChild(acts);
  return f}
function sendAction(action){var s=byName[state.sel];if(!s||state.sending)return;var note=action==='continue'&&$('note')?$('note').value.trim():'';state.sending=true;state.msg=null;renderSession();var same=function(){return state.view==='session'&&state.sel===s.name},show=function(m){if(same()){state.msg=m;renderSession()}};
  postJson('/api/action',{run:D.ts,name:s.name,action:action,note:note||undefined,expect_state:s.state||undefined}).then(function(r){state.sending=false;if(r.ok){DRAFTS[s.name]='';if(same())state.draft='';show({k:'ok',t:r.json&&r.json.queued?r.json.queued:action==='stop'?'Stopped.':'Accepted: it is running again.'});refresh()}else{show({k:'bad',t:(r.json&&(r.json.error||r.json.errors&&r.json.errors.join('; ')))||'Refused.'});refresh()}}).catch(function(){state.sending=false;show({k:'bad',t:'The server did not answer. Your note is kept.'})})}
function copyText(txt,btn){var done=function(){btn.textContent='Copied';setTimeout(function(){btn.textContent='Copy'},1400)};var fb=function(){var t=el('textarea');t.value=txt;document.body.appendChild(t);t.select();try{document.execCommand('copy')}catch(e){}t.remove();done()};if(navigator.clipboard&&window.isSecureContext)navigator.clipboard.writeText(txt).then(done,fb);else fb()}
function updatePanelLive(){if(state.view==='session'&&state.sel){var s=byName[state.sel];var rs=replayState(s),b=$('stbadge');if(b){b.textContent=rs;b.className='badge st-'+rs.replace(' ','-')}
    var at=$('atreplay');if(at)at.textContent=rs+' at '+fm(state.t);
    if(state.tab==='steps'){var c=visibleSteps(s).length;if(c!==seenSteps){var tp=$('tabpanel'),bd=tp&&tp.parentNode,sc=bd?bd.scrollTop:0,atEnd=bd&&bd.scrollHeight-bd.clientHeight-sc<40;tp.textContent='';fillSteps(tp,s);if(bd)bd.scrollTop=atEnd?bd.scrollHeight:sc}}
    if(state.tab==='report'){var q=M.sess[s.name];var key=q&&q.ended;if(key!==state._rk){state._rk=key;var t2=$('tabpanel');if(t2){t2.textContent='';fillReport(t2,s)}}}}
  if(state.view==='esc'){ESC.forEach(function(e,i){var n=$('esc'+i);if(n){n.classList.toggle('fut',state.t<e.t);escNodes(e,i)}});}
  if(state.view==='budget'){var bh=$('b-now');if(bh){var so=totalSpent(state.t);bh.textContent=usd(so);var pl=$('cc-head');if(pl){var x=ccX(state.t);pl.setAttribute('x1',x);pl.setAttribute('x2',x);var pd=$('cc-dot');pd.setAttribute('cx',x);pd.setAttribute('cy',ccY(Math.min(ccMax,costAtReal(state.t))))}}}}

/* escalations view */
function escNodes(e,i){var c=$('esc'+i);if(!c)return;var t=state.t;var a=c.querySelectorAll('.n');var T=[e.t,e.t+50000,e.t+110000];
  if(e.td){var span=e.td-e.t;T=[e.t,e.t+Math.min(50000,span*.35),e.t+Math.min(110000,span*.7),e.td,e.td+70000]}
  a.forEach(function(n,j){n.classList.toggle('on',t>=T[j]&&t>=e.t)})}
function renderEsc(focus){var ownScroll=null;panelHead('Escalations',ESC.length+' in this run. What a mother could not grant went to the master.');var b=panelBody();b.id='escbody';
  ESC.forEach(function(e,i){var s=el('article','esc');s.id='esc'+i;if(state.climb&&state.climb.i===i)s.setAttribute('aria-current','true');
    s.appendChild(el('h3',null,nice(e.list)+' #'+e.n+(e.apply?', live apply':'')));
    s.appendChild(el('p',null,e.cause));
    var pth=el('div','path');var nd=function(name,lbl,dn){var x=el('button','n'+(dn?' dn':''),lbl);x.type='button';x.onclick=function(){select(name,true)};pth.appendChild(x)};var bar=function(){pth.appendChild(el('i'))};
    nd(e.origin,byName[e.origin]?byName[e.origin].short:'origin');bar();nd(e.mother,'Mother');bar();nd('master','Master');if(e.td){bar();nd('master','Decision',true);bar();nd(e.mother,'Back to mother',true)}s.appendChild(pth);
    var o=el('p','sub','Born in '+(e.apply?'the Do session':'the plan')+' of the task (origin inferred); the mother could not grant it. Raised '+fm(e.t)+(e.fixed?' (from the mother\u2019s log: the file time was overwritten by a later update)':'')+'.');s.appendChild(o);
    var de=el('p');de.appendChild(el('b',null,'Decision: '));de.appendChild(document.createTextNode(e.decision?firstPara(e.decision):'None recorded.'));s.appendChild(de);
    if(e.td)s.appendChild(el('p','sub','By '+e.by+', '+fm(e.td)+'.'));
    var rp=el('button','btn','Replay this climb');rp.type='button';rp.onclick=function(){climb(i)};s.appendChild(rp);
    var dt=el('details');dt.appendChild(el('summary',null,'Full text of the files'));dt.appendChild(md(e.raw+(e.decision?'\n\n'+e.decision:'')));s.appendChild(dt);
    b.appendChild(s);});
  openPanel('esc');ESC.forEach(function(e,i){var n=$('esc'+i);n.classList.toggle('fut',state.t<e.t);escNodes(e,i)});if(state.climb){var cur=$('esc'+state.climb.i);if(cur)cur.scrollIntoView({block:'nearest'})}}
function firstPara(t){var x=t.replace(/\s+/g,' ').replace(/^(Decision on|Result for) [^:]+:\s*/,'');x=x[0].toUpperCase()+x.slice(1);if(x.length<=260)return x;var c=x.slice(0,260),i=c.lastIndexOf('. ');return i>80?c.slice(0,i+1):c.slice(0,c.lastIndexOf(' '))+'...'}
function openEsc(i){state.sel=null;markSel();renderEsc();climb(i)}
function clearClimb(){document.querySelectorAll('.esc[aria-current],.ecard[aria-current]').forEach(function(n){n.removeAttribute('aria-current')})}
function climb(i){var e=ESC[i],from=e.t-20000,to=(e.td||e.t+110000)+80000;state.playing=false;if(from<state.t)rebuild(from);else advance(from,false);state.t=from;
  clearClimb();var c=$('esc'+i);if(c){c.setAttribute('aria-current','true');c.scrollIntoView({block:'nearest'})}var ec=$('ec'+i);if(ec){ec.setAttribute('aria-current','true');ec.scrollIntoView({block:'nearest'})}
  var real=reduce.matches;if(real){setT(e.td||e.t,false);caption('#'+e.n+' climbed to the master and came back');return}
  var dur=7000;state.climb={i:i,stop:to,rate:(to-from)/dur/(BASE*state.speed)};state.playing=true;last=0;setPlayLabel();syncTime();req();$('sr').textContent='Replaying the climb of #'+e.n}

/* budget view */
var ccSer=[],ccMax=1,CW=680,CH=120;
function costAtReal(t){return S.reduce(function(c,s){return c+spentOf(s,t)},0)}
function ccX(t){return Math.max(0,Math.min(CW,(t-T0)/(T1-T0)*CW))}
function ccY(v){return CH-4-(v/ccMax)*(CH-12)}
function realSum(){return S.reduce(function(a,s){return addTok(a,s.allTok)},ZERO)}
function byModel(){var o={};S.forEach(function(s){Object.keys(s.by_model).forEach(function(m){var x=s.by_model[m],k=x.cost_by_kind||{},r={input:x.input,output:x.output,cache_read:x.cache_read,cache_write:x.write_5m+x.write_1h,requests:x.requests,cost:x.cost,c_input:k.input||0,c_output:k.output||0,c_cache_read:k.cache_read||0,c_cache_write:k.cache_write||0,c_web:k.web_search||0};o[m]=addTok(o[m]||ZERO,r)})});return o}
function priceNote(){return'Tokens by kind times each model\u2019s official price, plus web searches, subagents included'+(D.prices.date?'. Prices of '+D.prices.date:'')+'.'}
function renderBudget(){panelHead('Budget','At API prices. '+priceNote());var b=panelBody();var tot=realSum();
  var bg=el('p','big',usd(tot.cost));b.appendChild(bg);
  var nowp=el('p','sub');nowp.appendChild(document.createTextNode((LIVE?'So far. ':'Whole day. ')+'At the playhead: '));var nb=el('b',null,'');nb.id='b-now';nb.style.color='var(--ink)';nowp.appendChild(nb);b.appendChild(nowp);
  var np=[];S.forEach(function(s){s.no_price.forEach(function(m){if(np.indexOf(m)<0)np.push(m)})});if(np.length){b.appendChild(el('p','sub','No price for '+np.join(', ')+': its tokens are shown, its cost is not counted.'))}
  var miss=S.filter(function(s){return s.transcript_missing});if(miss.length)b.appendChild(el('p','sub','No transcript on this machine, so not counted: '+miss.map(function(s){return s.short}).join(', ')+'.'));
  b.appendChild(el('h3',null,'Cost over time'));ccMax=Math.max(.01,costAtReal(T1));var pts=[];for(var i=0;i<=120;i++){var t=T0+(T1-T0)*i/120;pts.push(ccX(t).toFixed(1)+','+ccY(costAtReal(t)).toFixed(1))}
  var svg='<svg class="cc" viewBox="0 0 '+CW+' '+(CH+16)+'" role="img" aria-label="Cost rises from $0 at '+fm(masterS.t0)+' to '+usd(ccMax)+' at '+fm(T1)+', from the time of every request"><polygon points="0,'+(CH-4)+' '+pts.join(' ')+' '+CW+','+(CH-4)+'" style="fill:color-mix(in srgb,var(--core) 16%,transparent)"/><polyline points="'+pts.join(' ')+'" fill="none" style="stroke:var(--core)" stroke-width="1.6"/><line id="cc-head" x1="0" x2="0" y1="0" y2="'+(CH-4)+'" style="stroke:var(--ink)" stroke-width="1"/><circle id="cc-dot" r="3.5" style="fill:var(--ink)" cx="0" cy="0"/><text x="0" y="'+(CH+12)+'" style="fill:var(--muted)" font-size="12">'+fm(masterS.t0)+'</text><text x="'+CW+'" y="'+(CH+12)+'" style="fill:var(--muted)" font-size="12" text-anchor="end">'+fm(T1)+'</text><text x="'+(CW-4)+'" y="12" style="fill:var(--ink)" font-size="13" text-anchor="end">'+usd(ccMax)+'</text></svg>';b.insertAdjacentHTML('beforeend',svg);
  b.appendChild(el('h3',null,'Split, children rolled up'));var rm=rollup(masterS);var maxv=0;var parts=MOTHERS.map(function(n){var r=rollup(byName[n]);maxv=Math.max(maxv,r.sum.cost);return{n:n,own:r.own.cost,ch:r.children.cost,sum:r.sum.cost}});maxv=Math.max(maxv,rm.own.cost,.01);
  var mkbar=function(lbl,name,own,ch,sum){var row=el('div','bar');var l=linkBtn(name,lbl);row.appendChild(l);var tr=el('div','tr');var a=el('span');a.style.width=(own/maxv*100)+'%';a.style.background='#c4b5ff';tr.appendChild(a);if(ch>0){var c=el('span');c.style.width=(ch/maxv*100)+'%';c.style.background='rgba(245,121,154,.85)';tr.appendChild(c)}row.appendChild(tr);row.appendChild(el('span','v',usd(sum)));row.title=lbl+': own '+usd(own)+', children '+usd(ch);b.appendChild(row)};
  mkbar('Master, own','master',rm.own.cost,0,rm.own.cost);parts.forEach(function(p){mkbar(nice(byName[p.n].list),p.n,p.own,p.ch,p.sum)});
  var sumt=el('table');sumt.style.marginTop='8px';var hd=el('tr');['','Own','Children','Sum'].forEach(function(x){hd.appendChild(el('th',null,x))});sumt.appendChild(hd);
  parts.forEach(function(p){var tr=el('tr');tr.appendChild(el('td',null,nice(byName[p.n].list)));[p.own,p.ch,p.sum].forEach(function(v){tr.appendChild(el('td',null,usd(v)))});sumt.appendChild(tr)});
  var mt=el('tr');mt.appendChild(el('td',null,'Master'));[rm.own.cost,rm.children.cost,rm.sum.cost].forEach(function(v){mt.appendChild(el('td',null,usd(v)))});mt.className='sum';sumt.appendChild(mt);sumt.id='mothersum';b.appendChild(sumt);
  b.appendChild(el('p','sub','Master\u2019s children column is its mothers, each with her children. Purple is own, rose is children.'));
  b.appendChild(el('h3',null,'By kind'));tokTable([['All sessions',tot]],b);
  b.appendChild(el('h3',null,'By model'));var models=byModel();tokTable(Object.keys(models).map(function(k){return[k,models[k]]}),b);
  b.appendChild(el('h3',null,'Plan usage'));var u=el('ul');if(!D.usage.length)u.appendChild(el('li',null,'Not recorded yet.'));D.usage.slice().reverse().forEach(function(x){u.appendChild(el('li',null,x.replace(/ · /g,', ')))});b.appendChild(u);
  b.appendChild(el('h3',null,'Per session'));var host=el('div');host.id='bsess';b.appendChild(host);fillSessTable(host);
  openPanel('budget');updatePanelLive()}
function fillSessTable(host){host.textContent='';var cols=[['short','Session'],['cost','Cost'],['output','Output'],['cache_read','Cache read'],['cache_write','Cache write'],['input','Input']];var tb=el('table');var hr=el('tr');
  cols.forEach(function(c){var th=el('th');th.scope='col';if(state.sort.k===c[0])th.setAttribute('aria-sort',state.sort.d>0?'ascending':'descending');var sb=el('button','sortb',c[1]+(state.sort.k===c[0]?(state.sort.d>0?' \u2191':' \u2193'):''));sb.type='button';sb.onclick=function(){if(state.sort.k===c[0])state.sort.d*=-1;else state.sort={k:c[0],d:-1};fillSessTable(host);var f=host.querySelectorAll('.sortb');cols.forEach(function(cc,i){if(cc[0]===c[0])f[i].focus()})};th.appendChild(sb);hr.appendChild(th)});tb.appendChild(hr);
  var val=function(s,k){return k==='short'?s.short:k==='cost'?s.cost:s.allTok[k]};
  S.slice().sort(function(a,b){var x=val(a,state.sort.k),y=val(b,state.sort.k);return (x>y?1:x<y?-1:0)*state.sort.d}).forEach(function(s){var tr=el('tr');var t0=el('td');t0.appendChild(linkBtn(s.name,s.short.replace('Mother of ','Mother, ')));tr.appendChild(t0);tr.appendChild(el('td',null,usd(s.cost)));['output','cache_read','cache_write','input'].forEach(function(k){tr.appendChild(el('td',null,K(s.allTok[k])))});tb.appendChild(tr)});host.appendChild(tb)}

/* secondary views */
var FLOWS=[['Routine','Fires on a schedule, or by hand. Starts one master per day.'],['monitor.js','A plain script costing no tokens. It scans, ranks, waits, and wakes the master with a reason: start-mother, escalation, cannot, answer, usage-check, close.'],['Master','One per day. Starts mothers and decides only what is passed up.'],['Mother','One per list. Sets first statuses, approves her children\u2019s plans, passes up what she may not grant: paid, new outbound host or upload, messages to others, .env or settings, migrations, anything irreversible.'],['Plan','Claims the task with a 60-minute lease and writes the plan into the description. Never approves its own plan.'],['Approval','A record with a hash of the plan text. A Do session runs approve.js verify first; an edited plan stops it.'],['Do','Executes, reports DONE, CANNOT or HAND OFF, and finishes with a check card in quadrant C. The task waits for Accept or Needs changes.'],['Eliminate','Proposes drops with a plain reason. Only the person cancels.'],['Delegate card','A question for the person. The task waits, the rest goes on.']];
/* ---------- How it works: the path every task takes ---------- */
var CHAIN=[
 {id:'board',n:'Board',d:'Tasks wait in lists named HomeOS - something. Each has a state, shown by its shape.',lit:function(){return{refs:TASKS.map(function(k){return k.ref})}}},
 {id:'scan',n:'Scan',d:'scan.js, a plain script, reads the board for no tokens: what can be taken, and why not.',lit:function(){return{extra:'qm'}}},
 {id:'master',n:'Master wakes',d:'One per day. monitor.js wakes it with a reason: start-mother, escalation, cannot, answer, usage-check, close. It sleeps otherwise.',lit:function(){return{sess:['master']}}},
 {id:'mother',n:'Mother',d:'One per list. Sets first statuses, starts children, approves their plans.',lit:function(){return{sess:MOTHERS}}},
 {id:'plan',n:'Plan',d:'Claims the task with a 60-minute lease and writes the plan into its description. It never approves its own plan.',lit:function(){return{sess:S.filter(function(s){return s.role==='plan'}).map(function(s){return s.name})}}},
 {id:'approval',n:'Approval',d:'A record with a hash of the plan text. What a mother may not grant goes up to the master: paid, a new outbound host, messages to others, .env or settings, migrations, anything irreversible.',lit:function(){return{sess:['master'].concat(ESC.map(function(e){return e.origin}))}}},
 {id:'do',n:'Do',d:'Runs approve.js verify first, so an edited plan stops it. Then executes and reports DONE, CANNOT or HAND OFF.',lit:function(){return{sess:S.filter(function(s){return s.role==='do'}).map(function(s){return s.name})}}},
 {id:'check',n:'Check card',d:'A Do session finishes with a card for you in quadrant C. The task waits for Accept or Needs changes.',lit:function(){return{refs:TASKS.filter(function(k){return k.state==='waits_for_person'}).map(function(k){return k.ref})}}},
 {id:'done',n:'Done',d:'You accept and the task leaves the open board.',lit:function(){return{refs:TASKS.filter(function(k){return k._b.dataset.st==='done'}).map(function(k){return k.ref})}}}];
var EXITS=[
 {id:'delegate',n:'Delegate',d:'A question for you. The task waits, the rest goes on. Your answer returns it to Plan.',lit:function(){return{refs:TASKS.filter(function(k){return k.quadrant==='C'}).map(function(k){return k.ref})}}},
 {id:'eliminate',n:'Eliminate',d:'A session proposes a drop with a plain reason. Only you cancel.',lit:function(){return{sess:S.filter(function(s){return s.role==='eliminate'}).map(function(s){return s.name}),refs:TASKS.filter(function(k){return k.quadrant==='D'}).map(function(k){return k.ref})}}}];
function stageById(id){return CHAIN.concat(EXITS).filter(function(x){return x.id===id})[0]}
function lightStage(id){var st=stageById(id);if(!st)return;state.stageHi=id;var l=st.lit();setLit(l.refs,l.sess,l.extra);document.querySelectorAll('.cs').forEach(function(b){if(b.dataset.id===id)b.setAttribute('aria-current','true');else b.removeAttribute('aria-current')});var d=$('cs-detail');if(d){d.textContent='';d.appendChild(el('h3',null,st.n));d.appendChild(el('p',null,st.d))}}
function stageOf(s){return s.role}
function chainBtn(x,small){var b=el('button','cs');b.type='button';b.dataset.id=x.id;b.textContent=x.n;b.onclick=function(){if(small)openFlow(x.id);else lightStage(x.id)};return b}
function openFlow(id){restoreSize();state.sel=null;markSel();renderFlow();if(id)lightStage(id);var f=$('p-title');if(f)f.focus()}
function renderFlow(){panelHead('How it works','The path every task takes. Pick a stage to light it on the day.');var b=panelBody();
  var ch=el('ol','chain');CHAIN.forEach(function(x){var li=el('li');li.appendChild(chainBtn(x));ch.appendChild(li)});b.appendChild(ch);
  var ex=el('div','exits');ex.appendChild(el('span','sub','Side exits'));EXITS.forEach(function(x){ex.appendChild(chainBtn(x))});b.appendChild(ex);
  var de=el('div');de.id='cs-detail';de.setAttribute('aria-live','polite');de.appendChild(el('p','sub','No stage picked.'));b.appendChild(de);
  b.appendChild(el('h3',null,'Who decides what'));var w=el('ul','mdl');['Master: only what a mother passes up, and starting mothers.','Mother: first statuses and her children\u2019s plans.','Plan and Do: nothing about themselves. A writer never approves its own plan.','You: check cards, Delegate questions, every cancel.'].forEach(function(t){w.appendChild(el('li',null,t))});b.appendChild(w);
  b.appendChild(el('h3',null,'Limits'));var lm=el('ul','mdl');['Sessions per list and subagents per session: concurrency, not tokens.','Work pauses at 90% of a plan window. A ping restarts it after the reset.','Sessions are headless, so they talk through files and the board.'].forEach(function(t){lm.appendChild(el('li',null,t))});b.appendChild(lm);
  var lp=el('p');var lb=el('button','lk','Limits per list on this device');lb.type='button';lb.onclick=function(){renderLimitsPage();var f=$('p-title');if(f)f.focus()};lp.appendChild(lb);b.appendChild(lp);
  b.appendChild(el('h3',null,'Plan usage today'));var u=el('ul');if(!D.usage.length)u.appendChild(el('li',null,'Not recorded yet.'));D.usage.slice().reverse().forEach(function(x){u.appendChild(el('li',null,x.replace(/ · /g,', ')))});b.appendChild(u);
  var lh=el('h3',null,'Legend');lh.id='flow-legend';b.appendChild(lh);var lgw=el('div','lgk');lgw.innerHTML=$('lg').innerHTML;b.appendChild(lgw);
  openPanel('flow')}

/* ---------- Day report ---------- */
function barRow(host,label,v,max,c,txt,link){var r=el('div','rb');if(link)r.appendChild(linkBtn(link,label));else r.appendChild(el('span',null,label));var tr=el('div','tr');(Array.isArray(v)?v:[[v,c]]).forEach(function(x){var a=el('span');a.style.width=(max?x[0]/max*100:0)+'%';a.style.background=x[1];tr.appendChild(a)});r.appendChild(tr);r.appendChild(el('span','v',txt));host.appendChild(r)}
var REASON=[[/^in Delegate/,'In Delegate: you decide'],[/^in Eliminate/,'In Eliminate: you make the call'],[/^not before/,'Its date has not come'],[/^waits for the person/,'Waits for your review'],[/^after /,'Waits for another task'],[/^held by/,'Held by a session']];
function reasonOf(i){if(!(i.why_not||[]).length)return'Could be taken: no mother ran for its list';var w=i.why_not[0];for(var x=0;x<REASON.length;x++)if(REASON[x][0].test(w))return REASON[x][1];return w}
function secHead(b,t,n){var s=el('section','rs');s.style.setProperty('--i',n);s.appendChild(el('h3','rh',t));b.appendChild(s);return s}
function openDayReport(auto){
  opener=document.activeElement&&document.activeElement!==document.body?document.activeElement:$('prof');if(state.psize!=='full'&&!state.prevSize)state.prevSize=state.psize;state.psize='full';state.sel=null;markSel();
  PO.classList.remove('rise');void PO.offsetWidth;if(auto&&!reduce.matches)PO.classList.add('rise');
  var tot=S.reduce(function(a,s){return addTok(a,s.allTok)},ZERO),totc=tot.cost,day=D.day;
  panelHead('Day report');var b=panelBody();b.classList.add('rep');
  var s1=secHead(b,'How the day closed',0);var closed=D.day_report?(D.day_report.match(/^Closed:\s*(.*)$/m)||[])[1]:null;
  s1.appendChild(el('p','outc',LIVE?'The day is still running. This report fills as it goes; the written report comes at its close.':(closed?closed.replace(/\.$/,'').replace(/^./,function(c){return c.toUpperCase()})+'. ':'No day report was written. ')+(D.stop?'Recorded stop: '+D.stop+'. ':'')+'The last session ended '+fm(T1)+'.'));var pb=el('button','btn','Print');pb.type='button';pb.onclick=function(){window.print()};s1.appendChild(pb);
  var decs=D.decisions.map(function(l){var m=l.match(/^(\d\d:\d\d) ([\s\S]*)$/),t=m?m[2]:l,w=t.match(/^(mother-[a-z0-9_-]+):\s*/);return{hm:m?m[1]:'',who:w?w[1]:'master',text:w?t.slice(w[0].length):t}});
  var s2=secHead(b,'Decisions taken: '+decs.length,1);decs.forEach(function(d){var r=el('div','dec dr');r.appendChild(el('time',null,d.hm));var w=el('div');if(byName[d.who])w.appendChild(linkBtn(d.who,d.who==='master'?'Master':byName[d.who].short));var m=el('div','md');m.innerHTML=mdInline(d.text);w.appendChild(m);r.appendChild(w);s2.appendChild(r)});
  var s3=secHead(b,'Tasks done: '+day.done.length,2);day.done.forEach(function(ref){var k=TK[ref];var d=el('div','qrow');d.appendChild(el('b',null,ref.replace('HomeOS - ','')+' '));if(k)d.appendChild(document.createTextNode(k.title));var sb=el('div','meta');S.filter(function(s){return s.task===ref}).forEach(function(s){sb.appendChild(linkBtn(s.name))});d.appendChild(sb);s3.appendChild(d)});
  var nt=day.not_taken,grp={};nt.forEach(function(i){var r=reasonOf(i);(grp[r]=grp[r]||[]).push(i)});var s4=secHead(b,'Not taken: '+nt.length+', by first reason',3);Object.keys(grp).sort(function(a,c){return grp[c].length-grp[a].length}).forEach(function(r){var d=el('details','nt');var sm=el('summary');sm.appendChild(el('b',null,grp[r].length+' '));sm.appendChild(document.createTextNode(r));d.appendChild(sm);var u=el('ul','mdl');grp[r].forEach(function(i){var li=el('li',null,i.ref.replace('HomeOS - ','')+' '+i.title);if((i.why_not||[]).length>1)li.appendChild(el('span','sub',' Also: '+i.why_not.slice(1).join('; ')));u.appendChild(li)});d.appendChild(u);s4.appendChild(d)});
  var s5=secHead(b,'Tokens and cost',4);var kc={input:'#9fd6ff',output:'#f5799a',cache_read:'#ffd9a0',cache_write:'#c4b5ff'};s5.appendChild(el('h4',null,'By kind'));var mk=0;KINDS.forEach(function(k){mk=Math.max(mk,tot['c_'+k[0]])});KINDS.forEach(function(k){barRow(s5,k[1],tot['c_'+k[0]],mk,kc[k[0]],usd(tot['c_'+k[0]])+' for '+K(tot[k[0]]))});if(tot.c_web)s5.appendChild(el('p','sub','Web searches: '+usd(tot.c_web)+'.'));
  s5.appendChild(el('h4',null,'By mother, with children'));var rm=rollup(masterS),rows=MOTHERS.map(function(n){var r=rollup(byName[n]);return{n:n,o:r.own.cost,c:r.children.cost,sum:r.sum.cost}}),mm=Math.max.apply(null,rows.map(function(r){return r.sum}).concat([rm.own.cost]));barRow(s5,'Master, own',rm.own.cost,mm,'#ffd9a0',usd(rm.own.cost),'master');rows.forEach(function(r){barRow(s5,nice(byName[r.n].list),[[r.o,'#c4b5ff'],[r.c,'#f5799a']],mm,null,usd(r.o)+' + '+usd(r.c)+' = '+usd(r.sum),r.n)});s5.appendChild(el('p','sub','Violet is the mother herself, rose her children.'));
  s5.appendChild(el('h4',null,'By model'));var mod=byModel(),mx2=Math.max.apply(null,Object.keys(mod).map(function(k){return mod[k].cost}).concat([0]));Object.keys(mod).forEach(function(k){barRow(s5,k,mod[k].cost,mx2,'#86a9ff',usd(mod[k].cost))});
  var dt=el('details','nt');dt.appendChild(el('summary',null,'The full tokens table'));dt.appendChild(md(D.tokens_md));s5.appendChild(dt);
  var s6=secHead(b,'Waiting for you',5);var cards=TASKS.filter(function(k){return k.quadrant==='C'&&!k.is_check}),chk=TASKS.filter(function(k){return k.is_check});s6.appendChild(el('h4',null,'Delegate cards: '+cards.length));var u6=el('ul','mdl');cards.forEach(function(k){var li=el('li');var bb=el('button','lk',k.ref.replace('HomeOS - ','')+' '+k.title);bb.type='button';bb.onclick=function(){openTask(k)};li.appendChild(bb);u6.appendChild(li)});s6.appendChild(u6);
  s6.appendChild(el('h4',null,'Check cards: '+chk.length));if(chk.length){var uc=el('ul','mdl');chk.forEach(function(k){var li=el('li');var bb=el('button','lk',k.ref.replace('HomeOS - ','')+' '+k.title);bb.type='button';bb.onclick=function(){openTask(k)};li.appendChild(bb);uc.appendChild(li)});s6.appendChild(uc)}else s6.appendChild(el('p',null,'None seen in this run\u2019s scans. Runs from before the check field show none: not recorded.'));
  s6.appendChild(el('h4',null,'Eliminate proposals'));var el6=el('ul','mdl');S.filter(function(s){return s.role==='eliminate'}).forEach(function(s){var li=el('li');li.appendChild(linkBtn(s.name,(s.task||s.name).replace('HomeOS - ','')+': '+((TK[s.task]||{}).title||'')));el6.appendChild(li)});s6.appendChild(el6);
  var sus=D.suspects||[];if(sus.length){var ds=el('details','nt');ds.appendChild(el('summary',null,sus.length+' more look like duplicates or dead tasks to the scan'));var us=el('ul','mdl');sus.forEach(function(x){us.appendChild(el('li',null,x.ref.replace('HomeOS - ','')+': '+x.reason))});ds.appendChild(us);s6.appendChild(ds)}
  var wh=null;if(D.day_report){wh=el('details','nt');wh.id='dr-full';wh.appendChild(el('summary',null,'The whole report as written'));wh.appendChild(md(D.day_report));b.appendChild(wh)}
  var km=el('div','rkm'),kl=function(a){var d=el('div','hstats');a.forEach(function(x){var c=el('div');c.appendChild(el('b',null,x[0]));c.appendChild(el('span',null,x[1]));d.appendChild(c)});km.appendChild(d)};kl([[String(S.length),'Sessions'],[usd(totc),'At API prices'],[String(decs.length),'Decisions recorded']]);kl([[String(day.done.length),'Tasks done'],[String(nt.length),'Not taken']]);b.insertBefore(km,b.firstChild);
  [s6,s5,s3,s4,s2,s1].concat(wh?[wh]:[]).forEach(function(x,i){x.style.setProperty('--i',i);b.appendChild(x)});
  openPanel('report');if(!auto){var f=$('p-title');if(f)f.focus()}else $('sr').textContent='Day report opened.'}

function renderDecisions(){panelHead('Decisions','The master\u2019s and the mothers\u2019 decisions, oldest first.');var b=panelBody();b.tabIndex=0;if(!D.decisions.length)b.appendChild(el('p',null,'No decision recorded yet.'));D.decisions.forEach(function(x){var m=x.match(/^(\d\d:\d\d) ([\s\S]*)$/);var li=el('div','dec');li.appendChild(el('time',null,m?m[1]:''));var w=el('div','md');w.innerHTML=mdInline(m?m[2]:x);li.appendChild(w);b.appendChild(li)});
  b.appendChild(el('h3',null,'What woke the master'));if(!D.wakes)b.appendChild(el('p',null,'Not recorded: this run is from before the monitor log.'));else if(!D.wakes.length)b.appendChild(el('p',null,'No wake yet.'));else{var u=el('ul','mdl');D.wakes.forEach(function(w){u.appendChild(el('li',null,w.at+' '+w.event+(w.list?', '+w.list:'')+(w.num?' #'+w.num:'')+(w.why?': '+w.why:'')))});b.appendChild(u)}openPanel('decisions')}

/* legend */
function buildLegend(){var L=$('lg'),line=function(svg,t){return'<li><svg width="46" height="16" viewBox="0 0 46 16" aria-hidden="true">'+svg+'</svg><span>'+t+'</span></li>'};
  L.innerHTML='<h3>Sessions</h3><ul>'+
   '<li>'+rolesvg('plan',14)+'<span>Plan</span></li><li>'+rolesvg('do',14)+'<span>Do</span></li><li>'+rolesvg('eliminate',14)+'<span>Eliminate</span></li></ul>'+
   '<h3>Tasks. Press L to close</h3><ul>'+STATES.map(function(x){return'<li>'+glyph(x.k,16)+'<span>'+x.m+'</span></li>'}).join('')+'</ul>'+
   '<h3>Links</h3><ul>'+line('<path d="M2 8h38" stroke="#c4b5ff"/><circle cx="40" cy="8" r="3" fill="#fff"/>','Brief, a single pulse')+line('<path d="M2 8h42" stroke="#f3cf7a" stroke-dasharray="2 5"/><circle cx="23" cy="8" r="3" fill="#f3cf7a"/>','Plan, approval, Do')+line('<path d="M2 8h34" stroke="#ffb347" stroke-width="2" stroke-dasharray="7 6"/><circle cx="40" cy="8" r="4" fill="#ff9d2e"/>','Escalation, marching up')+line('<path d="M2 8h36" stroke="#fff" stroke-width="2.4"/><path d="M41 3l5 5-5 5-5-5z" fill="#fff"/>','Decision, a beam down')+line('<circle cx="14" cy="8" r="2.4" fill="#7fe3c0"/><circle cx="23" cy="8" r="2.4" fill="#7fe3c0"/><circle cx="32" cy="8" r="2.4" fill="#7fe3c0"/>','Report, three slow dots')+line('<rect x="17" y="4" width="12" height="8" fill="#ffe9b8"/>','Card to you')+'</ul><p class="sub" style="margin-top:6px">Where no event is logged, a link reads \u201cinferred from timestamps\u201d.</p>'}

/* run switcher */
/* ---------- components around the scene: each one always visible, each expands in place ---------- */
var DL=$('dockL'),DR=$('dockR'),CMP={};
function comp(id,title,host,action){var c=el('section','cmp');c.id='c-'+id;var h=el('div','cmph'),t=el('h2'),b=el('button','cmpt');b.type='button';b.setAttribute('aria-expanded','true');b.id='ct-'+id;b.appendChild(el('span',null,title));b.onclick=function(){toggleFold(id)};t.appendChild(b);h.appendChild(t);
  if(action){var a=el('button','cmpa',action[0]);a.type='button';a.onclick=function(){opener=a;action[1]()};a.setAttribute('aria-label',action[2]||action[0]);h.appendChild(a)}c.appendChild(h);var bd=el('div','cmpb');bd.id='cb-'+id;c.appendChild(bd);host.appendChild(c);CMP[id]=c;return bd}
function hmToMin(x){var m=/(\d{1,2}):(\d{2})/.exec(x||'');return m?+m[1]*60+ +m[2]:null}
var CK={};
function plannedMs(v){if(!v)return null;var d=Date.parse(v);if(!isNaN(d))return d;var hm=hmOf(v);if(!hm)return null;var x=new Date(masterS.t0).toLocaleDateString('en-CA',{timeZone:'Europe/Lisbon'});return Date.parse(x+'T'+hm+':00')}
function buildClock(b){var ps=plannedMs(D.planned.start),pe=plannedMs(D.planned.end),a0=masterS.t0,st=D.stopped_at?Date.parse(D.stopped_at):null,la=isFinite(masterS.t1)?masterS.t1:null,lo=Math.min(ps||a0,a0),hi=Math.max(pe||0,la||0,st||0,a0+3600000);
  var mn=function(t){return hmToMin(fm(t))},lom=Math.floor(mn(lo)/60)*60,span=Math.max(60,(hi-lo)/60000+mn(lo)-lom);CK.x=function(m){return Math.max(0,Math.min(100,(m-lom)/span*100))};
  var bar=el('div','dbar');bar.setAttribute('role','img');bar.setAttribute('aria-label','Started '+fm(a0)+(st?', stopped '+fm(st):'')+(pe?', planned end '+fm(pe):''));var seg=function(cl,f,t){var i=el('i',cl);i.style.left=CK.x(mn(f))+'%';i.style.width=Math.max(1,CK.x(mn(t))-CK.x(mn(f)))+'%';bar.appendChild(i)};
  if(ps&&pe)seg('db-plan',ps,pe);seg('db-act',a0,st||la||Date.now());var n=el('i','db-now');n.id='db-now';bar.appendChild(n);b.appendChild(bar);
  var dl=el('dl','dtimes');[['Planned start',ps?fm(ps):'not recorded'],['Actual start',fm(a0)],['Planned end',pe?fm(pe):'not recorded'],['Actual stop',st?fm(st):LIVE?'still running':'not recorded']].forEach(function(x){var d=el('div');d.appendChild(el('dt',null,x[0]));d.appendChild(el('dd',null,x[1]));dl.appendChild(d)});b.appendChild(dl);
  var ln=el('p','dlast');ln.appendChild(el('span',null,'Now on the page'));var nw=el('b',null,'');nw.id='ck-now';ln.appendChild(nw);b.appendChild(ln);
  if(la){var l2=el('p','dlast');l2.appendChild(linkBtn('master','Master\u2019s last activity'));l2.appendChild(el('b',null,fm(la)));b.appendChild(l2)}}
function shortCause(e){var c=e.cause.replace(/\s+/g,' ');var i=c.search(/[.:;]\s/);if(i>24)c=c.slice(0,i);return c.length>84?c.slice(0,c.lastIndexOf(' ',82))+'...':c}
function buildEsc(b){ESC.forEach(function(e,i){if($('ec'+i))return;var a=el('article','ecard');a.id='ec'+i;var hb=el('button','ech');hb.type='button';hb.setAttribute('aria-expanded','false');hb.setAttribute('aria-controls','ecf'+i);var tt=el('span','ect');tt.appendChild(el('span',null,shortList(e.list)+' #'+e.n+(e.apply?' apply':'')));var st=el('span','ec-fut','');st.id='ecs'+i;tt.appendChild(st);hb.appendChild(tt);hb.appendChild(el('span','ecc',shortCause(e)));
    hb.onclick=function(){var o=a.classList.toggle('open');hb.setAttribute('aria-expanded',o);if(o)climb(i);else{state.climb=null;a.removeAttribute('aria-current')}};a.appendChild(hb);
    var p=el('div','ecp');p.setAttribute('role','group');p.setAttribute('aria-label','Path of this escalation');[[e.origin,byName[e.origin]?byName[e.origin].role[0].toUpperCase()+byName[e.origin].role.slice(1)+' #'+e.n:'Origin'],[e.mother,'Mother'],['master','Master']].forEach(function(x,j){if(j)p.appendChild(el('i'));var n=el('button',null,x[1]);n.type='button';n.setAttribute('aria-label','Open '+(byName[x[0]]?byName[x[0]].short:x[1]));n.onclick=function(){select(x[0],true)};p.appendChild(n)});a.appendChild(p);
    var d=el('p','ecd');d.appendChild(el('b',null,e.td?'Decision: ':''));d.appendChild(document.createTextNode(e.decision?firstPara(e.decision).replace(/master-[0-9-]+/,'the master').slice(0,64).replace(/[\s,]+\S*$/,'')+'...':'No decision recorded.'));a.appendChild(d);
    var f=el('div','ecf');f.id='ecf'+i;f.tabIndex=0;f.setAttribute('role','region');f.setAttribute('aria-label','Full text of escalation '+e.n);f.appendChild(md(e.raw+(e.decision?'\n\n'+e.decision:'')));var mm=el('div','ecm');var w=el('button','cmpa','Read wide');w.type='button';w.onclick=function(){opener=w;renderEsc();var c=$('esc'+i);if(c){c.scrollIntoView({block:'start'});var dt=c.querySelector('details');if(dt)dt.open=true}};mm.appendChild(w);f.appendChild(mm);a.appendChild(f);b.appendChild(a)})}
function syncEsc(){ESC.forEach(function(e,i){var s=$('ecs'+i);if(!s)return;var t=state.t,x=t<e.t?['ec-fut','later']:e.td&&t>=e.td?['ec-dec','decided '+fm(e.td)]:e.td?['ec-wait','raised '+fm(e.t)]:['ec-wait','no decision'];s.textContent=x[1];s.className=x[0];$('ec'+i).classList.toggle('fut',t<e.t)})}
function hmOf(x){var m=/(\d{1,2}:\d{2})/.exec(x||'');return m?m[1]:null}
var runCur=D.ts;
function buildRuns(b){b.textContent='';var day=null;RUNS.forEach(function(r){var d=r.ts.slice(0,10);if(d!==day){day=d;b.appendChild(el('h3','rday',d))}var closed=r.day_report||r.stopped,det=r.sessions+' sessions, '+(r.cost!=null?usd(r.cost)+' at API prices, ':'')+r.escalations+' escalated';var bt=el('button','rrow');bt.type='button';bt.dataset.ts=r.ts;var bb=el('b');var mk=el('i','rmk'+(closed?'':' open'));bb.appendChild(mk);bb.appendChild(document.createTextNode((hmOf(r.start)||hmOf(r.ts.replace(/.*--(\d\d)-(\d\d).*/,'$1:$2'))||'?')+(r.stopped_at?' to '+fm(Date.parse(r.stopped_at)):closed?'':', not closed')));bt.appendChild(bb);bt.appendChild(el('span','rdt',det));bt.title=det;bt.setAttribute('aria-label','Run '+r.ts+': '+det);bt.onclick=function(){switchRun(r)};b.appendChild(bt)});markRun()}
function markRun(){document.querySelectorAll('.rrow').forEach(function(x){if(x.dataset.ts===runCur)x.setAttribute('aria-current','true');else x.removeAttribute('aria-current')})}
function backToRun(){}
/* a run is the whole page: choosing one loads it */
function switchRun(r){if(r.ts===D.ts)return;location.hash='#run='+r.ts;location.reload()}
/* resume and fork: never a dead end */
function cmdBlock(s,pre){var w=el('div','cmds');var c=s.controls;if(!c.copy){w.appendChild(el('p','sub','No session id.'));return w}
  var r=el('div','cmdr');if(c.continue_in_claude){var a=el('a','btn','Continue in Claude');a.href=c.continue_in_claude;a.id=pre+'claude';a.title='Opens a copy in the Claude app; the original is untouched. Needs tools/install-continue-handler.ps1. The handler refuses while it runs or holds its task.';r.appendChild(gate(a,'claude',s))}
  var b=el('button','btn copyi','Copy');b.type='button';b.id=pre+'fork';b.title='Copies: '+c.copy+'. Run it in the repo folder.';b.setAttribute('aria-label','Copy the command that opens a copy of this session');b.onclick=function(){copyText(c.copy,b)};r.appendChild(gate(b,'copy',s));w.appendChild(r);return w}
var nowKey='';
function syncNow(){$('now').textContent=nowLine();var wk=S.filter(function(s){return s.role!=='master'&&(M.sess[s.name]||{}).working}),rec=[];for(var i=Math.min(cursor,EV.length)-1;i>=0&&rec.length<2;i--){var e=EV[i];if(e.cap&&e.t<=state.t)rec.push(e)}
  var key=wk.map(function(s){return s.name}).join()+'|'+rec.map(function(e){return e.t+e.cap}).join();if(key===nowKey)return;nowKey=key;var L=$('nowl');L.textContent='';wk.slice(0,4).forEach(function(s){L.appendChild(linkBtn(s.name,s.role==='mother'?'Mother '+shortList(s.list):s.short))});
  var U=$('nowe');U.textContent='';rec.forEach(function(e){var li=el('li');li.appendChild(el('time',null,fm(e.t)));var tg=e.s||e.to||e.from;if(tg&&byName[tg])li.appendChild(linkBtn(tg,e.cap));else li.appendChild(el('span',null,e.cap));U.appendChild(li)})}
var spLast=0;
function syncSpend(force){var nw=performance.now();if(!force&&state.playing&&nw-spLast<400)return;spLast=nw;var t=state.t,tot=totalSpent(t);$('sp-t').firstChild.textContent=usd(tot);var mx=Math.max(1,tot);$('sp-rows').querySelectorAll('.spr').forEach(function(r){var l=r.dataset.l,v=S.reduce(function(a,s){return a+((l==='master'?s.role==='master':s.list===l)?spentOf(s,t):0)},0);r.querySelector('i').style.width=(v/mx*100)+'%';r.lastChild.textContent=usd(v)})}
function renderRoutine(){opener=document.activeElement&&document.activeElement!==document.body?document.activeElement:$('prof');restoreSize();state.sel=null;markSel();panelHead('Routine eisenhower-master','It fires on a schedule or by hand and starts one master for the day. It has no session of its own.');var b=panelBody();
  var sc=null;D.master_decisions.some(function(x){var i=x.indexOf('Schedule in the app');if(i<0)return false;sc=x.slice(i).split(': left')[0].split('. ')[0];return true});
  b.appendChild(el('h3',null,'Schedule'));b.appendChild(el('p',null,sc?sc+'.':'Not recorded in this run.'));
  b.appendChild(el('h3',null,'This run'));var dl=el('dl','kv');[['Fired','about '+fs(RT)+', inferred: the master\u2019s first record is its only trace'],['Planned start',D.planned.start||'not recorded']].forEach(function(x){dl.appendChild(el('dt',null,x[0]));dl.appendChild(el('dd',null,x[1]))});b.appendChild(dl);
  b.appendChild(el('h3',null,'What it started'));var p=el('p');p.appendChild(linkBtn('master','Master: '+masterS.goal));b.appendChild(p);
  b.appendChild(el('h3',null,'Go on from here'));b.appendChild(el('p','sub','A routine cannot be resumed; the master it started can.'));b.appendChild(cmdBlock(masterS,'r-'));openPanel('routine');lightRoutine(true);var f=$('p-title');if(f)f.focus()}
function lightRoutine(on){if(on)$('lab-routine').setAttribute('aria-current','true');else $('lab-routine').removeAttribute('aria-current')}
function buildDocks(){
  buildClock(comp('clock','Day clock',DL));
  buildEsc(comp('esc','Escalations',DL,['All',function(){renderEsc();var f=$('p-title');if(f)f.focus()},'Open all escalations']));var cn=el('b',null,'0');cn.id='n-esc';$('ct-esc').appendChild(cn);
  buildRuns(comp('runs','Runs',DL));
  
  var nb=comp('now','Now',DR);var bw=el('p','budgetw');bw.id='budgetw';bw.setAttribute('role','status');bw.hidden=true;nb.appendChild(bw);var lv=el('p','nowpast','');lv.id='nowpast';nb.appendChild(lv);var cn2=el('p','sub');cn2.id='conn';cn2.hidden=true;nb.appendChild(cn2);var np=el('p');np.id='now';nb.appendChild(np);var nl=el('div','nowl');nl.id='nowl';nb.appendChild(nl);var ne=el('ul','nowe');ne.id='nowe';nb.appendChild(ne);syncNowHead();
  comp('queue','Queue',DR).appendChild($('qm'));
  var sb=comp('spend','Spend',DR,['Budget',function(){renderBudget();var f=$('p-title');if(f)f.focus()},'Open Budget']);var bt=el('button','spb');bt.type='button';bt.setAttribute('aria-label','Open Budget');bt.onclick=function(){opener=bt;renderBudget();var f=$('p-title');if(f)f.focus()};var tt=el('span','spt');tt.style.display='block';tt.id='sp-t';tt.appendChild(document.createTextNode('$0'));tt.appendChild(el('small',null,'at API prices'));bt.appendChild(tt);var rows=el('span');rows.style.display='block';rows.id='sp-rows';addSpendRow(rows,'master','Master, own','mcm');MOTHERS.forEach(function(n){addSpendRow(rows,byName[n].list,shortList(byName[n].list),mcOf(byName[n]))});bt.appendChild(rows);sb.appendChild(bt);
  var se=comp('sessions','Sessions',DR);var ns=el('b',null,'0');ns.id='n-ses';$('ct-sessions').appendChild(ns);se.appendChild($('tree'));var wf=el('div');wf.id='wf';STAGE.appendChild(wf);var sm=el('div');sm.id='stackm';STAGE.appendChild(sm);buildShell();syncDocks(true)}
function shortList(l){return({'homeos-gamedevelopment':'Game','homeos-self-improvements':'Self-impr.','homeos-telegram-development':'Telegram','homeos-tasks':'Generic'})[l]||nice(l).slice(0,14)}
function syncDocks(force){var n=$('db-now');if(n&&CK.x){var m=hmToMin(fm(state.t));n.style.left=CK.x(m)+'%'}var ck=$('ck-now');if(ck)ck.textContent=fm(state.t);$('n-esc').textContent=M.esc||0;syncEsc();syncNow();syncSpend(force)}

/* ---------- the frame: view, preferences per view, sections, rails, player ---------- */
var MENU_MIN=240,RAIL=58,VKEY='eisenhower-harness-view',PKEYS={modern:'eisenhower-harness-prefs-modern',classic:'eisenhower-harness-prefs-classic'},CMIN={modern:540,classic:480};
try{[localStorage,sessionStorage].forEach(function(st){for(var i=st.length-1;i>=0;i--){var k=st.key(i);if(/^(eisenhower-harness-prefs-v\d|p2d-|p1d|classic\.v\d)/.test(k))st.removeItem(k)}})}catch(e){}
var CO=[['clock','Day clock'],['esc','Escalations'],['runs','Runs'],['queue','Queue'],['sessions','Sessions'],['now','Now'],['spend','Spend']];
var CNAME={};CO.forEach(function(c){CNAME[c[0]]=c[1]});
var PLACES={left:'Left menu',right:'Right menu',below:'Below the centre'};
var ICO={clock:'<circle cx="9" cy="9" r="6.5"/><path d="M9 5v4l3 2"/>',esc:'<path d="M9 15V4M5 8l4-4 4 4"/><path d="M4 15h10"/>',runs:'<rect x="3" y="4" width="12" height="11" rx="1"/><path d="M3 8h12M7 2v3M11 2v3"/>',queue:'<path d="M3 5h12M3 9h12M3 13h7"/>',sessions:'<circle cx="4" cy="9" r="2"/><circle cx="14" cy="4" r="2"/><circle cx="14" cy="14" r="2"/><path d="M6 9h3M9 4v10M9 4h3M9 14h3"/>',now:'<path d="M2 9h3l2-5 4 10 2-5h3"/>',spend:'<path d="M4 15V9M9 15V3M14 15v-4"/>'};
function ic(k){return'<svg class="ci" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+ICO[k]+'</svg>'}
var CHEV='<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3l4 4-4 4"/></svg>';
var CUP='<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l4-4 4 4"/></svg>',CDN=CUP.replace('M3 9l4-4 4 4','M3 5l4 4 4-4');
function defaults(){return{comps:[['queue','left'],['esc','left'],['now','left'],['clock','right'],['sessions','right'],['runs','right'],['spend','below']].map(function(x){return{id:x[0],on:true,place:x[1]}}),lw:null,rw:null,lc:false,rc:false,player:false,split:.5,fold:{},mfold:{clock:true,runs:true,queue:true,sessions:true,spend:true},mpos:{},morder:[]}}
function loadP(v){var d=defaults();try{var r=JSON.parse(localStorage.getItem(PKEYS[v])||'null');if(r&&Array.isArray(r.comps)){var seen={},o=[];r.comps.forEach(function(c){if(CNAME[c.id]&&PLACES[c.place]&&!seen[c.id]){seen[c.id]=1;o.push({id:c.id,on:!!c.on,place:c.place})}});d.comps.forEach(function(c){if(!seen[c.id])o.push(c)});d.comps=o;['lw','rw'].forEach(function(k){if(typeof r[k]==='number')d[k]=r[k]});d.lc=!!r.lc;d.rc=!!r.rc;d.player=!!r.player;if(typeof r.split==='number')d.split=Math.max(.05,Math.min(.95,r.split));if(r.fold&&typeof r.fold==='object')d.fold=r.fold;if(r.mfold&&typeof r.mfold==='object')d.mfold=r.mfold;if(r.mpos&&typeof r.mpos==='object')d.mpos=r.mpos;if(Array.isArray(r.morder))d.morder=r.morder}}catch(e){}return d}
function saveP(){try{localStorage.setItem(PKEYS[VIEW],JSON.stringify(PR))}catch(e){}}
function firstView(){try{return localStorage.getItem(VKEY)==='classic'?'classic':'modern'}catch(e){return'modern'}}
var VIEW=firstView(),PR=loadP(VIEW),CENTRE_MIN=CMIN[VIEW];document.documentElement.dataset.view=VIEW;
function isStack(){return innerWidth<900}
function hiddenHere(c){return VIEW==='classic'&&c.id==='sessions'} /* Classic: the waterfall is the session list */
function inPlace(p){return PR.comps.filter(function(c){return c.place===p&&c.on&&!hiddenHere(c)})}
function has(s){return inPlace(s==='l'?'left':'right').length>0}
function defW(s){return Math.max(MENU_MIN,Math.round(innerWidth*.25))}
function rawW(s){var w=PR[s+'w'];return w==null?defW(s):Math.max(MENU_MIN,w)}
function collapsed(s){return PR[s+'c']}
function fit(){var V=innerWidth,l=has('l')?(PR.lc?RAIL:rawW('l')):0,r=has('r')?(PR.rc?RAIL:rawW('r')):0,lr=false,rr=false,over=l+r+CENTRE_MIN-V,d;
  if(over>0&&r>MENU_MIN){d=Math.min(over,r-MENU_MIN);r-=d;over-=d}if(over>0&&l>MENU_MIN){d=Math.min(over,l-MENU_MIN);l-=d;over-=d}
  if(over>0&&l>RAIL){over-=l-RAIL;l=RAIL;lr=true}if(over>0&&r>RAIL){r=RAIL;rr=true}
  return{l:l,r:r,lRail:PR.lc||lr,rRail:PR.rc||rr}}
function maxW(s){var f=fit(),other=s==='l'?f.r:f.l;return Math.max(MENU_MIN,innerWidth-other-CENTRE_MIN)}
var RL={};
function buildShell(){
  var pk=el('div');pk.id='parking';document.body.appendChild(pk);
  var bl=el('div');bl.id='below';bl.setAttribute('role','region');bl.setAttribute('aria-label','Below the centre');document.body.appendChild(bl);
  ['l','r'].forEach(function(s){var dk=s==='l'?DL:DR,rl=el('div','rails0');dk.prepend(rl);RL[s]=rl;
    var z=el('div','mz');z.id='mz'+s;z.setAttribute('role','separator');z.tabIndex=0;z.setAttribute('aria-orientation','vertical');z.setAttribute('aria-label',(s==='l'?'Left':'Right')+' menu width. Arrow keys resize, Home collapses, End goes to the widest.');z.setAttribute('aria-valuemin',MENU_MIN);document.body.appendChild(z);
    var c=el('button','mc');c.type='button';c.id='mc'+s;c.onclick=function(){var rail=fit()[s+'Rail'];expandOrCollapse(s,!rail)};document.body.appendChild(c);
    var drag=false;z.addEventListener('pointerdown',function(e){drag=true;z.setPointerCapture(e.pointerId);z.classList.add('drag');e.preventDefault()});
    z.addEventListener('pointermove',function(e){if(drag)setMenuW(s,s==='l'?e.clientX:innerWidth-e.clientX)});
    var up=function(){if(drag){drag=false;z.classList.remove('drag');saveP()}};z.addEventListener('pointerup',up);z.addEventListener('pointercancel',up);
    z.addEventListener('keydown',function(e){var grow=s==='l'?'ArrowRight':'ArrowLeft',shrink=s==='l'?'ArrowLeft':'ArrowRight',cur=rawW(s);if(e.key===grow)setMenuW(s,collapsed(s)?MENU_MIN:cur+24);else if(e.key===shrink)setMenuW(s,cur<=MENU_MIN?MENU_MIN-1:Math.max(MENU_MIN,cur-24));else if(e.key==='Home')setMenuW(s,0);else if(e.key==='End')setMenuW(s,maxW(s));else return;e.preventDefault();saveP()})});
  $('ph').onclick=function(){PR.player=!PR.player;saveP();syncPlayer();setCam()};
  $('prof').onclick=function(){toggleMenu()};
  $('pm-prefs').onclick=function(){toggleMenu(false);openPrefs()};
  $('pm-view').onclick=function(){toggleMenu(false);setView(VIEW==='modern'?'classic':'modern');$('prof').focus()};
  $('pmenu').addEventListener('keydown',function(e){var it=[$('pm-prefs'),$('pm-view')],i=it.indexOf(document.activeElement);if(e.key==='ArrowDown'||e.key==='ArrowUp'){it[(i+1)%2].focus();e.preventDefault()}});
  wireClose();
  if(window.ResizeObserver)new ResizeObserver(function(){if(W)setCam()}).observe(bl);syncViewLabel();syncPlayer();applyLayout()}
function expandOrCollapse(s,col){PR[s+'c']=col;if(!col&&fit()[s+'Rail']){var o=s==='l'?'r':'l';PR[o+'c']=true}saveP();setCam()}
function foldKey(){return isStack()?'mfold':'fold'}
function syncFold(){CO.forEach(function(c){var k=c[0],f=!!PR[foldKey()][k];CMP[k].classList.toggle('shut',f);$('ct-'+k).setAttribute('aria-expanded',!f)})}
function toggleFold(id){var o=PR[foldKey()];o[id]=!o[id];saveP();syncFold();posDirty=true;setCam()}
function syncPlayer(){var o=PR.player,l=o?'Collapse the player':'Expand the player';$('hud').classList.toggle('closed',!o);$('ph').setAttribute('aria-expanded',o);$('ph').setAttribute('aria-label',l);$('ph').title=l}
function setMenuW(s,v){if(v<MENU_MIN)PR[s+'c']=true;else{PR[s+'c']=false;PR[s+'w']=Math.min(v,maxW(s))}setCam()}
function toggleMenu(f){var m=$('pmenu'),o=f===undefined?!m.classList.contains('open'):f;m.classList.toggle('open',o);$('prof').setAttribute('aria-expanded',o);if(o)$('pm-prefs').focus()}
function syncViewLabel(){$('pm-view').textContent=VIEW==='modern'?'Switch to classic view':'Switch to modern view'}
function viewLabel(){STAGE.setAttribute('aria-label',VIEW==='classic'?'Plan execution over budget spend, on one time axis. Pick a row to open a session.':'The day: master in the centre, four lists around it. Each task and session keeps its place.')}
function setView(v){if(v===VIEW)return;VIEW=v;try{localStorage.setItem(VKEY,v)}catch(e){}PR=loadP(v);CENTRE_MIN=CMIN[v];document.documentElement.dataset.view=v;syncViewLabel();viewLabel();pfMsg='';
  var fd=document.documentElement;fd.classList.remove('vfade');void fd.offsetWidth;if(!reduce.matches)fd.classList.add('vfade');
  buildWf();syncPlayer();applyLayout();if($('prefs').classList.contains('open'))renderPrefs();syncDocks(true);$('sr').textContent=v==='classic'?'Classic view':'Modern view';posDirty=true;measure();syncWf()}
/* place components by preference; one design for every menu */
function applyLayout(){var stack=isStack(),pk=$('parking');document.body.classList.toggle('stack',stack);var was=applyLayout.stack;applyLayout.stack=stack;
  var sm=$('stackm');PR.comps.forEach(function(c){if(!c.on||spendInCentre(c)||hiddenHere(c))pk.appendChild(CMP[c.id])});
  ['left','right','below'].forEach(function(p){var host=stack?sm:(p==='left'?DL:p==='right'?DR:$('below'));inPlace(p).forEach(function(c){if(!spendInCentre(c))host.appendChild(CMP[c.id])})});
  syncFold();
  ['l','r'].forEach(function(s){var rl=RL[s];rl.textContent='';inPlace(s==='l'?'left':'right').forEach(function(c){var b=el('button','rbtn');b.type='button';b.dataset.c=c.id;b.title='Expand '+CNAME[c.id];b.setAttribute('aria-label','Expand '+CNAME[c.id]);b.innerHTML=ic(c.id)+'<span class="ar">'+CHEV+'</span>';b.onclick=function(){expandOrCollapse(s,false);if(PR.fold[c.id]){PR.fold[c.id]=false;saveP();syncFold();setCam()}CMP[c.id].scrollIntoView({block:'nearest'});$('ct-'+c.id).focus()};rl.appendChild(b)})});
  syncCentre();posDirty=true;if(W)setCam()}
function spendInCentre(c){return VIEW==='classic'&&c.id==='spend'&&c.place==='below'}
function placeDocks(){if(CMP.clock&&applyLayout.stack!==isStack())applyLayout()}
/* preferences */
var pfMsg='';
function openPrefs(){pfMsg='';$('prefs').classList.add('open');renderPrefs();setCam();$('pf-title').focus()}
function closePrefs(){$('prefs').classList.remove('open');$('prof').focus()}
function renderPrefs(focusId){var p=$('prefs');p.textContent='';var h=el('h2',null,'Preferences: '+(VIEW==='classic'?'Classic':'Modern')+' view');h.id='pf-title';h.tabIndex=-1;p.appendChild(h);p.appendChild(el('p','sub','Choose what shows and where in this view. The other view keeps its own choices.'));var x=el('button','x pfx');x.type='button';x.id='pf-x';x.setAttribute('aria-label','Close preferences');x.innerHTML='&times;';x.onclick=closePrefs;p.appendChild(x);
  Object.keys(PLACES).forEach(function(pl){var g=PR.comps.filter(function(c){return c.place===pl&&!hiddenHere(c)});p.appendChild(el('h3',null,PLACES[pl]));if(!g.length)p.appendChild(el('p','pempty',pl==='below'?'Nothing here: the scene takes the space.':'Nothing here: this menu stays closed.'));g.forEach(function(c,i){var r=el('div','prow'+(c.on?'':' isoff'));r.insertAdjacentHTML('beforeend',ic(c.id));r.appendChild(el('span','pn',CNAME[c.id]));
      var sw=el('label','sw'),cb=el('input');cb.type='checkbox';cb.setAttribute('role','switch');cb.id='pf-on-'+c.id;cb.checked=c.on;cb.setAttribute('aria-label','Show '+CNAME[c.id]);cb.onchange=function(){c.on=cb.checked;prefChange(cb.id)};sw.appendChild(cb);sw.appendChild(el('i'));r.appendChild(sw);
      var se=el('select');se.id='pf-pl-'+c.id;se.setAttribute('aria-label','Place of '+CNAME[c.id]);Object.keys(PLACES).forEach(function(k){var o=el('option',null,PLACES[k]);o.value=k;if(k===pl)o.selected=true;se.appendChild(o)});se.onchange=function(){PR.comps.splice(PR.comps.indexOf(c),1);c.place=se.value;PR.comps.push(c);prefChange(se.id)};r.appendChild(se);
      var mv=function(dir,cl,svg,lab,dis){var b=el('button','mv '+cl);b.type='button';b.id='pf-'+cl+'-'+c.id;b.innerHTML=svg;b.setAttribute('aria-label',lab+' '+CNAME[c.id]);b.disabled=dis;b.onclick=function(){var o=g[i+dir],a=PR.comps.indexOf(c),z=PR.comps.indexOf(o);PR.comps[a]=o;PR.comps[z]=c;prefChange(g[i+dir+dir]?b.id:'pf-'+(dir<0?'dn':'up')+'-'+c.id)};r.appendChild(b)};
      mv(-1,'up',CUP,'Move up',i===0);mv(1,'dn',CDN,'Move down',i===g.length-1);p.appendChild(r)})});
  var f=el('div','pff');var ms=el('span',null,pfMsg);ms.id='pf-msg';ms.setAttribute('role','status');f.appendChild(ms);var rs=el('button','btn','Reset this view');rs.type='button';rs.id='pf-reset';rs.onclick=function(){try{localStorage.removeItem(PKEYS[VIEW])}catch(e){}PR=defaults();pfMsg=(VIEW==='classic'?'Classic':'Modern')+' view is back to its defaults. The other view did not change.';renderPrefs('pf-reset');applyLayout();syncDocks(true)};f.appendChild(rs);p.appendChild(f);
  if(focusId){var t=$(focusId);if(t)t.focus()}}
function prefChange(fid){pfMsg='';saveP();renderPrefs(fid);applyLayout();syncDocks(true)}
/* the Classic centre: Plan execution over Budget spend, on one time axis; same model, same selection, same replay position */
var MCI={};D.sessions.filter(function(s){return s.role==='mother'&&!s.restart_of}).forEach(function(s,i){MCI[s.name]=i%4});
function mcOf(s){var r=s;while(r&&r.role!=='mother')r=r.parent?byName[r.parent]:null;return r?'mc'+MCI[r.name]:'mcm'}
var wfN=-1,WFX={},BUD=[],wfE=0,wfLast=0;
function wfOrder(){var o=[],w=function(s,d){o.push([s,d]);var kids=childrenOf(s.name).sort(function(a,b){return a.t0-b.t0}),hung={},sib=function(k,r){return kids.filter(function(x){return x.role===r&&x.num===k.num})[0]};kids.forEach(function(k){if(k.role==='do'&&sib(k,'plan'))hung[k.name]=1});kids.forEach(function(k){if(hung[k.name])return;w(k,d+1);if(k.role==='plan'){var dn=sib(k,'do');if(dn&&hung[dn.name])w(dn,d+2)}})};w(masterS,0);S.forEach(function(x){if(!o.some(function(y){return y[0]===x}))o.push([x,x.role==='master'?1:2])});return o}
function wfEnd(){return Math.max(T1,tEnd())}
function ticksInto(ax){ax.textContent='';var e=wfEnd(),step=15*60000,n=0,all=[];for(var t=Math.ceil(T0/step)*step;t<e;t+=step)all.push(t);var every=isStack()?3:all.length>7?2:1;all.forEach(function(t){if(n++%every)return;var sn=el('span',null,fm(t));sn.style.left=((t-T0)/(e-T0)*100)+'%';ax.appendChild(sn)})}
function budPath(fn,mx){var e=wfEnd(),n=160,d='M0 100',i,t;for(i=0;i<=n;i++){t=T0+(e-T0)*i/n;d+=' L'+(i/n*1000).toFixed(1)+' '+(100-Math.min(1,fn(t)/mx)*94).toFixed(2)}return d+' L1000 100 Z'}
function budSvg(fn,mx,cls,label){var d=budPath(fn,mx);return'<svg class="'+cls+'" viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label="'+esc(label)+'"><path class="bghost" d="'+d+'" vector-effect="non-scaling-stroke"/><path class="bfill" d="'+d+'" vector-effect="non-scaling-stroke"/></svg><i class="bcur"></i>'}
function groupAt(a,t){return a.reduce(function(c,s){return c+spentOf(s,t)},0)}
function buildWf(){var wf=$('wf');wf.textContent='';WFX={};BUD=[];if(VIEW!=='classic'){wfN=-1;return}wfN=S.length;wfE=wfEnd();
  var pl=el('section','cplan');pl.id='cplan';pl.setAttribute('aria-labelledby','cplan-h');var ph=el('div','chd');var h=el('h2',null,'Plan execution');h.id='cplan-h';ph.appendChild(h);var hax=el('div','chax');hax.appendChild(el('span','chwho','Who started whom. Solid: working. Thin: idle.'));var ax=el('div','wfax');ax.id='wfax';hax.appendChild(ax);ph.appendChild(hax);pl.appendChild(ph);ticksInto(ax);
  var rw=el('div','wfrows');rw.id='wfrows';pl.appendChild(rw);
  var rt=el('button','wfr d0 wr-routine');rt.type='button';rt.id='wf-routine';var rn=el('span','wn');rn.appendChild(el('i','wm'));rn.appendChild(el('span',null,'Routine'));rt.appendChild(rn);rt.appendChild(el('span','wfb'));rt.setAttribute('aria-label','Routine: what started the day');rt.onclick=renderRoutine;rw.appendChild(rt);
  wfOrder().forEach(function(x){var s=x[0],d=Math.min(x[1],3),b=el('button','wfr d'+d+' wr-'+s.role);b.type='button';b.dataset.w=s.name;var n=el('span','wn');n.appendChild(el('i','wm'));n.appendChild(el('span',null,s.role==='mother'?nice(s.list):s.short));b.appendChild(n);var ba=el('span','wfb'),spn=el('i','sp');ba.appendChild(spn);var segs=(s.per||[]).map(function(p){var g=el('i','sg');ba.appendChild(g);return{g:g,p:p}});b.appendChild(ba);b.setAttribute('aria-label',s.short+', '+fm(s.t0)+' to '+fm(s.t1));b.onclick=function(){select(s.name,true)};rw.appendChild(b);WFX[s.name]={b:b,sp:spn,segs:segs,s:s}});
  var cur=el('i','wfcur');cur.id='wfcur';rw.appendChild(cur);wf.appendChild(pl);
  var sl=el('div','csplit');sl.id='csplit';sl.setAttribute('role','separator');sl.setAttribute('aria-orientation','horizontal');sl.tabIndex=0;sl.setAttribute('aria-label','Divider between Plan execution and Budget spend. Arrow keys move it, Home goes back to half.');sl.setAttribute('aria-valuemin','0');sl.setAttribute('aria-valuemax','100');wf.appendChild(sl);wireSplit(sl);
  var bu=el('section','cbud');bu.id='cbud';bu.setAttribute('aria-labelledby','cbud-h');var top=el('div','cbm');var side=el('div','cbs');var bh=el('h2',null,'Budget spend');bh.id='cbud-h';side.appendChild(bh);var tt=el('p','cbt');var tv=el('b',null,'$0');tv.id='cb-tot';tt.appendChild(tv);tt.appendChild(el('span',null,' at API prices, so far'));side.appendChild(tt);side.appendChild(el('p','cbn','Tokens by kind times each model’s price, at the time of every request.'));var ob=el('button','btn','Open Budget');ob.type='button';ob.id='cb-open';ob.onclick=function(){opener=ob;renderBudget();var f=$('p-title');if(f)f.focus()};side.appendChild(ob);top.appendChild(side);
  var total=Math.max(.01,costAtReal(T1)),plot=el('div','cbp');plot.appendChild(el('span','cbtop',usd(total)));var ch=el('div','cbchart');ch.innerHTML=budSvg(costAtReal,total,'bmain','Cost over the day, from $0 to '+usd(total));plot.appendChild(ch);var ta=el('div','wfax cbax');ticksInto(ta);plot.appendChild(ta);top.appendChild(plot);bu.appendChild(top);
  var ls=el('div','cbl');var groups=[{n:'Master, own',name:'master',c:'mcm',a:[masterS],f:function(s){return s.role==='master'}}].concat(D.sessions.filter(function(s){return s.role==='mother'&&!s.restart_of}).map(function(m){var nm=m.name,l=byName[nm].list;return{n:nice(l),name:nm,c:mcOf(byName[nm]),a:S.filter(function(s){return s.list===l}),f:function(s){return s.list===l}}}));
  var gm=Math.max.apply(null,groups.map(function(g){return groupAt(g.a,T1)}).concat([.01]));groups.forEach(function(g){var r=el('div','cbr '+g.c),lb=el('div','cbrl');lb.appendChild(el('i','bmark'));var a=el('button','lk',g.n);a.type='button';a.onclick=function(){select(g.name,true)};lb.appendChild(a);var v=el('b',null,'');lb.appendChild(v);r.appendChild(lb);var sp2=el('div','cbspark');sp2.innerHTML=budSvg(function(t){return groupAt(g.a,t)},gm,'bspark','Cost of '+g.n+' over the day');r.appendChild(sp2);ls.appendChild(r);BUD.push({g:g,v:v})});bu.appendChild(ls);wf.appendChild(bu);
  syncCentre()}
function syncCentre(){var bu=$('cbud');if(!bu)return;var c=PR.comps.filter(function(x){return x.id==='spend'})[0],on=c.on&&c.place==='below';bu.style.display=on?'':'none';$('csplit').style.display=on?'':'none';splitApply()}
function splitApply(){var pl=$('cplan'),bu=$('cbud'),sl=$('csplit');if(!pl)return;var on=bu.style.display!=='none'&&!isStack();pl.style.flex=on?PR.split+' 1 0':(isStack()?'':'1 1 0');bu.style.flex=on?(1-PR.split)+' 1 0':'';sl.setAttribute('aria-valuenow',Math.round(PR.split*100))}
function wireSplit(sl){var drag=false,mv=function(y){var r=$('wf').getBoundingClientRect(),h=r.height-sl.offsetHeight;if(h<=0)return;var mn=Math.min(.45,130/h);PR.split=Math.max(mn,Math.min(1-mn,(y-r.top)/h));splitApply()};
  sl.addEventListener('pointerdown',function(e){drag=true;sl.setPointerCapture(e.pointerId);sl.classList.add('drag');e.preventDefault()});sl.addEventListener('pointermove',function(e){if(drag)mv(e.clientY)});var up=function(){if(drag){drag=false;sl.classList.remove('drag');saveP()}};sl.addEventListener('pointerup',up);sl.addEventListener('pointercancel',up);
  sl.addEventListener('keydown',function(e){var r=$('wf').getBoundingClientRect(),h=r.height;if(e.key==='ArrowUp')mv(r.top+PR.split*h-24);else if(e.key==='ArrowDown')mv(r.top+PR.split*h+24);else if(e.key==='Home'){PR.split=.5;splitApply()}else return;e.preventDefault();saveP()})}
function syncWf(){if(VIEW!=='classic')return;var e=wfEnd(),nw=performance.now();if(wfN!==S.length||(e!==wfE&&nw-wfLast>1500)){wfLast=nw;var st=$('wfrows')?$('wfrows').scrollTop:0;buildWf();if(st)$('wfrows').scrollTop=st}e=wfE;var t=state.t,X=function(v){return Math.min(100,(v-T0)/(e-T0)*100)},head=X(t);
  Object.keys(WFX).forEach(function(n){var w=WFX[n],q=M.sess[n]||{},s=w.s;w.b.classList.toggle('future',!q.born);if(state.sel===n)w.b.setAttribute('aria-current','true');else w.b.removeAttribute('aria-current');var end=s.t1===Infinity?t:s.t1;w.sp.style.left=X(s.t0)+'%';w.sp.style.width=Math.max(0,X(end)-X(s.t0))+'%';w.segs.forEach(function(g){g.g.style.left=X(g.p[0])+'%';g.g.style.width=Math.max(.2,X(g.p[1])-X(g.p[0]))+'%';g.g.classList.toggle('ahead',g.p[0]>t)})});
  var w=$('wf');w.style.setProperty('--x',head/100);w.style.setProperty('--cut',(100-head)+'%');
  $('cb-tot').textContent=usd(totalSpent(t));BUD.forEach(function(b){b.v.textContent=usd(S.reduce(function(a,s){return a+(b.g.f(s)?spentOf(s,t):0)},0))})}
function wfLit(sess){if(VIEW!=='classic')return;Object.keys(WFX).forEach(function(n){WFX[n].b.classList.toggle('lit',!!sess&&sess.indexOf(n)>=0)})}
/* mothers: a per-run layout, derived from the run id; the same run always looks the same */
var MOTHER_DIST_MIN=170,MOTHER_DIST_MAX=620,MOTHER_CLEAR=10,MOTHER_ANGLE_SHIFT=90,layoutSeed=D.ts;
function seedOf(id){var h=2166136261;for(var i=0;i<id.length;i++){h^=id.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0}
function setLayoutSeed(id){layoutSeed=id;layoutMothers();readPos();req()}
function layoutMothers(){var qs=MOTHERS.map(function(n,i){return $('q'+i)});if(!qs[0])return;MG=null;qs.forEach(function(q){q.classList.remove('qanim');q.style.transform='';q.style.minHeight=''});wireDrag(qs);if(VIEW==='classic'||G.compact||!STAGE.clientWidth){orbOff(qs);return}if(orbArrange(qs))return;
  /* each mother is one reserved block of fixed height; if they do not fit: smaller marks, then icon and count only */
  var reserve=function(){var cm=STAGE.classList.contains('ccomp'),row=STAGE.classList.contains('csm')?20:24;qs.forEach(function(q,i){var tr=q.querySelector('.tray'),l=byName[MOTHERS[i]].list,rows=0;STATES.forEach(function(x){if((MAXG||{})[l+'|'+x.k])rows++});if(!tr)return;var per=cm?Math.max(1,Math.floor((q.clientWidth-16)/52)):1,est=q.classList.contains('qdone')?8+row:8+Math.ceil(rows/per)*row,head=q.querySelector('.mh').offsetHeight+(q.querySelector('.osys')||q.querySelector('.rails')).offsetHeight+10;q.style.minHeight=Math.ceil(head+est)+'px'});var st=null;if(st){var sr=0;STATES.forEach(function(x){if((MAXG||{})['stocks|'+x.k])sr++});st.style.minHeight=(8+(cm?Math.ceil(sr/4):sr)*row)+'px'}capWidths();syncCaps()},over=function(){var cols={l:0,r:0},rb=$('ringbox').getBoundingClientRect(),mx=rb.left+rb.width/2,st=null,nm=null;qs.forEach(function(q){var r=q.getBoundingClientRect();cols[r.left+r.width/2<mx?'l':'r']+=parseFloat(q.style.minHeight)||r.height});var h=STAGE.clientHeight-12,mid=120+(nm?nm.offsetHeight:0)+(st?parseFloat(st.style.minHeight)||0:0);return cols.l+14>h||cols.r+14>h||mid>h};
  STAGE.classList.remove('csm','ccomp');reserve();if(over()){STAGE.classList.add('csm');reserve();if(over()){STAGE.classList.add('ccomp');reserve()}}
  var st=STAGE.getBoundingClientRect(),R=qs.map(function(q){return q.getBoundingClientRect()}),rb=$('ringbox').getBoundingClientRect(),c={x:rb.left+rb.width/2,y:rb.top+rb.height/2},ring=Math.max(44,Math.min(rb.width,rb.height)/2-10),rn=rnd(seedOf(layoutSeed));rn();
  var box=function(e){if(!e||!e.offsetParent)return null;var r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom}},obs=[{left:c.x-ring,right:c.x+ring,top:c.y-ring,bottom:c.y+ring},box($('lab-routine')),box(null),box(null)].filter(Boolean);
  var dmin=Math.max(MOTHER_DIST_MIN,ring+60),orb=MOTHERS.map(function(n){return rectC($('orb-'+n))}),placed=[],hit=function(a,b){return a.left<b.right+MOTHER_CLEAR&&a.right>b.left-MOTHER_CLEAR&&a.top<b.bottom+MOTHER_CLEAR&&a.bottom>b.top-MOTHER_CLEAR};
  var pairs={},dy=[0,0,0,0];R.forEach(function(r,i){var k=r.left+r.width/2<c.x?'l':'r';(pairs[k]=pairs[k]||[]).push(i)});Object.keys(pairs).forEach(function(k){var p=pairs[k].slice().sort(function(a,b){return R[a].top-R[b].top});if(p.length!==2)return;var a=p[0],b=p[1],slack=Math.max(0,R[b].top-R[a].bottom-MOTHER_CLEAR);dy[a]=slack*rn()*.85;dy[b]=-(slack-dy[a])*rn()*.85});
  R.forEach(function(r,i){var left=r.left+r.width/2<c.x,dx=(left?1:-1)*MOTHER_ANGLE_SHIFT*rn(),found=[0,0],done=false;for(var tx=1;tx>-.01&&!done;tx-=.25)for(var t=1;t>0.04&&!done;t-=.1){var x=dx*tx,y=dy[i]*t,a={left:r.left+x,right:r.right+x,top:r.top+y,bottom:r.bottom+y},d=Math.hypot(orb[i].x+x-c.x,orb[i].y+y-c.y);if(a.top>=st.top&&a.bottom<=st.bottom&&a.left>=st.left&&a.right<=st.right&&d>=dmin&&d<=MOTHER_DIST_MAX&&!obs.some(function(o){return hit(a,o)})&&!placed.some(function(o){return hit(a,o)})){found=[x,y];done=true}}
    placed.push({left:r.left+found[0],right:r.right+found[0],top:r.top+found[1],bottom:r.bottom+found[1]});qs[i].style.transform=found[0]||found[1]?'translate('+Math.round(found[0])+'px,'+Math.round(found[1])+'px)':''});
  qGeom(qs,R,placed,orb,obs,c,dmin,st)}
/* a mother's reserved block moves within the centre; blocks it lands on slide to a free slot, right or below first */
var MG=null,qDragJust=false;
function qGeom(qs,R,placed,orb,obs,c,dmin,st){var ox=st.left-STAGE.scrollLeft,oy=st.top-STAGE.scrollTop,rc=function(r){return{left:r.left-ox,right:r.right-ox,top:r.top-oy,bottom:r.bottom-oy}};
  MG={qs:qs,sw:STAGE.clientWidth,sh:STAGE.clientHeight,c:{x:c.x-ox,y:c.y-oy},dmin:dmin,obs:obs.map(rc),nat:R.map(function(r){return{x:r.left-ox,y:r.top-oy,w:r.width,h:r.height}}),orb:orb.map(function(o,i){return{x:o.x-R[i].left,y:o.y-R[i].top}}),cur:placed.map(function(p){return{x:p.left-ox,y:p.top-oy}})};
  if(!PR.mpos||!Object.keys(PR.mpos).length){if(MOTHERS.length<=4&&MG.cur.some(function(p,i){var o=MG.orb[i];return Math.hypot(p.x+o.x-MG.c.x,p.y+o.y-MG.c.y)<MG.dmin})){MG.cur=qSettle(MOTHERS.map(function(_,i){return i}),MG.cur);qApply()}return}var want=MG.cur.slice(),done={},order=[];(PR.morder||[]).forEach(function(n){var i=MOTHERS.indexOf(n),f=PR.mpos[n];if(i<0||!f||done[i])return;done[i]=1;order.push(i);want[i]=qFromFrac(i,f)});MOTHERS.forEach(function(n,i){if(!done[i])order.push(i)});MG.cur=qSettle(order,want);qApply()}
function qFromFrac(i,f){var n=MG.nat[i];return{x:f.x*Math.max(0,MG.sw-n.w),y:f.y*Math.max(0,MG.sh-n.h)}}
function qRect(i,p){var n=MG.nat[i];return{left:p.x,top:p.y,right:p.x+n.w,bottom:p.y+n.h}}
function qHit(a,b){return a.left<b.right+MOTHER_CLEAR&&a.right>b.left-MOTHER_CLEAR&&a.top<b.bottom+MOTHER_CLEAR&&a.bottom>b.top-MOTHER_CLEAR}
function qFree(i,p,placed){var a=qRect(i,p),o=MG.orb[i];if(a.left<0||a.top<0||a.right>MG.sw||a.bottom>MG.sh)return false;if(Math.hypot(a.left+o.x-MG.c.x,a.top+o.y-MG.c.y)<MG.dmin)return false;return !MG.obs.some(function(b){return qHit(a,b)})&&!placed.some(function(b){return qHit(a,b)})}
function qFind(i,d,placed){var n=MG.nat[i],c=[];placed.forEach(function(b){if(qHit(qRect(i,d),b)){c.push({x:b.right+MOTHER_CLEAR+1,y:d.y});c.push({x:d.x,y:b.bottom+MOTHER_CLEAR+1})}});for(var k=0;k<c.length;k++)if(qFree(i,c[k],placed))return c[k];
  var g=[],mx=Math.max(0,MG.sw-n.w),my=Math.max(0,MG.sh-n.h);for(var x=0;x<=mx+15;x+=16)for(var y=0;y<=my+15;y+=16){var q={x:Math.min(x,mx),y:Math.min(y,my)};if(qFree(i,q,placed)){var dx=q.x-d.x,dy=q.y-d.y;g.push({p:q,s:Math.hypot(dx<0?dx*1.4:dx,dy<0?dy*1.4:dy)})}}if(g.length){g.sort(function(a,b){return a.s-b.s});return g[0].p}
  /* no free slot in view: below everything, the stage scrolls */
  var low=placed.concat(MG.obs).reduce(function(m,b){return Math.max(m,b.bottom)},0);return{x:Math.max(0,Math.min(d.x,mx)),y:low+MOTHER_CLEAR+1}}
function qSettle(order,want){var placed=[],out=[];order.forEach(function(i){var n=MG.nat[i],d={x:Math.max(0,Math.min(want[i].x,Math.max(0,MG.sw-n.w))),y:Math.max(0,Math.min(want[i].y,Math.max(0,MG.sh-n.h)))},p=qFree(i,d,placed)?d:qFind(i,d,placed);out[i]=p;placed.push(qRect(i,p))});return out}
function qApply(){MG.qs.forEach(function(q,i){var n=MG.nat[i],p=MG.cur[i];q.style.transform='translate('+Math.round(p.x-n.x)+'px,'+Math.round(p.y-n.y)+'px)'})}
function qFollow(ms){var end=performance.now()+ms;(function f(){readPos();req();if(performance.now()<end)requestAnimationFrame(f)})()}
function qDrop(i,x,y){var prev=MG.cur,order=[i].concat(MOTHERS.map(function(_,j){return j}).filter(function(j){return j!==i}).sort(function(a,b){return Math.hypot(prev[a].x-x,prev[a].y-y)-Math.hypot(prev[b].x-x,prev[b].y-y)})),want=prev.slice();want[i]={x:x,y:y};var cur=qSettle(order,want);MG.cur=cur;
  var names=[MOTHERS[i]];MOTHERS.forEach(function(n,j){if(j!==i&&(Math.abs(cur[j].x-prev[j].x)>.5||Math.abs(cur[j].y-prev[j].y)>.5))names.push(n)});PR.mpos=PR.mpos||{};names.forEach(function(n){var j=MOTHERS.indexOf(n),m=MG.nat[j],fw=MG.sw-m.w,fh=MG.sh-m.h;PR.mpos[n]={x:fw>0?cur[j].x/fw:0,y:fh>0?cur[j].y/fh:0}});PR.morder=names.concat((PR.morder||[]).filter(function(n){return names.indexOf(n)<0}));
  MG.qs.forEach(function(q){q.classList.remove('qdrag');if(!reduce.matches)q.classList.add('qanim')});qApply();qFollow(reduce.matches?0:340);saveP();$('sr').textContent=nice(byName[MOTHERS[i]].list)+' moved.'+(names.length>1?' '+(names.length-1)+' more slid to a free place.':'')}
function wireDrag(qs){qs.forEach(function(q,i){if(q._dw)return;q._dw=1;var n=MOTHERS[i],gr=el('button','qgrip');gr.type='button';gr.title='Move this block';gr.setAttribute('aria-label','Move the '+nice(byName[n].list)+' block. Arrow keys move it.');gr.innerHTML='<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true"><circle cx="2" cy="2" r="1.4"/><circle cx="8" cy="2" r="1.4"/><circle cx="2" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="2" cy="14" r="1.4"/><circle cx="8" cy="14" r="1.4"/></svg>';q.appendChild(gr);
    gr.addEventListener('keydown',function(e){var d={ArrowLeft:[-24,0],ArrowRight:[24,0],ArrowUp:[0,-24],ArrowDown:[0,24]}[e.key];if(!d||!MG)return;e.preventDefault();qDrop(i,MG.cur[i].x+d[0],MG.cur[i].y+d[1]);gr.focus()});
    q.addEventListener('click',function(e){if(MG&&!e.target.closest('button,a,input,select,textarea'))select(n,true)});
    var st=null,mv=function(e){if(!st||!MG)return;var dx=e.clientX-st.x,dy=e.clientY-st.y;if(!st.on){if(Math.hypot(dx,dy)<5)return;st.on=true;hideTip();q.setPointerCapture(st.id);q.classList.remove('qanim');q.classList.add('qdrag')}var c=MG.cur[i],m=MG.nat[i],x=Math.max(0,Math.min(c.x+dx,MG.sw-m.w)),y=Math.max(0,Math.min(c.y+dy,MG.sh-m.h));q.style.transform='translate('+Math.round(x-m.x)+'px,'+Math.round(y-m.y)+'px)';st.px=x;st.py=y;readPos();req()},up=function(){document.removeEventListener('pointermove',mv);document.removeEventListener('pointerup',up);document.removeEventListener('pointercancel',up);if(!st)return;var s=st;st=null;if(s.on&&MG){qDragJust=true;setTimeout(function(){qDragJust=false},0);qDrop(i,s.px,s.py)}};q.addEventListener('pointerdown',function(e){if(!MG||e.button!==0)return;st={x:e.clientX,y:e.clientY,on:false,id:e.pointerId};document.addEventListener('pointermove',mv);document.addEventListener('pointerup',up);document.addEventListener('pointercancel',up)})})}
/* every popup closes the same way: Escape or a click on an empty place; topmost first; focus goes back to the opener */
var DRAFTS={};
function popTop(){if($('tip').style.display==='block')return'tip';if($('pmenu').classList.contains('open'))return'pmenu';if($('prefs').classList.contains('open'))return'prefs';if(PO.classList.contains('open'))return'panel';return null}
function popClose(k){if(k==='tip')hideTip();else if(k==='pmenu'){toggleMenu(false);$('prof').focus()}else if(k==='prefs')closePrefs();else if(k==='panel')closePanel()}
function wireClose(){var dn=null,SEL={pmenu:'#pmenu,#prof',prefs:'#prefs',panel:'#panel'},LIVE='button,a,input,select,textarea,label,summary,[role=separator],[role=tab],#stage:not(.compact) .q';
  document.addEventListener('keydown',function(e){if(e.key!=='Escape')return;var k=popTop();if(!k)return;popClose(k);e.stopPropagation();e.preventDefault()},true);
  document.addEventListener('pointerdown',function(e){dn={x:e.clientX,y:e.clientY}},true);
  document.addEventListener('click',function(e){if(qDragJust){qDragJust=false;e.stopPropagation();e.preventDefault();return}
    var k=popTop();if(!k)return;var t=e.target,moved=dn&&Math.hypot(e.clientX-dn.x,e.clientY-dn.y)>5,sel=String(getSelection()||'');if(moved||sel)return;
    if(k==='tip'){if(!t.closest(LIVE)){hideTip();e.stopPropagation()}return}
    if(t.closest(SEL[k]))return;
    if(k==='pmenu'){var lv=!!t.closest(LIVE);toggleMenu(false);if(!lv)$('prof').focus();return}
    if(t.closest(LIVE))return;popClose(k)},true)}
/* marks stay on one row: the rest are counted as +N */
var CAP={};
function capWidths(){Object.keys(GROUP).forEach(function(x){var w=GROUP[x],t=w.closest('.tray');if(!t||!t.clientWidth)return;var row=STAGE.classList.contains('csm')?20:24,lw=STAGE.classList.contains('tn')?44:78;CAP[x]=Math.max(1,Math.floor((t.clientWidth-16-lw-6+2)/row))})}
function syncCaps(){Object.keys(GROUP).forEach(function(x){var w=GROUP[x],cap=CAP[x]||5,ch=[].slice.call(w.querySelectorAll('.chip')),more=w.querySelector('.tgm'),n=ch.length,show=n>cap?cap-1:n;ch.forEach(function(b,i){b.classList.toggle('over',i>=show)});if(n>cap){if(!more){more=el('span','tgm');w.appendChild(more)}else w.appendChild(more);more.textContent='+'+(n-show)}else if(more)more.remove()})}
/* one Tasks panel: a list, or a state across lists; a snapshot of this replay moment, stable while it plays */
var tasksCtx=null;
function openTasks(l,st,keep){if(!keep)opener=document.activeElement;restoreSize();state.sel=null;markSel();tasksCtx={l:l,st:st};var at=fm(state.t);panelHead('Tasks of '+(l?nice(l):'all lists')+(st?': '+STBY[st].w:''),'As at '+at+' in this replay.');var b=panelBody();b.id='tasks-body';var any=false;
  STATES.forEach(function(x){if(st&&x.k!==st)return;var g=TASKS.filter(function(k){return (!l||k.list===l)&&k._b.dataset.st===x.k}).sort(function(a,z){return a.num-z.num});if(!g.length)return;any=true;var h=el('h3','tph');h.innerHTML=glyph(x.k,14);h.appendChild(document.createTextNode(' '+x.m.split(':')[0]+' '+g.length));b.appendChild(h);
    g.forEach(function(k){var r=el('button','trow2');r.type='button';r.dataset.ref=k.ref;r.appendChild(el('b',null,'#'+k.num));var tx=el('span');tx.appendChild(el('span','tt',(l?'':shortList(k.list)+': ')+k.title));if(k.why.length&&/blocked_by_task|deferred_by_date|waits_for_person/.test(x.k))tx.appendChild(el('span','tw',k.why.join('; ')));r.appendChild(tx);r.onclick=function(){openTask(k,true)};b.appendChild(r)})});
  if(!any)b.appendChild(el('p',null,'No task at '+at+' in this replay.'));openPanel('tasks');var f=$('p-title');if(f)f.focus()}
/* ---------- the server: reads, writes, live changes ---------- */
function getJson(u){if(TRX&&TRX.getJson)return TRX.getJson(u);return fetch(u).then(function(r){if(!r.ok)throw new Error(String(r.status));return r.json()})}
var writeToken=null;
function postJson(u,body){if(TRX&&TRX.postJson)return TRX.postJson(u,body);return (writeToken?Promise.resolve(writeToken):getJson('/api/ping').then(function(p){writeToken=p.token;return writeToken})).then(function(tk){return fetch(u,{method:'POST',headers:{'Content-Type':'application/json','X-Eis-Token':tk},body:JSON.stringify(body)})}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){return{ok:r.ok,status:r.status,json:j}})})}
function addSpendRow(rows,l,label,mc){var r=el('span','spr '+mc);r.dataset.l=l;r.appendChild(el('span',null,label));var w=el('span','spw');w.appendChild(el('i'));r.appendChild(w);r.appendChild(el('span',null,''));rows.appendChild(r)}
function syncNowHead(){var p=$('nowpast');if(p)p.textContent=LIVE?'Live: this run is going now.':'A past run: '+D.ts.slice(0,10)+'.'}
function syncTransport(){['play','replay','scrub','speed','prev','next'].forEach(function(id){$(id).disabled=LIVE});$('replay').title=LIVE?'Replay comes when the day has closed.':'';$('transport').setAttribute('aria-label',LIVE?'Live run '+D.ts:'Replay of '+D.ts)}
var liveTimer=0,liveTicks=0;
function startLive(){if(liveTimer)return;state.playing=false;liveTimer=setInterval(function(){T1=calcT1();state.t=T1;if(++liveTicks%60===0){buildReplayEvents();rebuild(state.t)}else advance(state.t,true);syncTime();req()},500)}
function stopLive(){clearInterval(liveTimer);liveTimer=0}
var refreshing=false,refreshAgain=false,evWait=0;
function refresh(){if(refreshing){refreshAgain=true;return}refreshing=true;getJson('/api/runs/'+D.ts).then(function(run){try{applyRun(run)}catch(e){connLine('The page could not show the latest change: '+e.message+'. Reload it.')}},function(){connLine('The server did not answer. The page keeps what it has.')}).then(function(){refreshing=false;if(refreshAgain){refreshAgain=false;refresh()}})}
function connLine(t){var c=$('conn');if(!c)return;c.hidden=!t;c.textContent=t||''}
/* a change on disk: take the run again, add what is new to the scene in place, and rebuild the event stream up to now */
function applyRun(run){if(!run)return;connLine('');var nd=HD.toHarness(run),sel=state.sel?byName[state.sel]:null,selKey=sel?sel.state+'|'+!!sel.report+'|'+sel.t1:'',wasLive=LIVE,escKey=function(){return ESC.map(function(e){return e.key+'|'+e.t+'|'+(e.decision||'')+'|'+(e.applied||'')}).join()},kEsc=escKey();
  ['start','stop','stopped_at','usage','decisions','master_decisions','mother_decisions','escalations','tasks','day','planned','wakes','links','prices','board_at','suspects','day_report','tokens_md','live','list_names','sessions'].forEach(function(k){D[k]=nd[k]});ESC=D.escalations;
  var fresh=[];nd.sessions.forEach(function(s){if(byName[s.name])fillSession(byName[s.name],s);else fresh.push(addSession(s))});
  fresh.forEach(function(s){if(s.role!=='mother'||s.restart_of||MOTHER_OF[s.list])return;noteMother(s);MCI[s.name]=(MOTHERS.length-1)%4;LISTS.push(s.list)});
  loadTasks();loadDecisions();LIVE=nd.live;T1=calcT1();BASE=(T1-T0)/80000;buildReplayEvents();
  if(LIVE)state.t=T1;else if(wasLive)state.t=T1;
  MAXG=maxPerGroup();
  fresh.forEach(function(s){if(MOTHERS.indexOf(s.name)<0)return;var l=s.list;addQmRow(l,$('qm'));addBlock(s.name,MOTHERS.indexOf(s.name));addSpendRow($('sp-rows'),l,shortList(l),mcOf(s));addTreeGroup(s.name)});
  if(fresh.some(function(s){return MOTHERS.indexOf(s.name)>=0}))placeBlocks();
  fresh.forEach(function(s){placeSession(s);if(!document.querySelector('.row[data-s="'+s.name+'"]'))addRow(s)});
  TASKS.forEach(function(k){if(!k._b){var tr=trayOf(k.list);if(tr)addChip(k,tr)}});
  document.querySelectorAll('.tg').forEach(function(g){var key=g.closest('.q');if(key)g.style.setProperty('--n',Math.max(1,g.querySelectorAll('.chip').length))});
  rebuild(state.t);document.querySelectorAll('.row').forEach(function(b){var s=byName[b.dataset.s];if(s)rowBars(s,b)});
  if(escKey()!==kEsc){var h=$('cb-esc');if(h){h.textContent='';buildEsc(h)}}
  syncNowHead();syncTransport();var cb=$('cb-clock');if(cb){cb.textContent='';buildClock(cb)}if(wasLive&&!LIVE)stopLive();if(!wasLive&&LIVE)startLive();
  posDirty=true;modelDirty=true;layoutMothers();syncScene();readPos();syncTime();
  if(sel&&state.view==='session'){var trx=TRX&&TRX.stamp?TRX.stamp():'';var chg=sel.state+'|'+!!sel.report+'|'+sel.t1!==selKey||state.rePanel||trx!==(state._trx||'');state._trx=trx;if(chg&&document.activeElement!==$('note')){state.rePanel=false;renderSession()}else{if(chg)state.rePanel=true;updatePanelLive()}if(state.tab==='steps'&&sel.feedState==='ok')loadFeed(sel)}
  req()}
function connectEvents(){var onChange=function(){clearTimeout(evWait);evWait=setTimeout(refresh,300)},onRuns=function(){getJson('/api/runs').then(function(r){RUNS=r;var h=$('cb-runs');if(h)buildRuns(h)}).catch(function(){})};
  if(TRX&&TRX.events){TRX.events(D.ts,{change:onChange,runs:onRuns,open:function(){connLine('')},error:function(t){connLine(t||'The server is not answering. The page keeps trying.')}});return}
  if(!window.EventSource)return;var es=new EventSource('/api/events?run='+encodeURIComponent(D.ts));
  es.addEventListener('change',onChange);
  es.addEventListener('runs',onRuns);
  es.onopen=function(){connLine('')};es.onerror=function(){connLine('The server is not answering. The page keeps trying.')}}
/* the token warning (D46) */
function pollBudget(){getJson('/api/budget').then(function(b){var p=$('budgetw');if(!p)return;if(!b.level||b.closed){p.hidden=true;return}var reset=b.resets_at?', resets '+fm(Date.parse(b.resets_at)):'';p.hidden=false;p.className='budgetw '+b.level;p.textContent=(b.level==='stop'?'Work stopped':'Work paused')+(b.label?': '+b.label+' at '+b.pct+'%':'')+reset+(b.next_ping?'. A ping restarts it at '+fm(Date.parse(b.next_ping)):'')+(b.stale?'. This reading is over an hour old':'')+'.'}).catch(function(){})}
/* Limits: the file localConfigs/eisenhower-harness-limits.json of this device */
function renderLimitsPage(){restoreSize();state.sel=null;markSel();state.stageHi=null;setLit();panelHead('Limits','This device: localConfigs/eisenhower-harness-limits.json.');var b=panelBody();var h=el('div');h.id='limits';b.appendChild(h);loadLimits();openPanel('limits')}
function loadLimits(msg){var h=$('limits');if(!h)return;if(!h.firstChild)h.appendChild(el('p','sub','Reading the limits…'));getJson('/api/limits').then(function(v){renderLimits(v,msg)}).catch(function(){h.textContent='';h.appendChild(el('p','sub','Could not read the limits from the server.'))})}
function renderLimits(v,msg){var h=$('limits');if(!h)return;h.textContent='';
  if(v.state==='invalid'||(v.errors&&v.errors.length)){var bad=el('p','limbad','! '+v.file+' is broken: '+(v.errors||[]).join('; '));bad.setAttribute('role','alert');h.appendChild(bad)}
  if(v.board!=='ok')h.appendChild(el('p','sub','The board cannot be reached: lists come from the file only.'));
  h.appendChild(el('p','sub','Sessions per list and subagents per session: concurrency, not tokens. A new run reads them when it starts a session.'));
  var num=function(id,val,max,lab){var i=el('input');i.type='number';i.step='1';i.min='0';i.max=max;i.value=val;i.setAttribute('aria-label',lab);if(id)i.id=id;return i};
  var d=el('div','limd');[['Default sessions','lim-ms',v.defaults.max_sessions,v.max.max_sessions],['Default subagents','lim-ma',v.defaults.max_agents_per_session,v.max.max_agents_per_session]].forEach(function(x){var l=el('label',null,x[0]+' ');l.appendChild(num(x[1],x[2],x[3],x[0]));d.appendChild(l)});h.appendChild(d);
  var tw=el('div','tw');tw.tabIndex=0;tw.setAttribute('role','region');tw.setAttribute('aria-label','Limits per list');var tb=el('table','limt');var hr=el('tr');['List','On','Sessions','Subagents','Now'].forEach(function(x){var th=el('th',null,x);th.scope='col';hr.appendChild(th)});tb.appendChild(hr);
  v.rows.forEach(function(r){var tr=el('tr');tr.dataset.slug=r.slug;var t=el('td',null,r.name);if(r.on_board===false)t.appendChild(el('span','sub',' not on the board'));tr.appendChild(t);var c=el('td'),cb=el('input');cb.type='checkbox';cb.checked=r.enabled;cb.dataset.f='enabled';cb.setAttribute('aria-label',r.name+' on');c.appendChild(cb);tr.appendChild(c);
    [['max_sessions',r.max_sessions,v.max.max_sessions,' max sessions'],['max_agents_per_session',r.max_agents_per_session,v.max.max_agents_per_session,' max subagents']].forEach(function(x){var td=el('td'),i=num(null,x[1],x[2],r.name+x[3]);i.dataset.f=x[0];td.appendChild(i);tr.appendChild(td)});tr.appendChild(el('td',null,r.live+' live'));tb.appendChild(tr)});tw.appendChild(tb);h.appendChild(tw);
  var acts=el('div','acts');var sv=el('button','btn primary','Save limits');sv.type='button';sv.id='lim-save';var m=el('p','msg');m.id='lim-msg';m.setAttribute('role','status');if(msg){m.textContent=msg.t;m.classList.add(msg.k)}sv.onclick=function(){saveLimits(v,sv)};acts.appendChild(gate(sv,'limits',null,{scope:'any'}));h.appendChild(acts);h.appendChild(m);
  var lock=function(nodes,scope){var g=canDo('limits',null,{scope:scope});if(!g||g.ok!==false)return;nodes.forEach(function(i){i.disabled=true;i.title='Run local version'+(g.why?'\n'+g.why:'')})};
  lock([$('lim-ms'),$('lim-ma')],'defaults');h.querySelectorAll('tr[data-slug]').forEach(function(tr){lock([].slice.call(tr.querySelectorAll('input')),'list:'+tr.dataset.slug)})}
function saveLimits(v,btn){var n=function(i){return i.value===''?NaN:Number(i.value)},lists={};$('limits').querySelectorAll('tr[data-slug]').forEach(function(tr){var q=function(f){return tr.querySelector('[data-f="'+f+'"]')};lists[tr.dataset.slug]={enabled:q('enabled').checked,max_sessions:n(q('max_sessions')),max_agents_per_session:n(q('max_agents_per_session'))}});
  btn.disabled=true;postJson('/api/limits',{defaults:{max_sessions:n($('lim-ms')),max_agents_per_session:n($('lim-ma'))},lists:lists,base_hash:v.base_hash}).then(function(r){if(r.ok)renderLimits(r.json,{k:'ok',t:'Saved.'});else{btn.disabled=false;var m=$('lim-msg');m.className='msg bad';m.textContent=(r.json.errors||[r.json.error||'Not saved.']).join('; ')}}).catch(function(){btn.disabled=false;var m=$('lim-msg');m.className='msg bad';m.textContent='The server did not answer. Nothing was saved.'})}
/* ---------- start ---------- */
$('play').onclick=function(){state.playing?stopPlay():startPlay()};
$('next').onclick=function(){state.stepping=true;step(1);state.stepping=false};$('prev').onclick=function(){state.stepping=true;step(-1);state.stepping=false};
$('speed').onclick=function(){var SPD=[1,2,4,8,16,32];state.speed=SPD[(SPD.indexOf(state.speed)+1)%SPD.length];$('speed').textContent=state.speed+'x'};
$('scrub').oninput=function(e){var v=+e.target.value;if(state.playing)stopPlay();state.climb=null;clearClimb();var end=tEnd();setT(T0+(end-T0)*v/1000,false)};
/* Replay: everything of the shown moment goes at once (fades, glides and CSS transitions snap), and play starts only after that frame,
   so the master's appearance is never drawn over what was there before (Maksym 2026-11-11) */
$('replay').onclick=function(){stopPlay();state.reportSeen=false;state.climb=null;clearClimb();VA={};STAGE.classList.add('snap');document.documentElement.classList.add('snap');setT(T0,false);syncScene();void STAGE.offsetWidth;
  requestAnimationFrame(function(){requestAnimationFrame(function(){STAGE.classList.remove('snap');document.documentElement.classList.remove('snap');startPlay()})})};
$('skip').onclick=function(e){e.preventDefault();var r=document.querySelector(VIEW==='classic'?'.wfr':'#tree .row');if(r)r.focus()};
function fromHash(){var m=location.hash.match(/[#&]s=([^&]+)/);return m&&byName[decodeURIComponent(m[1])]?decodeURIComponent(m[1]):null}
window.addEventListener('hashchange',function(){var rm=location.hash.match(/run=([0-9a-z_-]+)/i);if(rm&&rm[1]!==D.ts){location.reload();return}var n=fromHash();if(n&&n!==state.sel)select(n)});
function measure(){W=innerWidth;H=innerHeight;G.mob=W<760;placeDocks();DPR=Math.min(devicePixelRatio||1,1.5);cv.width=W*DPR;cv.height=H*DPR;applySize();readPos();bakeScene();req()}
var rz;window.addEventListener('resize',function(){clearTimeout(rz);rz=setTimeout(measure,120)});
reduce.addEventListener('change',function(){stopPlay()});
M=newModel();buildStage();buildTree();buildDocks();buildLegend();M=newModel();modelDirty=true;syncScene();
viewLabel();buildWf();applyLayout();measure();syncTransport();
setT(T1,false);setPlayLabel();
var dl=fromHash();if(dl)select(dl);
syncTime();
if(LIVE)startLive();
connectEvents();pollBudget();setInterval(pollBudget,60000);
}
/* the page opens the run in the address, else the newest; a run still open wins over a closed one only when it is the newest */
(function(){
  var main=document.getElementById('stage');
  var say=function(t){main.textContent='';var p=document.createElement('p');p.className='emptyrun';p.textContent=t;main.appendChild(p)};
  var tr=harnessTransport();var json=function(u){if(tr&&tr.getJson)return tr.getJson(u);return fetch(u).then(function(r){if(!r.ok)throw new Error(u+': '+r.status);return r.json()})};
  json('/api/runs').then(function(runs){
    if(!runs.length){say('No runs yet. A run appears here when the master starts one.');return}
    var m=location.hash.match(/run=([0-9a-z_-]+)/i),ts=m&&runs.some(function(r){return r.ts===m[1]})?m[1]:runs[0].ts;
    return json('/api/runs/'+ts).then(function(run){startHarness(window.HarnessData.toHarness(run),runs)});
  }).catch(function(e){say('The page could not read the runs: '+e.message+'. Is the server running?')});
})();
