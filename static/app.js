(() => {
'use strict';

// ---------- constants ----------

const REL = {
  knows:      { label: 'Knows',      color: '#64748b', directed: false, verb: 'knows' },
  reports_to: { label: 'Reports to', color: '#2563eb', directed: true,  verb: 'reports to', back: 'manages' },
  referred:   { label: 'Referred',   color: '#16a34a', directed: true,  verb: 'referred', back: 'was referred by' },
  partner:    { label: 'Partner',    color: '#9333ea', directed: false, verb: 'partners with' },
  vendor:     { label: 'Vendor to',  color: '#d97706', directed: true,  verb: 'is a vendor to', back: 'buys from' },
  competitor: { label: 'Competitor', color: '#dc2626', directed: false, verb: 'competes with' },
  other:      { label: 'Other',      color: '#94a3b8', directed: false, verb: 'is connected to' },
};
const WORKS_AT = 'works_at';
const STRENGTH = { 1: 'Weak', 2: 'Medium', 3: 'Strong' };
const PALETTE = ['#0f766e', '#2563eb', '#c2410c', '#7c3aed', '#be123c', '#15803d', '#a16207', '#0369a1', '#9d174d', '#4d7c0f', '#6d28d9', '#b45309'];
const NO_COMPANY = '#94a3b8';
const POLL_MS = 5000;

const state = {
  version: -1,
  nodes: new Map(),
  edges: new Map(),
  connecting: false,
  connectFrom: null,
  connectedAt: 0,
  notes: new Map(),     // node id -> notes, newest first
  noteText: new Map(),  // node id -> lowercased note text, for search
  panel: null,          // { kind: 'node' | 'node-edit' | 'edge' | 'directory', id } or { kind: 'new-node' | 'new-edge', ... }
  panelDirty: false,
  picker: null,         // { nodeId, otherId } while the inline "add connection" form is open
  reps: [],
  wingmate: null,       // admin-only Wingmate connection status
  wingmateEditing: false,
  isAdmin: false,
  me: null,             // the signed-in rep, from /api/me
  signedOut: false,
  adminConfigured: false,
  editRepId: null,
  dirTab: 'people',
  dirQuery: '',
  focusId: null,
  hiddenRels: new Set(),
  ownerFilter: '',
  priorityFilter: '',
  colorPickerFor: null,
  dirFilters: [],       // [{ field, value }] in the Contacts list
  stageFilter: '',
  view: storeGet('pss.view') || 'team',  // 'team', 'mine' or (admins) a rep's name
  viewSets: null,       // { visible, context } node ids when a rep view is on
  tagFilter: '',
  cityFilter: '',
  firstLoad: true,
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hasPos = (n) => n && n.x != null && n.y != null;
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const splitTags = (s) => String(s || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);

function storeGet(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } }
function storeSet(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } }

function toast(message, isError) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', !!isError);
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, isError ? 5000 : 2600);
}

function timeAgo(iso) {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 86400 * 7) return `${Math.floor(secs / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function companyColor(companyId) {
  return companyId == null ? NO_COMPANY : PALETTE[companyId % PALETTE.length];
}
// A card's own color wins; contacts otherwise follow their company's color.
function nodeColor(n) {
  if (n.color) return n.color;
  if (n.type === 'company') return companyColor(n.id);
  const company = n.company_id != null ? state.nodes.get(n.company_id) : null;
  return company?.color || companyColor(n.company_id);
}

const CARD_COLORS = ['#e73235', '#144579', ...PALETTE, '#64748b'];

// ---------- identity ----------

// Who's signed in comes from the server session (reps sign in by email,
// the admin by password); every change is credited to that person.
const activeReps = () => state.reps.filter((r) => r.active);

function myName() {
  return state.me ? state.me.name : '';
}

function renderMeChip() {
  const chip = $('#me-chip');
  const name = state.me ? state.me.name : state.isAdmin ? 'Admin' : '';
  chip.hidden = !name;
  chip.innerHTML = `<span class="avatar avatar-xs" style="--hue:var(--accent)">${esc(initials(name))}</span><span class="me-name">${esc(name)}</span>`;
  chip.title = state.me ? `Signed in as ${state.me.email}. Click to sign out.` : 'Signed in as admin. Click to sign out.';
}

function showSignIn(on) {
  state.signedOut = on;
  $('#signin').hidden = !on;
  if (on) setTimeout(() => $('#signin-email').focus(), 0);
}

async function loadMe() {
  let me;
  try {
    me = await (await fetch('/api/me', { cache: 'no-store' })).json();
  } catch {
    setLive(false);
    setTimeout(loadMe, POLL_MS);
    return;
  }
  state.me = me.rep;
  state.adminConfigured = me.admin_configured;
  state.adminEnvManaged = me.env_managed;
  setAdmin(me.admin);
  renderMeChip();
  if (!me.rep && !me.admin) {
    showSignIn(true);
    return;
  }
  showSignIn(false);
  sync();
}

$('#signin-form').addEventListener('submit', async (evt) => {
  evt.preventDefault();
  const err = $('#signin-error');
  err.hidden = true;
  try {
    const passwordBox = $('#signin-password');
    const result = await api('POST', '/api/login', {
      email: $('#signin-email').value,
      password: passwordBox.hidden ? '' : passwordBox.value,
    });
    if (result.needs_password) {
      passwordBox.hidden = false;
      passwordBox.required = true;
      $('#signin-hint').textContent = 'You’re an admin, so enter your password too.';
      passwordBox.focus();
      return;
    }
    await loadMe();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
});

$('#signin-admin').addEventListener('click', () => {
  if (!state.adminConfigured) {
    $('#signin-error').textContent = 'Admin isn’t set up yet.';
    $('#signin-error').hidden = false;
    return;
  }
  openAdminLogin();
});

$('#me-chip').addEventListener('click', async () => {
  if (!confirm('Sign out of PSS Connect?')) return;
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
});

// ---------- API ----------

async function api(method, path, body) {
  const headers = {};
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.signed_out) {
    showSignIn(true);
    throw new Error('Please sign in');
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.duplicates = data.duplicates;  // set when the server spots a likely duplicate
    throw err;
  }
  return data;
}

// ---------- graph setup ----------

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function graphStyle() {
  const label = cssVar('--cy-label');
  const labelBg = cssVar('--cy-label-bg');
  const accent = cssVar('--accent');
  return [
    { selector: 'node', style: {
      'label': 'data(label)', 'font-size': 11, 'color': label,
      'font-family': 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      'text-valign': 'bottom', 'text-margin-y': 5, 'text-wrap': 'wrap', 'text-max-width': 130,
      'text-background-color': labelBg, 'text-background-opacity': 0.85,
      'text-background-padding': 2, 'text-background-shape': 'roundrectangle',
      'background-color': 'data(color)', 'border-width': 2, 'border-color': labelBg,
      'width': 28, 'height': 28,
    } },
    { selector: 'node[kind="company"]', style: {
      'shape': 'round-rectangle', 'width': 52, 'height': 52,
      'font-size': 13, 'font-weight': 700, 'border-width': 0,
    } },
    { selector: 'edge', style: {
      'curve-style': 'bezier', 'width': 'data(width)', 'line-color': 'data(color)',
      'target-arrow-color': 'data(color)', 'target-arrow-shape': 'data(arrow)', 'arrow-scale': 0.9,
      'opacity': 0.85, 'font-size': 10, 'color': label, 'text-rotation': 'autorotate',
      'text-background-color': labelBg, 'text-background-opacity': 0.9, 'text-background-padding': 2,
    } },
    { selector: `edge[rel="${WORKS_AT}"]`, style: {
      'line-style': 'dashed', 'line-dash-pattern': [4, 4], 'line-color': cssVar('--cy-works-at'), 'opacity': 1,
    } },
    { selector: 'edge[rel="competitor"]', style: { 'line-style': 'dashed', 'line-dash-pattern': [7, 4] } },
    { selector: 'edge.hover, edge:selected', style: { 'label': 'data(label)', 'opacity': 1, 'z-index': 10 } },
    { selector: 'node[priority = 1]', style: { 'border-width': 4, 'border-color': '#f5b301' } },
    { selector: 'node:selected', style: { 'border-width': 4, 'border-color': accent } },
    { selector: 'node.match', style: { 'border-width': 4, 'border-color': '#f59e0b' } },
    { selector: 'node.connect-from', style: { 'border-width': 4, 'border-color': accent, 'border-style': 'dashed' } },
    { selector: 'node.focus-root', style: { 'border-width': 5, 'border-color': accent } },
    { selector: '.dim, .faded', style: { 'opacity': 0.13 } },
    { selector: '.hidden-rel', style: { 'display': 'none' } },
    { selector: '.view-hidden', style: { 'display': 'none' } },
    { selector: 'node.ctx', style: { 'opacity': 0.45, 'border-style': 'dashed', 'border-width': 2, 'border-color': cssVar('--muted') } },
  ];
}

const cy = cytoscape({
  container: $('#cy'),
  style: graphStyle(),
  minZoom: 0.1,
  maxZoom: 3,
  boxSelectionEnabled: false,
});

// On phones a finger meant to pan or scroll can easily drag a dot, which would move it
// for everyone, so dots are locked there (arrange them from a computer).
const phoneQuery = window.matchMedia('(max-width: 720px)');
const lockDotsOnPhones = () => cy.autoungrabify(phoneQuery.matches);
lockDotsOnPhones();
phoneQuery.addEventListener?.('change', () => { lockDotsOnPhones(); cy.resize(); });

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
darkQuery.addEventListener?.('change', () => cy.style(graphStyle()));

function nodeElement(n) {
  const name = n.priority ? `★ ${n.name}` : n.name;
  const label = n.type === 'person' && n.title ? `${name}\n${n.title}` : name;
  return {
    group: 'nodes',
    data: { id: `n${n.id}`, nid: n.id, kind: n.type, label, color: nodeColor(n), priority: n.priority ? 1 : 0 },
    position: hasPos(n) ? { x: n.x, y: n.y } : undefined,
  };
}

function edgeElement(e) {
  const rel = REL[e.rel_type] || REL.other;
  return {
    group: 'edges',
    data: {
      id: `e${e.id}`, eid: e.id, source: `n${e.source_id}`, target: `n${e.target_id}`,
      rel: e.rel_type, label: rel.label, color: rel.color,
      width: 1 + e.strength * 1.5, arrow: rel.directed ? 'triangle' : 'none',
    },
  };
}

function worksAtElement(person) {
  return {
    group: 'edges',
    data: {
      id: `w${person.id}`, source: `n${person.id}`, target: `n${person.company_id}`,
      rel: WORKS_AT, label: 'Works at', color: NO_COMPANY, width: 1, arrow: 'none',
    },
  };
}

// ---------- company tag pills ----------
// A node label can only have one style, so company tags are small HTML pills
// laid over the map and kept just under each company's name.
const tagLayer = $('#tag-layer');
const tagPills = new Map();   // company id -> pill element
let tagFrame = 0;

function renderTagPills() {
  const seen = new Set();
  for (const n of state.nodes.values()) {
    const tags = n.type === 'company' ? String(n.tags || '').split(',').map((t) => t.trim()).filter(Boolean) : [];
    if (!tags.length) continue;
    seen.add(n.id);
    let el = tagPills.get(n.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'map-tags';
      tagLayer.appendChild(el);
      tagPills.set(n.id, el);
    }
    const html = tags.map((t) => `<span>${esc(t)}</span>`).join('');
    if (el.innerHTML !== html) el.innerHTML = html;
  }
  for (const [id, el] of tagPills) {
    if (!seen.has(id)) { el.remove(); tagPills.delete(id); }
  }
  scheduleTagPositions();
}

function positionTagPills() {
  tagFrame = 0;
  const zoom = cy.zoom();
  const pan = cy.pan();
  tagLayer.hidden = zoom < 0.45;  // too small to read when zoomed far out
  if (tagLayer.hidden) return;
  for (const [id, el] of tagPills) {
    const node = cy.getElementById(`n${id}`);
    if (node.empty() || node.hasClass('view-hidden')) { el.hidden = true; continue; }
    const box = node.boundingBox({ includeNodes: true, includeLabels: true, includeOverlays: false });
    el.hidden = false;
    el.style.left = `${node.position('x') * zoom + pan.x}px`;
    el.style.top = `${box.y2 * zoom + pan.y + 3 * zoom}px`;
    el.style.transform = `translateX(-50%) scale(${zoom})`;
    el.style.opacity = node.hasClass('dim') || node.hasClass('faded') ? '0.15' : '1';
  }
}

function scheduleTagPositions() {
  if (!tagFrame) tagFrame = requestAnimationFrame(positionTagPills);
}

function buildElements() {
  const els = [];
  for (const n of state.nodes.values()) els.push(nodeElement(n));
  for (const n of state.nodes.values()) {
    if (n.type === 'person' && n.company_id != null && state.nodes.has(n.company_id)) els.push(worksAtElement(n));
  }
  for (const e of state.edges.values()) els.push(edgeElement(e));
  return els;
}

function render() {
  const els = buildElements();
  const wanted = new Set(els.map((e) => e.data.id));
  cy.batch(() => {
    cy.elements().forEach((el) => { if (!wanted.has(el.id())) el.remove(); });
    for (const el of els) {
      const existing = cy.getElementById(el.data.id);
      if (existing.empty()) {
        cy.add(el);
        continue;
      }
      if (existing.isEdge() && (existing.data('source') !== el.data.source || existing.data('target') !== el.data.target)) {
        existing.remove();
        cy.add(el);
        continue;
      }
      existing.data(el.data);
      if (el.position && !existing.grabbed()) {
        const p = existing.position();
        if (Math.abs(p.x - el.position.x) > 0.5 || Math.abs(p.y - el.position.y) > 0.5) existing.position(el.position);
      }
    }
  });
  placeUnpositioned();
  refreshViewOptions();
  applyView();
  renderTagPills();
  applyFilters();
  applyFocus();
  applySearch();
  refreshFilterOptions();
  updateStats();
  $('#empty').hidden = state.nodes.size > 0;
}

// New nodes (and CSV imports) arrive without coordinates: put people around
// their company and loose nodes in a grid beside the existing map.
function placeUnpositioned() {
  const all = [...state.nodes.values()];
  const missing = all.filter((n) => !hasPos(n));
  if (!missing.length) return;
  if (missing.length === all.length) {
    runLayout(true);
    return;
  }
  const placed = cy.nodes().filter((el) => hasPos(state.nodes.get(el.data('nid'))));
  const bb = placed.boundingBox();
  const updates = [];
  let slot = 0;
  const cols = Math.max(4, Math.ceil(Math.sqrt(missing.filter((n) => n.type === 'company').length)));
  missing.sort((a, b) => (a.type === 'company' ? 0 : 1) - (b.type === 'company' ? 0 : 1));
  for (const n of missing) {
    const company = n.company_id != null ? state.nodes.get(n.company_id) : null;
    let pos;
    if (n.type === 'person' && hasPos(company)) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 90 + Math.random() * 60;
      pos = { x: company.x + radius * Math.cos(angle), y: company.y + radius * Math.sin(angle) };
    } else {
      pos = { x: bb.x2 + 220 + (slot % cols) * 220, y: bb.y1 + Math.floor(slot / cols) * 220 };
      slot += 1;
    }
    n.x = Math.round(pos.x);
    n.y = Math.round(pos.y);
    cy.getElementById(`n${n.id}`).position({ x: n.x, y: n.y });
    updates.push({ id: n.id, x: n.x, y: n.y });
  }
  savePositions(updates);
}

function runLayout(randomize) {
  if (!cy.nodes().length) return;
  const layout = cy.layout({
    name: 'cose',
    animate: !randomize,
    animationDuration: 700,
    randomize: !!randomize,
    fit: true,
    padding: 50,
    nodeRepulsion: () => 400000,
    nodeOverlap: 20,
    idealEdgeLength: (edge) => (edge.data('rel') === WORKS_AT ? 90 : 170),
    edgeElasticity: (edge) => (edge.data('rel') === WORKS_AT ? 50 : 120),
    gravity: 0.25,
    componentSpacing: 140,
  });
  layout.one('layoutstop', () => {
    const updates = cy.nodes().map((el) => {
      const p = el.position();
      const n = state.nodes.get(el.data('nid'));
      if (n) { n.x = Math.round(p.x); n.y = Math.round(p.y); }
      return { id: el.data('nid'), x: Math.round(p.x), y: Math.round(p.y) };
    });
    savePositions(updates);
  });
  layout.run();
}

async function savePositions(positions) {
  if (!positions.length) return;
  try {
    await api('PATCH', '/api/nodes/positions', { positions });
    sync();
  } catch (err) {
    toast(err.message, true);
  }
}

const pendingPositions = new Map();
let positionTimer = null;
cy.on('render', scheduleTagPositions);

cy.on('dragfree', 'node', (evt) => {
  const el = evt.target;
  const p = el.position();
  const n = state.nodes.get(el.data('nid'));
  if (n) { n.x = Math.round(p.x); n.y = Math.round(p.y); }
  pendingPositions.set(el.data('nid'), { id: el.data('nid'), x: Math.round(p.x), y: Math.round(p.y) });
  clearTimeout(positionTimer);
  positionTimer = setTimeout(() => {
    const batch = [...pendingPositions.values()];
    pendingPositions.clear();
    savePositions(batch);
  }, 250);
});

// ---------- sync ----------

let syncPromise = null;
let syncAgain = false;

function sync() {
  if (syncPromise) {
    syncAgain = true;
    return syncPromise;
  }
  syncPromise = doSync().finally(() => {
    syncPromise = null;
    if (syncAgain) {
      syncAgain = false;
      sync();
    }
  });
  return syncPromise;
}

async function doSync() {
  try {
    const res = await fetch(`/api/graph?since=${state.version}`, { cache: 'no-store' });
    if (res.status === 401) { showSignIn(true); return; }
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    setLive(true);
    if (data.unchanged) return;
    state.version = data.version;
    state.nodes = new Map(data.nodes.map((n) => [n.id, n]));
    state.edges = new Map(data.edges.map((e) => [e.id, e]));
    state.notes = new Map();
    for (const note of [...(data.notes || [])].reverse()) {
      if (!state.notes.has(note.node_id)) state.notes.set(note.node_id, []);
      state.notes.get(note.node_id).push(note);
    }
    state.reps = data.reps || [];
    $('#storage-warning').hidden = !data.temporary_storage;
    state.noteText = new Map([...state.notes].map(([id, list]) =>
      [id, list.map((note) => note.body).join('\n').toLowerCase()]));
    render();
    if (state.firstLoad) {
      state.firstLoad = false;
      if (isPhone() && !state.panel) openDirectory('people');
      if (cy.nodes().length) cy.fit(undefined, 50);
    }
    refreshPanelAfterSync();
    if (!$('#activity').hidden) loadActivity();
  } catch {
    setLive(false);
  }
}

function setLive(online) {
  $('#live-dot').className = `live-dot ${online ? 'on' : 'off'}`;
  $('#live-text').textContent = online ? 'Live · shared with your team' : 'Offline · retrying…';
}

setInterval(() => { if (!document.hidden && !state.signedOut) sync(); }, POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.signedOut) sync(); });

// ---------- filters, legend, stats ----------

function buildLegend() {
  const rels = [...Object.entries(REL), [WORKS_AT, { label: 'Works at', color: NO_COMPANY }]];
  // The phone layout shows the same chips inside the Filter menu.
  $('#legend').innerHTML = $('#legend-mobile').innerHTML = rels.map(([key, r]) => `
    <button class="chip ${state.hiddenRels.has(key) ? 'off' : ''}" data-rel="${key}" title="Show or hide ${esc(r.label)}">
      <span class="swatch ${key === WORKS_AT || key === 'competitor' ? 'dashed' : ''}" style="background:${r.color};color:${r.color}"></span>${esc(r.label)}
    </button>`).join('');
}

function onLegendClick(evt) {
  const chip = evt.target.closest('[data-rel]');
  if (!chip) return;
  const rel = chip.dataset.rel;
  if (state.hiddenRels.has(rel)) state.hiddenRels.delete(rel); else state.hiddenRels.add(rel);
  buildLegend();
  applyFilters();
}
$('#legend').addEventListener('click', onLegendClick);
$('#legend-mobile').addEventListener('click', onLegendClick);

// City is the part of Location before the first comma ("Dallas, TX" -> "Dallas").
const cityOf = (n) => String(n.location || '').split(',')[0].trim();

function activeFilterCount() {
  return [state.cityFilter, state.tagFilter, state.ownerFilter, state.stageFilter, state.priorityFilter].filter(Boolean).length;
}

// A person also matches through their company (and a company through its
// people), so filtering by a company's tag or city keeps its team in view.
function filterMatches() {
  const city = state.cityFilter.toLowerCase();
  const tag = state.tagFilter.toLowerCase();
  const owner = state.ownerFilter.toLowerCase();
  const stage = state.stageFilter.toLowerCase();
  const cityOk = (n) => cityOf(n).toLowerCase() === city;
  const stageOk = (p) => p.stage.trim().toLowerCase() === stage;
  const matched = new Set();
  for (const n of state.nodes.values()) {
    if (!inView(n.id)) continue;  // filters work within the current view
    if (owner && n.owner_rep.trim().toLowerCase() !== owner) continue;
    const company = n.type === 'company' ? n : companyOf(n);
    if (tag && !(company && splitTags(company.tags).includes(tag))) continue;  // tags live on companies
    if (city && !(cityOk(n) || (company && cityOk(company)) || (n.type === 'company' && peopleAt(n.id).some(cityOk)))) continue;
    // Stage lives on contacts; a company matches through its contacts.
    if (stage && !(n.type === 'person' ? stageOk(n) : peopleAt(n.id).some((p) => inView(p.id) && stageOk(p)))) continue;
    if (state.priorityFilter && !(n.type === 'person' ? n.priority : peopleAt(n.id).some((p) => inView(p.id) && p.priority))) continue;
    matched.add(n.id);
  }
  return matched;
}

// ---------- team view / rep view ----------
// Team view is the whole shared map, each company once. A rep's view shows what's
// theirs: their companies and contacts, plus any company where one of their contacts
// works (so a company two reps both work shows in both views), plus faded "context"
// for other reps' contacts they've connected to.

function viewRep() {
  if (state.view === 'team') return '';
  if (state.view === 'mine') return myName();
  return state.isAdmin ? state.view : myName();
}

function computeViewSets(rep) {
  const r = rep.trim().toLowerCase();
  const own = (n) => n.owner_rep.trim().toLowerCase() === r;
  const visible = new Set();
  for (const n of state.nodes.values()) {
    if (!own(n)) continue;
    visible.add(n.id);
    if (n.type === 'person' && n.company_id != null && state.nodes.has(n.company_id)) visible.add(n.company_id);
  }
  const context = new Set();
  for (const e of state.edges.values()) {
    if (visible.has(e.source_id) && !visible.has(e.target_id)) context.add(e.target_id);
    if (visible.has(e.target_id) && !visible.has(e.source_id)) context.add(e.source_id);
  }
  return { visible, context };
}

function inView(id) {
  const v = state.viewSets;
  return !v || v.visible.has(id) || v.context.has(id);
}

function applyView() {
  const rep = viewRep();
  state.viewSets = rep ? computeViewSets(rep) : null;
  const v = state.viewSets;
  cy.batch(() => {
    cy.nodes().forEach((el) => {
      const id = el.data('nid');
      el.toggleClass('view-hidden', !!v && !v.visible.has(id) && !v.context.has(id));
      el.toggleClass('ctx', !!v && v.context.has(id));
    });
  });
  $('#view-select').classList.toggle('active', !!v);
}

function refreshViewOptions() {
  const select = $('#view-select');
  const me = myName();
  const others = state.isAdmin ? activeReps().map((r) => r.name).filter((name) => name !== me) : [];
  if (state.view !== 'team' && state.view !== 'mine' && !others.includes(state.view)) state.view = 'team';
  if (state.view === 'mine' && !me) state.view = 'team';
  select.innerHTML = '<option value="team">Team view</option>'
    + (me ? '<option value="mine">My view</option>' : '')
    + (others.length ? `<optgroup label="A rep's view">${others.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('')}</optgroup>` : '');
  select.value = state.view;
}

function setView(view) {
  state.view = view;
  storeSet('pss.view', view);
  applyView();
  applyFilters();
  updateStats();
  scheduleTagPositions();
  applySearch();
  const shown = cy.nodes().not('.view-hidden');
  if (state.viewSets && !state.viewSets.visible.size) {
    toast(`Nothing is assigned to ${view === 'mine' ? 'you' : view} yet. Switch to Team view to see everyone's.`);
  }
  if (shown.length) moveMap({ fit: { eles: shown, padding: 60 } }, 350);
}

