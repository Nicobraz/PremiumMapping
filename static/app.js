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
  isAdmin: false,
  editRepId: null,
  dirTab: 'companies',
  dirQuery: '',
  focusId: null,
  hiddenRels: new Set(),
  ownerFilter: '',
  tagFilter: '',
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
function nodeColor(n) {
  return n.type === 'company' ? companyColor(n.id) : companyColor(n.company_id);
}

// ---------- identity ----------

// Once an admin has added reps, "You" is a dropdown; before that it's free text.
const meInput = $('#me');
const meSelect = $('#me-select');
meInput.value = storeGet('pss.me');
meInput.addEventListener('change', () => storeSet('pss.me', meInput.value.trim()));
meSelect.addEventListener('change', () => {
  storeSet('pss.me', meSelect.value);
  meSelect.classList.remove('attention');
});

const activeReps = () => state.reps.filter((r) => r.active);

function myName() {
  return activeReps().length ? meSelect.value : meInput.value.trim();
}

function renderMe() {
  const reps = activeReps();
  meSelect.hidden = !reps.length;
  meInput.hidden = !!reps.length;
  if (!reps.length) return;
  const current = storeGet('pss.me');
  meSelect.innerHTML = '<option value="">Who are you?</option>'
    + reps.map((r) => `<option value="${esc(r.name)}" ${r.name === current ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
}

function ensureName() {
  if (myName()) return true;
  if (activeReps().length) {
    meSelect.classList.add('attention');
    meSelect.focus();
    toast('Pick your name at the top so the team knows who made changes');
    return true;
  }
  const name = prompt('What\'s your name? It shows in the activity log so the team knows who changed what.');
  if (name && name.trim()) {
    meInput.value = name.trim().slice(0, 60);
    storeSet('pss.me', meInput.value);
  }
  return true;
}

// ---------- API ----------

async function api(method, path, body) {
  const headers = { 'X-Actor': encodeURIComponent(myName()) };
  const key = storeGet('pss.editKey');
  if (key) headers['X-Edit-Key'] = key;
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 401) {
    const entered = prompt('This map is protected. Enter the team edit key:');
    if (entered && entered.trim()) {
      storeSet('pss.editKey', entered.trim());
      return api(method, path, body);
    }
    throw new Error('Edit key required to make changes');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
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
    { selector: 'node:selected', style: { 'border-width': 4, 'border-color': accent } },
    { selector: 'node.match', style: { 'border-width': 4, 'border-color': '#f59e0b' } },
    { selector: 'node.connect-from', style: { 'border-width': 4, 'border-color': accent, 'border-style': 'dashed' } },
    { selector: 'node.focus-root', style: { 'border-width': 5, 'border-color': accent } },
    { selector: '.dim, .faded', style: { 'opacity': 0.13 } },
    { selector: '.hidden-rel', style: { 'display': 'none' } },
  ];
}

const cy = cytoscape({
  container: $('#cy'),
  style: graphStyle(),
  minZoom: 0.1,
  maxZoom: 3,
  boxSelectionEnabled: false,
});

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
darkQuery.addEventListener?.('change', () => cy.style(graphStyle()));

function nodeElement(n) {
  const label = n.type === 'person' && n.title ? `${n.name}\n${n.title}` : n.name;
  return {
    group: 'nodes',
    data: { id: `n${n.id}`, nid: n.id, kind: n.type, label, color: nodeColor(n) },
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
  missing.sort((a, b) => (a.type === 'company' ? 0 : 1) - (b.type === 'company' ? 0 : 1));
  for (const n of missing) {
    const company = n.company_id != null ? state.nodes.get(n.company_id) : null;
    let pos;
    if (n.type === 'person' && hasPos(company)) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 90 + Math.random() * 60;
      pos = { x: company.x + radius * Math.cos(angle), y: company.y + radius * Math.sin(angle) };
    } else {
      pos = { x: bb.x2 + 180 + (slot % 4) * 180, y: bb.y1 + Math.floor(slot / 4) * 180 };
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
    renderMe();
    state.noteText = new Map([...state.notes].map(([id, list]) =>
      [id, list.map((note) => note.body).join('\n').toLowerCase()]));
    render();
    if (state.firstLoad) {
      state.firstLoad = false;
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

setInterval(() => { if (!document.hidden) sync(); }, POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });

// ---------- filters, legend, stats ----------

function buildLegend() {
  const rels = [...Object.entries(REL), [WORKS_AT, { label: 'Works at', color: NO_COMPANY }]];
  $('#legend').innerHTML = rels.map(([key, r]) => `
    <button class="chip ${state.hiddenRels.has(key) ? 'off' : ''}" data-rel="${key}" title="Show or hide ${esc(r.label)}">
      <span class="swatch ${key === WORKS_AT || key === 'competitor' ? 'dashed' : ''}" style="background:${r.color};color:${r.color}"></span>${esc(r.label)}
    </button>`).join('');
}

$('#legend').addEventListener('click', (evt) => {
  const chip = evt.target.closest('[data-rel]');
  if (!chip) return;
  const rel = chip.dataset.rel;
  if (state.hiddenRels.has(rel)) state.hiddenRels.delete(rel); else state.hiddenRels.add(rel);
  buildLegend();
  applyFilters();
});

function applyFilters() {
  const owner = state.ownerFilter.toLowerCase();
  const tag = state.tagFilter.toLowerCase();
  cy.batch(() => {
    cy.edges().forEach((e) => e.toggleClass('hidden-rel', state.hiddenRels.has(e.data('rel'))));
    cy.elements().removeClass('dim');
    if (!owner && !tag) return;
    cy.nodes().forEach((el) => {
      const n = state.nodes.get(el.data('nid'));
      const ownerOk = !owner || n.owner_rep.trim().toLowerCase() === owner;
      const tagOk = !tag || splitTags(n.tags).includes(tag);
      if (!(ownerOk && tagOk)) el.addClass('dim');
    });
    cy.edges().forEach((e) => {
      if (e.source().hasClass('dim') || e.target().hasClass('dim')) e.addClass('dim');
    });
  });
  $('#btn-clear-filters').hidden = !owner && !tag && !state.hiddenRels.size;
}

function fillSelect(select, values, allLabel, current) {
  const opts = [`<option value="">${allLabel}</option>`]
    .concat(values.map((v) => `<option value="${esc(v)}" ${v.toLowerCase() === current.toLowerCase() ? 'selected' : ''}>${esc(v)}</option>`));
  select.innerHTML = opts.join('');
}

function refreshFilterOptions() {
  const owners = new Map();
  const tags = new Map();
  for (const r of activeReps()) owners.set(r.name.toLowerCase(), r.name);
  for (const n of state.nodes.values()) {
    const o = n.owner_rep.trim();
    if (o) owners.set(o.toLowerCase(), o);
    for (const raw of String(n.tags || '').split(',')) {
      const t = raw.trim();
      if (t) tags.set(t.toLowerCase(), t);
    }
  }
  const ownerList = [...owners.values()].sort((a, b) => a.localeCompare(b));
  const tagList = [...tags.values()].sort((a, b) => a.localeCompare(b));
  fillSelect($('#filter-owner'), ownerList, 'All reps', state.ownerFilter);
  fillSelect($('#filter-tag'), tagList, 'All tags', state.tagFilter);
  $('#owner-list').innerHTML = ownerList.map((o) => `<option value="${esc(o)}">`).join('');
}

$('#filter-owner').addEventListener('change', (evt) => { state.ownerFilter = evt.target.value; applyFilters(); });
$('#filter-tag').addEventListener('change', (evt) => { state.tagFilter = evt.target.value; applyFilters(); });
$('#btn-clear-filters').addEventListener('click', () => {
  state.ownerFilter = '';
  state.tagFilter = '';
  state.hiddenRels.clear();
  $('#filter-owner').value = '';
  $('#filter-tag').value = '';
  buildLegend();
  applyFilters();
});

function updateStats() {
  let companies = 0;
  let people = 0;
  for (const n of state.nodes.values()) { if (n.type === 'company') companies += 1; else people += 1; }
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  $('#stats').textContent = [
    count(companies, 'company', 'companies'),
    count(people, 'person', 'people'),
    count(state.edges.size, 'connection', 'connections'),
  ].join(' · ');
}

// ---------- search ----------

function searchMatches() {
  const q = $('#search').value.trim().toLowerCase();
  if (!q) return [];
  return [...state.nodes.values()].filter((n) =>
    [n.name, n.title, n.email, n.tags, n.location, n.owner_rep, n.notes].some((v) => String(v || '').toLowerCase().includes(q))
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
  cy.animate({ center: { eles: el }, zoom: Math.max(cy.zoom(), 1) }, { duration: 350 });
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
  cy.animate({ fit: { eles: keep, padding: 80 } }, { duration: 400 });
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
  if (state.connecting || Date.now() - state.connectedAt < 500) return;
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
}

function showPanel(desc, html) {
  closeActivity();
  state.panel = desc;
  state.panelDirty = false;
  panel.innerHTML = html;
  panel.hidden = false;
  panel.scrollTop = 0;
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
  return `<div class="meta-line">Last edited ${esc(timeAgo(item.updated_at))}${item.updated_by ? ` by ${esc(item.updated_by)}` : ''}</div>`;
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
    </div>
    <button class="icon-btn" data-act="close" aria-label="Close">×</button>
  </div>`;
}

function actionsHtml(n) {
  const btns = [];
  if (n.type === 'company') btns.push('<button class="btn btn-sm btn-primary" data-act="add-person-here">+ Add person</button>');
  if (n.email) btns.push(`<a class="btn btn-sm" href="mailto:${esc(n.email)}">Email</a>`);
  if (n.phone) btns.push(`<a class="btn btn-sm" href="tel:${esc(n.phone.replace(/[^\d+]/g, ''))}">Call</a>`);
  btns.push('<button class="btn btn-sm" data-act="show-map">Show on map</button>');
  btns.push('<button class="btn btn-sm" data-act="edit">Edit</button>');
  return `<div class="card-actions">${btns.join('')}</div>`;
}

function factsHtml(n, skip = []) {
  const facts = [['Email', n.email], ['Phone', n.phone], ['Location', n.location], ['Owner rep', n.owner_rep]]
    .filter(([label, value]) => value && !skip.includes(label));
  const tags = String(n.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  return (facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '')
    + (tags.length ? `<div class="tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : '');
}

function aboutHtml(n) {
  return n.notes ? `<div class="section"><h3>About</h3><p class="about">${esc(n.notes)}</p></div>` : '';
}

function connListHtml(rows, empty) {
  if (!rows.length) return `<p class="muted">${empty}</p>`;
  return `<ul class="conn-list">${rows.map((r) => `<li data-goto="${r.other.id}">
      ${avatar(r.other, 'avatar-sm')}
      <span class="who"><b>${esc(r.other.name)}</b>
        <span><i class="rel-dot" style="background:${r.color}"></i>${esc(capitalize(r.phrase))}${r.other.title ? ` · ${esc(r.other.title)}` : ''}</span></span>
      <span class="strength" title="${STRENGTH[r.strength]}">${'●'.repeat(r.strength)}${'○'.repeat(3 - r.strength)}</span>
      <button class="icon-btn icon-sm" data-edge="${r.edgeId}" title="Edit connection" aria-label="Edit connection">✎</button>
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
        <div class="note-meta">${esc(note.author || 'Someone')} · ${esc(timeAgo(note.created_at))}
          <button type="button" class="link-btn" data-del-note="${note.id}">Delete</button></div>
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
  return heroHtml(n, n.title, company
    ? `<button class="hero-link" data-goto="${company.id}">${esc(company.name)} →</button>`
    : '<div class="hero-sub muted">No company</div>')
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
    <span class="who"><b>${esc(p.name)}</b>${detail ? `<span>${esc(detail)}</span>` : ''}</span>
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
  cy.elements().unselect();
  cy.getElementById(`n${id}`).select();
  const back = opts.fromDir ? '<button class="back-link" data-act="directory">← Directory</button>' : '';
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

// ----- edit forms -----

function nodeFormHtml(n, isNew) {
  const companies = [...state.nodes.values()].filter((c) => c.type === 'company').sort(byName);
  const field = (name, label, attrs = '') =>
    `<label>${label}<input name="${name}" value="${esc(n[name])}" ${attrs}></label>`;
  const person = n.type === 'person';
  return `<form class="form" data-form="node">
    ${field('name', 'Name', `required maxlength="300" placeholder="${person ? 'Jane Smith' : 'Acme Corp'}"`)}
    ${person ? field('title', 'Title / role', 'maxlength="300" placeholder="VP of Operations"') : ''}
    ${person ? `<label>Company<select name="company_id">
        <option value="">None</option>
        ${companies.map((c) => `<option value="${c.id}" ${c.id === n.company_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select></label>` : ''}
    ${person ? `<div class="row">${field('email', 'Email', 'type="email" maxlength="300"')}${field('phone', 'Phone', 'type="tel" maxlength="300"')}</div>` : ''}
    ${field('location', 'Location', 'maxlength="300" placeholder="City, State"')}
    ${ownerFieldHtml(n.owner_rep, isNew)}
    ${field('tags', 'Tags <small>comma separated</small>', `maxlength="300" placeholder="${person ? 'decision maker, champion' : 'target, customer'}"`)}
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
  if (!n) return;
  showPanel({ kind: 'node-edit', id },
    panelHead(n.type === 'company' ? 'Company' : 'Person', `pill-${n.type}`, `Edit ${n.name}`)
    + nodeFormHtml(n, false) + metaLine(n));
  panel.querySelector('input[name="name"]').focus();
}

function openNewNodePanel(type, companyId) {
  stopConnect();
  ensureName();
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

function openEdgePanel(id) {
  const e = state.edges.get(id);
  if (!e) return;
  cy.elements().unselect();
  cy.getElementById(`e${id}`).select();
  showPanel({ kind: 'edge', id },
    panelHead('Connection', '', (REL[e.rel_type] || REL.other).label)
    + edgeEndsHtml(e.source_id, e.target_id, e.rel_type, true)
    + edgeFormHtml(e, false) + metaLine(e));
}

function openNewEdgePanel(sourceId, targetId) {
  ensureName();
  const draft = { rel_type: 'knows', strength: 2, notes: '' };
  showPanel({ kind: 'new-edge', sourceId, targetId },
    panelHead('Connection', '', 'New connection')
    + edgeEndsHtml(sourceId, targetId, draft.rel_type, false)
    + edgeFormHtml(draft, true));
}

// ----- directory -----

function openDirectory(tab) {
  if (tab) state.dirTab = tab;
  showPanel({ kind: 'directory' }, `<div class="panel-head">
      <h2>Directory</h2>
      <button class="icon-btn" data-act="close" aria-label="Close">×</button>
    </div>
    <div class="dir-controls">
      <div class="tabs-seg" role="tablist">
        ${['companies', 'people'].map((t) => `<button type="button" role="tab" aria-selected="${state.dirTab === t}" class="${state.dirTab === t ? 'on' : ''}" data-dir-tab="${t}">${t === 'companies' ? 'Companies' : 'People'}</button>`).join('')}
      </div>
      <input id="dir-filter" type="search" placeholder="Filter by name, title, location, tag…" value="${esc(state.dirQuery)}" data-nodirty autocomplete="off">
    </div>
    <ul id="dir-list" class="conn-list dir-list"></ul>`);
  renderDirectoryList();
}

function renderDirectoryList() {
  const list = $('#dir-list');
  if (!list) return;
  const q = state.dirQuery.trim().toLowerCase();
  const matches = (n) => !q || [n.name, n.title, n.location, n.tags, n.owner_rep, companyOf(n)?.name]
    .some((v) => String(v || '').toLowerCase().includes(q));
  if (state.dirTab === 'companies') {
    const items = [...state.nodes.values()].filter((n) => n.type === 'company' && matches(n)).sort(byName);
    list.innerHTML = items.length ? items.map((c) => {
      const detail = [plural(peopleAt(c.id).length, 'person', 'people'), c.location].filter(Boolean).join(' · ');
      return `<li data-goto="${c.id}">${avatar(c, 'avatar-sm')}<span class="who"><b>${esc(c.name)}</b><span>${esc(detail)}</span></span></li>`;
    }).join('') : '<li class="muted">No companies match.</li>';
  } else {
    const items = [...state.nodes.values()].filter((n) => n.type === 'person' && matches(n)).sort(byName);
    list.innerHTML = items.length ? items.map((p) => {
      const detail = [p.title, companyOf(p)?.name].filter(Boolean).join(' · ');
      return `<li data-goto="${p.id}">${avatar(p, 'avatar-sm')}<span class="who"><b>${esc(p.name)}</b>${detail ? `<span>${esc(detail)}</span>` : ''}</span></li>`;
    }).join('') : '<li class="muted">No people match.</li>';
  }
}

// Keep the open panel in step with remote changes without clobbering edits in progress.
function refreshPanelAfterSync() {
  const p = state.panel;
  if (!p) return;
  if ((p.kind === 'node' || p.kind === 'node-edit') && !state.nodes.has(p.id)) { closePanel(); toast('That record was deleted by someone else'); return; }
  if (p.kind === 'edge' && !state.edges.has(p.id)) { closePanel(); toast('That connection was deleted by someone else'); return; }
  if (p.kind === 'new-edge' && (!state.nodes.has(p.sourceId) || !state.nodes.has(p.targetId))) { closePanel(); return; }
  if (p.kind === 'directory') { renderDirectoryList(); return; }
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
  if (evt.target.id === 'dir-filter') {
    state.dirQuery = evt.target.value;
    renderDirectoryList();
    return;
  }
  state.panelDirty = true;
});

// Changing the relationship type on a new connection updates the arrow preview.
panel.addEventListener('change', (evt) => {
  if (evt.target.name !== 'rel_type') return;
  const arrow = panel.querySelector('.edge-ends .arrow');
  if (arrow) arrow.textContent = (REL[evt.target.value] || REL.other).directed ? '→' : '—';
});

// Cmd/Ctrl+Enter saves a note.
panel.addEventListener('keydown', (evt) => {
  if (evt.key === 'Enter' && (evt.metaKey || evt.ctrlKey) && evt.target.closest('[data-form="note"]')) {
    evt.preventDefault();
    evt.target.form.requestSubmit();
  }
});

panel.addEventListener('click', async (evt) => {
  const p = state.panel;
  const repBtn = evt.target.closest('[data-rep-act]');
  if (repBtn) { await handleRepAction(repBtn.dataset.repAct, Number(repBtn.dataset.rep)); return; }
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
  if (act === 'close') closePanel();
  else if (act === 'directory') openDirectory();
  else if (act === 'edit') openEditPanel(p.id);
  else if (act === 'cancel-edit') openNodePanel(p.id);
  else if (act === 'show-map') focusOn(p.id);
  else if (act === 'add-person-here') openNewNodePanel('person', p.id);
  else if (act === 'open-picker') {
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
  submit.disabled = true;
  try {
    if (form.dataset.form === 'admin-password') {
      if (data.new_password !== data.confirm) { toast('The two passwords don’t match', true); return; }
      await api('POST', '/api/admin/password', { new_password: data.new_password });
      state.panelDirty = false;
      form.reset();
      toast('Admin password changed');
    } else if (form.dataset.form === 'rep-new' || form.dataset.form === 'rep-edit') {
      const isNew = form.dataset.form === 'rep-new';
      const body = { name: data.name, email: data.email, phone: data.phone };
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
      ensureName();
      await api('POST', `/api/nodes/${p.id}/notes`, { body: data.body });
      state.panelDirty = false;
      await sync();
      rerenderCard();
      toast('Note added');
    } else if (form.dataset.form === 'quick-edge') {
      if (!data.target_id) { toast('Choose who to connect to'); return; }
      ensureName();
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
    toast(err.message, true);
  } finally {
    submit.disabled = false;
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
        <input name="email" type="email" value="${esc(r.email)}" maxlength="300" placeholder="Email" aria-label="Email">
        <input name="phone" type="tel" value="${esc(r.phone)}" maxlength="300" placeholder="Phone" aria-label="Phone">
      </div>
      <div class="row-btns">
        <button type="submit" class="btn btn-sm btn-primary">Save</button>
        <button type="button" class="btn btn-sm btn-ghost" data-rep-act="cancel">Cancel</button>
      </div>
    </form></li>`;
  }
  const owned = [...state.nodes.values()].filter((n) => n.owner_rep === r.name).length;
  const detail = [r.email, r.phone, plural(owned, 'record', 'records')].filter(Boolean).join(' · ');
  return `<li class="${r.active ? '' : 'inactive'}">
    <span class="avatar avatar-sm" style="--hue:${r.active ? 'var(--accent)' : 'var(--muted)'}">${esc(initials(r.name))}</span>
    <span class="who"><b>${esc(r.name)}</b>${r.active ? '' : ' <span class="pill">Inactive</span>'}<span>${esc(detail)}</span></span>
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
      <p class="muted">Reps appear in the “You” and “Owner rep” dropdowns. If someone leaves, deactivate them so their name stays on their records.</p>
      <form class="rep-form" data-form="rep-new">
        <input name="name" required maxlength="100" placeholder="Rep name" aria-label="Rep name">
        <div class="row2">
          <input name="email" type="email" maxlength="300" placeholder="Email (optional)" aria-label="Email">
          <input name="phone" type="tel" maxlength="300" placeholder="Phone (optional)" aria-label="Phone">
        </div>
        <div class="row-btns"><button type="submit" class="btn btn-sm btn-primary">+ Add rep</button></div>
      </form>
      ${reps.length ? `<ul class="rep-list">${reps.map(repRowHtml).join('')}</ul>` : '<p class="muted">No reps yet.</p>'}
    </div>
    <div class="section">
      <h3>Admin password</h3>
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
    <div class="section"><button class="btn btn-sm" data-rep-act="logout">Log out of admin</button></div>`);
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
      setAdmin(false);
      closePanel();
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

$('#btn-admin').addEventListener('click', async () => {
  if (state.panel?.kind === 'admin') { closePanel(); return; }
  try {
    const me = await (await fetch('/api/admin/me', { cache: 'no-store' })).json();
    state.adminEnvManaged = me.env_managed;
    setAdmin(me.admin);
    if (me.admin) {
      openAdminPanel();
    } else if (!me.configured) {
      toast('Admin isn’t set up yet. Ask whoever runs PSS Connect to set the admin password.', true);
    } else {
      $('#admin-error').hidden = true;
      $('#admin-password').value = '';
      adminDialog.showModal();
    }
  } catch {
    toast('Can’t reach the server', true);
  }
});

adminDialog.addEventListener('click', (evt) => {
  if (evt.target === adminDialog || evt.target.closest('[data-close]')) adminDialog.close();
});

$('#admin-login').addEventListener('submit', async (evt) => {
  evt.preventDefault();
  try {
    await api('POST', '/api/admin/login', { password: $('#admin-password').value });
    adminDialog.close();
    openAdminPanel();
    setAdmin(true);
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

async function refreshAdminStatus() {
  try {
    const me = await (await fetch('/api/admin/me', { cache: 'no-store' })).json();
    state.adminEnvManaged = me.env_managed;
    setAdmin(me.admin);
  } catch { /* offline; sync shows the status */ }
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
  $('#restore-label').hidden = !state.isAdmin;
  $('#csv-owner-note').hidden = state.isAdmin;
  dataDialog.showModal();
}
$('#btn-data').addEventListener('click', openDataDialog);
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
  ensureName();
  const form = new FormData();
  form.append('file', file);
  try {
    const r = await api('POST', '/api/import.csv', form);
    dataDialog.close();
    await sync();
    cy.animate({ fit: { eles: cy.elements(), padding: 50 } }, { duration: 300 });
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
  ensureName();
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
  if (state.connecting) stopConnect();
  else if (state.focusId != null) clearFocus();
  else if (state.panel) closePanel();
  else closeActivity();
});

// ---------- start ----------

buildLegend();
sync();
refreshAdminStatus();

})();
