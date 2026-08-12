/* ===================== CSO Capacity & Impact Instrument ===================== */
/* Data (DOMAINS, INDICATORS) is injected above this script as window.__DATA__ */
const DOMAINS = window.__DATA__.domains;
const INDICATORS = window.__DATA__.indicators;
const LEGAL_FORMS = ['NPO','NPC','Trust','Cooperative','Social Enterprise','Pty Ltd'];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const TRACKS = [
  {key:'lead', label:'Lead assessor'},
  {key:'second', label:'Second assessor'},
  {key:'self', label:'Self-assessment'},
];
const PRIORITIES = ['Low','Medium','High'];
// Data lives in Supabase now (table: cso_organisations), readable/writable via the public
// anon/publishable key below (see js/supabase-client.js). Access is governed by Postgres Row
// Level Security, not by anything in this file. Current policy: anyone holding the public key
// can read and write every organisation's record — the same "shared" trust model the app had
// before, just backed by a real database instead of the Claude-artifact storage API. Tighten
// this later with real per-user auth if it needs to be locked down further.

let STATE = null;          // current org state object
let VIEW = 'landing';      // current view id
let ORG_LIST_CACHE = [];   // cached list of state objects
let SAVE_TIMER = null;
let IS_ADMIN = false;      // in-memory only; resets on page reload

/* ---------------- storage helpers (Supabase) ---------------- */
function rowToState(row){
  const s = (row.data && typeof row.data === 'object') ? row.data : {};
  s.id = row.id;
  s.name = row.name;
  s.updatedAt = row.updated_at || s.updatedAt;
  if(!s.createdAt) s.createdAt = row.created_at || s.updatedAt;
  return s;
}
function stateToRow(state){
  return { id: state.id, name: state.name, data: state };
}

async function storageListOrgs(){
  try{
    const { data, error } = await sb.from('cso_organisations').select('*').order('updated_at', { ascending:false });
    if(error){ console.error('list orgs failed', error); return []; }
    return (data||[]).map(rowToState);
  }catch(e){ console.error('list orgs failed', e); return []; }
}

async function storageSave(state){
  try{
    const { error } = await sb.from('cso_organisations').upsert(stateToRow(state));
    if(error){ console.error('save failed', error); showToast('Could not save — check connection'); }
  }catch(e){ console.error('save failed', e); showToast('Could not save — check connection'); }
}

async function storageLoad(id){
  try{
    const { data, error } = await sb.from('cso_organisations').select('*').eq('id', id).maybeSingle();
    if(error || !data) return null;
    return rowToState(data);
  }catch(e){ console.error('load failed', e); return null; }
}

async function storageDelete(id){
  try{
    const { error } = await sb.from('cso_organisations').delete().eq('id', id);
    if(error) console.error('delete failed', error);
  }catch(e){ console.error('delete failed', e); }
}

/* ---------------- admin auth (Supabase RPC; password never reaches the client) ---------------- */
async function verifyAdminPassword(pw){
  try{
    const { data, error } = await sb.rpc('cso_verify_admin_password', { pw });
    if(error){ console.error('admin check failed', error); return false; }
    return data === true;
  }catch(e){ console.error('admin check failed', e); return false; }
}

function scheduleSave(){
  STATE.updatedAt = new Date().toISOString();
  if(SAVE_TIMER) clearTimeout(SAVE_TIMER);
  SAVE_TIMER = setTimeout(()=>{ storageSave(STATE); }, 500);
}

/* ---------------- state model ---------------- */
function blankTrack(){ return {level:0, comment:''}; }

function newOrgState(name, legalForm){
  const id = 'o_' + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
  const capacity = {};
  DOMAINS.forEach(dom=>{
    const q = {};
    dom.questions.forEach(qq=>{
      q[qq.id] = { lead: blankTrack(), second: blankTrack(), self: blankTrack() };
    });
    capacity[dom.key] = { priority:'', supportNeeds:'', comments:'', q };
  });
  const me = {};
  INDICATORS.forEach(ind=>{ me[ind.idx] = { months:{} }; });
  return {
    id, name: name || 'Untitled organisation',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    basic: {
      legalForm: legalForm || '', teamSize:'', country:'South Africa', city:'',
      sessionDates:'', location:'',
      csoTeam:[{name:'',title:'',email:'',phone:''}],
      supportTeam:[{name:'',title:'',email:'',phone:''}],
    },
    capacity, me,
    currentMonth: 1,
  };
}

/* migrate older/incomplete state objects when loaded (defensive) */
function ensureShape(state){
  if(!state.basic) state.basic = newOrgState().basic;
  if(!state.basic.csoTeam) state.basic.csoTeam=[{name:'',title:'',email:'',phone:''}];
  if(!state.basic.supportTeam) state.basic.supportTeam=[{name:'',title:'',email:'',phone:''}];
  if(!state.capacity) state.capacity = {};
  DOMAINS.forEach(dom=>{
    if(!state.capacity[dom.key]) state.capacity[dom.key] = {priority:'',supportNeeds:'',comments:'',q:{}};
    const c = state.capacity[dom.key];
    if(!c.q) c.q = {};
    dom.questions.forEach(qq=>{
      if(!c.q[qq.id]) c.q[qq.id] = {lead:blankTrack(),second:blankTrack(),self:blankTrack()};
    });
  });
  if(!state.me) state.me = {};
  INDICATORS.forEach(ind=>{ if(!state.me[ind.idx]) state.me[ind.idx] = {months:{}}; });
  if(!state.currentMonth) state.currentMonth = 1;
  return state;
}

/* ---------------- scoring helpers ---------------- */
function domainTrackAvg(domKey, trackKey){
  const dom = DOMAINS.find(d=>d.key===domKey);
  const c = STATE.capacity[domKey];
  let sum=0, n=0;
  dom.questions.forEach(qq=>{
    const lvl = c.q[qq.id][trackKey].level;
    if(lvl>0){ sum+=lvl; n++; }
  });
  return n>0 ? sum/n : null;
}
function domainCombinedAvg(domKey){
  const vals = TRACKS.map(t=>domainTrackAvg(domKey,t.key)).filter(v=>v!==null);
  if(!vals.length) return null;
  return vals.reduce((a,b)=>a+b,0)/vals.length;
}
function overallTrackAvg(trackKey){
  const vals = DOMAINS.map(d=>domainTrackAvg(d.key,trackKey)).filter(v=>v!==null);
  if(!vals.length) return null;
  return vals.reduce((a,b)=>a+b,0)/vals.length;
}
function domainAnsweredCount(domKey){
  const dom = DOMAINS.find(d=>d.key===domKey);
  const c = STATE.capacity[domKey];
  let n=0;
  dom.questions.forEach(qq=>{
    const t = c.q[qq.id];
    if(t.lead.level>0||t.second.level>0||t.self.level>0) n++;
  });
  return n;
}
function fmtScore(v){ return v===null||v===undefined ? '—' : v.toFixed(1); }

/* ---- org-agnostic versions used by the admin dashboard, which lists many orgs at once
   without loading each one into the global STATE ---- */