$('#view-select').addEventListener('change', (evt) => setView(evt.target.value));

function applyFilters() {
  const matched = activeFilterCount() ? filterMatches() : null;
  cy.batch(() => {
    cy.edges().forEach((e) => e.toggleClass('hidden-rel', state.hiddenRels.has(e.data('rel'))));
    cy.elements().removeClass('dim');
    if (!matched) return;
    cy.nodes().forEach((el) => { if (!matched.has(el.data('nid'))) el.addClass('dim'); });
    cy.edges().forEach((e) => {
      if (e.source().hasClass('dim') || e.target().hasClass('dim')) e.addClass('dim');
    });
  });
  renderFilterSummary(matched);
  if (state.panel?.kind === 'directory') renderDirectoryList();
  return matched;
}

function renderFilterSummary(matched) {
  const count = activeFilterCount();
  $('#filter-count').hidden = !count;
  $('#filter-count').textContent = count;
  $('#btn-filter').classList.toggle('active', !!count);
  $('#nav-filter-count').hidden = !count;
  $('#nav-filter-count').textContent = count;
  const chips = [['city', 'City', state.cityFilter], ['tag', 'Tag', state.tagFilter], ['stage', 'Stage', state.stageFilter],
    ['priority', 'Priority', state.priorityFilter ? 'High' : ''], ['owner', 'Rep', state.ownerFilter]]
    .filter(([, , value]) => value)
    .map(([key, label, value]) => `<button type="button" class="filter-chip" data-clear="${key}" title="Remove this filter">${label}: <b>${esc(value)}</b> ×</button>`);
  if (matched) chips.push(`<span class="muted">${plural(matched.size, 'match', 'matches')}</span>`);
  $('#active-filters').innerHTML = chips.join('');
}

function fillSelect(select, entries, allLabel, current) {
  select.innerHTML = [`<option value="">${allLabel}</option>`]
    .concat(entries.map(({ value, label }) =>
      `<option value="${esc(value)}" ${value.toLowerCase() === current.toLowerCase() ? 'selected' : ''}>${esc(label)}</option>`))
    .join('');
}

function countedEntries(counts) {
  return [...counts.values()]
    .sort((a, b) => a.value.localeCompare(b.value))
    .map(({ value, n }) => ({ value, label: `${value} (${n})` }));
}

function refreshFilterOptions() {
  const owners = new Map();
  const tags = new Map();
  const cities = new Map();
  const stages = new Map();
  const bump = (map, value) => {
    const key = value.toLowerCase();
    if (!map.has(key)) map.set(key, { value, n: 0 });
    map.get(key).n += 1;
  };
  for (const r of activeReps()) owners.set(r.name.toLowerCase(), { value: r.name, n: 0 });
  for (const n of state.nodes.values()) {
    if (n.owner_rep.trim()) bump(owners, n.owner_rep.trim());
    if (n.type === 'company') for (const t of String(n.tags || '').split(',').map((x) => x.trim()).filter(Boolean)) bump(tags, t);
    if (cityOf(n)) bump(cities, cityOf(n));
    if (n.type === 'person' && n.stage.trim()) bump(stages, n.stage.trim());
  }
  fillSelect($('#filter-city'), countedEntries(cities), 'All cities', state.cityFilter);
  fillSelect($('#filter-tag'), countedEntries(tags), 'All tags', state.tagFilter);
  fillSelect($('#filter-owner'), countedEntries(owners), 'All reps', state.ownerFilter);
  fillSelect($('#filter-stage'), countedEntries(stages), 'All stages', state.stageFilter);
  $('#stage-list').innerHTML = [...stages.values()].map((t) => `<option value="${esc(t.value)}">`).join('');
  $('#owner-list').innerHTML = [...owners.values()].map((o) => `<option value="${esc(o.value)}">`).join('');
  $('#tag-list').innerHTML = [...tags.values()].map((t) => `<option value="${esc(t.value)}">`).join('');
}

function setFilter(key, value) {
  state[`${key}Filter`] = value;
  const matched = applyFilters();
  const els = matched && matched.size
    ? cy.nodes().filter((el) => matched.has(el.data('nid')))
    : cy.elements();
  if (els.length) moveMap({ fit: { eles: els, padding: 70 } }, 350);
}

const filterMenu = $('#filter-menu');
function toggleFilterMenu(open) {
  filterMenu.hidden = !open;
  $('#btn-filter').setAttribute('aria-expanded', String(open));
  syncNav();
}
$('#btn-filter').addEventListener('click', () => toggleFilterMenu(filterMenu.hidden));
$('#btn-filter-done').addEventListener('click', () => toggleFilterMenu(false));
document.addEventListener('click', (evt) => {
  // Use the event path: a tapped chip may already be redrawn (detached) by now.
  const inside = evt.composedPath().some((el) => el.classList?.contains('filter-wrap') || el.classList?.contains('sheet') || el.id === 'bottom-nav');
  if (!filterMenu.hidden && !inside) toggleFilterMenu(false);
});
$('#filter-city').addEventListener('change', (evt) => setFilter('city', evt.target.value));
$('#filter-tag').addEventListener('change', (evt) => setFilter('tag', evt.target.value));
$('#filter-owner').addEventListener('change', (evt) => setFilter('owner', evt.target.value));
$('#filter-stage').addEventListener('change', (evt) => setFilter('stage', evt.target.value));
$('#filter-priority').addEventListener('change', (evt) => setFilter('priority', evt.target.value));
$('#btn-clear-filters').addEventListener('click', () => {
  state.cityFilter = '';
  state.tagFilter = '';
  state.ownerFilter = '';
  state.stageFilter = '';
  state.priorityFilter = '';
  $('#filter-priority').value = '';
  refreshFilterOptions();
  setFilter('city', '');
});
$('#active-filters').addEventListener('click', (evt) => {
  const chip = evt.target.closest('[data-clear]');
  if (!chip) return;
  $(`#filter-${chip.dataset.clear}`).value = '';
  setFilter(chip.dataset.clear, '');
});

function updateStats() {
  let companies = 0;
  let people = 0;
  for (const n of state.nodes.values()) {
    if (!inView(n.id)) continue;
    if (n.type === 'company') companies += 1; else people += 1;
  }
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  $('#stats').textContent = [
    count(companies, 'company', 'companies'),
    count(people, 'person', 'people'),
    count([...state.edges.values()].filter((e) => inView(e.source_id) && inView(e.target_id)).length, 'connection', 'connections'),
  ].join(' · ');
}

// ---------- search ----------

function searchMatches() {
  const q = $('#search').value.trim().toLowerCase();
  if (!q) return [];
  return [...state.nodes.values()].filter((n) => inView(n.id)).filter((n) =>
    [n.name, n.title, n.email, n.type === 'company' ? n.tags : '', n.location, n.owner_rep, n.notes].some((v) => String(v || '').toLowerCase().includes(q))
    || (state.noteText.get(n.id) || '').includes(q));
}

function applySearch() {
  const matches = searchMatches();
  cy.nodes().removeClass('match');
  for (const n of matches) cy.getElementById(`n${n.id}`).addClass('match');
  const q = $('#search').value.trim();
  $('#search-count').textContent = q ? `${matches.length} found` : '';
}

$('#search').addEventListener('input', applySearch);
$('#search').addEventListener('keydown', (evt) => {
  if (evt.key === 'Enter') {
    const [first] = searchMatches().sort(byName);
    if (first) { goToNode(first.id); openNodePanel(first.id); }
  } else if (evt.key === 'Escape') {
    evt.target.value = '';
    applySearch();
  }
});

function goToNode(id) {
  const el = cy.getElementById(`n${id}`);
  if (el.empty()) return;
  cy.elements().unselect();
  el.select();
  moveMap({ center: { eles: el }, zoom: Math.max(cy.zoom(), 1) }, 350);
}

// On phones the map sits behind full-screen lists and cards. Move it instantly there
// instead of animating unseen, so it doesn't drift or jump when you come back to it.
function moveMap(opts, duration) {
  cy.stop(true, true);
  if (isPhone() && state.panel) {
    if (opts.fit) cy.fit(opts.fit.eles, opts.fit.padding);
    if (opts.zoom) cy.zoom(opts.zoom);
    if (opts.center) cy.center(opts.center.eles);
    return;
  }
  cy.animate(opts, { duration });
}

// ---------- focus ----------

function applyFocus() {
  cy.elements().removeClass('faded focus-root');
  const chip = $('#focus-chip');
  if (state.focusId == null) { chip.hidden = true; return; }
  const root = cy.getElementById(`n${state.focusId}`);
  if (root.empty()) { state.focusId = null; chip.hidden = true; return; }
  const keep = root.closedNeighborhood().closedNeighborhood();
  cy.elements().not(keep).addClass('faded');
  root.addClass('focus-root');
  $('#focus-text').textContent = `Showing everyone within 2 steps of ${state.nodes.get(state.focusId).name}`;
  chip.hidden = false;
}

function focusOn(id) {
  state.focusId = id;
  applyFocus();
  const keep = cy.getElementById(`n${id}`).closedNeighborhood().closedNeighborhood();
  moveMap({ fit: { eles: keep, padding: 80 } }, 400);
}

function clearFocus() {
  state.focusId = null;
  applyFocus();
}

$('#btn-clear-focus').addEventListener('click', clearFocus);

// ---------- connect mode ----------

function startConnect(fromId) {
  closeActivity();
  closePanel();
  state.connecting = true;
  state.connectFrom = fromId ?? null;
  updateConnectUi();
}

function stopConnect() {
  state.connecting = false;
  state.connectFrom = null;
  updateConnectUi();
}

function updateConnectUi() {
  cy.nodes().removeClass('connect-from');
  $('#btn-connect').classList.toggle('active', state.connecting);
  $('.stage').classList.toggle('connecting', state.connecting);
  $('#mode-banner').hidden = !state.connecting;
  if (!state.connecting) return;
  if (state.connectFrom == null) {
    $('#mode-text').textContent = 'Click the first person or company';
  } else {
    cy.getElementById(`n${state.connectFrom}`).addClass('connect-from');
    $('#mode-text').textContent = `Now click who ${state.nodes.get(state.connectFrom)?.name || 'they'} is connected to`;
  }
}

$('#btn-connect').addEventListener('click', () => (state.connecting ? stopConnect() : startConnect()));
$('#btn-cancel-connect').addEventListener('click', stopConnect);

// ---------- graph events ----------

cy.on('tap', 'node', (evt) => {
  const id = evt.target.data('nid');
  if (state.connecting) {
    if (state.connectFrom == null) {
      state.connectFrom = id;
      updateConnectUi();
    } else if (id !== state.connectFrom) {
      const from = state.connectFrom;
      state.connectedAt = Date.now();
      stopConnect();
      openNewEdgePanel(from, id);
    }
    return;
  }
  openNodePanel(id);
});

cy.on('tap', 'edge', (evt) => {
  if (state.connecting) return;
  const el = evt.target;
  if (el.data('rel') === WORKS_AT) {
    openNodePanel(el.source().data('nid'));
  } else {
    openEdgePanel(el.data('eid'));
  }
});

cy.on('tap', (evt) => {
  if (evt.target !== cy || state.connecting) return;
  closePanel();
  clearFocus();
});

// The two quick taps that finish a connection can register as a double-tap; ignore those.
cy.on('dbltap', 'node', (evt) => {
  if (isPhone() || state.connecting || Date.now() - state.connectedAt < 500) return;
  focusOn(evt.target.data('nid'));
});
cy.on('mouseover', 'edge', (evt) => evt.target.addClass('hover'));
cy.on('mouseout', 'edge', (evt) => evt.target.removeClass('hover'));

// ---------- panels ----------

const panel = $('#panel');

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function avatar(n, size) {
  const shape = n.type === 'company' ? 'avatar-company' : '';
  return `<span class="avatar ${shape} ${size || ''}" style="--hue:${nodeColor(n)}" aria-hidden="true">${esc(initials(n.name))}</span>`;
}

function peopleAt(companyId) {
  return [...state.nodes.values()].filter((p) => p.type === 'person' && p.company_id === companyId).sort(byName);
}

function companyOf(n) {
  return n.type === 'person' && n.company_id != null ? state.nodes.get(n.company_id) || null : null;
}

function notesFor(nodeId) {
  return state.notes.get(nodeId) || [];
}

function closePanel() {
  panel.hidden = true;
  panel.innerHTML = '';
  state.panel = null;
  state.panelDirty = false;
  state.picker = null;
  cy.elements().unselect();
  syncNav();
}

function showPanel(desc, html) {
  closeActivity();
  state.panel = desc;
  state.panelDirty = false;
  panel.innerHTML = html;
  panel.hidden = false;
  panel.scrollTop = 0;
  syncNav();
}

function panelHead(pill, pillClass, title) {
  return `<div class="panel-head">
    ${pill ? `<span class="pill ${pillClass}">${pill}</span>` : ''}
    <h2>${esc(title)}</h2>
    <button class="icon-btn" data-act="close" aria-label="Close">×</button>
  </div>`;
}

function metaLine(item) {
  if (!item.updated_at) return '';
  return `<div class="meta-line">Last edited ${esc(timeAgo(item.updated_at))}${item.updated_by ? ` by ${esc(item.updated_by)}` : ''}${item.wingmate_id ? ' · Synced from Wingmate' : ''}</div>`;
}

function relOptions(selected) {
  return Object.entries(REL).map(([key, r]) =>
    `<option value="${key}" ${key === selected ? 'selected' : ''}>${esc(r.label)}</option>`).join('');
}

function strengthSeg(selected) {
  return [1, 2, 3].map((s) =>
    `<label><input type="radio" name="strength" value="${s}" ${s === selected ? 'checked' : ''}>${STRENGTH[s]}</label>`).join('');
}

function connectionRows(nodeId) {
  const rows = [];
  for (const e of state.edges.values()) {
    if (e.source_id !== nodeId && e.target_id !== nodeId) continue;
    const outgoing = e.source_id === nodeId;
    const other = state.nodes.get(outgoing ? e.target_id : e.source_id);
    if (!other) continue;
    const rel = REL[e.rel_type] || REL.other;
    const phrase = rel.directed && !outgoing ? rel.back : rel.verb;
    rows.push({ other, phrase, strength: e.strength, edgeId: e.id, color: rel.color });
  }
  return rows.sort((a, b) => b.strength - a.strength || byName(a.other, b.other));
}

// ----- player cards -----

function heroHtml(n, subtitle, extra) {
  return `<div class="hero" style="--hue:${nodeColor(n)}">
    ${avatar(n, 'avatar-lg')}
    <div class="hero-text">
      <span class="pill ${n.type === 'company' ? 'pill-company' : ''}">${n.type === 'company' ? 'Company' : 'Person'}</span>
      <h2>${esc(n.name)}</h2>
      ${subtitle ? `<div class="hero-sub">${esc(subtitle)}</div>` : ''}
      ${extra || ''}
      ${n.type === 'company' ? tagEditorHtml(n) : ''}
    </div>
    <button class="icon-btn" data-act="close" aria-label="Close">×</button>
  </div>`;
}

// Mirrors the server: reps change only leads assigned to them, connections
// they added and notes they wrote; admins can change anything.
function canEditNode(n) {
  return state.isAdmin || (!!myName() && n.owner_rep === myName());
}

function canEditEdge(e) {
  return state.isAdmin || (!!myName() && e.created_by === myName());
}

function canDeleteNote(note) {
  return state.isAdmin || (!!myName() && note.author === myName());
}

function actionsHtml(n) {
  const btns = [];
  if (n.type === 'company') btns.push('<button class="btn btn-sm btn-primary" data-act="add-person-here">+ Add person</button>');
  if (n.email) btns.push(`<a class="btn btn-sm" href="mailto:${esc(n.email)}">Email</a>`);
  if (n.phone) btns.push(`<a class="btn btn-sm" href="tel:${esc(n.phone.replace(/[^\d+]/g, ''))}">Call</a>`);
  btns.push('<button class="btn btn-sm" data-act="show-map">Show on map</button>');
  if (n.type === 'person') {
    btns.push(`<button class="btn btn-sm ${n.priority ? 'btn-priority' : ''}" data-act="priority" aria-pressed="${!!n.priority}" title="Anyone can flag a contact as high priority">${n.priority ? '★ High priority' : '☆ Mark high priority'}</button>`);
  }
  btns.push(`<button class="btn btn-sm" data-act="color" title="Change this card's color (everyone sees it)"><span class="swatch-dot" style="background:${nodeColor(n)}"></span>Color</button>`);
  if (canEditNode(n)) btns.push('<button class="btn btn-sm" data-act="edit">Edit</button>');
  if (canEditNode(n) && n.type === 'person') btns.push('<button class="btn btn-sm" data-act="merge" title="Fold a duplicate of this contact into it">Merge…</button>');
  const viewOnly = canEditNode(n) ? ''
    : `<div class="view-only">View only · ${n.owner_rep ? `assigned to ${esc(n.owner_rep)}` : 'unassigned'}. You can still add tags, notes, connections, change its color${n.type === 'person' ? ' or flag it high priority' : ''}.</div>`;
  const picker = state.colorPickerFor === n.id ? `<div class="color-picker" role="group" aria-label="Card color">
      ${CARD_COLORS.map((c) => `<button type="button" class="color-swatch ${n.color === c ? 'on' : ''}" data-color="${c}" style="background:${c}" aria-label="Color ${c}"></button>`).join('')}
      <button type="button" class="btn btn-sm btn-ghost" data-color="">${n.type === 'person' ? 'Use company color' : 'Default'}</button>
    </div>` : '';
  return `<div class="card-actions">${btns.join('')}</div>${picker}${viewOnly}`;
}