function orgDomainTrackAvg(org, domKey, trackKey){
  const dom = DOMAINS.find(d=>d.key===domKey);
  const c = org.capacity && org.capacity[domKey];
  if(!c) return null;
  let sum=0, n=0;
  dom.questions.forEach(qq=>{
    const rec = c.q && c.q[qq.id];
    const lvl = rec ? rec[trackKey].level : 0;
    if(lvl>0){ sum+=lvl; n++; }
  });
  return n>0 ? sum/n : null;
}
function orgDomainCombinedAvg(org, domKey){
  const vals = TRACKS.map(t=>orgDomainTrackAvg(org,domKey,t.key)).filter(v=>v!==null);
  return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
}
function orgOverallAvg(org){
  const vals = DOMAINS.map(d=>orgDomainCombinedAvg(org,d.key)).filter(v=>v!==null);
  return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
}
function orgDomainsScoredCount(org){
  return DOMAINS.filter(d=>orgDomainCombinedAvg(org,d.key)!==null).length;
}
function orgHighPriorityCount(org){
  return DOMAINS.filter(d=>org.capacity && org.capacity[d.key] && org.capacity[d.key].priority==='High').length;
}
function orgMEEnteredCount(org){
  if(!org.me) return 0;
  return INDICATORS.filter(ind=>{
    const rec = org.me[ind.idx];
    return rec && rec.months && Object.values(rec.months).some(m=>m && m.result!=='' && m.result!==undefined);
  }).length;
}

/* ---------------- M&E helpers ---------------- */
function indParseEntry(idx, month){
  const rec = STATE.me[idx].months[month];
  if(!rec) return null;
  const n = parseFloat(String(rec.result).replace(/[€,\s]/g,''));
  return isNaN(n) ? null : n;
}
function indCumulated(ind, uptoMonth){
  if(ind.unit==='percent_frac' || ind.unit==='percent_num' || ind.unit==='days'){
    // status-type indicator: use latest entered value up to the month
    for(let m=uptoMonth; m>=1; m--){
      const v = indParseEntry(ind.idx, m);
      if(v!==null) return v;
    }
    return null;
  }
  // cumulative-sum type (count / currency)
  let sum=0, any=false;
  for(let m=1; m<=uptoMonth; m++){
    const v = indParseEntry(ind.idx, m);
    if(v!==null){ sum+=v; any=true; }
  }
  return any ? sum : null;
}
function indExecutionRate(ind, uptoMonth){
  const cum = indCumulated(ind, uptoMonth);
  if(cum===null || !ind.target_y1) return null;
  return (cum/ind.target_y1)*100;
}
function fmtIndValue(ind, v){
  if(v===null||v===undefined) return '—';
  if(ind.unit==='percent_frac') return (v<=1? (v*100).toFixed(0) : v.toFixed(0)) + '%';
  if(ind.unit==='percent_num') return v.toFixed(0)+'%';
  if(ind.unit==='currency') return '€'+v.toLocaleString();
  if(ind.unit==='days') return v.toFixed(0)+' d';
  return (Number.isInteger(v) ? v : v.toFixed(1)).toString();
}
function fmtTarget(ind){
  if(ind.target_y1===null||ind.target_y1===undefined) return '—';
  return fmtIndValue(ind, ind.target_y1);
}