// Anyone can add or remove a company's tags (not just its owner); new tags
// join the shared list that the "+ Add tag" box suggests.
function tagEditorHtml(n) {
  const tags = String(n.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  return `<div class="tags tag-editor">
    ${tags.map((t) => `<span class="tag">${esc(t)}<button type="button" class="tag-x" data-untag="${esc(t)}" title="Remove tag" aria-label="Remove tag ${esc(t)}">×</button></span>`).join('')}
    <form class="tag-add" data-form="add-tag"><input name="tag" maxlength="40" autocomplete="off" placeholder="+ Add tag" aria-label="Add a tag" aria-autocomplete="list"></form>
    <div class="tag-suggest" role="listbox" aria-label="Tags" hidden></div>
  </div>`;
}

// Clickable tag suggestions: existing tags (most used first) plus "Create" for a new one.
function tagSuggestions(company, query) {
  const have = new Set(splitTags(company.tags));
  const used = new Map();
  for (const n of state.nodes.values()) {
    if (n.type !== 'company') continue;
    for (const t of String(n.tags || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      const entry = used.get(t.toLowerCase()) || { tag: t, n: 0 };
      entry.n += 1;
      used.set(t.toLowerCase(), entry);
    }
  }
  const q = query.trim().toLowerCase();
  const items = [...used.values()]
    .filter((x) => !have.has(x.tag.toLowerCase()) && (!q || x.tag.toLowerCase().includes(q)))
    .sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag))
    .slice(0, 10);
  const create = q && !used.has(q) && !have.has(q) ? query.trim() : '';
  return { items, create };
}

function showTagSuggestions(input) {
  const box = input.closest('.tag-editor')?.querySelector('.tag-suggest');
  const company = state.panel?.kind === 'node' ? state.nodes.get(state.panel.id) : null;
  if (!box || !company) return;
  const { items, create } = tagSuggestions(company, input.value);
  box.innerHTML = items.map((x) => `<button type="button" role="option" class="tag-option" data-addtag="${esc(x.tag)}">${esc(x.tag)}<small>${x.n}</small></button>`).join('')
    + (create ? `<button type="button" role="option" class="tag-option create" data-addtag="${esc(create)}">+ Create “${esc(create)}”</button>` : '')
    + (!items.length && !create ? '<span class="muted">Type to create a new tag</span>' : '');
  box.hidden = false;
}

function hideTagSuggestions() {
  panel.querySelectorAll('.tag-suggest').forEach((box) => { box.hidden = true; });
}

async function addTag(tag) {
  const p = state.panel;
  if (!tag.trim() || p?.kind !== 'node') return;
  try {
    await api('POST', `/api/nodes/${p.id}/tags`, { add: tag });
    state.panelDirty = false;
    await sync();
    rerenderCard();
    const input = panel.querySelector('.tag-add input');
    if (input) { input.focus(); showTagSuggestions(input); }  // ready for the next one
  } catch (err) { toast(err.message, true); }
}

panel.addEventListener('focusin', (evt) => {
  if (evt.target.matches('.tag-add input')) showTagSuggestions(evt.target);
});
panel.addEventListener('focusout', (evt) => {
  if (!evt.target.matches('.tag-add input')) return;
  setTimeout(() => {
    if (!panel.contains(document.activeElement) || !document.activeElement.closest('.tag-editor')) hideTagSuggestions();
  }, 150);
});
// Keep focus in the box while a suggestion is pressed, so the click lands.
panel.addEventListener('pointerdown', (evt) => {
  if (evt.target.closest('[data-addtag]')) evt.preventDefault();
});

function tagChipsHtml(n) {
  if (n.type !== 'company') return '';
  const tags = String(n.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  return tags.length ? `<div class="tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : '';
}

function factsHtml(n, skip = []) {
  const facts = [['Email', n.email], ['Phone', n.phone], ['Location', n.location], ['Owner rep', n.owner_rep]]
    .filter(([label, value]) => value && !skip.includes(label));
  return facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '';
}

function aboutHtml(n) {
  return n.notes ? `<div class="section"><h3>About</h3><p class="about">${esc(n.notes)}</p></div>` : '';
}

function stageBadge(n) {
  if (!n || n.type !== 'person') return '';
  return (n.priority ? ' <span class="priority-star" title="High priority">★</span>' : '')
    + (n.stage ? ` <span class="stage-chip" title="Pipeline stage">${esc(n.stage)}</span>` : '');
}

function connListHtml(rows, empty) {
  if (!rows.length) return `<p class="muted">${empty}</p>`;
  return `<ul class="conn-list">${rows.map((r) => `<li data-goto="${r.other.id}">
      ${avatar(r.other, 'avatar-sm')}
      <span class="who"><b>${esc(r.other.name)}</b>${stageBadge(r.other)}
        <span><i class="rel-dot" style="background:${r.color}"></i>${esc(capitalize(r.phrase))}${r.other.title ? ` · ${esc(r.other.title)}` : ''}</span></span>
      <span class="strength" title="${STRENGTH[r.strength]}">${'●'.repeat(r.strength)}${'○'.repeat(3 - r.strength)}</span>
      ${canEditEdge(state.edges.get(r.edgeId)) ? `<button class="icon-btn icon-sm" data-edge="${r.edgeId}" title="Edit connection" aria-label="Edit connection">✎</button>` : ''}
    </li>`).join('')}</ul>`;
}

// Inline "connect to…" form: coworkers are listed first.
function pickerHtml(n) {
  const p = state.picker;
  if (!p || p.nodeId !== n.id) return '<button class="btn btn-sm add-conn" data-act="open-picker">+ Add connection</button>';
  const company = companyOf(n);
  const others = [...state.nodes.values()].filter((o) => o.id !== n.id).sort(byName);
  const groups = [];
  if (company) groups.push([`At ${company.name}`, others.filter((o) => o.type === 'person' && o.company_id === company.id)]);
  if (n.type === 'company') groups.push([`People at ${n.name}`, others.filter((o) => o.company_id === n.id)]);
  const listed = new Set(groups.flatMap(([, list]) => list.map((o) => o.id)));
  groups.push(['People', others.filter((o) => o.type === 'person' && !listed.has(o.id))]);
  groups.push(['Companies', others.filter((o) => o.type === 'company')]);
  const optionLabel = (o) => {
    const c = companyOf(o);
    return esc(o.name) + (c && c !== company ? ` (${esc(c.name)})` : '');
  };
  const options = groups.filter(([, list]) => list.length).map(([label, list]) =>
    `<optgroup label="${esc(label)}">${list.map((o) =>
      `<option value="${o.id}" ${o.id === p.otherId ? 'selected' : ''}>${optionLabel(o)}</option>`).join('')}</optgroup>`).join('');
  return `<form class="picker" data-form="quick-edge">
    <div class="picker-line"><b>${esc(n.name)}</b><select name="rel_type" aria-label="Relationship">${relOptions('knows')}</select></div>
    <select name="target_id" aria-label="Connect to"><option value="">Choose who…</option>${options}</select>
    <div class="seg" role="radiogroup" aria-label="Strength">${strengthSeg(2)}</div>
    <input name="notes" maxlength="5000" placeholder="How do they know each other? (optional)">
    <div class="form-actions">
      <button type="submit" class="btn btn-sm btn-primary">Connect</button>
      <button type="button" class="btn btn-sm btn-ghost" data-act="close-picker">Cancel</button>
    </div>
  </form>`;
}

function notesSectionHtml(n) {
  const notes = notesFor(n.id);
  return `<div class="section">
    <h3>Notes <span>${notes.length}</span></h3>
    <form class="note-form" data-form="note">
      <textarea name="body" rows="2" maxlength="5000" placeholder="Add a note about ${esc(n.name)}…"></textarea>
      <button type="submit" class="btn btn-sm btn-primary">Add note</button>
    </form>
    ${notes.length ? `<ul class="notes">${notes.map((note) => `<li>
        <p>${esc(note.body)}</p>
        <div class="note-meta">${esc(note.author || 'Someone')} · ${esc(timeAgo(note.created_at))}${String(note.external_id || '').startsWith('wingmate') ? ' · from Wingmate' : ''}
          ${canDeleteNote(note) ? `<button type="button" class="link-btn" data-del-note="${note.id}">Delete</button>` : ''}</div>
      </li>`).join('')}</ul>` : ''}
  </div>`;
}

function personCardHtml(n) {
  const company = companyOf(n);
  const rows = connectionRows(n.id);
  const inside = company ? rows.filter((r) => r.other.company_id === company.id && r.other.type === 'person') : [];
  const outside = rows.filter((r) => !inside.includes(r));
  const linked = new Set(rows.map((r) => r.other.id));
  const unlinked = company ? peopleAt(company.id).filter((p) => p.id !== n.id && !linked.has(p.id)) : [];
  const stage = n.stage
    ? `<div class="stage-line">Stage: <span class="stage-chip big">${esc(n.stage)}</span>${n.owner_rep ? ` <span class="muted">· ${esc(n.owner_rep)}'s contact</span>` : ''}</div>`
    : '';
  return heroHtml(n, n.title, (company
    ? `<button class="hero-link" data-goto="${company.id}">${esc(company.name)} →</button>`
    : '<div class="hero-sub muted">No company</div>') + stage)
    + actionsHtml(n)
    + factsHtml(n)
    + aboutHtml(n)
    + `<div class="section">
        <h3>Connections <span>${rows.length}</span></h3>
        ${pickerHtml(n)}
        ${company ? `<div class="group-label">Inside ${esc(company.name)}</div>${connListHtml(inside, 'No connections inside the company yet.')}` : ''}
        ${unlinked.length ? `<div class="suggest"><span class="muted">Also at ${esc(company.name)}:</span>
          ${unlinked.map((p) => `<button type="button" class="chip-btn" data-link="${p.id}" title="Connect ${esc(n.name)} and ${esc(p.name)}">+ ${esc(p.name)}</button>`).join('')}</div>` : ''}
        <div class="group-label">${company ? `Outside ${esc(company.name)}` : 'Connected to'}</div>
        ${connListHtml(outside, 'None yet.')}
      </div>`
    + notesSectionHtml(n)
    + metaLine(n);
}

function rosterRowHtml(p, staffIds) {
  const rows = connectionRows(p.id);
  const internal = rows.filter((r) => staffIds.has(r.other.id));
  const external = rows.length - internal.length;
  const links = internal.slice(0, 2).map((r) => `${capitalize(r.phrase)} ${r.other.name}`);
  if (internal.length > 2) links.push(`+${internal.length - 2} more`);
  const detail = [p.title, ...links, external ? plural(external, 'outside link', 'outside links') : '']
    .filter(Boolean).join(' · ');
  const noteCount = notesFor(p.id).length;
  return `<li data-goto="${p.id}">
    ${avatar(p, 'avatar-sm')}
    <span class="who"><b>${esc(p.name)}</b>${stageBadge(p)}${detail ? `<span>${esc(detail)}</span>` : ''}</span>
    ${noteCount ? `<span class="badge" title="${plural(noteCount, 'note', 'notes')}">${noteCount} ✎</span>` : ''}
  </li>`;
}

function companyCardHtml(n) {
  const staff = peopleAt(n.id);
  const staffIds = new Set(staff.map((p) => p.id));
  let inside = 0;
  for (const e of state.edges.values()) {
    if (staffIds.has(e.source_id) && staffIds.has(e.target_id)) inside += 1;
  }
  const counts = `<div class="hero-sub">${plural(staff.length, 'person', 'people')} · ${plural(inside, 'connection', 'connections')} inside</div>`;
  const direct = connectionRows(n.id);
  return heroHtml(n, n.location, counts)
    + actionsHtml(n)
    + factsHtml(n, ['Location'])
    + aboutHtml(n)
    + `<div class="section">
        <h3>People at ${esc(n.name)} <span>${staff.length}</span></h3>
        ${staff.length
          ? `<ul class="conn-list roster">${staff.map((p) => rosterRowHtml(p, staffIds)).join('')}</ul>`
          : '<p class="muted">No one added yet. Use “+ Add person”.</p>'}
      </div>
      <div class="section">
        <h3>Company connections <span>${direct.length}</span></h3>
        ${pickerHtml(n)}
        ${connListHtml(direct, 'Partners, vendors or competitors of this company.')}
      </div>`
    + notesSectionHtml(n)
    + metaLine(n);
}

function openNodePanel(id, opts = {}) {
  const n = state.nodes.get(id);
  if (!n) return;
  if (state.picker && state.picker.nodeId !== id) state.picker = null;
  if (state.colorPickerFor !== id) state.colorPickerFor = null;
  cy.elements().unselect();
  cy.getElementById(`n${id}`).select();
  const back = opts.fromDir ? '<button class="back-link" data-act="directory">← Contacts</button>' : '';
  showPanel({ kind: 'node', id, fromDir: !!opts.fromDir },
    back + (n.type === 'company' ? companyCardHtml(n) : personCardHtml(n)));
}

function rerenderCard() {
  const p = state.panel;
  if (!p || p.kind !== 'node') return;
  const scroll = panel.scrollTop;
  openNodePanel(p.id, { fromDir: p.fromDir });
  panel.scrollTop = scroll;
}

// ----- duplicates -----
// Mirrors the server's matching so people see a warning while they type.

const COMPANY_SUFFIXES = new Set(['inc', 'llc', 'co', 'corp', 'corporation', 'company', 'ltd', 'limited',
  'lp', 'llp', 'pllc', 'pc', 'the']);

function normName(name, isCompany) {
  const words = String(name || '').toLowerCase().replace(/['\u2019]/g, '').replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const trimmed = isCompany ? words.filter((w) => !COMPANY_SUFFIXES.has(w)) : words;
  return (trimmed.length ? trimmed : words).join(' ');
}

function localDuplicates(type, name, companyId, email, excludeId) {
  const target = normName(name, type === 'company');
  const mail = String(email || '').trim().toLowerCase();
  return [...state.nodes.values()].filter((n) => {
    if (n.type !== type || n.id === excludeId) return false;
    const sameName = normName(n.name, type === 'company') === target;
    if (type === 'company') return sameName;
    return (sameName && n.company_id === companyId) || (mail && n.email.trim().toLowerCase() === mail);
  });
}

function similarCompanies(name, excludeId, exclude) {
  const target = normName(name, true);
  if (target.length < 3) return [];
  return [...state.nodes.values()].filter((n) => {
    if (n.type !== 'company' || n.id === excludeId || exclude.has(n.id)) return false;
    const other = normName(n.name, true);
    return other !== target && (other.includes(target) || target.includes(other));
  }).slice(0, 3);
}

function dupItemHtml(n) {
  const detail = n.type === 'person' ? (companyOf(n)?.name || n.company || '') : n.location;
  return `<button type="button" class="dup-item" data-goto="${n.id}" title="Open ${esc(n.name)}">${esc(n.name)}${detail ? ` <small>${esc(detail)}</small>` : ''}</button>`;
}

function updateDupHint(form) {
  const p = state.panel;
  const box = form.querySelector('[data-dup-hint]');
  if (!box || !p || (p.kind !== 'new-node' && p.kind !== 'node-edit')) return;
  const type = p.kind === 'new-node' ? p.type : state.nodes.get(p.id)?.type;
  const excludeId = p.kind === 'node-edit' ? p.id : null;
  const name = form.elements.name.value;
  const companyId = form.elements.company_id ? Number(form.elements.company_id.value) || null : null;
  const email = form.elements.email ? form.elements.email.value : '';
  const dups = name.trim() || email.trim() ? localDuplicates(type, name, companyId, email, excludeId) : [];
  const similar = type === 'company' ? similarCompanies(name, excludeId, new Set(dups.map((d) => d.id))) : [];
  box.hidden = !dups.length && !similar.length;
  box.classList.toggle('strong', dups.length > 0);
  box.innerHTML = (dups.length ? `<span><b>Already on the map:</b></span>${dups.map(dupItemHtml).join('')}` : '')
    + (similar.length ? `<span class="muted">Similar:</span>${similar.map(dupItemHtml).join('')}` : '');
}

function showDuplicateWarning(form, err, isNew) {
  form.querySelector('.dup-warning')?.remove();
  const box = document.createElement('div');
  box.className = 'dup-warning';
  box.setAttribute('role', 'alert');
  box.innerHTML = `<p><b>${esc(err.message)}</b> Open the existing one, or keep yours if it's really different (another location, say).</p>
    <div class="dup-list">${err.duplicates.map((d) => dupItemHtml({ ...d, type: state.nodes.get(d.id)?.type || '' })).join('')}</div>
    <button type="button" class="btn btn-sm" data-act="force-save">${isNew ? 'Add anyway' : 'Save anyway'}</button>`;
  form.querySelector('.form-actions').before(box);
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ----- edit forms -----

function nodeFormHtml(n, isNew) {
  const companies = [...state.nodes.values()].filter((c) => c.type === 'company').sort(byName);
  const field = (name, label, attrs = '') =>
    `<label>${label}<input name="${name}" value="${esc(n[name])}" ${attrs}></label>`;
  const person = n.type === 'person';
  return `<form class="form" data-form="node">
    ${field('name', 'Name', `required maxlength="300" autocomplete="off" placeholder="${person ? 'Jane Smith' : 'Acme Corp'}"`)}
    <div class="dup-hint" data-dup-hint role="status" hidden></div>
    ${person ? field('title', 'Title / role', 'maxlength="300" placeholder="VP of Operations"') : ''}
    ${person ? field('stage', `Pipeline stage${n.wingmate_id ? ' <small>synced from Wingmate; a change there updates it</small>' : ''}`, 'list="stage-list" maxlength="60" autocomplete="off" placeholder="e.g. Meeting Set"') : ''}
    ${person ? `<label>Company<select name="company_id">
        <option value="">None</option>
        ${companies.map((c) => `<option value="${c.id}" ${c.id === n.company_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select></label>` : ''}
    ${person ? `<div class="row">${field('email', 'Email', 'type="email" maxlength="300"')}${field('phone', 'Phone', 'type="tel" maxlength="300"')}</div>` : ''}
    ${field('location', 'Location', 'maxlength="300" placeholder="City, State"')}
    ${ownerFieldHtml(n.owner_rep, isNew)}
    ${!person && isNew ? field('tags', 'Tags <small>comma separated; add more later on the card</small>', 'maxlength="300" placeholder="target, gym"') : ''}
    <label>About <small>a short summary; use Notes on the card for running updates</small>
      <textarea name="notes" rows="3" maxlength="5000" placeholder="${person ? 'Background, what they care about…' : 'What they do, size, how we sell to them…'}">${esc(n.notes)}</textarea></label>
    <div class="form-actions">
      <span class="row-btns">
        <button type="submit" class="btn btn-primary">${isNew ? 'Add to map' : 'Save'}</button>
        ${isNew ? '' : '<button type="button" class="btn btn-ghost" data-act="cancel-edit">Cancel</button>'}
      </span>
      ${isNew ? '' : '<button type="button" class="btn btn-danger-ghost" data-act="delete-node">Delete</button>'}
    </div>
  </form>`;
}

// Reps can't reassign leads: new ones go to whoever is "You", and only an admin
// can change the owner afterwards (the server enforces this too).
function ownerFieldHtml(current, isNew) {
  if (!state.isAdmin) {
    const owner = isNew
      ? (myName() ? `${esc(myName())} (you)` : 'You (pick your name at the top)')
      : (current ? esc(current) : 'Unassigned');
    return `<div class="field"><span>Owner rep</span>
      <div class="readonly">${owner}<small>${isNew ? 'New leads are assigned to you' : 'Only an admin can reassign'}</small></div></div>`;
  }
  const reps = activeReps().map((r) => r.name);
  if (!reps.length) {
    return `<label>Owner rep<input name="owner_rep" value="${esc(current)}" list="owner-list" maxlength="300" placeholder="Who owns this relationship?"></label>`;
  }
  const names = current && !reps.includes(current) ? [...reps, current] : reps;
  return `<label>Owner rep<select name="owner_rep">
    <option value="">Unassigned</option>
    ${names.map((name) => `<option value="${esc(name)}" ${name === current ? 'selected' : ''}>${esc(name)}${reps.includes(name) ? '' : ' (not on rep list)'}</option>`).join('')}
  </select></label>`;
}

function openEditPanel(id) {
  const n = state.nodes.get(id);
  if (!n || !canEditNode(n)) return;
  showPanel({ kind: 'node-edit', id },
    panelHead(n.type === 'company' ? 'Company' : 'Person', `pill-${n.type}`, `Edit ${n.name}`)
    + nodeFormHtml(n, false) + metaLine(n));
  panel.querySelector('input[name="name"]').focus();
}

function openNewNodePanel(type, companyId) {
  stopConnect();
  const blank = { type, name: '', title: '', company_id: companyId ?? null, email: '', phone: '',
    location: '', tags: '', owner_rep: activeReps().some((r) => r.name === myName()) ? myName() : '', notes: '' };
  const company = companyId != null ? state.nodes.get(companyId) : null;
  showPanel({ kind: 'new-node', type },
    panelHead(type === 'company' ? 'Company' : 'Person', `pill-${type}`,
      type === 'company' ? 'New company' : company ? `New person at ${company.name}` : 'New person')
    + nodeFormHtml(blank, true));
  panel.querySelector('input[name="name"]').focus();
}

function edgeFormHtml(e, isNew) {
  return `<form class="form" data-form="edge">
    <label>Relationship<select name="rel_type">${relOptions(e.rel_type)}</select></label>
    <div class="field"><span>Strength</span><div class="seg" role="radiogroup">${strengthSeg(e.strength)}</div></div>
    <label>Notes<textarea name="notes" rows="4" maxlength="5000" placeholder="How do they know each other? Any context for the team?">${esc(e.notes)}</textarea></label>
    <div class="form-actions">
      <button type="submit" class="btn btn-primary">${isNew ? 'Add connection' : 'Save changes'}</button>
      ${isNew ? '' : '<button type="button" class="btn btn-danger-ghost" data-act="delete-edge">Delete</button>'}
    </div>
  </form>`;
}

function edgeEndsHtml(sourceId, targetId, relType, canSwap) {
  const a = state.nodes.get(sourceId);
  const b = state.nodes.get(targetId);
  const directed = (REL[relType] || REL.other).directed;
  return `<div class="edge-ends">
    <button type="button" data-goto="${a.id}">${esc(a.name)}</button>
    <span class="arrow">${directed ? '→' : '—'}</span>
    <button type="button" data-goto="${b.id}">${esc(b.name)}</button>
    ${canSwap && directed ? '<button type="button" class="btn btn-sm" data-act="swap" title="Reverse direction" style="margin-left:auto">⇄</button>' : ''}
  </div>`;
}

function edgeReadOnlyHtml(e) {
  const facts = [['Relationship', (REL[e.rel_type] || REL.other).label], ['Strength', STRENGTH[e.strength]],
    ['Added by', e.created_by || 'Unknown']];
  return `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    ${e.notes ? `<div class="section"><h3>Notes</h3><p class="about">${esc(e.notes)}</p></div>` : ''}
    <div class="view-only">View only. Only ${esc(e.created_by || 'the person who added it')} or an admin can change this connection.</div>`;
}

function openEdgePanel(id) {
  const e = state.edges.get(id);
  if (!e) return;
  cy.elements().unselect();
  cy.getElementById(`e${id}`).select();
  if (!canEditEdge(e)) {
    showPanel({ kind: 'edge', id }, panelHead('Connection', '', (REL[e.rel_type] || REL.other).label)
      + edgeEndsHtml(e.source_id, e.target_id, e.rel_type, false) + edgeReadOnlyHtml(e) + metaLine(e));
    return;
  }
  showPanel({ kind: 'edge', id },
    panelHead('Connection', '', (REL[e.rel_type] || REL.other).label)
    + edgeEndsHtml(e.source_id, e.target_id, e.rel_type, true)
    + edgeFormHtml(e, false) + metaLine(e));
}

function openNewEdgePanel(sourceId, targetId) {
  const draft = { rel_type: 'knows', strength: 2, notes: '' };
  showPanel({ kind: 'new-edge', sourceId, targetId },
    panelHead('Connection', '', 'New connection')
    + edgeEndsHtml(sourceId, targetId, draft.rel_type, false)
    + edgeFormHtml(draft, true));
}

// ----- merging duplicate contacts -----

function mergeCandidates(keep, query) {
  const q = query.trim().toLowerCase();
  const sameName = normName(keep.name);
  const email = keep.email.trim().toLowerCase();
  const score = (c) => (normName(c.name) === sameName || (email && c.email.trim().toLowerCase() === email) ? 0
    : c.company_id != null && c.company_id === keep.company_id ? 1 : 2);
  return [...state.nodes.values()]
    .filter((c) => c.type === 'person' && c.id !== keep.id && canEditNode(c))
    .filter((c) => !q || [c.name, c.email, c.title, companyOf(c)?.name].some((v) => String(v || '').toLowerCase().includes(q)))
    .sort((a, b) => score(a) - score(b) || byName(a, b))
    .slice(0, 40)
    .map((c) => ({ c, likely: score(c) === 0 }));
}

function renderMergeList() {
  const list = $('#merge-list');
  const keep = state.nodes.get(state.panel?.id);
  if (!list || !keep) return;
  const items = mergeCandidates(keep, $('#merge-filter').value);
  list.innerHTML = items.length ? items.map(({ c, likely }) => {
    const detail = [c.title, companyOf(c)?.name, c.email, c.owner_rep && `${c.owner_rep}'s`].filter(Boolean).join(' · ');
    return `<li data-merge="${c.id}" title="Merge ${esc(c.name)} into ${esc(keep.name)}">${avatar(c, 'avatar-sm')}
      <span class="who"><b>${esc(c.name)}</b>${stageBadge(c)}${likely ? ' <span class="pill">Likely duplicate</span>' : ''}<span>${esc(detail)}</span></span></li>`;
  }).join('') : `<li class="muted">${state.isAdmin ? 'No other contacts match.' : 'No other contacts of yours match. You can only merge contacts assigned to you.'}</li>`;
}

function openMergePanel(id) {
  const keep = state.nodes.get(id);
  if (!keep) return;
  showPanel({ kind: 'merge', id }, `${panelHead('Merge', '', `Merge into ${keep.name}`)}
    <div class="section">
      <p class="muted">Pick the duplicate. Its notes and connections move to <b>${esc(keep.name)}</b>, any details ${esc(keep.name)} is missing are filled in from it, and then the duplicate is removed.</p>
      <input id="merge-filter" class="panel-filter" type="search" placeholder="Search contacts…" autocomplete="off">
      <ul id="merge-list" class="conn-list"></ul>
      <button type="button" class="btn btn-sm btn-ghost" data-act="cancel-merge">← Back to ${esc(keep.name)}</button>
    </div>`);
  renderMergeList();
}

async function mergeInto(keepId, otherId) {
  const keep = state.nodes.get(keepId);
  const other = state.nodes.get(otherId);
  if (!keep || !other) return;
  if (!confirm(`Merge ${other.name} into ${keep.name}?\n\n${other.name}'s notes and connections move to ${keep.name}, missing details are filled in, and ${other.name} is removed. This can't be undone.`)) return;
  try {
    await api('POST', `/api/nodes/${keepId}/merge`, { other_id: otherId });
    await sync();
    openNodePanel(keepId);
    toast(`Merged ${other.name} into ${keep.name}`);
  } catch (err) { toast(err.message, true); }
}

// ----- Contacts list -----
// Everyone's contacts (and companies), whatever view the map is in, narrowed by
// stackable "Filter by" choices: values of one field are OR'd, fields are AND'd.

const DIR_FIELDS = [
  ['company', 'Company'], ['priority', 'Priority'], ['tag', 'Tag'], ['city', 'City'], ['rep', 'Rep'],
];

function dirValues(field, n) {
  const isPerson = n.type === 'person';
  const company = isPerson ? companyOf(n) : n;
  const staff = isPerson ? [n] : peopleAt(n.id);
  switch (field) {
    case 'company': return company ? [company.name] : ['No company'];
    case 'priority': return staff.some((p) => p.priority) ? ['High priority'] : ['Not high priority'];
    case 'tag': return company ? String(company.tags || '').split(',').map((t) => t.trim()).filter(Boolean) : [];
    case 'city': return [...new Set([cityOf(n), company ? cityOf(company) : ''].filter(Boolean))];
    case 'rep': return [n.owner_rep.trim() || 'Unassigned'];
    default: return [];
  }
}

function dirItems() {
  const type = state.dirTab === 'companies' ? 'company' : 'person';
  return [...state.nodes.values()].filter((n) => n.type === type);
}

function dirMatches(n) {
  const q = isPhone() ? state.dirQuery.trim().toLowerCase() : '';
  if (q) {
    const company = n.type === 'person' ? companyOf(n) : n;
    const hay = [n.name, n.title, n.email, n.phone, n.location, n.owner_rep, n.stage, company?.name, company?.tags]
      .map((v) => String(v || '').toLowerCase());
    if (!hay.some((v) => v.includes(q))) return false;
  }
  const byField = new Map();
  for (const f of state.dirFilters) {
    if (!byField.has(f.field)) byField.set(f.field, new Set());
    byField.get(f.field).add(f.value.toLowerCase());
  }
  for (const [field, wanted] of byField) {
    if (!dirValues(field, n).some((v) => wanted.has(v.toLowerCase()))) return false;
  }
  return true;
}

function openDirectory(tab) {
  if (tab && tab !== state.dirTab) { state.dirTab = tab; state.dirFilters = []; }
  if (state.dirTab !== 'companies') state.dirTab = 'people';
  showPanel({ kind: 'directory' }, `<div class="panel-head">
      <h2>Contacts</h2>
      <button class="icon-btn" data-act="close" aria-label="Close">×</button>
    </div>
    <div class="dir-controls">
      <div class="tabs-seg" role="tablist">
        ${[['people', 'Contacts'], ['companies', 'Companies']].map(([t, label]) => `<button type="button" role="tab" aria-selected="${state.dirTab === t}" class="${state.dirTab === t ? 'on' : ''}" data-dir-tab="${t}">${label}</button>`).join('')}
      </div>
      <input id="dir-search" class="dir-search" type="search" value="${esc(state.dirQuery)}" autocomplete="off"
        placeholder="Search name, company, email, phone…" aria-label="Search contacts">
      <div class="dir-add">
        <span>Filter by</span>
        <select id="dir-field" aria-label="Filter by">
          <option value="">Choose…</option>
          ${DIR_FIELDS.map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}
        </select>
        <select id="dir-value" aria-label="Filter value" disabled><option value="">—</option></select>
      </div>
      <div id="dir-chips" class="dir-chips"></div>
    </div>
    <ul id="dir-list" class="conn-list dir-list"></ul>`);
  renderDirectoryList();
}

function fillDirValues() {
  const field = $('#dir-field')?.value;
  const select = $('#dir-value');
  if (!select) return;
  if (!field) { select.innerHTML = '<option value="">—</option>'; select.disabled = true; return; }
  const counts = new Map();
  for (const n of dirItems()) {
    for (const v of new Set(dirValues(field, n))) {
      const entry = counts.get(v.toLowerCase()) || { v, n: 0 };
      entry.n += 1;
      counts.set(v.toLowerCase(), entry);
    }
  }
  const taken = new Set(state.dirFilters.filter((f) => f.field === field).map((f) => f.value.toLowerCase()));
  const options = [...counts.values()].filter((x) => !taken.has(x.v.toLowerCase()))
    .sort((a, b) => a.v.localeCompare(b.v));
  select.innerHTML = `<option value="">${options.length ? 'Pick one…' : 'Nothing else to pick'}</option>`
    + options.map((x) => `<option value="${esc(x.v)}">${esc(x.v)} (${x.n})</option>`).join('');
  select.disabled = !options.length;
}

function renderDirectoryList() {
  const list = $('#dir-list');
  if (!list) return;
  const label = Object.fromEntries(DIR_FIELDS);
  $('#dir-chips').innerHTML = state.dirFilters.map((f, i) =>
    `<button type="button" class="filter-chip" data-dir-remove="${i}" title="Remove this filter">${esc(label[f.field])}: <b>${esc(f.value)}</b> ×</button>`).join('')
    + (state.dirFilters.length > 1 ? '<button type="button" class="link-btn" data-dir-clear>Clear all</button>' : '');
  const items = dirItems().filter(dirMatches).sort(byName);
  const kind = state.dirTab === 'companies' ? ['company', 'companies'] : ['contact', 'contacts'];
  const countLine = `<li class="dir-count muted">${plural(items.length, kind[0], kind[1])}${state.dirFilters.length ? ' match' : ''}</li>`;
  if (state.dirTab === 'companies') {
    list.innerHTML = countLine + (items.length ? items.map((c) => {
      const detail = [plural(peopleAt(c.id).length, 'contact', 'contacts'), c.location, c.owner_rep].filter(Boolean).join(' · ');
      return `<li data-goto="${c.id}">${avatar(c, 'avatar-sm')}<span class="who"><b>${esc(c.name)}</b><span>${esc(detail)}</span>${tagChipsHtml(c)}</span></li>`;
    }).join('') : '<li class="muted">No companies match.</li>');
  } else {
    list.innerHTML = countLine + (items.length ? items.map((p) => {
      const detail = [p.title, companyOf(p)?.name, p.owner_rep || 'Unassigned'].filter(Boolean).join(' · ');
      return `<li data-goto="${p.id}">${avatar(p, 'avatar-sm')}<span class="who"><b>${esc(p.name)}</b>${stageBadge(p)}<span>${esc(detail)}</span></span></li>`;
    }).join('') : '<li class="muted">No contacts match.</li>');
  }
  fillDirValues();
}

panel.addEventListener('change', (evt) => {
  if (evt.target.id === 'dir-field') fillDirValues();
  if (evt.target.id === 'dir-value' && evt.target.value) {
    state.dirFilters.push({ field: $('#dir-field').value, value: evt.target.value });
    renderDirectoryList();
  }
});

// Keep the open panel in step with remote changes without clobbering edits in progress.
function refreshPanelAfterSync() {
  const p = state.panel;
  if (!p) return;
  if ((p.kind === 'node' || p.kind === 'node-edit') && !state.nodes.has(p.id)) { closePanel(); toast('That record was deleted by someone else'); return; }
  if (p.kind === 'edge' && !state.edges.has(p.id)) { closePanel(); toast('That connection was deleted by someone else'); return; }
  if (p.kind === 'new-edge' && (!state.nodes.has(p.sourceId) || !state.nodes.has(p.targetId))) { closePanel(); return; }
  if (p.kind === 'directory') { renderDirectoryList(); return; }
  if (p.kind === 'merge') { if (state.nodes.has(p.id)) renderMergeList(); else closePanel(); return; }
  if (state.panelDirty) return;
  if (p.kind === 'admin') rerenderAdmin();
  else if (p.kind === 'node') rerenderCard();
  else if (p.kind === 'edge') {
    const scroll = panel.scrollTop;
    openEdgePanel(p.id);
    panel.scrollTop = scroll;
  }
}

panel.addEventListener('input', (evt) => {
  if (evt.target.id === 'dir-search' || evt.target.id === 'dir-filter') {
    state.dirQuery = evt.target.value;
    renderDirectoryList();
    return;
  }
  if (evt.target.matches('.tag-add input')) { showTagSuggestions(evt.target); return; }
  if (evt.target.id === 'merge-filter') { renderMergeList(); return; }
  state.panelDirty = true;
  const nodeForm = evt.target.closest('[data-form="node"]');
  if (nodeForm && (evt.target.name === 'name' || evt.target.name === 'email')) updateDupHint(nodeForm);
});

// Changing the relationship type on a new connection updates the arrow preview.
panel.addEventListener('change', (evt) => {
  if (evt.target.name === 'company_id') updateDupHint(evt.target.form);
  if (evt.target.name !== 'rel_type') return;
  const arrow = panel.querySelector('.edge-ends .arrow');
  if (arrow) arrow.textContent = (REL[evt.target.value] || REL.other).directed ? '→' : '—';
});

// Cmd/Ctrl+Enter saves a note.
panel.addEventListener('keydown', (evt) => {
  if (evt.key === 'Escape' && evt.target.matches('.tag-add input') && panel.querySelector('.tag-suggest:not([hidden])')) {
    evt.stopPropagation();  // close the suggestions, not the card
    hideTagSuggestions();
    return;
  }
  if (evt.key === 'Enter' && (evt.metaKey || evt.ctrlKey) && evt.target.closest('[data-form="note"]')) {
    evt.preventDefault();
    evt.target.form.requestSubmit();
  }
});

panel.addEventListener('click', async (evt) => {
  const p = state.panel;
  const wmBtn = evt.target.closest('[data-wm-act]');
  if (wmBtn) { await handleWingmateAction(wmBtn.dataset.wmAct); return; }
  const repBtn = evt.target.closest('[data-rep-act]');
  if (repBtn) { await handleRepAction(repBtn.dataset.repAct, Number(repBtn.dataset.rep)); return; }
  const dirRemove = evt.target.closest('[data-dir-remove]');
  if (dirRemove) { state.dirFilters.splice(Number(dirRemove.dataset.dirRemove), 1); renderDirectoryList(); return; }
  if (evt.target.closest('[data-dir-clear]')) { state.dirFilters = []; renderDirectoryList(); return; }
  const tab = evt.target.closest('[data-dir-tab]');
  if (tab) { openDirectory(tab.dataset.dirTab); return; }

  const delNote = evt.target.closest('[data-del-note]');
  if (delNote) {
    if (!confirm('Delete this note for everyone?')) return;
    try {
      await api('DELETE', `/api/notes/${delNote.dataset.delNote}`);
      state.panelDirty = false;
      await sync();
      rerenderCard();
    } catch (err) { toast(err.message, true); }
    return;
  }

  const swatch = evt.target.closest('[data-color]');
  if (swatch) {
    try {
      await api('POST', `/api/nodes/${p.id}/display`, { color: swatch.dataset.color });
      state.colorPickerFor = null;
      await sync();
      rerenderCard();
    } catch (err) { toast(err.message, true); }
    return;
  }

  const mergeRow = evt.target.closest('[data-merge]');
  if (mergeRow) { await mergeInto(p.id, Number(mergeRow.dataset.merge)); return; }

  const addtag = evt.target.closest('[data-addtag]');
  if (addtag) { await addTag(addtag.dataset.addtag); return; }

  const untag = evt.target.closest('[data-untag]');
  if (untag) {
    try {
      await api('POST', `/api/nodes/${p.id}/tags`, { remove: untag.dataset.untag });
      state.panelDirty = false;
      await sync();
      rerenderCard();
    } catch (err) { toast(err.message, true); }
    return;
  }

  const edgeBtn = evt.target.closest('[data-edge]');
  if (edgeBtn) { openEdgePanel(Number(edgeBtn.dataset.edge)); return; }

  const link = evt.target.closest('[data-link]');
  if (link) {
    state.picker = { nodeId: p.id, otherId: Number(link.dataset.link) };
    rerenderCard();
    panel.querySelector('.picker select[name="rel_type"]')?.focus();
    return;
  }

  const goto = evt.target.closest('[data-goto]');
  if (goto) {
    const id = Number(goto.dataset.goto);
    const fromDir = p?.kind === 'directory';
    goToNode(id);
    openNodePanel(id, { fromDir });
    return;
  }

  const act = evt.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'close') {
    if (isPhone() && p?.kind !== 'directory') openDirectory(); else closePanel();
  }
  else if (act === 'directory') openDirectory();
  else if (act === 'edit') openEditPanel(p.id);
  else if (act === 'cancel-edit') openNodePanel(p.id);
  else if (act === 'show-map') focusOn(p.id);
  else if (act === 'add-person-here') openNewNodePanel('person', p.id);
  else if (act === 'color') {
    state.colorPickerFor = state.colorPickerFor === p.id ? null : p.id;
    rerenderCard();
  } else if (act === 'priority') {
    const n = state.nodes.get(p.id);
    try {
      await api('POST', `/api/nodes/${p.id}/display`, { priority: !n.priority });
      await sync();
      rerenderCard();
      toast(n.priority ? 'Removed high priority' : `${n.name} is now high priority`);
    } catch (err) { toast(err.message, true); }
  } else if (act === 'merge') openMergePanel(p.id);
  else if (act === 'cancel-merge') openNodePanel(p.id);
  else if (act === 'force-save') {
    const form = panel.querySelector('[data-form="node"]');
    form.dataset.force = '1';
    form.requestSubmit();
  } else if (act === 'open-picker') {
    state.picker = { nodeId: p.id, otherId: null };
    rerenderCard();
    panel.querySelector('.picker select[name="target_id"]')?.focus();
  } else if (act === 'close-picker') {
    state.picker = null;
    state.panelDirty = false;
    rerenderCard();
  } else if (act === 'delete-node') await deleteNode(p.id);
  else if (act === 'delete-edge') await deleteEdge(p.id);
  else if (act === 'swap') {
    try {
      await api('PATCH', `/api/edges/${p.id}`, { swap: true });
      state.panelDirty = false;
      await sync();
      toast('Direction reversed');
    } catch (err) { toast(err.message, true); }
  }
});

panel.addEventListener('submit', async (evt) => {
  evt.preventDefault();
  const form = evt.target;
  const data = Object.fromEntries(new FormData(form).entries());
  const submit = form.querySelector('[type="submit"]');
  const p = state.panel;
  if (submit) submit.disabled = true;  // the tag box submits on Enter and has no button
  try {
    if (form.dataset.form === 'wingmate-settings') {
      state.wingmate = await api('POST', '/api/wingmate/settings', { token: data.token, campaign_id: data.campaign_id });
      state.wingmateEditing = false;
      state.panelDirty = false;
      renderWingmateSection();
      toast(`Connected to Wingmate${state.wingmate.campaign_name ? `: ${state.wingmate.campaign_name}` : ''}`);
    } else if (form.dataset.form === 'add-tag') {
      await addTag(data.tag);  // Enter still works for typed tags
    } else if (form.dataset.form === 'my-password') {
      if (data.new_password !== data.confirm) { toast('The two passwords don’t match', true); return; }
      await api('POST', '/api/me/password', { new_password: data.new_password });
      state.panelDirty = false;
      form.reset();
      toast('Your password was changed');
    } else if (form.dataset.form === 'admin-password') {
      if (data.new_password !== data.confirm) { toast('The two passwords don’t match', true); return; }
      await api('POST', '/api/admin/password', { new_password: data.new_password });
      state.panelDirty = false;
      form.reset();
      toast('Admin password changed');
    } else if (form.dataset.form === 'rep-new' || form.dataset.form === 'rep-edit') {
      const isNew = form.dataset.form === 'rep-new';
      const body = { name: data.name, email: data.email, phone: data.phone, is_admin: !!data.is_admin };
      if (data.password) body.password = data.password;
      if (isNew) await api('POST', '/api/reps', body);
      else await api('PATCH', `/api/reps/${form.dataset.rep}`, body);
      state.editRepId = null;
      state.panelDirty = false;
      await sync();
      rerenderAdmin();
      toast(isNew ? `Added ${data.name.trim()}` : 'Saved');
      if (isNew) panel.querySelector('[data-form="rep-new"] input[name="name"]')?.focus();
    } else if (form.dataset.form === 'note') {
      if (!data.body.trim()) { toast('Write something first'); return; }
      await api('POST', `/api/nodes/${p.id}/notes`, { body: data.body });
      state.panelDirty = false;
      await sync();
      rerenderCard();
      toast('Note added');
    } else if (form.dataset.form === 'quick-edge') {
      if (!data.target_id) { toast('Choose who to connect to'); return; }
      await api('POST', '/api/edges', {
        source_id: p.id, target_id: Number(data.target_id), rel_type: data.rel_type,
        strength: Number(data.strength || 2), notes: data.notes,
      });
      state.picker = null;
      state.panelDirty = false;
      await sync();
      rerenderCard();
      toast('Connected');
    } else if (form.dataset.form === 'node') {
      if ('company_id' in data) data.company_id = data.company_id ? Number(data.company_id) : null;
      if (form.dataset.force) data.allow_duplicate = true;
      if (p.kind === 'new-node') {
        const created = await api('POST', '/api/nodes', { type: p.type, ...data });
        await sync();
        openNodePanel(created.id);
        goToNode(created.id);
        toast(`Added ${created.name}`);
      } else {
        await api('PATCH', `/api/nodes/${p.id}`, data);
        state.panelDirty = false;
        await sync();
        openNodePanel(p.id);
        toast('Saved');
      }
    } else {
      data.strength = Number(data.strength || 2);
      if (p.kind === 'new-edge') {
        const created = await api('POST', '/api/edges', { source_id: p.sourceId, target_id: p.targetId, ...data });
        await sync();
        openEdgePanel(created.id);
        toast('Connection added');
      } else {
        await api('PATCH', `/api/edges/${p.id}`, data);
        state.panelDirty = false;
        await sync();
        openEdgePanel(p.id);
        toast('Saved');
      }
    }
  } catch (err) {
    if (err.duplicates && form.dataset.form === 'node') showDuplicateWarning(form, err, state.panel?.kind === 'new-node');
    else toast(err.message, true);
  } finally {
    if (submit) submit.disabled = false;
    delete form.dataset.force;
  }
});

async function deleteNode(id) {
  const n = state.nodes.get(id);
  if (!n) return;
  const links = connectionRows(id).length;
  const extra = links ? ` and ${plural(links, 'connection', 'connections')}` : '';
  if (!confirm(`Delete ${n.name}${extra} for everyone?`)) return;
  try {
    await api('DELETE', `/api/nodes/${id}`);
    closePanel();
    if (state.focusId === id) clearFocus();
    await sync();
    toast(`Deleted ${n.name}`);
  } catch (err) { toast(err.message, true); }
}

async function deleteEdge(id) {
  if (!confirm('Delete this connection for everyone?')) return;
  try {
    await api('DELETE', `/api/edges/${id}`);
    closePanel();
    await sync();
    toast('Connection deleted');
  } catch (err) { toast(err.message, true); }
}

// ---------- admin ----------

const adminDialog = $('#admin-dialog');

function repRowHtml(r) {
  if (state.editRepId === r.id) {
    return `<li><form class="rep-form" data-form="rep-edit" data-rep="${r.id}">
      <input name="name" value="${esc(r.name)}" required maxlength="100" placeholder="Name" aria-label="Name">
      <div class="row2">
        <input name="email" type="email" required value="${esc(r.email)}" maxlength="300" placeholder="Work email (to sign in)" aria-label="Work email">
        <input name="phone" type="tel" value="${esc(r.phone)}" maxlength="300" placeholder="Phone" aria-label="Phone">
      </div>
      <label class="check"><input type="checkbox" name="is_admin" ${r.is_admin ? 'checked' : ''}> Admin <small>(manage reps, reassign leads; signs in with a password)</small></label>
      <input class="admin-pass" name="password" type="password" minlength="8" autocomplete="new-password" placeholder="${r.is_admin ? 'New password (leave blank to keep)' : 'Password for this admin'}" aria-label="Admin password">
      <div class="row-btns">
        <button type="submit" class="btn btn-sm btn-primary">Save</button>
        <button type="button" class="btn btn-sm btn-ghost" data-rep-act="cancel">Cancel</button>
      </div>
    </form></li>`;
  }
  const owned = [...state.nodes.values()].filter((n) => n.owner_rep === r.name).length;
  const detail = [r.email || 'No email: can’t sign in', r.phone, plural(owned, 'record', 'records')].filter(Boolean).join(' · ');
  return `<li class="${r.active ? '' : 'inactive'}">
    <span class="avatar avatar-sm" style="--hue:${r.active ? 'var(--accent)' : 'var(--muted)'}">${esc(initials(r.name))}</span>
    <span class="who"><b>${esc(r.name)}</b>${r.is_admin ? ' <span class="pill pill-company">Admin</span>' : ''}${r.active ? '' : ' <span class="pill">Inactive</span>'}<span>${esc(detail)}</span></span>
    <span class="rep-actions">
      <button class="btn btn-sm btn-ghost" data-rep-act="edit" data-rep="${r.id}">Edit</button>
      <button class="btn btn-sm btn-ghost" data-rep-act="toggle" data-rep="${r.id}">${r.active ? 'Deactivate' : 'Activate'}</button>
      <button class="btn btn-sm btn-danger-ghost" data-rep-act="delete" data-rep="${r.id}">Delete</button>
    </span>
  </li>`;
}

function openAdminPanel() {
  const reps = [...state.reps].sort((a, b) => (b.active - a.active) || byName(a, b));
  showPanel({ kind: 'admin' }, `${panelHead('Admin', 'pill-company', 'Settings')}
    <div class="section">
      <h3>Reps <span>${activeReps().length} active</span></h3>
      <p class="muted">Reps sign in with the email listed here. If someone leaves, deactivate them: they're signed out and their name stays on their records.</p>
      <form class="rep-form" data-form="rep-new">
        <input name="name" required maxlength="100" placeholder="Rep name" aria-label="Rep name">
        <div class="row2">
          <input name="email" type="email" required maxlength="300" placeholder="Work email (to sign in)" aria-label="Work email">
          <input name="phone" type="tel" maxlength="300" placeholder="Phone (optional)" aria-label="Phone">
        </div>
      <label class="check"><input type="checkbox" name="is_admin" > Admin <small>(manage reps, reassign leads; signs in with a password)</small></label>
      <input class="admin-pass" name="password" type="password" minlength="8" autocomplete="new-password" placeholder="Password for this admin" aria-label="Admin password">
        <div class="row-btns"><button type="submit" class="btn btn-sm btn-primary">+ Add rep</button></div>
      </form>
      ${reps.length ? `<ul class="rep-list">${reps.map(repRowHtml).join('')}</ul>` : '<p class="muted">No reps yet.</p>'}
    </div>
    ${state.me?.is_admin ? `<div class="section">
      <h3>Your password</h3>
      <form class="rep-form" data-form="my-password">
        <div class="row2">
          <input name="new_password" type="password" minlength="8" required autocomplete="new-password" placeholder="New password" aria-label="New password">
          <input name="confirm" type="password" minlength="8" required autocomplete="new-password" placeholder="Type it again" aria-label="Confirm new password">
        </div>
        <div class="row-btns"><button type="submit" class="btn btn-sm">Change my password</button></div>
      </form>
    </div>` : ''}
    <div class="section" id="wingmate-section">${wingmateSectionHtml()}</div>
    <div class="section">
      <h3>Backup admin password</h3>
      <p class="muted">Used with “Admin login” on the sign-in screen, in case an admin gets locked out.</p>
      ${state.adminEnvManaged
        ? '<p class="muted">This password is set in Render (ADMIN_PASSWORD). Change it there.</p>'
        : `<form class="rep-form" data-form="admin-password">
            <div class="row2">
              <input name="new_password" type="password" minlength="8" required autocomplete="new-password" placeholder="New password" aria-label="New password">
              <input name="confirm" type="password" minlength="8" required autocomplete="new-password" placeholder="Type it again" aria-label="Confirm new password">
            </div>
            <div class="row-btns"><button type="submit" class="btn btn-sm">Change password</button></div>
          </form>`}
    </div>
    ${state.me?.is_admin ? '' : '<div class="section"><button class="btn btn-sm" data-rep-act="logout">Log out of admin</button></div>'}`);
  loadWingmate();
}

// ----- Wingmate -----

const WM_LABELS = [
  ['companies_added', 'company added', 'companies added'], ['companies_linked', 'company linked', 'companies linked'],
  ['companies_updated', 'company updated', 'companies updated'], ['people_added', 'person added', 'people added'],
  ['people_linked', 'person linked', 'people linked'], ['people_updated', 'person updated', 'people updated'],
  ['notes_added', 'note added', 'notes added'], ['notes_moved', 'note moved to its contact', 'notes moved to their contacts'],
];

function wingmateCounts(r, preview) {
  const parts = WM_LABELS.filter(([key]) => r[key]).map(([key, one, many]) =>
    `${r[key]} ${(r[key] === 1 ? one : many).replace(preview ? /added|linked|updated/ : /$^/, (w) => `to be ${w}`)}`);
  if (preview && r.notes_to_check) parts.push(`notes checked on ${plural(r.notes_to_check, 'company', 'companies')}`);
  return parts.length ? parts.join(' · ') : 'Everything already up to date';
}

function wingmateSectionHtml() {
  const w = state.wingmate;
  if (!w) return '<h3>Wingmate</h3><p class="muted">Loading…</p>';
  const form = `<form class="rep-form" data-form="wingmate-settings">
      <input name="token" type="password" autocomplete="off" ${w.connected ? '' : 'required'}
        placeholder="${w.connected ? `API token (saved, ending ${esc(w.token_hint)}; leave blank to keep)` : 'Pipeline API token'}" aria-label="Wingmate API token">
      <input name="campaign_id" required value="${esc(w.campaign_id)}" placeholder="Campaign (pipeline) ID" aria-label="Wingmate campaign ID">
      <div class="row-btns">
        <button type="submit" class="btn btn-sm btn-primary">${w.connected ? 'Save & test' : 'Connect'}</button>
        ${w.connected ? '<button type="button" class="btn btn-sm btn-ghost" data-wm-act="cancel-edit">Cancel</button>' : ''}
      </div>
      <p class="muted">Get the token in Wingmate:
        <a href="https://support.wingmateapp.com/hc/en-us/articles/32035342435853-Retrieving-your-Pipeline-API-Access-Token" target="_blank" rel="noopener">Retrieving your Pipeline API Access Token</a>.
        Needs the API Access &amp; Integrations add-on.</p>
    </form>`;
  if (!w.connected || state.wingmateEditing) {
    return `<h3>Wingmate</h3>
      <p class="muted">Automatically brings Wingmate leads in as companies, with their contacts, notes and owner. One-way: nothing here is sent back to Wingmate.</p>${form}`;
  }
  const running = w.running;
  const last = w.last;
  const lastHtml = !last ? '<p class="muted">Not synced yet.</p>'
    : last.ok ? `<p class="wm-result">Last sync ${esc(timeAgo(last.at))}: ${esc(wingmateCounts(last, false))}.</p>`
    : `<p class="wm-result error-text">Last sync ${esc(timeAgo(last.at))} failed: ${esc(last.error)}</p>`;
  const preview = w.preview && !running
    ? (w.preview.ok ? `<p class="wm-preview">Preview (${plural(w.preview.leads, 'lead', 'leads')}, ${plural(w.preview.contacts, 'contact', 'contacts')} in Wingmate): ${esc(wingmateCounts(w.preview, true))}.</p>`
      : `<p class="wm-result error-text">Preview failed: ${esc(w.preview.error)}</p>`) : '';
  return `<h3>Wingmate <span class="pill pill-company">Connected</span></h3>
    <p class="muted">Pipeline <b>${esc(w.campaign_name || w.campaign_id)}</b>. Syncs automatically every ${w.interval_minutes} minutes while the site is awake.</p>
    ${running ? `<p class="wm-result"><span class="spinner"></span> ${running === 'preview' ? 'Building preview…' : 'Syncing with Wingmate…'}</p>` : lastHtml}
    ${preview}
    <div class="row-btns">
      <button type="button" class="btn btn-sm" data-wm-act="preview" ${running ? 'disabled' : ''}>Preview</button>
      <button type="button" class="btn btn-sm btn-primary" data-wm-act="sync" ${running ? 'disabled' : ''}>Sync now</button>
      <button type="button" class="btn btn-sm btn-ghost" data-wm-act="edit">Settings</button>
      <button type="button" class="btn btn-sm btn-danger-ghost" data-wm-act="disconnect">Disconnect</button>
    </div>
    ${w.cron_url ? `<details class="wm-cron"><summary>Sync even when nobody has the site open</summary>
      <p class="muted">The free server sleeps after 15 minutes without visitors. Add this link to a free scheduler such as cron-job.org, set to every 15 minutes, to keep syncing around the clock:</p>
      <input readonly value="${esc(w.cron_url)}" aria-label="Wingmate sync link" onclick="this.select()"></details>` : ''}`;
}

function renderWingmateSection() {
  const box = $('#wingmate-section');
  if (box) box.innerHTML = wingmateSectionHtml();
}

let wingmatePoll = null;
async function loadWingmate() {
  try {
    state.wingmate = await api('GET', '/api/wingmate/status');
  } catch (err) {
    state.wingmate = null;
    return;
  }
  renderWingmateSection();
  clearTimeout(wingmatePoll);
  if (state.wingmate.running && state.panel?.kind === 'admin') {
    wingmatePoll = setTimeout(async () => {
      const wasSync = state.wingmate.running === 'sync';
      await loadWingmate();
      if (wasSync && !state.wingmate?.running) {
        sync();
        toast(state.wingmate?.last?.ok ? 'Wingmate sync finished' : 'Wingmate sync failed', !state.wingmate?.last?.ok);
      }
    }, 2000);
  }
}

async function handleWingmateAction(act) {
  try {
    if (act === 'edit' || act === 'cancel-edit') {
      state.wingmateEditing = act === 'edit';
      state.panelDirty = false;
      renderWingmateSection();
    } else if (act === 'disconnect') {
      if (!confirm('Disconnect Wingmate? Companies and people already synced stay on the map.')) return;
      state.wingmate = await api('POST', '/api/wingmate/settings', { disconnect: true });
      renderWingmateSection();
    } else if (act === 'preview' || act === 'sync') {
      await api('POST', '/api/wingmate/sync', { dry_run: act === 'preview' });
      await loadWingmate();
    }
  } catch (err) { toast(err.message, true); }
}

function rerenderAdmin() {
  if (state.panel?.kind !== 'admin') return;
  const scroll = panel.scrollTop;
  openAdminPanel();
  panel.scrollTop = scroll;
}

async function handleRepAction(act, id) {
  const rep = state.reps.find((r) => r.id === id);
  try {
    if (act === 'logout') {
      await api('POST', '/api/admin/logout');
      closePanel();
      await loadMe();
      toast('Logged out of admin');
      return;
    }
    if (act === 'edit' || act === 'cancel') {
      state.editRepId = act === 'edit' ? id : null;
      state.panelDirty = false;
      rerenderAdmin();
      return;
    }
    if (act === 'toggle') await api('PATCH', `/api/reps/${id}`, { active: !rep.active });
    if (act === 'delete') {
      if (!confirm(`Remove ${rep.name} from the rep list? Their name stays on records they own. To keep them in history, use Deactivate instead.`)) return;
      await api('DELETE', `/api/reps/${id}`);
    }
    state.panelDirty = false;
    await sync();
    rerenderAdmin();
  } catch (err) {
    toast(err.message, true);
    if (/admin login/i.test(err.message)) closePanel();
  }
}

function openAdminLogin() {
  $('#admin-error').hidden = true;
  $('#admin-password').value = '';
  adminDialog.showModal();
}

$('#btn-admin').addEventListener('click', () => {
  if (state.panel?.kind === 'admin') closePanel();
  else if (state.isAdmin) openAdminPanel();
  else if (!state.adminConfigured) toast('Admin isn’t set up yet.', true);
  else openAdminLogin();
});

adminDialog.addEventListener('click', (evt) => {
  if (evt.target === adminDialog || evt.target.closest('[data-close]')) adminDialog.close();
});

$('#admin-login').addEventListener('submit', async (evt) => {
  evt.preventDefault();
  try {
    await api('POST', '/api/admin/login', { password: $('#admin-password').value });
    adminDialog.close();
    await loadMe();
    openAdminPanel();
    toast('Logged in as admin');
  } catch (err) {
    $('#admin-error').textContent = err.message;
    $('#admin-error').hidden = false;
  }
});

function setAdmin(on) {
  if (state.isAdmin === !!on) return;
  state.isAdmin = !!on;
  if (state.panel?.kind === 'node-edit' && !state.panelDirty) openEditPanel(state.panel.id);
}

// ---------- activity ----------

function closeActivity() { $('#activity').hidden = true; }

async function loadActivity() {
  try {
    const items = await api('GET', '/api/activity?limit=100');
    $('#activity-list').innerHTML = items.length
      ? items.map((a) => `<li><b>${esc(a.actor)}</b> ${esc(a.summary.charAt(0).toLowerCase() + a.summary.slice(1))}<span class="when">${esc(timeAgo(a.ts))}</span></li>`).join('')
      : '<li class="muted">No changes yet.</li>';
  } catch (err) { toast(err.message, true); }
}

$('#btn-activity').addEventListener('click', () => {
  const box = $('#activity');
  if (!box.hidden) { closeActivity(); return; }
  closePanel();
  box.hidden = false;
  loadActivity();
});
$('#btn-close-activity').addEventListener('click', closeActivity);

// ---------- data dialog ----------

const dataDialog = $('#data-dialog');
function openDataDialog() {
  $('#backup-section').hidden = !state.isAdmin;
  $('#export-section').hidden = !state.isAdmin;
  $('#restore-label').hidden = !state.isAdmin;
  $('#csv-owner-note').hidden = state.isAdmin;
  dataDialog.showModal();
}
$('#btn-data').addEventListener('click', openDataDialog);

// What's on screen right now: the current view, narrowed by any filters.
function shownIds(type) {
  const matched = activeFilterCount() ? filterMatches() : null;
  return [...state.nodes.values()]
    .filter((n) => n.type === type && inView(n.id) && (!matched || matched.has(n.id)))
    .map((n) => n.id);
}

async function exportCsv(kind) {
  const onlyShown = $('#export-shown').checked;
  const body = onlyShown ? { ids: shownIds(kind === 'contacts' ? 'person' : 'company') } : {};
  try {
    const res = await fetch(`/api/export/${kind}.csv`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Export failed');
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || `pss-connect-${kind}.csv`;
    download(name, await res.blob());
    toast(`Exported ${onlyShown ? plural(body.ids.length, kind === 'contacts' ? 'contact' : 'company', kind) : `all ${kind}`}`);
  } catch (err) { toast(err.message, true); }
}
$('#btn-export-contacts').addEventListener('click', () => exportCsv('contacts'));
$('#btn-export-companies').addEventListener('click', () => exportCsv('companies'));
dataDialog.addEventListener('click', (evt) => {
  if (evt.target === dataDialog || evt.target.closest('[data-close]')) dataDialog.close();
});

function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#btn-template').addEventListener('click', () => {
  const csv = 'name,title,company,email,phone,owner_rep,location,tags,notes\n'
    + 'Jane Smith,VP Operations,Acme Corp,jane@acme.com,555-0100,Alex,"Dallas, TX","decision maker",Met at trade show\n';
  download('pss-connect-template.csv', new Blob([csv], { type: 'text/csv' }));
});

$('#csv-file').addEventListener('change', async (evt) => {
  const file = evt.target.files[0];
  evt.target.value = '';
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  try {
    const r = await api('POST', '/api/import.csv', form);
    dataDialog.close();
    await sync();
    moveMap({ fit: { eles: cy.elements(), padding: 50 } }, 300);
    toast(`Imported ${r.people} people and ${r.companies} companies${r.skipped ? ` (${r.skipped} skipped)` : ''}`);
  } catch (err) { toast(err.message, true); }
});

$('#restore-file').addEventListener('change', async (evt) => {
  const file = evt.target.files[0];
  evt.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('That file isn\'t valid JSON', true); return; }
  if (!confirm('Restoring replaces the ENTIRE map for everyone with this backup. Continue?')) return;
  try {
    const r = await api('POST', '/api/import.json', data);
    dataDialog.close();
    closePanel();
    state.firstLoad = true;
    await sync();
    toast(`Restored ${r.nodes} records and ${r.edges} connections`);
  } catch (err) { toast(err.message, true); }
});