/* ---------------- misc utils ---------------- */
function esc(s){
  return String(s===undefined||s===null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function nl2br(s){ return esc(s).replace(/\n/g,'<br>'); }
function showToast(msg){
  let t = document.getElementById('toast');
  if(!t){
    t = document.createElement('div'); t.id='toast'; t.className='toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(()=>t.classList.remove('show'), 2200);
}
function downloadJSON(){
  const blob = new Blob([JSON.stringify(STATE,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = (STATE.name||'organisation').replace(/[^a-z0-9]+/gi,'_') + '_assessment.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
}
/* ===================== Rendering: shell / landing ===================== */

function el(html){ const d=document.createElement('div'); d.innerHTML=html.trim(); return d.firstElementChild; }

async function boot(){
  const app = document.getElementById('app');
  app.innerHTML = '<div class="landing"><div class="spinner"></div></div>';
  ORG_LIST_CACHE = await storageListOrgs();
  renderLanding();
}

function renderLanding(){
  VIEW = 'landing'; STATE = null;
  const app = document.getElementById('app');
  const cards = ORG_LIST_CACHE.map(o=>`
    <div class="card org-card click" data-open="${esc(o.id)}">
      <div class="row">
        <div>
          <h4>${esc(o.name)}</h4>
          <div class="meta">${esc(o.basic?.legalForm||'—')} · ${esc(o.basic?.city||'')||'&nbsp;'}</div>
        </div>
        <button class="row-del" data-del="${esc(o.id)}" title="Delete">×</button>
      </div>
      <div class="meta" style="margin-top:8px;">Updated ${new Date(o.updatedAt).toLocaleDateString()}</div>
    </div>`).join('');

  app.innerHTML = `
  <div class="landing">
    <div class="landing-wrap">
      <div class="landing-hero">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;">
          <div class="eyebrow">Organisational capacity &amp; impact instrument</div>
          <button class="btn btn-ghost btn-sm" id="btn-admin-login">🔒 Admin login</button>
        </div>
        <h1>Measure capacity. Track impact. One instrument.</h1>
        <p>A combined diagnostic and monitoring tool for civil-society organisations: an 8-domain organisational
        capacity assessment scored across Lead, Second and Self-assessment tracks, paired with a live M&amp;E
        indicator tracker for impact, outcome and output KPIs. Built for the REACH CSO capacity-building programme.</p>
      </div>
      <div class="section-head"><h3>Your organisations</h3><div class="section-line"></div></div>
      <div class="org-grid">
        ${cards}
        <div class="card new-org-card" id="btn-new-org">+ New assessment</div>
      </div>
      ${ORG_LIST_CACHE.length===0 ? '<p class="muted" style="margin-top:14px;font-size:12.6px;">No saved organisations yet — start one above. Everything you enter is saved automatically as you go.</p>' : ''}
    </div>
  </div>`;
  document.getElementById('btn-admin-login').addEventListener('click', openAdminLoginModal);

  app.querySelectorAll('[data-open]').forEach(c=>{
    c.addEventListener('click', async (e)=>{
      if(e.target.closest('[data-del]')) return;
      const id = c.getAttribute('data-open');
      app.innerHTML = '<div class="landing"><div class="spinner"></div></div>';
      const s = await storageLoad(id);
      if(s){ STATE = ensureShape(s); VIEW='dashboard'; renderShell(); }
      else { showToast('Could not open that organisation'); renderLanding(); }
    });
  });
  app.querySelectorAll('[data-del]').forEach(b=>{
    b.addEventListener('click', async (e)=>{
      e.stopPropagation();
      const id = b.getAttribute('data-del');
      const org = ORG_LIST_CACHE.find(o=>o.id===id);
      if(!confirm(`Delete "${org?org.name:'this organisation'}"? This cannot be undone.`)) return;
      await storageDelete(id);
      ORG_LIST_CACHE = ORG_LIST_CACHE.filter(o=>o.id!==id);
      renderLanding();
    });
  });
  document.getElementById('btn-new-org').addEventListener('click', openNewOrgModal);
}

function openNewOrgModal(){
  const backdrop = el(`
    <div class="modal-backdrop">
      <div class="modal">
        <h3>New assessment</h3>
        <div class="field">
          <label class="field-label">Name of the CSO</label>
          <input type="text" id="m-name" placeholder="e.g. Green Roots Cooperative">
        </div>
        <div class="field">
          <label class="field-label">Legal form</label>
          <select id="m-legal">
            <option value="">Select…</option>
            ${LEGAL_FORMS.map(f=>`<option value="${f}">${f}</option>`).join('')}
          </select>
        </div>
        <div class="btn-row" style="justify-content:flex-end;margin-top:18px;">
          <button class="btn btn-ghost" id="m-cancel">Cancel</button>
          <button class="btn btn-gold" id="m-create">Create &amp; open</button>
        </div>
      </div>
    </div>`);
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', e=>{ if(e.target===backdrop) backdrop.remove(); });
  document.getElementById('m-cancel').addEventListener('click', ()=>backdrop.remove());
  document.getElementById('m-create').addEventListener('click', async ()=>{
    const name = document.getElementById('m-name').value.trim();
    const legal = document.getElementById('m-legal').value;
    if(!name){ showToast('Enter an organisation name'); return; }
    const s = newOrgState(name, legal);
    STATE = s;
    await storageSave(STATE);
    backdrop.remove();
    VIEW = 'basic';
    renderShell();
  });
}

function openAdminLoginModal(){
  const backdrop = el(`
    <div class="modal-backdrop">
      <div class="modal">
        <h3>Admin login</h3>
        <p class="muted" style="font-size:12.3px;margin-bottom:14px;">
          Admin view lists every organisation saved to this instrument and rolls up scores across
          all of them. The password itself is checked server-side and never sent to the browser —
          but note that the underlying data is still readable/writable by anyone with the public
          key this site ships with (same as the rest of the app). This login gates the admin
          screen, not the data itself. Ask your Supabase admin to tighten this with real per-user
          auth if that's needed later.
        </p>
        <div class="field">
          <label class="field-label">Password</label>
          <input type="text" id="m-admin-pass" placeholder="Admin password" autocomplete="off">
        </div>
        <div class="btn-row" style="justify-content:flex-end;margin-top:6px;">
          <button class="btn btn-ghost" id="m-admin-cancel">Cancel</button>
          <button class="btn btn-gold" id="m-admin-go">Log in</button>
        </div>
      </div>
    </div>`);
  document.body.appendChild(backdrop);
  const passInput = document.getElementById('m-admin-pass');
  backdrop.addEventListener('click', e=>{ if(e.target===backdrop) backdrop.remove(); });
  document.getElementById('m-admin-cancel').addEventListener('click', ()=>backdrop.remove());
  const goBtn = document.getElementById('m-admin-go');
  async function tryLogin(){
    goBtn.disabled = true; goBtn.textContent = 'Checking…';
    const ok = await verifyAdminPassword(passInput.value);
    goBtn.disabled = false; goBtn.textContent = 'Log in';
    if(ok){
      IS_ADMIN = true;
      backdrop.remove();
      renderAdminDashboard();
    } else {
      showToast('Incorrect password');
      passInput.value=''; passInput.focus();
    }
  }
  goBtn.addEventListener('click', tryLogin);
  passInput.addEventListener('keydown', e=>{ if(e.key==='Enter') tryLogin(); });
  passInput.focus();
}

/* ===================== App shell (sidebar + main) ===================== */

function renderShell(){
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">Δ</div>
          <div class="brand-text">Capacity &amp; Impact<br>Instrument<small>REACH CSO Programme</small></div>
        </div>
        <div class="org-switch" id="org-switch">
          <div class="lbl">Organisation</div>
          <div class="name">${esc(STATE.name)}</div>
          <div class="sw">${IS_ADMIN? 'Back to admin dashboard →' : 'Switch or create new →'}</div>
        </div>
        ${IS_ADMIN ? `<div class="nav-group-label">Admin</div>
        <nav class="main-nav" id="nav-admin"></nav>` : ''}
        <div class="nav-group-label">Overview</div>
        <nav class="main-nav" id="nav-top"></nav>
        <div class="nav-group-label">Organisational capacity</div>
        <nav class="main-nav" id="nav-domains"></nav>
        <div class="nav-group-label">Impact</div>
        <nav class="main-nav" id="nav-bottom"></nav>
        <div class="sidebar-foot">
          <b>${esc(STATE.basic.legalForm||'Legal form not set')}</b><br>
          ${esc(STATE.basic.city||'')}${STATE.basic.city&&STATE.basic.country?', ':''}${esc(STATE.basic.country||'')}<br>
          Saved automatically
        </div>
      </aside>
      <main class="main" id="main"></main>
    </div>`;

  document.getElementById('org-switch').addEventListener('click', ()=>{
    if(IS_ADMIN) renderAdminDashboard(); else renderLandingFromShell();
  });

  if(IS_ADMIN){
    const navAdmin = document.getElementById('nav-admin');
    const item = el(`<div class="nav-item"><span class="ico">◈</span><span class="txt">Admin dashboard</span></div>`);
    item.addEventListener('click', renderAdminDashboard);
    navAdmin.appendChild(item);
  }

  const navTop = document.getElementById('nav-top');
  navTop.appendChild(navItem('dashboard','◆','Dashboard'));
  navTop.appendChild(navItem('basic','▤','Basic information'));

  const navDomains = document.getElementById('nav-domains');
  DOMAINS.forEach(dom=>{
    navDomains.appendChild(navDomainItem(dom));
  });

  const navBottom = document.getElementById('nav-bottom');
  navBottom.appendChild(navItem('me','◷','M&E KPI tracker'));
  navBottom.appendChild(navItem('summary','▦','Summary &amp; report'));

  renderMain();
}

async function renderLandingFromShell(){
  ORG_LIST_CACHE = await storageListOrgs();
  renderLanding();
}

function navItem(view, icon, label){
  const item = el(`<div class="nav-item ${VIEW===view?'active':''}"><span class="ico">${icon}</span><span class="txt">${label}</span></div>`);
  item.addEventListener('click', ()=>{ VIEW=view; renderShell(); });
  return item;
}
function navDomainItem(dom){
  const avg = domainCombinedAvg(dom.key);
  const filled = avg===null?0:Math.round(avg);
  let ladder='';
  for(let i=1;i<=4;i++) ladder += `<i class="${i<=filled?'on':''}"></i>`;
  const active = VIEW===dom.key;
  const item = el(`<div class="nav-item ${active?'active':''}">
      <span class="ico">${dom.num}</span><span class="txt">${esc(dom.title)}</span>
      <span class="nav-ladder">${ladder}</span>
    </div>`);
  item.addEventListener('click', ()=>{ VIEW=dom.key; renderShell(); });
  return item;
}
/* ===================== Main router ===================== */
function renderMain(){
  const main = document.getElementById('main');
  if(VIEW==='dashboard') return renderDashboard(main);
  if(VIEW==='basic') return renderBasic(main);
  if(VIEW==='me') return renderME(main);
  if(VIEW==='summary') return renderSummary(main);
  const dom = DOMAINS.find(d=>d.key===VIEW);
  if(dom) return renderDomain(main, dom);
  return renderDashboard(main);
}

/* ===================== Dashboard ===================== */
function renderDashboard(main){
  const overall = TRACKS.map(t=>overallTrackAvg(t.key));
  const combinedOverall = (()=>{
    const vals = overall.filter(v=>v!==null);
    return vals.length? vals.reduce((a,b)=>a+b,0)/vals.length : null;
  })();

  const impactInds = INDICATORS.filter(i=>i.section==='IMPACT');
  const month = STATE.currentMonth;

  const priorityRows = DOMAINS.map(d=>({
    dom:d, avg: domainCombinedAvg(d.key), priority: STATE.capacity[d.key].priority
  })).filter(r=>r.avg!==null || r.priority);
  priorityRows.sort((a,b)=>{
    const rank = {High:0,Medium:1,Low:2,'':3};
    const pr = (rank[a.priority]??3) - (rank[b.priority]??3);
    if(pr!==0) return pr;
    return (a.avg??9) - (b.avg??9);
  });

  main.innerHTML = `
    <div class="page-head">
      <div class="eyebrow">Dashboard</div>
      <h1>${esc(STATE.name)}</h1>
      <div class="sub">${esc(STATE.basic.legalForm||'Legal form not set')} · ${esc(STATE.basic.city||'City not set')}${STATE.basic.country?(', '+esc(STATE.basic.country)):''} ${STATE.basic.sessionDates?(' · Session: '+esc(STATE.basic.sessionDates)):''}</div>
    </div>

    <div class="grid grid-4" style="margin-bottom:16px;">
      <div class="card stat-card">
        <div class="lbl">Overall capacity</div>
        <div class="val">${fmtScore(combinedOverall)}<small> / 4</small></div>
        <div class="delta">across ${DOMAINS.length} domains, all tracks</div>
      </div>
      ${TRACKS.map((t,i)=>`
        <div class="card stat-card">
          <div class="lbl">${t.label}</div>
          <div class="val">${fmtScore(overall[i])}<small> / 4</small></div>
          <div class="delta">${DOMAINS.filter(d=>domainTrackAvg(d.key,t.key)!==null).length}/${DOMAINS.length} domains scored</div>
        </div>`).join('')}
    </div>

    <div class="card card-pad" style="margin-bottom:16px;">
      <div class="section-head" style="margin-top:0;"><h3>Capacity by domain</h3><div class="section-line"></div></div>
      <div class="radar-wrap">
        <div id="radar-holder"></div>
        <div class="radar-legend">
          ${TRACKS.map((t,i)=>`<span><i style="background:${RADAR_COLORS[i]}"></i>${t.label}</span>`).join('')}
        </div>
      </div>
    </div>

    <div class="grid grid-2" style="align-items:start;">
      <div class="card card-pad">
        <div class="section-head" style="margin-top:0;"><h3>Priority domains</h3><div class="section-line"></div></div>
        ${priorityRows.length===0?'<p class="muted">No domains scored yet — start with a capacity domain in the sidebar.</p>':
          priorityRows.slice(0,8).map(r=>`
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--line-soft);">
            <div>
              <div style="font-weight:600;font-size:13px;">${r.dom.num}. ${esc(r.dom.title)}</div>
              <div class="muted" style="font-size:11.5px;">Avg score ${fmtScore(r.avg)} / 4</div>
            </div>
            <span class="badge ${r.priority?('badge-'+r.priority):'badge-none'}">${r.priority||'Not set'}</span>
          </div>`).join('')}
      </div>
      <div class="card card-pad">
        <div class="section-head" style="margin-top:0;"><h3>Impact snapshot <span class="muted" style="font-weight:400;font-size:11.5px;">(through ${MONTHS[month-1]})</span></h3><div class="section-line"></div></div>
        ${impactInds.map(ind=>{
          const cum = indCumulated(ind, month);
          const pct = (cum!==null && ind.target_y1) ? Math.min(100, (cum/ind.target_y1)*100) : 0;
          return `<div style="margin-bottom:14px;">
            <div style="display:flex;justify-content:space-between;font-size:12.4px;margin-bottom:5px;">
              <span style="font-weight:600;">${esc(ind.name)}</span>
              <span class="muted">${fmtIndValue(ind,cum)} / ${fmtTarget(ind)}</span>
            </div>
            <div class="pbar"><i style="width:${pct}%"></i></div>
          </div>`;
        }).join('')}
      </div>
    </div>
  `;
  renderRadar(document.getElementById('radar-holder'));
}

const RADAR_COLORS = ['#B07F26','#2F6F63','#A34A32'];

function renderRadar(holder){
  const size = 340, cx=size/2, cy=size/2, r=size/2-46, N=DOMAINS.length;
  function pt(i, value){
    const ang = -Math.PI/2 + i*(2*Math.PI/N);
    const rad = (value/4)*r;
    return [cx+rad*Math.cos(ang), cy+rad*Math.sin(ang)];
  }
  let rings='';
  for(let lvl=1; lvl<=4; lvl++){
    const pts = DOMAINS.map((d,i)=>pt(i,lvl).join(',')).join(' ');
    rings += `<polygon points="${pts}" fill="none" stroke="#D3C9AC" stroke-width="1"/>`;
  }
  let spokes='', labels='';
  DOMAINS.forEach((d,i)=>{
    const [x,y] = pt(i,4.55);
    spokes += `<line x1="${cx}" y1="${cy}" x2="${pt(i,4)[0]}" y2="${pt(i,4)[1]}" stroke="#D3C9AC" stroke-width="1"/>`;
    labels += `<text x="${x}" y="${y}" font-size="10.5" font-family="IBM Plex Mono, monospace" fill="#3C5548" text-anchor="middle" dominant-baseline="middle">${d.num}</text>`;
  });
  let polys='';
  TRACKS.forEach((t,ti)=>{
    const pts = DOMAINS.map((d,i)=>{
      const v = domainTrackAvg(d.key, t.key);
      return pt(i, v===null?0:v).join(',');
    }).join(' ');
    polys += `<polygon points="${pts}" fill="${RADAR_COLORS[ti]}22" stroke="${RADAR_COLORS[ti]}" stroke-width="2"/>`;
  });
  holder.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${rings}${spokes}${polys}${labels}</svg>`;
}
/* ===================== Basic Information ===================== */
function renderBasic(main){
  const b = STATE.basic;
  main.innerHTML = `
    <div class="page-head">
      <div class="eyebrow">Basic information</div>
      <h1>Organisation profile</h1>
      <div class="sub">Core details captured at the start of every assessment cycle.</div>
    </div>

    <div class="card card-pad">
      <div class="field-row">
        <div class="field">
          <label class="field-label">Name of the CSO</label>
          <input type="text" id="b-name" value="${esc(STATE.name)}">
        </div>
        <div class="field">
          <label class="field-label">Legal form</label>
          <select id="b-legal">
            <option value="">Select…</option>
            ${LEGAL_FORMS.map(f=>`<option value="${f}" ${b.legalForm===f?'selected':''}>${f}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label class="field-label">Team size</label>
          <input type="number" min="0" id="b-teamsize" value="${esc(b.teamSize)}">
        </div>
        <div class="field">
          <label class="field-label">Country</label>
          <input type="text" id="b-country" value="${esc(b.country)}">
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label class="field-label">City</label>
          <input type="text" id="b-city" value="${esc(b.city)}">
        </div>
        <div class="field">
          <label class="field-label">Location</label>
          <input type="text" id="b-location" value="${esc(b.location)}" placeholder="e.g. head office, community hall…">
        </div>
      </div>
      <div class="field">
        <label class="field-label">Session dates</label>
        <input type="text" id="b-sessiondates" value="${esc(b.sessionDates)}" placeholder="e.g. 14–15 September 2026">
      </div>
    </div>

    <div class="card card-pad">
      <div class="section-head" style="margin-top:0;"><h3>People involved — within the CSO</h3><div class="section-line"></div></div>
      <div id="team-cso"></div>
      <button class="btn btn-ghost btn-sm" id="add-cso-row" style="margin-top:8px;">+ Add person</button>
    </div>

    <div class="card card-pad">
      <div class="section-head" style="margin-top:0;"><h3>People involved — within the support structure</h3><div class="section-line"></div></div>
      <div id="team-support"></div>
      <button class="btn btn-ghost btn-sm" id="add-support-row" style="margin-top:8px;">+ Add person</button>
    </div>
  `;

  ['name','legal','teamsize','country','city','location','sessiondates'].forEach(f=>{
    const elx = document.getElementById('b-'+f);
    const evt = (elx.tagName==='SELECT') ? 'change' : 'input';
    elx.addEventListener(evt, ()=>{
      const v = elx.value;
      if(f==='name'){ STATE.name = v; }
      else if(f==='legal'){ b.legalForm = v; }
      else if(f==='teamsize'){ b.teamSize = v; }
      else if(f==='country'){ b.country = v; }
      else if(f==='city'){ b.city = v; }
      else if(f==='location'){ b.location = v; }
      else if(f==='sessiondates'){ b.sessionDates = v; }
      scheduleSave();
      if(f==='name'){
        const nameLbl = document.querySelector('.org-switch .name');
        if(nameLbl) nameLbl.textContent = v;
      }
    });
  });

  renderTeamTable(document.getElementById('team-cso'), b.csoTeam);
  renderTeamTable(document.getElementById('team-support'), b.supportTeam);

  document.getElementById('add-cso-row').addEventListener('click', ()=>{
    b.csoTeam.push({name:'',title:'',email:'',phone:''});
    scheduleSave();
    renderTeamTable(document.getElementById('team-cso'), b.csoTeam);
  });
  document.getElementById('add-support-row').addEventListener('click', ()=>{
    b.supportTeam.push({name:'',title:'',email:'',phone:''});
    scheduleSave();
    renderTeamTable(document.getElementById('team-support'), b.supportTeam);
  });
}

function renderTeamTable(holder, arr){
  holder.innerHTML = `
    <table class="mini-table">
      <thead><tr><th>Surname &amp; first name</th><th>Title</th><th>Email</th><th>Phone / WhatsApp</th><th></th></tr></thead>
      <tbody>
        ${arr.map((p,i)=>`
          <tr>
            <td><input type="text" data-i="${i}" data-f="name" value="${esc(p.name)}"></td>
            <td><input type="text" data-i="${i}" data-f="title" value="${esc(p.title)}"></td>
            <td><input type="email" data-i="${i}" data-f="email" value="${esc(p.email)}"></td>
            <td><input type="text" data-i="${i}" data-f="phone" value="${esc(p.phone)}"></td>
            <td><button class="row-del" data-del="${i}" title="Remove">×</button></td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  holder.querySelectorAll('input').forEach(inp=>{
    inp.addEventListener('input', ()=>{
      const i = +inp.getAttribute('data-i'), f = inp.getAttribute('data-f');
      arr[i][f] = inp.value;
      scheduleSave();
    });
  });
  holder.querySelectorAll('[data-del]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const i = +btn.getAttribute('data-del');
      arr.splice(i,1);
      if(arr.length===0) arr.push({name:'',title:'',email:'',phone:''});
      scheduleSave();
      renderTeamTable(holder, arr);
    });
  });
}
/* ===================== Domain assessment view ===================== */
function renderDomain(main, dom){
  const c = STATE.capacity[dom.key];
  const idx = DOMAINS.findIndex(d=>d.key===dom.key);
  const prev = DOMAINS[idx-1], next = DOMAINS[idx+1];

  main.innerHTML = `
    <div class="page-head">
      <div class="eyebrow">Organisational capacity · Domain ${dom.num} of ${DOMAINS.length}</div>
      <h1>${dom.num}. ${esc(dom.title)}</h1>
      <div class="sub">${esc(dom.desc)}</div>
    </div>

    <div class="card card-pad" style="margin-bottom:18px;">
      <div class="grid grid-4" style="margin-bottom:14px;">
        ${TRACKS.map(t=>`
          <div class="stat-card" style="padding:0;">
            <div class="lbl">${t.label}</div>
            <div class="val" style="font-size:22px;">${fmtScore(domainTrackAvg(dom.key,t.key))}<small> / 4</small></div>
          </div>`).join('')}
        <div class="stat-card" style="padding:0;">
          <div class="lbl">Answered</div>
          <div class="val" style="font-size:22px;">${domainAnsweredCount(dom.key)}<small> / ${dom.questions.length}</small></div>
        </div>
      </div>
      <label class="field-label">Priority for this organisation</label>
      <div class="priority-row" id="pri-row">
        ${PRIORITIES.map(p=>`<button class="pri-btn ${c.priority===p?('sel-'+p):''}" data-p="${p}">${p}</button>`).join('')}
      </div>
    </div>

    <div class="legend-row">
      <span><i style="background:var(--l1)"></i>Level 1 — clear need for capacity building</span>
      <span><i style="background:var(--l2)"></i>Level 2 — basic</span>
      <span><i style="background:var(--l3)"></i>Level 3 — moderate</span>
      <span><i style="background:var(--l4)"></i>Level 4 — high</span>
    </div>

    <div id="q-list"></div>

    <div class="card card-pad domain-foot" style="margin-top:18px;">
      <div class="section-head" style="margin-top:0;"><h3>Support needed</h3><div class="section-line"></div></div>
      <div class="support-flag">This question is asked at the end of every domain so support needs are captured consistently across the assessment.</div>
      <div class="field">
        <label class="field-label">What support does the organisation need in this area?</label>
        <textarea id="support-needs" placeholder="Describe the type of support, training or resources that would help…">${esc(c.supportNeeds)}</textarea>
      </div>
      <div class="field">
        <label class="field-label">General comments on ${esc(dom.title)}</label>
        <textarea id="domain-comments" placeholder="Any additional notes on this domain…">${esc(c.comments)}</textarea>
      </div>
    </div>

    <div class="domain-nextprev no-print">
      ${prev ? `<button class="btn btn-ghost" id="btn-prev">← ${prev.num}. ${esc(prev.title)}</button>` : '<span></span>'}
      ${next ? `<button class="btn btn-gold" id="btn-next">${next.num}. ${esc(next.title)} →</button>` : '<span></span>'}
    </div>
  `;

  document.querySelectorAll('#pri-row .pri-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      c.priority = btn.getAttribute('data-p');
      scheduleSave();
      document.querySelectorAll('#pri-row .pri-btn').forEach(b=>b.className='pri-btn');
      btn.classList.add('sel-'+c.priority);
      updateSidebarLadders();
    });
  });

  document.getElementById('support-needs').addEventListener('input', e=>{ c.supportNeeds = e.target.value; scheduleSave(); });
  document.getElementById('domain-comments').addEventListener('input', e=>{ c.comments = e.target.value; scheduleSave(); });

  const qList = document.getElementById('q-list');
  dom.questions.forEach(qq=>{ qList.appendChild(renderQuestionCard(dom, qq, c)); });

  if(prev) document.getElementById('btn-prev').addEventListener('click', ()=>{ VIEW=prev.key; renderShell(); window.scrollTo(0,0); });
  if(next) document.getElementById('btn-next').addEventListener('click', ()=>{ VIEW=next.key; renderShell(); window.scrollTo(0,0); });
}

function renderQuestionCard(dom, qq, c){
  const card = el(`<div class="card qcard"></div>`);
  const rec = c.q[qq.id];
  card.innerHTML = `
    <div class="qtop">
      <div>
        <span class="qid">${qq.id}</span> <span class="qsub">${esc(qq.sub)}</span>
      </div>
    </div>
    <div class="qtext">${nl2br(qq.q)}</div>
    <button class="guide-toggle" data-toggle="guide">▸ View scoring guide (levels 1–4)</button>
    <div class="guide-grid" data-guide>
      ${qq.levels.map((lv,i)=>`
        <div class="guide-cell gc-${i+1}">
          <div class="gh"><span class="dot"></span>Level ${i+1}</div>
          ${nl2br(lv)}
        </div>`).join('')}
    </div>
    <div data-tracks></div>
  `;
  const tracksHolder = card.querySelector('[data-tracks]');
  TRACKS.forEach(t=>{
    tracksHolder.appendChild(renderTrackRow(qq, t, rec[t.key]));
  });

  card.querySelector('[data-toggle]').addEventListener('click', ()=>{
    const g = card.querySelector('[data-guide]');
    g.classList.toggle('open');
    card.querySelector('[data-toggle]').textContent = (g.classList.contains('open')?'▾':'▸') + ' View scoring guide (levels 1–4)';
  });
  return card;
}

function renderTrackRow(qq, track, rec){
  const row = el(`<div class="track-row"></div>`);
  row.innerHTML = `
    <div class="track-label">${track.label}</div>
    <div class="track-mid">
      <div class="ladder" data-ladder></div>
      <button class="comment-toggle" data-ctoggle>${rec.comment? 'Edit comment':'+ Add comment'}</button>
      <div class="comment-box ${rec.comment?'open':''}" data-cbox>
        <textarea placeholder="Comment (optional)">${esc(rec.comment)}</textarea>
      </div>
    </div>
  `;
  const ladder = row.querySelector('[data-ladder]');
  for(let lvl=1; lvl<=4; lvl++){
    const btn = el(`<button class="rung ${rec.level===lvl?('on-'+lvl):''}" type="button">${lvl}</button>`);
    btn.addEventListener('click', ()=>{
      rec.level = (rec.level===lvl) ? 0 : lvl; // click again to clear
      scheduleSave();
      ladder.querySelectorAll('.rung').forEach((b,i)=>{
        b.className = 'rung' + (rec.level===(i+1) ? (' on-'+(i+1)) : '');
      });
      refreshDomainHeaderStats();
      updateSidebarLadders();
    });
    ladder.appendChild(btn);
  }
  const ctoggle = row.querySelector('[data-ctoggle]');
  const cbox = row.querySelector('[data-cbox]');
  ctoggle.addEventListener('click', ()=>{ cbox.classList.toggle('open'); });
  cbox.querySelector('textarea').addEventListener('input', e=>{
    rec.comment = e.target.value;
    ctoggle.textContent = rec.comment ? 'Edit comment' : '+ Add comment';
    scheduleSave();
  });
  return row;
}

function refreshDomainHeaderStats(){
  // cheap re-render of the stat cards + answered count without rebuilding question list
  const dom = DOMAINS.find(d=>d.key===VIEW);
  if(!dom) return;
  const vals = document.querySelectorAll('.page-head + .card .stat-card .val');
  if(vals.length>=4){
    TRACKS.forEach((t,i)=>{ vals[i].innerHTML = `${fmtScore(domainTrackAvg(dom.key,t.key))}<small> / 4</small>`; });
    vals[3].innerHTML = `${domainAnsweredCount(dom.key)}<small> / ${dom.questions.length}</small>`;
  }
}
function updateSidebarLadders(){
  const navDomains = document.getElementById('nav-domains');
  if(!navDomains) return;
  navDomains.innerHTML='';
  DOMAINS.forEach(dom=>navDomains.appendChild(navDomainItem(dom)));
}
/* ===================== M&E KPI Tracker ===================== */
const ME_SECTIONS = ['IMPACT','OUTCOMES','OUTPUTS','INTERNAL / OPERATIONAL KPI'];
const ME_SECTION_LABEL = {
  'IMPACT':'Impact', 'OUTCOMES':'Outcomes', 'OUTPUTS':'Outputs',
  'INTERNAL / OPERATIONAL KPI':'Internal / operational KPIs'
};

function renderME(main){
  const month = STATE.currentMonth;
  main.innerHTML = `
    <div class="page-head">
      <div class="eyebrow">M&amp;E KPI tracker</div>
      <h1>Monitoring &amp; evaluation</h1>
      <div class="sub">Impact, outcome, output and internal KPIs, tracked monthly against Year-1 and project targets. 2026 reporting calendar.</div>
    </div>

    <div class="card card-pad" style="margin-bottom:18px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
      <label class="field-label" style="margin:0;">Reporting month</label>
      <select id="month-select" style="width:auto;min-width:160px;">
        ${MONTHS.map((m,i)=>`<option value="${i+1}" ${month===i+1?'selected':''}>${m} 2026</option>`).join('')}
      </select>
      <span class="muted" style="font-size:12px;">Entries and progress below are for the selected month. Cumulated values roll up everything entered up to that month.</span>
    </div>

    <div id="me-sections"></div>
  `;
  document.getElementById('month-select').addEventListener('change', e=>{
    STATE.currentMonth = +e.target.value;
    scheduleSave();
    renderME(main);
  });

  const holder = document.getElementById('me-sections');
  ME_SECTIONS.forEach(sec=>{
    const inds = INDICATORS.filter(i=>i.section===sec);
    if(!inds.length) return;
    const head = el(`<div class="section-head"><h3>${ME_SECTION_LABEL[sec]}</h3><span class="count">${inds.length}</span><div class="section-line"></div></div>`);
    holder.appendChild(head);
    inds.forEach(ind=> holder.appendChild(renderIndicatorCard(ind, STATE.currentMonth)));
  });
}

function renderIndicatorCard(ind, month){
  const card = el(`<div class="card ind-card"></div>`);
  const cum = indCumulated(ind, month);
  const rate = indExecutionRate(ind, month);
  card.innerHTML = `
    <div class="ind-top" data-toggle>
      <div>
        <div class="ind-name">${esc(ind.name)}</div>
        <div class="ind-meta">${esc(ind.responsible||'—')} · ${esc(ind.frequency||'—')}</div>
      </div>
      <div class="ind-nums">
        <div class="ind-num"><div class="v">${fmtIndValue(ind,cum)}</div><div class="l">Cumulated</div></div>
        <div class="ind-num"><div class="v">${fmtTarget(ind)}</div><div class="l">Target Y1</div></div>
        <div class="ind-num"><div class="v">${rate===null?'—':rate.toFixed(0)+'%'}</div><div class="l">Execution</div></div>
      </div>
    </div>
    <div class="pbar" style="margin-top:10px;"><i style="width:${rate===null?0:Math.min(100,rate)}%"></i></div>
    <div class="ind-body" data-body>
      <div class="ind-def">${nl2br(ind.definition)}</div>
      <div class="ind-metarow">
        <span><b>Data source:</b> ${esc(ind.data_source||'—')}</span>
        <span><b>Collection method:</b> ${esc(ind.collection_method||'—')}</span>
        <span><b>Baseline:</b> ${ind.baseline!==null?fmtIndValue(ind,ind.baseline):'—'}</span>
        <span><b>Target (project):</b> ${ind.target_project!==null?fmtIndValue(ind,ind.target_project):'—'}</span>
      </div>
      <div class="entry-row" data-entry></div>
      <div class="section-head" style="margin:16px 0 8px;"><h3 style="font-size:12.5px;">All months</h3><div class="section-line"></div></div>
      <div class="month-grid" data-monthgrid></div>
    </div>
  `;

  card.querySelector('[data-toggle]').addEventListener('click', ()=>{
    card.querySelector('[data-body]').classList.toggle('open');
  });

  const rec = STATE.me[ind.idx].months[month] || {result:'', obs:''};
  const entryHolder = card.querySelector('[data-entry]');
  entryHolder.innerHTML = `
    <div class="field short">
      <label class="field-label">${MONTHS[month-1]} result</label>
      <input type="text" data-entry-result value="${esc(rec.result)}" placeholder="0">
    </div>
    <div class="field">
      <label class="field-label">Observations</label>
      <input type="text" data-entry-obs value="${esc(rec.obs)}" placeholder="Notes for this period…">
    </div>
  `;
  function ensureRec(){
    if(!STATE.me[ind.idx].months[month]) STATE.me[ind.idx].months[month] = {result:'',obs:''};
    return STATE.me[ind.idx].months[month];
  }
  entryHolder.querySelector('[data-entry-result]').addEventListener('input', e=>{
    ensureRec().result = e.target.value;
    scheduleSave();
    refreshIndicatorNums(card, ind, month);
    renderMonthGrid(card.querySelector('[data-monthgrid]'), ind, month);
  });
  entryHolder.querySelector('[data-entry-obs]').addEventListener('input', e=>{
    ensureRec().obs = e.target.value;
    scheduleSave();
  });

  renderMonthGrid(card.querySelector('[data-monthgrid]'), ind, month);
  return card;
}

function refreshIndicatorNums(card, ind, month){
  const cum = indCumulated(ind, month);
  const rate = indExecutionRate(ind, month);
  const nums = card.querySelectorAll('.ind-num .v');
  nums[0].textContent = fmtIndValue(ind,cum);
  nums[2].textContent = rate===null?'—':rate.toFixed(0)+'%';
  card.querySelector('.pbar > i').style.width = (rate===null?0:Math.min(100,rate))+'%';
}

function renderMonthGrid(holder, ind, currentMonth){
  holder.innerHTML = MONTHS.map((m,i)=>{
    const mm = i+1;
    const rec = STATE.me[ind.idx].months[mm];
    const v = rec && rec.result ? rec.result : '—';
    return `<div class="month-cell ${mm===currentMonth?'current':''}">
      <div class="mname">${m}</div>
      <div class="mval">${esc(v)}</div>
    </div>`;
  }).join('');
}
/* ===================== Admin dashboard ===================== */
let ADMIN_ORGS_CACHE = [];
let ADMIN_FILTER = '';

async function renderAdminDashboard(){
  VIEW = 'admin-dashboard'; STATE = null;
  const app = document.getElementById('app');
  app.innerHTML = '<div class="landing"><div class="spinner"></div></div>';
  ADMIN_ORGS_CACHE = await storageListOrgs();
  paintAdminDashboard();
}

function paintAdminDashboard(){
  const app = document.getElementById('app');
  const orgs = ADMIN_ORGS_CACHE;

  const scored = orgs.map(o=>orgOverallAvg(o)).filter(v=>v!==null);
  const avgAll = scored.length ? scored.reduce((a,b)=>a+b,0)/scored.length : null;
  const highPriCount = orgs.filter(o=>orgHighPriorityCount(o)>0).length;
  const meCount = orgs.filter(o=>orgMEEnteredCount(o)>0).length;

  const q = ADMIN_FILTER.trim().toLowerCase();
  const filtered = !q ? orgs : orgs.filter(o=>
    (o.name||'').toLowerCase().includes(q) ||
    (o.basic?.legalForm||'').toLowerCase().includes(q) ||
    (o.basic?.city||'').toLowerCase().includes(q));

  app.innerHTML = `
  <div class="landing" style="align-items:flex-start;">
    <div class="landing-wrap" style="max-width:1080px;">
      <div class="landing-hero">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;">
          <div>
            <div class="eyebrow">Admin · REACH programme</div>
            <h1 style="font-size:28px;">Programme dashboard</h1>
            <p style="max-width:70ch;">Every organisation saved to this instrument, with capacity scores and
            M&amp;E progress rolled up in one place.</p>
          </div>
          <button class="btn btn-ghost btn-sm" id="btn-admin-logout">Log out of admin</button>
        </div>
      </div>

      <div class="grid grid-4" style="margin-bottom:20px;">
        <div class="card stat-card">
          <div class="lbl">CSOs on record</div>
          <div class="val">${orgs.length}</div>
        </div>
        <div class="card stat-card">
          <div class="lbl">Avg overall capacity</div>
          <div class="val">${fmtScore(avgAll)}<small> / 4</small></div>
        </div>
        <div class="card stat-card">
          <div class="lbl">With a high-priority domain</div>
          <div class="val">${highPriCount}<small> / ${orgs.length}</small></div>
        </div>
        <div class="card stat-card">
          <div class="lbl">Reporting M&amp;E data</div>
          <div class="val">${meCount}<small> / ${orgs.length}</small></div>
        </div>
      </div>

      <div class="section-head" style="margin-top:0;"><h3>Organisations</h3><div class="section-line"></div></div>
      <div class="card card-pad">
        <div class="field" style="margin-bottom:14px;max-width:340px;">
          <input type="text" id="admin-search" placeholder="Filter by name, legal form or city…" value="${esc(ADMIN_FILTER)}">
        </div>
        ${filtered.length===0 ? '<div class="empty-state"><h3>No organisations found</h3><p>Nothing saved yet, or no match for that filter.</p></div>' : `
        <table class="report-table">
          <thead>
            <tr>
              <th>Organisation</th><th>Legal form</th><th>City</th>
              <th>Overall</th><th>Domains scored</th><th>High priority</th>
              <th>M&amp;E</th><th>Updated</th><th></th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map(o=>`
              <tr class="click" data-open="${esc(o.id)}">
                <td><b>${esc(o.name)}</b></td>
                <td>${esc(o.basic?.legalForm||'—')}</td>
                <td>${esc(o.basic?.city||'—')}</td>
                <td>${fmtScore(orgOverallAvg(o))} / 4</td>
                <td>${orgDomainsScoredCount(o)} / ${DOMAINS.length}</td>
                <td>${orgHighPriorityCount(o)>0 ? `<span class="badge badge-High">${orgHighPriorityCount(o)}</span>` : '<span class="badge badge-none">0</span>'}</td>
                <td>${orgMEEnteredCount(o)} / ${INDICATORS.length}</td>
                <td>${o.updatedAt ? new Date(o.updatedAt).toLocaleDateString() : '—'}</td>
                <td><button class="row-del" data-del="${esc(o.id)}" title="Delete">×</button></td>
              </tr>`).join('')}
          </tbody>
        </table>`}
      </div>
    </div>
  </div>`;

  document.getElementById('btn-admin-logout').addEventListener('click', ()=>{
    IS_ADMIN = false;
    renderLanding();
  });
  const search = document.getElementById('admin-search');
  search.addEventListener('input', ()=>{ ADMIN_FILTER = search.value; paintAdminDashboard(); document.getElementById('admin-search').focus(); });

  app.querySelectorAll('[data-open]').forEach(tr=>{
    tr.addEventListener('click', async (e)=>{
      if(e.target.closest('[data-del]')) return;
      const id = tr.getAttribute('data-open');
      app.innerHTML = '<div class="landing"><div class="spinner"></div></div>';
      const s = await storageLoad(id);
      if(s){ STATE = ensureShape(s); VIEW='dashboard'; renderShell(); }
      else { showToast('Could not open that organisation'); paintAdminDashboard(); }
    });
  });
  app.querySelectorAll('[data-del]').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      const id = btn.getAttribute('data-del');
      const org = ADMIN_ORGS_CACHE.find(o=>o.id===id);
      if(!confirm(`Delete "${org?org.name:'this organisation'}"? This cannot be undone.`)) return;
      await storageDelete(id);
      ADMIN_ORGS_CACHE = ADMIN_ORGS_CACHE.filter(o=>o.id!==id);
      paintAdminDashboard();
    });
  });
}
/* ===================== Summary & Report ===================== */
function renderSummary(main){
  const month = STATE.currentMonth;
  main.innerHTML = `
    <div class="page-head">
      <div class="eyebrow">Summary &amp; report</div>
      <h1>Assessment summary</h1>
      <div class="sub">A consolidated view for printing or export, current as of ${new Date(STATE.updatedAt).toLocaleString()}.</div>
    </div>

    <div class="btn-row no-print" style="margin-bottom:18px;">
      <button class="btn btn-gold" id="btn-print">Print / save as PDF</button>
      <button class="btn btn-ghost" id="btn-export">Export JSON backup</button>
    </div>

    <div class="card card-pad" style="margin-bottom:16px;">
      <div class="section-head" style="margin-top:0;"><h3>Organisation</h3><div class="section-line"></div></div>
      <div class="grid grid-3" style="font-size:13px;">
        <div><b>Name</b><br>${esc(STATE.name)}</div>
        <div><b>Legal form</b><br>${esc(STATE.basic.legalForm||'—')}</div>
        <div><b>Team size</b><br>${esc(STATE.basic.teamSize||'—')}</div>
        <div><b>Location</b><br>${esc(STATE.basic.city||'—')}${STATE.basic.country?(', '+esc(STATE.basic.country)):''}</div>
        <div><b>Session dates</b><br>${esc(STATE.basic.sessionDates||'—')}</div>
        <div><b>Assessors involved</b><br>${STATE.basic.csoTeam.filter(p=>p.name).length + STATE.basic.supportTeam.filter(p=>p.name).length} people listed</div>
      </div>
    </div>

    <div class="card card-pad" style="margin-bottom:16px;">
      <div class="section-head" style="margin-top:0;"><h3>Organisational capacity — by domain</h3><div class="section-line"></div></div>
      <table class="report-table">
        <thead><tr><th>Domain</th><th>Lead</th><th>Second</th><th>Self</th><th>Combined</th><th>Priority</th><th>Support needed</th></tr></thead>
        <tbody>
          ${DOMAINS.map(d=>{
            const c = STATE.capacity[d.key];
            return `<tr>
              <td><b>${d.num}.</b> ${esc(d.title)}</td>
              <td>${fmtScore(domainTrackAvg(d.key,'lead'))}</td>
              <td>${fmtScore(domainTrackAvg(d.key,'second'))}</td>
              <td>${fmtScore(domainTrackAvg(d.key,'self'))}</td>
              <td><b>${fmtScore(domainCombinedAvg(d.key))}</b></td>
              <td><span class="badge ${c.priority?('badge-'+c.priority):'badge-none'}">${c.priority||'—'}</span></td>
              <td style="max-width:240px;">${esc(c.supportNeeds)||'<span class="muted">—</span>'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>

    <div class="card card-pad">
      <div class="section-head" style="margin-top:0;"><h3>M&amp;E indicators — status through ${MONTHS[month-1]} 2026</h3><div class="section-line"></div></div>
      ${ME_SECTIONS.map(sec=>{
        const inds = INDICATORS.filter(i=>i.section===sec);
        if(!inds.length) return '';
        return `
          <h4 style="font-size:13px;margin:14px 0 6px;">${ME_SECTION_LABEL[sec]}</h4>
          <table class="report-table" style="margin-bottom:8px;">
            <thead><tr><th>Indicator</th><th>Baseline</th><th>Cumulated</th><th>Target Y1</th><th>Execution</th></tr></thead>
            <tbody>
              ${inds.map(ind=>{
                const cum = indCumulated(ind, month);
                const rate = indExecutionRate(ind, month);
                return `<tr>
                  <td>${esc(ind.name)}</td>
                  <td>${ind.baseline!==null?fmtIndValue(ind,ind.baseline):'—'}</td>
                  <td>${fmtIndValue(ind,cum)}</td>
                  <td>${fmtTarget(ind)}</td>
                  <td>${rate===null?'—':rate.toFixed(0)+'%'}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>`;
      }).join('')}
    </div>
  `;
  document.getElementById('btn-print').addEventListener('click', ()=>window.print());
  document.getElementById('btn-export').addEventListener('click', downloadJSON);
}

/* ===================== Init ===================== */
document.addEventListener('DOMContentLoaded', boot);