$('#btn-png').addEventListener('click', () => {
  if (!cy.nodes().length) { toast('The map is empty'); return; }
  const blob = cy.png({ output: 'blob', full: true, scale: 2, bg: cssVar('--canvas') || '#ffffff' });
  download(`pss-connect-${new Date().toISOString().slice(0, 10)}.png`, blob);
});

// ---------- toolbar ----------

$('#btn-add-company').addEventListener('click', () => openNewNodePanel('company'));
$('#btn-add-person').addEventListener('click', () => openNewNodePanel('person'));
$('#btn-directory').addEventListener('click', () => {
  if (state.panel?.kind === 'directory') closePanel(); else openDirectory();
});
$('#btn-zoom-in').addEventListener('click', () => cy.animate({ zoom: { level: cy.zoom() * 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } } }, { duration: 150 }));
$('#btn-zoom-out').addEventListener('click', () => cy.animate({ zoom: { level: cy.zoom() / 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } } }, { duration: 150 }));
$('#btn-fit').addEventListener('click', () => cy.animate({ fit: { eles: cy.elements(), padding: 50 } }, { duration: 300 }));
$('#btn-layout').addEventListener('click', () => {
  if (confirm('Auto-arrange the whole map? This moves everyone\'s nodes for the whole team.')) runLayout(false);
});
$('#empty').addEventListener('click', (evt) => {
  const which = evt.target.closest('[data-empty]')?.dataset.empty;
  if (which === 'company') openNewNodePanel('company');
  else if (which === 'import') openDataDialog();
});

document.addEventListener('keydown', (evt) => {
  if (evt.key !== 'Escape' || dataDialog.open || adminDialog.open) return;
  if (!filterMenu.hidden) toggleFilterMenu(false);
  else if (state.connecting) stopConnect();
  else if (state.focusId != null) clearFocus();
  else if (state.panel) closePanel();
  else closeActivity();
});

// ---------- phone layout: bottom navigation ----------
// On phones the app is list-first (look up and add contacts on the go); the map
// is one tab away.

function isPhone() {
  return phoneQuery.matches;
}

// While typing on a phone the keyboard would shove the bottom bar up over the screen:
// hide it until the field loses focus.
document.addEventListener('focusin', (evt) => {
  if (isPhone() && evt.target.matches('input:not([type=checkbox]):not([type=radio]), textarea')) document.body.classList.add('typing');
});
document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (!document.activeElement?.matches?.('input, textarea')) document.body.classList.remove('typing');
  }, 50);
});

const sheets = { add: $('#sheet-add'), more: $('#sheet-more') };

function closeSheets() {
  Object.values(sheets).forEach((sheet) => { sheet.hidden = true; });
  $('#sheet-backdrop').hidden = true;
}

function openSheet(name) {
  const wasOpen = !sheets[name].hidden;
  closeSheets();
  toggleFilterMenu(false);
  if (wasOpen) { syncNav(); return; }
  $('[data-sheet="admin"]').hidden = !(state.isAdmin || state.adminConfigured);
  sheets[name].hidden = false;
  $('#sheet-backdrop').hidden = false;
  syncNav(name);
}

// Highlights the tab for whatever is on screen.
function syncNav(sheet) {
  const nav = $('#bottom-nav');
  if (!nav) return;
  const list = state.dirTab === 'companies' ? 'companies' : 'contacts';
  const current = sheet || (!filterMenu.hidden || !$('#activity').hidden ? 'more'
    : state.panel ? list : 'map');
  nav.querySelectorAll('[data-nav]').forEach((b) => b.classList.toggle('on', b.dataset.nav === current));
}

$('#bottom-nav').addEventListener('click', (evt) => {
  const which = evt.target.closest('[data-nav]')?.dataset.nav;
  if (!which) return;
  if (which === 'map') {
    closeSheets(); toggleFilterMenu(false); closeActivity(); closePanel();
    cy.resize();
  } else if (which === 'contacts' || which === 'companies') {
    closeSheets(); toggleFilterMenu(false); closeActivity();
    openDirectory(which === 'companies' ? 'companies' : 'people');
  } else {
    openSheet(which);
  }
});

$('#sheet-backdrop').addEventListener('click', () => { closeSheets(); syncNav(); });

document.querySelectorAll('.sheet').forEach((sheet) => sheet.addEventListener('click', (evt) => {
  const action = evt.target.closest('[data-sheet]')?.dataset.sheet;
  if (!action) return;
  closeSheets();
  const click = (id) => $(id).click();
  ({
    'add-company': () => click('#btn-add-company'),
    'add-person': () => click('#btn-add-person'),
    filter: () => { toggleFilterMenu(true); syncNav('more'); },
    activity: () => { click('#btn-activity'); syncNav('more'); },
    data: () => click('#btn-data'),
    admin: () => click('#btn-admin'),
    fit: () => click('#btn-fit'),
    layout: () => click('#btn-layout'),
    signout: () => click('#me-chip'),
  })[action]?.();
  if (action !== 'filter' && action !== 'activity') syncNav();
}));

// ---------- start ----------

buildLegend();
loadMe();

})();
