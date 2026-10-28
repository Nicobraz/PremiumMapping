(() => {
'use strict';

// ---------- constants ----------

// Flows have a page of their own (/flows), opened in its own browser tab.
const FLOWS_PAGE = location.pathname === '/flows';
if (FLOWS_PAGE) { document.body.classList.add('flows-page'); document.title = 'Flows · PSS Connect'; }

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
  transfers: [],        // lead transfer requests
  wingmate: null,       // admin-only Wingmate connection status
  aiAdmin: null,        // admin-only AI assistant settings and usage
  wmInspect: null,      // a pipeline being added: its stages, before saving
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
  moveFor: null,          // contact whose "change company" box is open
  addExistingFor: null,   // company whose "add existing contact" box is open
  addExistingQuery: '',
  flows: null,          // admins: outbound flows and who's in them (/api/flows)
  flowsTab: 'todo',     // 'todo', 'flows' or 'flow' (one flow, state.flowView)
  flowView: null,
  flowEdit: null,       // the flow being built or edited
  enrollFor: null,      // contact whose "add to flow" box is open
  dirFilters: [],       // [{ field, value }] in the Contacts list
  stageFilter: '',
  view: storeGet('pss.view') || 'team',  // 'team', 'mine' or (admins) a rep's name
  viewSets: null,       // { visible, context } node ids when a rep view is on
  mapIds: null,         // node ids drawn on the map (the rest are saved off the map)
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
  $('#ai-tab').hidden = !state.me;
  if (!state.me && typeof setAiOpen === 'function') setAiOpen(false);
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
  loadWmSync();
}

$('#signin-form').addEventListener('submit', async (evt) => {
  evt.preventDefault();
  const err = $('#signin-error');
  err.hidden = true;
  try {
    await api('POST', '/api/login', { email: $('#signin-email').value, password: $('#signin-password').value });
    $('#signin-password').value = '';
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

const accountDialog = $('#account-dialog');
$('#me-chip').addEventListener('click', () => {
  $('#account-name').textContent = state.me ? state.me.name : 'Admin';
  $('#account-email').textContent = state.me ? `Signed in as ${state.me.email}` : 'Signed in with the backup admin password.';
  $('#account-password').hidden = !state.me;
  $('#account-password').reset();
  $('#account-ai').hidden = !state.me;
  if (state.me) loadAiConnections();
  accountDialog.showModal();
});

async function loadAiConnections(method = 'GET') {
  try {
    const data = await api(method, '/api/me/ai-connections');
    $('#ai-url').value = data.url;
    const names = data.connections.map((c) => c.name);
    $('#ai-status').textContent = names.length ? `Connected: ${[...new Set(names)].join(', ')}` : 'No AI assistant connected yet.';
    $('#ai-disconnect').hidden = !names.length;
  } catch (err) { $('#ai-status').textContent = err.message; }
}
$('#ai-copy').addEventListener('click', async () => {
  const input = $('#ai-url');
  try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
  toast('Connector link copied');
});
$('#ai-disconnect').addEventListener('click', async () => {
  if (!confirm('Sign PSS Connect out of Claude and ChatGPT? You can connect again any time.')) return;
  await loadAiConnections('DELETE');
  toast('AI assistants disconnected');
});
accountDialog.addEventListener('click', (evt) => {
  if (evt.target === accountDialog || evt.target.closest('[data-close]')) accountDialog.close();
});
$('#account-password').addEventListener('submit', async (evt) => {
  evt.preventDefault();
  const data = Object.fromEntries(new FormData(evt.target).entries());
  if (data.new_password !== data.confirm) { toast('The two passwords don’t match', true); return; }
  try {
    await api('POST', '/api/me/password', { new_password: data.new_password });
    accountDialog.close();
    toast('Your password was changed');
  } catch (err) { toast(err.message, true); }
});
$('#btn-signout').addEventListener('click', async () => {
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
    // A connection that would run through someone else's dot bends around it.
    { selector: 'edge.detour', style: {
      'curve-style': 'unbundled-bezier', 'control-point-distances': 'data(bend)', 'control-point-weights': 0.5,
    } },
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

// ---------- lines that would cross another dot ----------

// How far a line must stay from a dot's centre (dot radius plus some room for its label).
const clearanceOf = (node) => node.width() / 2 + 12;

// The dots a line passes too close to: how much room is missing and which side of
// the line each sits on (the sign of `side`).
function blockersOf(edge, nodes) {
  const a = edge.source().position();
  const b = edge.target().position();
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return [];
  const found = [];
  for (const node of nodes) {
    if (node === edge.source() || node === edge.target()) continue;
    const p = node.position();
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    if (t <= 0.04 || t >= 0.96) continue;
    const side = (dx * (p.y - a.y) - dy * (p.x - a.x)) / Math.sqrt(len2);  // signed distance from the line
    const room = clearanceOf(node) - Math.abs(side);
    if (room > 0) found.push({ side, room, clearance: clearanceOf(node) });
  }
  return found;
}

function bendBlockedEdges() {
  const nodes = cy.nodes(':visible').toArray();
  const edges = cy.edges(':visible').filter((e) => e.data('rel') !== WORKS_AT);
  cy.batch(() => {
    cy.edges('.detour').forEach((e) => { if (!e.visible() || e.data('rel') === WORKS_AT) e.removeClass('detour'); });
    edges.forEach((edge) => {
      const blocks = blockersOf(edge, nodes);
      if (!blocks.length) { edge.removeClass('detour'); return; }
      // Bend toward the side with fewer dots in the way, far enough to clear the widest one.
      // The curve's middle sits at half the control distance, hence the doubling.
      const lean = blocks.reduce((sum, b) => sum + Math.sign(b.side) * b.room, 0);
      const reach = Math.max(...blocks.map((b) => b.clearance + Math.max(0, Math.sign(b.side) === -Math.sign(lean || 1) ? Math.abs(b.side) : 0)));
      // A positive control distance bends toward positive `side`, so go the other way.
      edge.data('bend', -Math.sign(lean || 1) * 2 * (reach + 10));
      edge.addClass('detour');
    });
  });
}

let bendsQueued = false;
function scheduleBends() {
  if (bendsQueued) return;
  bendsQueued = true;
  requestAnimationFrame(() => { bendsQueued = false; bendBlockedEdges(); });
}
cy.on('position', 'node', scheduleBends);

// ---------- company tag pills ----------
// A node label can only have one style, so company tags are small HTML pills
// laid over the map and kept just under each company's name.
const tagLayer = $('#tag-layer');
const tagPills = new Map();   // company id -> pill element
let tagFrame = 0;

function renderTagPills() {
  const seen = new Set();
  for (const n of mapNodes()) {
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

// Records can be saved but kept off the map (e.g. Wingmate leads before a pipeline's map
// stage). A company off the map still shows when one of its contacts is on it.
function computeMapIds() {
  const ids = new Set();
  for (const n of state.nodes.values()) {
    if (n.off_map) continue;
    ids.add(n.id);
    if (n.type === 'person' && n.company_id != null && state.nodes.has(n.company_id)) ids.add(n.company_id);
  }
  return ids;
}

const onMap = (id) => !state.mapIds || state.mapIds.has(id);
const mapNodes = () => [...state.nodes.values()].filter((n) => onMap(n.id));

function buildElements() {
  const els = [];
  const nodes = mapNodes();
  for (const n of nodes) els.push(nodeElement(n));
  for (const n of nodes) {
    if (n.type === 'person' && n.company_id != null && onMap(n.company_id)) els.push(worksAtElement(n));
  }
  for (const e of state.edges.values()) {
    if (onMap(e.source_id) && onMap(e.target_id)) els.push(edgeElement(e));
  }
  return els;
}

function render() {
  state.mapIds = computeMapIds();
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
  scheduleBends();
  refreshViewOptions();
  applyView();
  renderTagPills();
  applyFilters();
  applyFocus();
  applySearch();
  refreshFilterOptions();
  updateStats();
  $('#empty').hidden = state.mapIds.size > 0;
}

// New nodes (and CSV imports) arrive without coordinates: put people in the next free
// spot under their company and loose nodes in a grid beside the existing map.
function placeUnpositioned() {
  const all = mapNodes();
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
      // In the first free spot of the company's rows of people.
      const taken = all.filter((o) => o !== n && hasPos(o));
      for (let i = 0; !pos; i += 1) {
        const spot = { x: company.x + ((i % ORG.perRow) - (ORG.perRow - 1) / 2) * ORG.personGap,
                       y: company.y + ORG.firstGap + Math.floor(i / ORG.perRow) * ORG.rowGap };
        if (!taken.some((o) => Math.abs(o.x - spot.x) < 40 && Math.abs(o.y - spot.y) < 40)) pos = spot;
      }
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

// Org-chart layout: companies in rows across the top, each company's people beneath it
// in rows of 5, and
// contacts without a company in a block at the bottom. Most recently added or edited
// comes first: companies left to right (a company counts as edited when any of its
// people is), people left to right, row by row. Records that are connected are kept side by side,
// so their lines are short and don't run through other dots.
const ORG = { colWidth: 200, personGap: 150, perRow: 5, firstGap: 110, rowGap: 78, bandGap: 150 };

// Orders items newest first, but walks each group of connected items together so
// every item sits next to one it's linked to.
function chainOrder(items, links, newer) {
  const byId = new Map(items.map((n) => [n.id, n]));
  const seen = new Set();
  const out = [];
  for (const start of [...items].sort(newer)) {
    const stack = [start];
    while (stack.length) {
      const n = stack.pop();
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
      const next = [...(links.get(n.id) || [])].map((id) => byId.get(id))
        .filter((m) => m && !seen.has(m.id)).sort(newer).reverse();
      stack.push(...next);  // the newest neighbour comes off the stack first
    }
  }
  return out;
}

function orgChartPlan() {
  const nodes = mapNodes();
  const companyIds = new Set(nodes.filter((n) => n.type === 'company').map((n) => n.id));
  const staffOf = new Map([...companyIds].map((id) => [id, []]));
  const loose = [];
  for (const n of nodes) {
    if (n.type !== 'person') continue;
    if (staffOf.has(n.company_id)) staffOf.get(n.company_id).push(n);
    else loose.push(n);
  }
  const homeOf = (id) => {
    const n = state.nodes.get(id);
    if (!n) return null;
    if (n.type === 'company') return n.id;
    return staffOf.has(n.company_id) ? n.company_id : 'loose';
  };
  const peopleLinks = new Map();
  const companyLinks = new Map();
  const link = (map, a, b) => {
    if (!map.has(a)) map.set(a, new Set());
    if (!map.has(b)) map.set(b, new Set());
    map.get(a).add(b);
    map.get(b).add(a);
  };
  for (const e of state.edges.values()) {
    const [a, b] = [homeOf(e.source_id), homeOf(e.target_id)];
    if (a == null || b == null) continue;
    if (a === b) link(peopleLinks, e.source_id, e.target_id);           // same company (or both loose)
    else if (a !== 'loose' && b !== 'loose') link(companyLinks, a, b);  // across companies
  }
  const newest = (x, y) => String(y.updated_at).localeCompare(String(x.updated_at)) || byName(x, y);
  const latest = new Map([...companyIds].map((id) => [id, staffOf.get(id).reduce(
    (t, p) => (String(p.updated_at) > t ? String(p.updated_at) : t), String(state.nodes.get(id).updated_at))]));
  const newestCompany = (x, y) => latest.get(y.id).localeCompare(latest.get(x.id)) || byName(x, y);
  const companies = chainOrder([...companyIds].map((id) => state.nodes.get(id)), companyLinks, newestCompany);
  return {
    columns: companies.map((c) => ({ company: c, staff: chainOrder(staffOf.get(c.id), peopleLinks, newest) })),
    loose: chainOrder(loose, peopleLinks, newest),
  };
}

// Tries a range of row widths and keeps the one whose overall shape best matches the screen.
function orgChartPositions() {
  const plan = orgChartPlan();
  const aspect = Math.max(0.5, cy.width() / Math.max(1, cy.height()));
  let best = null;
  for (let width = 600; width <= 8000; width += 200) {
    const layout = orgChartFor(plan, width);
    const score = Math.abs(Math.log((layout.width / Math.max(layout.height, 1)) / aspect));
    if (!best || score < best.score - 0.01) best = { ...layout, score };
  }
  return best.pos;
}

function orgChartFor(plan, maxWidth) {
  const pos = {};
  let x = 0;
  let y = 0;
  let bandHeight = 0;
  for (const { company, staff } of plan.columns) {
    const across = Math.max(1, Math.min(staff.length, ORG.perRow));
    const width = ORG.colWidth + (across - 1) * ORG.personGap;
    if (x > 0 && x + width > maxWidth) {  // start a new band of companies
      y += bandHeight + ORG.bandGap;
      x = 0;
      bandHeight = 0;
    }
    const middle = x + width / 2;
    pos[company.id] = { x: middle, y };
    staff.forEach((p, i) => {
      const row = Math.floor(i / ORG.perRow);
      const inRow = Math.min(ORG.perRow, staff.length - row * ORG.perRow);  // a short last row is centred too
      pos[p.id] = { x: middle + ((i % ORG.perRow) - (inRow - 1) / 2) * ORG.personGap,
                    y: y + ORG.firstGap + row * ORG.rowGap };
    });
    const rows = Math.ceil(staff.length / ORG.perRow);
    bandHeight = Math.max(bandHeight, rows ? ORG.firstGap + (rows - 1) * ORG.rowGap : 0);
    x += width;
  }
  let widest = Math.max(x, ORG.colWidth);
  let bottom = y + bandHeight;
  if (plan.loose.length) {
    const top = plan.columns.length ? bottom + ORG.bandGap : 0;
    const perRow = Math.max(4, Math.floor(Math.max(maxWidth, widest) / ORG.colWidth));
    plan.loose.forEach((p, i) => {
      pos[p.id] = { x: ORG.colWidth / 2 + (i % perRow) * ORG.colWidth, y: top + Math.floor(i / perRow) * ORG.rowGap };
    });
    widest = Math.max(widest, Math.min(plan.loose.length, perRow) * ORG.colWidth);
    bottom = top + Math.floor((plan.loose.length - 1) / perRow) * ORG.rowGap;
  }
  return { pos, width: widest, height: bottom + ORG.rowGap };
}

function runLayout(randomize) {
  if (!cy.nodes().length) return;
  const target = orgChartPositions();
  const layout = cy.layout({
    name: 'preset',
    positions: (el) => target[el.data('nid')] || el.position(),
    animate: !randomize,
    animationDuration: 600,
    fit: true,
    padding: 50,
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
    state.transfers = data.transfers || [];
    renderRequestsBadge();
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
  return onMap(id) && inRepView(id);
}

function inRepView(id) {
  const v = state.viewSets;
  return !v || v.visible.has(id) || v.context.has(id);
}

function applyView() {
  scheduleBends();
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
  scheduleBends();
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
  return [...state.nodes.values()].filter((n) => inRepView(n.id)).filter((n) =>
    [n.name, n.title, n.email, n.type === 'company' ? n.tags : '', n.location, n.owner_rep, n.notes].some((v) => String(v || '').toLowerCase().includes(q))
    || (state.noteText.get(n.id) || '').includes(q));
}

function applySearch() {
  const matches = searchMatches();
  cy.nodes().removeClass('match');
  for (const n of matches) cy.getElementById(`n${n.id}`).addClass('match');
  const q = $('#search').value.trim();
  const off = matches.filter((n) => !onMap(n.id)).length;
  $('#search-count').textContent = q ? `${matches.length} found${off ? ` (${off} not on the map)` : ''}` : '';
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
  // On the Flows page, closing a contact's card goes back to the flows; closing them goes to the map.
  if (FLOWS_PAGE && state.isAdmin) {
    if (state.panel?.kind === 'flows') { location.href = '/'; return; }
    if (state.panel) { openFlowsPanel(state.flowsTab); return; }
  }
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
  panel.dataset.kind = desc.kind || '';
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
  if (n.type === 'company') {
    btns.push('<button class="btn btn-sm btn-primary" data-act="add-person-here">+ Add person</button>');
    if (state.me || state.isAdmin) btns.push('<button class="btn btn-sm" data-act="add-existing" title="Put a contact who\'s already in PSS Connect at this company">+ Add existing contact</button>');
  }
  if (n.type === 'person' && canEditNode(n)) {
    btns.push(`<button class="btn btn-sm" data-act="move-company">${n.company_id != null ? 'Change company' : 'Add to a company'}</button>`);
  }
  if (n.email) btns.push(`<a class="btn btn-sm" href="mailto:${esc(n.email)}">Email</a>`);
  if (n.phone) btns.push(`<a class="btn btn-sm" href="tel:${esc(n.phone.replace(/[^\d+]/g, ''))}">Call</a>`);
  if (onMap(n.id)) {
    btns.push('<button class="btn btn-sm" data-act="show-map">Show on map</button>');
  } else {
    btns.push(`<button class="btn btn-sm btn-primary" data-act="on-map" title="Draw ${n.type === 'company' ? 'this company and its contacts' : 'this contact (and its company)'} on the map">+ Put on the map</button>`);
  }
  if (n.type === 'person') {
    btns.push(`<button class="btn btn-sm ${n.priority ? 'btn-priority' : ''}" data-act="priority" aria-pressed="${!!n.priority}" title="Anyone can flag a contact as high priority">${n.priority ? '★ High priority' : '☆ Mark high priority'}</button>`);
  }
  btns.push(`<button class="btn btn-sm" data-act="color" title="Change this card's color (everyone sees it)"><span class="swatch-dot" style="background:${nodeColor(n)}"></span>Color</button>`);
  if (canEditNode(n)) btns.push('<button class="btn btn-sm" data-act="edit">Edit</button>');
  if (canEditNode(n) && n.type === 'person') btns.push('<button class="btn btn-sm" data-act="merge" title="Fold a duplicate of this contact into it">Merge…</button>');
  if (state.isAdmin && n.type === 'person') btns.push('<button class="btn btn-sm" data-flow-act="enroll-card" title="Add this contact to an outbound flow">Add to flow</button>');
  if (onMap(n.id) && (state.me || state.isAdmin)) btns.push(`<button class="btn btn-sm btn-ghost" data-act="off-map" title="Keep it in PSS Connect and searchable, but don't draw it${n.type === 'company' ? ' (or its contacts)' : ''}">Take off map</button>`);
  const offMap = onMap(n.id) ? ''
    : `<div class="off-map-note">Not on the map${n.stage ? ` (stage: ${esc(n.stage)})` : ''}. It's saved and searchable; put it on the map to see it there.</div>`;
  const viewOnly = canEditNode(n) ? ''
    : `<div class="view-only">View only · ${n.owner_rep ? `assigned to ${esc(n.owner_rep)}` : 'unassigned'}. You can still add tags, notes, connections, change its color${n.type === 'person' ? ' or flag it high priority' : ''}.</div>`;
  const picker = state.colorPickerFor === n.id ? `<div class="color-picker" role="group" aria-label="Card color">
      ${CARD_COLORS.map((c) => `<button type="button" class="color-swatch ${n.color === c ? 'on' : ''}" data-color="${c}" style="background:${c}" aria-label="Color ${c}"></button>`).join('')}
      <button type="button" class="btn btn-sm btn-ghost" data-color="">${n.type === 'person' ? 'Use company color' : 'Default'}</button>
    </div>` : '';
  const mine = myTransferRequest(n.id);
  if (mine) {
    btns.push(`<button class="btn btn-sm btn-pending" data-act="cancel-transfer" data-transfer="${mine.id}" title="Cancel your request">⏳ Transfer requested · Cancel</button>`);
  } else if (state.me && !canEditNode(n) && n.owner_rep !== myName()) {
    btns.push('<button class="btn btn-sm" data-act="request-transfer" title="Ask the owner (or an admin) to give you this lead">Request transfer</button>');
  }
  return `${offMap}<div class="card-actions">${btns.join('')}</div>${cardFlowsHtml(n)}${picker}${transferBannerHtml(n)}${viewOnly}`;
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

function offMapBadge(n) {
  return onMap(n.id) ? '' : ' <span class="off-map-chip" title="Saved, but not drawn on the map">Not on map</span>';
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

// ----- moving contacts between companies -----

function companyByName(name) {
  const target = name.trim().toLowerCase();
  return [...state.nodes.values()].find((c) => c.type === 'company' && c.name.trim().toLowerCase() === target) || null;
}

function moveBoxHtml(n) {
  if (state.moveFor !== n.id) return '';
  const current = companyOf(n);
  const options = [...state.nodes.values()].filter((c) => c.type === 'company' && c.id !== n.company_id).sort(byName);
  return `<form class="move-box" data-form="move-company">
    <label><span>${current ? `Moving from <b>${esc(current.name)}</b> to` : `Put ${esc(n.name)} at`}</span>
      <input name="company" list="move-company-list" required autocomplete="off" placeholder="Type or pick a company"></label>
    <datalist id="move-company-list">${options.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
    <p class="muted move-hint">Pick a company, or type a new name to add it.</p>
    ${current ? `<label class="check"><input type="checkbox" name="note" checked> Add a note: “Moved from ${esc(current.name)}”</label>` : ''}
    <div class="row-btns">
      <button type="submit" class="btn btn-sm btn-primary">Save</button>
      <button type="button" class="btn btn-sm" data-act="cancel-move">Cancel</button>
      ${current ? `<button type="button" class="btn btn-sm btn-danger-ghost" data-act="remove-company">Remove from ${esc(current.name)}</button>` : ''}
    </div>
  </form>`;
}

function updateMoveHint(form) {
  const typed = form.elements.company.value.trim();
  const hint = form.querySelector('.move-hint');
  const match = typed && companyByName(typed);
  hint.textContent = !typed ? 'Pick a company, or type a new name to add it.'
    : match ? `Existing company${match.location ? ` · ${match.location}` : ''}`
    : `“${typed}” isn’t in PSS Connect yet. Saving adds it as a new company.`;
}

function addExistingHtml(n) {
  if (state.addExistingFor !== n.id) return '';
  return `<div class="add-existing">
    <input type="search" id="add-existing-q" placeholder="Search contacts to add…" autocomplete="off" value="${esc(state.addExistingQuery)}">
    <ul class="conn-list add-existing-list">${addExistingListHtml(n)}</ul>
    ${state.isAdmin ? '' : '<p class="muted">Shows contacts assigned to you. Ask the owner or an admin to move anyone else.</p>'}
    <div class="row-btns"><button type="button" class="btn btn-sm" data-act="cancel-add-existing">Done</button></div>
  </div>`;
}

function addExistingListHtml(n) {
  const words = state.addExistingQuery.toLowerCase().split(/\s+/).filter(Boolean);
  const pool = [...state.nodes.values()].filter((p) => p.type === 'person' && p.company_id !== n.id && canEditNode(p));
  const matches = pool.filter((p) => {
    const hay = [p.name, p.title, p.email, companyOf(p)?.name].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  }).sort(byName).slice(0, 40);
  if (!matches.length) return `<li class="muted">${pool.length ? 'No matches.' : 'No contacts to add.'}</li>`;
  return matches.map((p) => {
    const at = companyOf(p);
    const detail = [p.title, at ? `at ${at.name}` : 'No company'].filter(Boolean).join(' · ');
    return `<li>${avatar(p, 'avatar-sm')}<span class="who"><b>${esc(p.name)}</b><span>${esc(detail)}</span></span>
      <button type="button" class="btn btn-sm" data-add-existing="${p.id}">${at ? 'Move here' : 'Add'}</button></li>`;
  }).join('');
}

async function moveContact(personId, body, message) {
  try {
    await api('POST', `/api/nodes/${personId}/company`, body);
    await sync();
    rerenderCard();
    toast(message);
  } catch (err) { toast(err.message, true); }
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
    + moveBoxHtml(n)
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
    <span class="who"><b>${esc(p.name)}</b>${stageBadge(p)}${offMapBadge(p)}${detail ? `<span>${esc(detail)}</span>` : ''}</span>
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
    + addExistingHtml(n)
    + factsHtml(n, ['Location'])
    + aboutHtml(n)
    + `<div class="section">
        <h3>People at ${esc(n.name)} <span>${staff.length}</span></h3>
        ${staff.length
          ? `<ul class="conn-list roster">${staff.map((p) => rosterRowHtml(p, staffIds)).join('')}</ul>`
          : '<p class="muted">No one added yet. Use “+ Add person” or “+ Add existing contact”.</p>'}
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
  if (state.moveFor !== id) state.moveFor = null;
  if (state.addExistingFor !== id) { state.addExistingFor = null; state.addExistingQuery = ''; }
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

// ----- lead transfer requests -----
// Reps ask for leads that belong to someone else; the owner (or an admin; only
// an admin for unassigned leads) approves or declines.

function myTransferRequest(nodeId) {
  return state.transfers.find((t) => t.node_id === nodeId && t.status === 'pending' && t.to_rep === myName());
}

function canDecideTransfer(t) {
  return state.isAdmin || (!!myName() && !!t.from_rep && t.from_rep === myName());
}

function incomingTransfers() {
  return state.transfers.filter((t) => t.status === 'pending' && canDecideTransfer(t) && t.to_rep !== myName());
}

function transferBannerHtml(n) {
  const waiting = state.transfers.filter((t) => t.node_id === n.id && t.status === 'pending' && canDecideTransfer(t));
  return waiting.map((t) => `<div class="transfer-banner">
      <div><b>${esc(t.to_rep)}</b> asked for this lead${n.type === 'company' && t.from_rep ? ` (and ${esc(t.from_rep)}'s contacts here)` : ''}.
        ${t.reason ? `<span class="muted">“${esc(t.reason)}”</span>` : ''}</div>
      <div class="row-btns">
        <button type="button" class="btn btn-sm btn-primary" data-act="approve-transfer" data-transfer="${t.id}">Approve</button>
        <button type="button" class="btn btn-sm" data-act="decline-transfer" data-transfer="${t.id}">Decline</button>
      </div>
    </div>`).join('');
}

async function decideTransfer(id, action) {
  const t = state.transfers.find((x) => x.id === id);
  if (action === 'approve' && t && !confirm(`Give ${state.nodes.get(t.node_id)?.name || 'this lead'} to ${t.to_rep}?`)) return;
  try {
    const r = await api('POST', `/api/transfers/${id}/${action}`);
    await sync();
    if (state.panel?.kind === 'node') rerenderCard();
    if (state.panel?.kind === 'requests') openRequestsPanel(true);
    toast({ approved: `Transferred to ${r.to_rep}`, declined: 'Request declined', cancelled: 'Request cancelled' }[r.status] || 'Done');
  } catch (err) { toast(err.message, true); }
}

function renderRequestsBadge() {
  const count = incomingTransfers().length;
  $('#btn-requests').hidden = !count && !state.transfers.some((t) => t.to_rep === myName() && t.status === 'pending');
  $('#requests-count').textContent = count || '';
  $('#requests-count').hidden = !count;
  $('#sheet-requests-count').textContent = count;
  $('#sheet-requests-count').hidden = !count;
  $('#nav-requests-dot').hidden = !count;
}

function openRequestsPanel(keepScroll) {
  const scroll = panel.scrollTop;
  const name = (t) => state.nodes.get(t.node_id)?.name || 'A deleted lead';
  const when = (iso) => esc(timeAgo(iso));
  const incoming = incomingTransfers();
  const mine = state.transfers.filter((t) => t.to_rep === myName())
    .sort((a, b) => b.id - a.id).slice(0, 20);
  const STATUS = { pending: 'Waiting', approved: 'Approved', declined: 'Declined', cancelled: 'Cancelled' };
  showPanel({ kind: 'requests' }, `${panelHead('', '', 'Transfer requests')}
    <div class="section">
      <h3>Waiting for you <span>${incoming.length}</span></h3>
      ${incoming.length ? `<ul class="conn-list request-list">${incoming.map((t) => `<li>
          <span class="who"><b data-goto="${t.node_id}" class="request-lead">${esc(name(t))}</b>
            <span>${esc(t.to_rep)} asked ${when(t.created_at)}${t.from_rep ? ` · now ${esc(t.from_rep)}'s` : ' · unassigned'}</span>
            ${t.reason ? `<span class="request-reason">“${esc(t.reason)}”</span>` : ''}</span>
          <span class="row-btns">
            <button type="button" class="btn btn-sm btn-primary" data-act="approve-transfer" data-transfer="${t.id}">Approve</button>
            <button type="button" class="btn btn-sm" data-act="decline-transfer" data-transfer="${t.id}">Decline</button>
          </span></li>`).join('')}</ul>` : '<p class="muted">Nothing to decide.</p>'}
    </div>
    ${state.me ? `<div class="section">
      <h3>Your requests</h3>
      ${mine.length ? `<ul class="conn-list request-list">${mine.map((t) => `<li>
          <span class="who"><b data-goto="${t.node_id}" class="request-lead">${esc(name(t))}</b>
            <span>${STATUS[t.status] || t.status} · asked ${when(t.created_at)}${t.from_rep ? ` from ${esc(t.from_rep)}` : ''}</span></span>
          ${t.status === 'pending' ? `<button type="button" class="btn btn-sm btn-ghost" data-act="cancel-transfer" data-transfer="${t.id}">Cancel</button>` : ''}
        </li>`).join('')}</ul>` : '<p class="muted">To ask for a lead that belongs to someone else, open it and tap <b>Request transfer</b>.</p>'}
    </div>` : ''}`);
  if (keepScroll) panel.scrollTop = scroll;
}

$('#btn-requests').addEventListener('click', () => {
  if (state.panel?.kind === 'requests') closePanel(); else openRequestsPanel();
});

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
  ['company', 'Company'], ['priority', 'Priority'], ['tag', 'Tag'], ['city', 'City'], ['rep', 'Rep'], ['stage', 'Stage'], ['map', 'Map'],
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
    case 'stage': return [...new Set(staff.map((p) => p.stage.trim()).filter(Boolean))];
    case 'map': return [onMap(n.id) ? 'On the map' : 'Not on the map'];
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
  const countLine = `<li class="dir-count muted">${plural(items.length, kind[0], kind[1])}${state.dirFilters.length ? ' match' : ''}${bulkFlowHtml(items.length)}</li>`;
  if (state.dirTab === 'companies') {
    list.innerHTML = countLine + (items.length ? items.map((c) => {
      const detail = [plural(peopleAt(c.id).length, 'contact', 'contacts'), c.location, c.owner_rep].filter(Boolean).join(' · ');
      return `<li data-goto="${c.id}">${avatar(c, 'avatar-sm')}<span class="who"><b>${esc(c.name)}</b>${offMapBadge(c)}<span>${esc(detail)}</span>${tagChipsHtml(c)}</span></li>`;
    }).join('') : '<li class="muted">No companies match.</li>');
  } else {
    list.innerHTML = countLine + (items.length ? items.map((p) => {
      const detail = [p.title, companyOf(p)?.name, p.owner_rep || 'Unassigned'].filter(Boolean).join(' · ');
      return `<li data-goto="${p.id}">${avatar(p, 'avatar-sm')}<span class="who"><b>${esc(p.name)}</b>${stageBadge(p)}${offMapBadge(p)}<span>${esc(detail)}</span></span></li>`;
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
  if (p.kind === 'requests') { openRequestsPanel(true); return; }
  if (p.kind === 'flows') { if (!state.panelDirty && !panel.querySelector('.flow-task :focus')) renderFlowsPanel(); return; }
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
  if (evt.target.id === 'add-existing-q') {
    state.addExistingQuery = evt.target.value;
    const company = state.nodes.get(state.addExistingFor);
    if (company) panel.querySelector('.add-existing-list').innerHTML = addExistingListHtml(company);
    return;
  }
  if (evt.target.closest('.move-box')) { updateMoveHint(evt.target.form); return; }
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
  if (evt.target.closest('[data-ai-admin="off"]')) {
    if (!confirm('Turn off the AI assistant for everyone?')) return;
    try {
      state.aiAdmin = await api('POST', '/api/assistant/settings', { disconnect: true });
      $('#ai-admin-section').innerHTML = aiAdminHtml();
      ai.enabled = null;
    } catch (err) { toast(err.message, true); }
    return;
  }
  const addBtn = evt.target.closest('[data-add-existing]');
  if (addBtn && p?.id) {
    const person = state.nodes.get(Number(addBtn.dataset.addExisting));
    const company = state.nodes.get(p.id);
    const from = companyOf(person);
    await moveContact(person.id, { company_id: company.id, note: true },
      from ? `Moved ${person.name} from ${from.name} to ${company.name}` : `Added ${person.name} to ${company.name}`);
    return;
  }
  const wmRemove = evt.target.closest('[data-wm-remove]');
  if (wmRemove) {
    if (!confirm('Stop syncing this pipeline? Companies and people already synced stay on the map.')) return;
    try {
      state.wingmate = await api('DELETE', `/api/wingmate/pipelines/${encodeURIComponent(wmRemove.dataset.wmRemove)}`);
      renderWingmateSection();
    } catch (err) { toast(err.message, true); }
    return;
  }
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
  else if (act === 'on-map' || act === 'off-map') {
    const n = state.nodes.get(p.id);
    const on = act === 'on-map';
    if (!on && !confirm(`Take ${n.name}${n.type === 'company' ? ' and its contacts' : ''} off the map? Nothing is deleted: it stays in Contacts and search, and anyone can put it back.`)) return;
    try {
      await api('POST', `/api/nodes/${n.id}/display`, { on_map: on });
      await sync();
      rerenderCard();
      if (on) focusOn(n.id);
      toast(on ? `${n.name} is on the map` : `${n.name} is off the map`);
    } catch (err) { toast(err.message, true); }
  }
  else if (act === 'add-person-here') openNewNodePanel('person', p.id);
  else if (act === 'move-company' || act === 'cancel-move') {
    state.moveFor = act === 'move-company' && state.moveFor !== p.id ? p.id : null;
    rerenderCard();
    panel.querySelector('.move-box input[name="company"]')?.focus();
  } else if (act === 'remove-company') {
    const n = state.nodes.get(p.id);
    const old = companyOf(n);
    if (!confirm(`Take ${n.name} off ${old.name}? They stay in PSS Connect with no company.`)) return;
    const note = panel.querySelector('.move-box input[name="note"]')?.checked ?? true;
    state.moveFor = null;
    await moveContact(n.id, { remove: true, note }, `${n.name} removed from ${old.name}`);
  } else if (act === 'add-existing' || act === 'cancel-add-existing') {
    state.addExistingFor = act === 'add-existing' && state.addExistingFor !== p.id ? p.id : null;
    state.addExistingQuery = '';
    rerenderCard();
    if (!isPhone()) panel.querySelector('#add-existing-q')?.focus();
  }
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
  } else if (act === 'request-transfer') {
    const n = state.nodes.get(p.id);
    const to = n.owner_rep ? n.owner_rep : 'an admin';
    const reason = prompt(`Ask ${to} to give you ${n.name}?\n\nAdd a reason (optional):`, '');
    if (reason === null) return;
    try {
      await api('POST', `/api/nodes/${p.id}/transfer-request`, { reason });
      await sync();
      rerenderCard();
      toast(`Request sent to ${to}`);
    } catch (err) { toast(err.message, true); }
  } else if (act === 'cancel-transfer' || act === 'approve-transfer' || act === 'decline-transfer') {
    await decideTransfer(Number(evt.target.closest('[data-transfer]').dataset.transfer), act.split('-')[0]);
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
    if (form.dataset.form.startsWith('flow-')) {
      await submitFlowForm(form, data);
    } else if (form.dataset.form === 'move-company') {
      const n = state.nodes.get(p.id);
      const typed = data.company.trim();
      const match = companyByName(typed);
      if (match && match.id === n.company_id) { toast(`${n.name} is already at ${match.name}`); return; }
      const from = companyOf(n);
      state.moveFor = null;
      state.panelDirty = false;
      await moveContact(n.id, { ...(match ? { company_id: match.id } : { company_name: typed }), note: 'note' in data },
        from ? `Moved ${n.name} to ${match ? match.name : typed}` : `Added ${n.name} to ${match ? match.name : typed}`);
    } else if (form.dataset.form === 'ai-settings') {
      state.aiAdmin = await api('POST', '/api/assistant/settings', { api_key: data.api_key });
      state.panelDirty = false;
      $('#ai-admin-section').innerHTML = aiAdminHtml();
      ai.enabled = null;
      toast('AI assistant is on');
    } else if (form.dataset.form === 'wm-pipeline-check') {
      const info = await api('POST', '/api/wingmate/pipelines/inspect', { token: data.token, campaign_id: data.campaign_id });
      state.wmInspect = { ...info, token: data.token };
      state.panelDirty = false;
      renderWingmateSection();
    } else if (form.dataset.form === 'wm-pipeline-save') {
      const i = state.wmInspect;
      state.wingmate = await api('POST', '/api/wingmate/pipelines', { token: i.token, campaign_id: i.campaign_id,
        from_stage: data.from_stage === 'never' ? '' : data.from_stage, keep_off_map: data.from_stage === 'never' });
      state.wmInspect = null;
      state.wmFound = null;
      state.panelDirty = false;
      renderWingmateSection();
      toast(`Added ${i.name || 'the pipeline'}. Use Preview, then Sync now.`);
    } else if (form.dataset.form === 'wingmate-settings') {
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
      <label class="check"><input type="checkbox" name="is_admin" ${r.is_admin ? 'checked' : ''}> Admin <small>(manage reps, reassign leads)</small></label>
      <input class="rep-pass" name="password" type="password" minlength="6" autocomplete="new-password" placeholder="New password (leave blank to keep)" aria-label="New password">
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
      <button class="btn btn-sm btn-ghost" data-rep-act="reset" data-rep="${r.id}" title="Set their password back to Firstname123">Reset password</button>
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
      <label class="check"><input type="checkbox" name="is_admin" > Admin <small>(manage reps, reassign leads)</small></label>
      <input class="rep-pass" name="password" type="password" minlength="6" autocomplete="new-password" placeholder="Password (leave blank for Firstname123)" aria-label="Password">
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
    <div class="section" id="ai-admin-section">${aiAdminHtml()}</div>
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
  loadAiAdmin();
}

// ----- AI assistant (admin) -----

async function loadAiAdmin() {
  try { state.aiAdmin = await api('GET', '/api/assistant/settings'); } catch { state.aiAdmin = null; }
  const box = $('#ai-admin-section');
  if (box) box.innerHTML = aiAdminHtml();
}

function aiAdminHtml() {
  const a = state.aiAdmin;
  if (!a) return '<h3>AI assistant</h3><p class="muted">Loading…</p>';
  const usage = a.usage;
  const money = (n) => `$${n.toFixed(2)}`;
  const reps = usage.by_rep.length
    ? `<ul class="ai-usage">${usage.by_rep.map((r) => `<li>${esc(r.name)}: ${plural(r.questions, 'question', 'questions')}, ${money(r.cost)}</li>`).join('')}</ul>` : '';
  const form = a.env_managed ? '<p class="muted">The key is set in Render (ANTHROPIC_API_KEY). Change it there.</p>'
    : `<form class="rep-form" data-form="ai-settings">
        <input name="api_key" type="password" required autocomplete="off" placeholder="${a.configured ? `Anthropic API key (saved, ending ${esc(a.key_hint)})` : 'Anthropic API key (sk-ant-…)'}" aria-label="Anthropic API key">
        <div class="row-btns"><button type="submit" class="btn btn-sm btn-primary">${a.configured ? 'Replace key' : 'Save & turn on'}</button>
        ${a.configured ? '<button type="button" class="btn btn-sm btn-danger-ghost" data-ai-admin="off">Turn off</button>' : ''}</div>
        <p class="muted">Create a key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a> → API keys, and add billing there. You can set a monthly spend limit in the Console.</p>
      </form>`;
  return `<h3>AI assistant ${a.configured ? '<span class="pill pill-company">On</span>' : ''}</h3>
    <p class="muted">The “Ask AI” tab: reps chat with ${esc(a.model)} inside PSS Connect. It works as the rep (same permissions, no deleting) and is paid from the team’s Anthropic account. Up to ${a.daily_limit} questions per rep per day.</p>
    ${a.configured ? `<p class="wm-result">This month: ${plural(usage.questions, 'question', 'questions')}, about ${money(usage.cost)}.</p>${reps}` : ''}
    ${form}`;
}

// ----- Wingmate -----

const WM_LABELS = [
  ['companies_added', 'company added', 'companies added'], ['companies_linked', 'company linked', 'companies linked'],
  ['companies_updated', 'company updated', 'companies updated'], ['people_added', 'person added', 'people added'],
  ['people_linked', 'person linked', 'people linked'], ['people_updated', 'person updated', 'people updated'],
  ['notes_added', 'note added', 'notes added'], ['notes_moved', 'note moved to its contact', 'notes moved to their contacts'],
  ['put_on_map', 'lead reached the map stage', 'leads reached the map stage'],
  ['flow_added', 'contact added to a flow', 'contacts added to flows'],
];

function wingmateCounts(r, preview) {
  const parts = WM_LABELS.filter(([key]) => r[key]).map(([key, one, many]) =>
    `${r[key]} ${(r[key] === 1 ? one : many).replace(preview ? /added|linked|updated/ : /$^/, (w) => `to be ${w}`)}`);
  if (preview && r.notes_to_check) parts.push(`notes checked on ${plural(r.notes_to_check, 'company', 'companies')}`);
  if (r.off_map) parts.push(`${plural(r.off_map, 'lead', 'leads')} kept off the map`);
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
    ${extraPipelinesHtml(w)}
    ${w.cron_url ? `<details class="wm-cron"><summary>Sync even when nobody has the site open</summary>
      <p class="muted">The free server sleeps after 15 minutes without visitors. Add this link to a free scheduler such as cron-job.org, set to every 15 minutes, to keep syncing around the clock:</p>
      <input readonly value="${esc(w.cron_url)}" aria-label="Wingmate sync link" onclick="this.select()"></details>` : ''}`;
}

function extraPipelinesHtml(w) {
  const list = w.extra_pipelines || [];
  const rows = list.map((p) => `<li><span><b>${esc(p.name || p.campaign_id)}</b>
      <span class="muted"> · all contacts; ${p.keep_off_map ? 'kept off the map' : `on the map ${p.from_stage ? `from “${esc(p.from_stage)}” on` : 'at every stage'}`}</span></span>
      <button type="button" class="link-btn" data-wm-remove="${esc(p.campaign_id)}">Remove</button></li>`).join('');
  const i = state.wmInspect;
  const pick = i ? `<form class="rep-form" data-form="wm-pipeline-save">
      <p><b>${esc(i.name || i.campaign_id)}</b> · ${plural(i.leads, 'lead', 'leads')}</p>
      <label class="wm-stage">Show on the map from this stage on
        <select name="from_stage">
          <option value="">Every stage</option>
          ${i.stages.map((st) => `<option value="${esc(st.name)}">${esc(st.name)} (${st.leads})</option>`).join('')}
          <option value="never">Never: keep them all off the map</option>
        </select></label>
      <p class="muted">Stages are listed in pipeline order. Every lead and contact comes into PSS Connect and can be searched; ones before the stage you pick are kept off the map until they reach it (or someone puts them on it). <b>Never</b> suits a cold outreach list: its contacts go on the map once they show up in another pipeline, such as the main one.</p>
      <div class="row-btns"><button type="submit" class="btn btn-sm btn-primary">Save pipeline</button>
        <button type="button" class="btn btn-sm btn-ghost" data-wm-act="cancel-pipeline">Cancel</button></div>
    </form>` : `${wmFoundHtml()}<form class="rep-form" data-form="wm-pipeline-check">
      <input name="campaign_id" required placeholder="Campaign (pipeline) ID" aria-label="Campaign ID">
      <input name="token" type="password" autocomplete="off" placeholder="API token (blank: use the main one)" aria-label="Pipeline API token">
      <p class="muted">A company API token reads every pipeline, so leave the token blank unless this pipeline has its own.</p>
      <div class="row-btns"><button type="submit" class="btn btn-sm">Check pipeline</button></div>
    </form>`;
  return `<div class="wm-pipelines">
    <h4>Other pipelines</h4>
    ${rows ? `<ul class="wm-pipeline-list">${rows}</ul>` : '<p class="muted">Only the main pipeline syncs.</p>'}
    <details ${i || state.wmFound ? 'open' : ''}><summary>+ Add another pipeline</summary>${pick}</details>
  </div>`;
}

function wmFoundHtml() {
  const f = state.wmFound;
  const btn = `<div class="row-btns"><button type="button" class="btn btn-sm btn-primary" data-wm-act="discover" ${f === 'loading' ? 'disabled' : ''}>${f === 'loading' ? 'Looking…' : 'Find my pipelines'}</button></div>`;
  if (!f || f === 'loading') return btn;
  if (f.error) return `${btn}<p class="error-text">${esc(f.error)}</p>`;
  if (!f.pipelines.length) return `${btn}<p class="muted">No other pipelines found. Enter a campaign ID below.</p>`;
  return `${btn}<ul class="wm-pipeline-list">${f.pipelines.map((p) => `<li><span><b>${esc(p.name || p.campaign_id)}</b>
        ${p.needs_token ? '<span class="muted"> · needs its own API token</span>' : ''}</span>
      <button type="button" class="btn btn-sm" data-wm-act="${p.needs_token ? 'fill' : 'pick'}:${esc(p.campaign_id)}">Add</button></li>`).join('')}</ul>
    ${f.pipelines.some((p) => p.needs_token) ? '<p class="muted">The main pipeline\'s token can\'t read the ones marked; in Wingmate, get that pipeline\'s own API token and paste it below.</p>' : ''}
    <p class="muted">Or enter a campaign ID:</p>`;
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
    if (act === 'discover') {
      state.wmFound = 'loading';
      renderWingmateSection();
      try { state.wmFound = await api('GET', '/api/wingmate/pipelines/discover'); }
      catch (err) { state.wmFound = { error: err.message }; }
      renderWingmateSection();
    } else if (act.startsWith('pick:')) {
      const info = await api('POST', '/api/wingmate/pipelines/inspect', { campaign_id: act.slice(5) });
      state.wmInspect = { ...info, token: '' };
      renderWingmateSection();
    } else if (act.startsWith('fill:')) {
      const form = $('[data-form=wm-pipeline-check]');
      form.campaign_id.value = act.slice(5);
      form.token.required = true;
      form.token.placeholder = 'That pipeline\'s API token';
      form.token.focus();
    } else if (act === 'cancel-pipeline') {
      state.wmInspect = null;
      renderWingmateSection();
    } else if (act === 'edit' || act === 'cancel-edit') {
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
    if (act === 'reset') {
      const first = rep.name.trim().split(/\s+/)[0] || 'Rep';
      const pw = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() + '123';
      if (!confirm(`Reset ${rep.name}'s password to ${pw}?`)) return;
      await api('PATCH', `/api/reps/${id}`, { reset_password: true });
      toast(`${rep.name}'s password is now ${pw}`);
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
  renderFlowsBadge();
  if (on) loadFlows();
  if (on && FLOWS_PAGE && !state.panel) openFlowsPanel();
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
  if (state.isAdmin) loadBackups();
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

const BACKUP_KINDS = { nightly: 'Nightly', manual: 'Saved by hand', 'before-restore': 'Before a restore' };

async function loadBackups() {
  const list = $('#backup-list');
  list.innerHTML = '<li class="muted">Loading…</li>';
  try {
    const { backups } = await api('GET', '/api/backups');
    list.innerHTML = backups.length ? backups.slice(0, 40).map((b) => `<li>
        <span class="who"><b>${esc(new Date(b.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</b>
          <span>${esc(BACKUP_KINDS[b.kind] || b.kind)} · ${Math.max(1, Math.round(b.size / 1024))} KB</span></span>
        <a class="btn btn-sm btn-ghost" href="/api/backups/${b.id}.json" download>Download</a>
        <button type="button" class="btn btn-sm btn-danger-ghost" data-restore-backup="${b.id}">Restore</button>
      </li>`).join('') : '<li class="muted">No backups yet. The first nightly copy is saved within the hour.</li>';
  } catch (err) {
    list.innerHTML = `<li class="muted">${esc(err.message)}</li>`;
  }
}

async function afterRestore(r) {
  dataDialog.close();
  closePanel();
  state.firstLoad = true;
  await sync();
  toast(`Restored ${r.nodes} records and ${r.edges} connections`);
}

$('#btn-backup-now').addEventListener('click', async () => {
  try {
    await api('POST', '/api/backups');
    await loadBackups();
    toast('Backup saved');
  } catch (err) { toast(err.message, true); }
});

$('#backup-list').addEventListener('click', async (evt) => {
  const btn = evt.target.closest('[data-restore-backup]');
  if (!btn) return;
  const when = btn.closest('li').querySelector('b').textContent;
  if (!confirm(`Restore the backup from ${when}?\n\nThis replaces the ENTIRE map for everyone with that copy. The current map is saved first, so you can undo it from this list.`)) return;
  try {
    await afterRestore(await api('POST', `/api/backups/${btn.dataset.restoreBackup}/restore`));
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
    await afterRestore(await api('POST', '/api/import.json', data));
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
  if (confirm('Arrange the whole map as an org chart (companies across the top, their people in a column under each)? This moves everyone\'s nodes for the whole team.')) runLayout(false);
});
$('#empty').addEventListener('click', (evt) => {
  const which = evt.target.closest('[data-empty]')?.dataset.empty;
  if (which === 'company') openNewNodePanel('company');
  else if (which === 'import') openDataDialog();
});

document.addEventListener('keydown', (evt) => {
  if (evt.key !== 'Escape' || dataDialog.open || adminDialog.open || accountDialog.open) return;
  if (!filterMenu.hidden) toggleFilterMenu(false);
  else if (state.connecting) stopConnect();
  else if (state.focusId != null) clearFocus();
  else if (state.panel && !(FLOWS_PAGE && state.panel.kind === 'flows')) closePanel();  // Escape doesn't leave the Flows page
  else closeActivity();
});

// ---------- phone layout: bottom navigation ----------
// On phones the app is list-first (look up and add contacts on the go); the map
// is one tab away.

function isPhone() {
  return phoneQuery.matches;
}

// The screen itself never zooms or slides on a phone; only the map pans and zooms.
// (iOS Safari ignores user-scalable=no, so its pinch gestures are stopped here.)
['gesturestart', 'gesturechange'].forEach((type) => document.addEventListener(type, (evt) => {
  if (isPhone() && !evt.target.closest?.('#cy')) evt.preventDefault();
}, { passive: false }));
document.addEventListener('touchmove', (evt) => {
  if (isPhone() && evt.touches.length > 1 && !evt.target.closest?.('#cy')) evt.preventDefault();
}, { passive: false });

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
  setAiOpen(false);
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
    requests: () => { openRequestsPanel(); syncNav('more'); },
    data: () => click('#btn-data'),
    admin: () => click('#btn-admin'),
    fit: () => click('#btn-fit'),
    layout: () => click('#btn-layout'),
    signout: () => click('#me-chip'),
    ai: () => setAiOpen(true),
    'wm-sync': () => refreshWingmate(),
    flows: () => { if (FLOWS_PAGE) openFlowsPanel(); else location.href = '/flows'; },
  })[action]?.();
  if (action !== 'filter' && action !== 'activity') syncNav();
}));

// ---------- Wingmate refresh (any rep) ----------
// Pulls in what reps just added in Wingmate instead of waiting for the 15-minute sync.

const wmSync = { connected: false, busy: false };

async function loadWmSync() {
  try { wmSync.connected = (await api('GET', '/api/wingmate/refresh')).connected; } catch { wmSync.connected = false; }
  renderWmSync();
}

function renderWmSync() {
  const btn = $('#btn-wm-sync');
  btn.hidden = !wmSync.connected;
  btn.disabled = wmSync.busy;
  btn.classList.toggle('busy', wmSync.busy);
  $('[data-sheet="wm-sync"]').hidden = !wmSync.connected;
}

function wingmateNews(r) {
  const parts = [[r.people_added, 'new contact', 'new contacts'], [r.companies_added, 'new company', 'new companies'],
    [r.notes_added, 'new note', 'new notes'], [(r.people_updated || 0) + (r.companies_updated || 0), 'update', 'updates']]
    .filter(([n]) => n).map(([n, one, many]) => plural(n, one, many));
  return parts.length ? `Wingmate synced: ${parts.join(', ')}` : 'You’re up to date with Wingmate';
}

async function refreshWingmate() {
  if (wmSync.busy) return;
  wmSync.busy = true;
  renderWmSync();
  toast('Syncing with Wingmate…');
  try {
    const before = await api('POST', '/api/wingmate/refresh');
    let status = before;
    if (before.started || before.running) {
      const startedFrom = before.last?.at;
      const deadline = Date.now() + 3 * 60 * 1000;
      do {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        status = await api('GET', '/api/wingmate/refresh');
      } while ((status.running || status.last?.at === startedFrom) && Date.now() < deadline);
    }
    await sync();
    const last = status.last;
    if (status.running) toast('Wingmate is still syncing. New records will appear shortly.');
    else if (!last) toast('You’re up to date with Wingmate');
    else if (!last.ok) toast(last.error || 'Wingmate sync failed', true);
    else toast(before.started ? wingmateNews(last) : `You’re up to date with Wingmate (synced ${timeAgo(last.at)})`);
  } catch (err) {
    toast(err.message, true);
  }
  wmSync.busy = false;
  renderWmSync();
}

$('#btn-wm-sync').addEventListener('click', refreshWingmate);

// ---------- AI assistant (the "Ask AI" side panel) ----------
// Chats with Claude through the server (/api/assistant), which works as the signed-in rep.

const ai = { open: false, busy: false, enabled: null, reason: '', messages: [], files: [], left: null, notice: '' };
const aiLog = $('#ai-log');
const aiInput = $('#ai-input');
const AI_SUGGESTIONS = [
  'What should I follow up on this week?',
  'Show my high-priority contacts',
  'Add contacts from a business card photo',
  'I’ll paste a list of contacts to add',
  'What changed on the team today?',
];

function setAiOpen(open) {
  if (ai.open === open) return;
  ai.open = open;
  $('#ai-drawer').hidden = !open;
  document.body.classList.toggle('ai-open', open);
  $('#ai-tab').setAttribute('aria-expanded', String(open));
  if (open) {
    closeSheets();
    if (ai.enabled === null || !ai.messages.length) loadAi();
    if (!isPhone()) setTimeout(() => aiInput.focus(), 50);
  }
  requestAnimationFrame(() => cy.resize());
  syncNav(open ? 'more' : undefined);
}

async function loadAi() {
  try {
    const data = await api('GET', '/api/assistant');
    ai.enabled = data.enabled;
    ai.reason = data.reason || '';
    if (data.enabled) { ai.messages = data.messages; ai.left = data.left_today; }
  } catch (err) {
    ai.enabled = false;
    ai.reason = err.message;
  }
  renderAi(true);
  if (ai.enabled === false && ai.open && !isPhone()) $('#ai-launch-q')?.focus();
}

// A little Markdown: paragraphs, bullet and numbered lists, **bold**, `code`, and links.
// Links to #record-ID open that card; only http(s) links leave the app.
function aiMarkdown(src) {
  const inline = (t) => t
    .replace(/\[([^\]]+)\]\(#record-(\d+)\)/g, '<a href="#" data-goto="$2">$1</a>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  let html = '';
  let list = '';
  for (const line of esc(src || '').split('\n')) {
    const item = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/);
    if (item) {
      const tag = item[1] ? 'ol' : 'ul';
      if (list !== tag) { html += (list ? `</${list}>` : '') + `<${tag}>`; list = tag; }
      html += `<li>${inline(item[2])}</li>`;
      continue;
    }
    if (list) { html += `</${list}>`; list = ''; }
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) html += `<p><b>${inline(heading[1])}</b></p>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  return html + (list ? `</${list}>` : '');
}

// Without the built-in assistant, the tab opens Claude or ChatGPT in a new tab with the
// question filled in. A link can't pick the PSS Connect plugin, so the question names it.
const AI_APPS = {
  claude: (q) => `https://claude.ai/new?q=${encodeURIComponent(q)}`,
  chatgpt: (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}`,
};

function aiLauncherHtml() {
  const url = `${location.origin}/mcp`;
  return `<div class="ai-launch">
    <p class="muted">Opens Claude or ChatGPT in a new tab, connected to PSS Connect as you.</p>
    <textarea id="ai-launch-q" rows="3" placeholder="What do you want to ask? e.g. Who do I know at Summit Dental?"></textarea>
    <button type="button" class="btn btn-primary ai-launch-btn" data-ai-open="claude">Open in Claude</button>
    <button type="button" class="btn ai-launch-btn" data-ai-open="chatgpt">Open in ChatGPT</button>
    <details class="ai-launch-help">
      <summary>First time? Connect it once</summary>
      <p><b>Claude:</b> Settings → Connectors → Add custom connector. Name it “PSS Connect”, paste the link below, click Add, then Connect and sign in with your PSS Connect email and password.</p>
      <p><b>ChatGPT:</b> Settings → Apps → Advanced settings → turn on Developer mode → Create app. Paste the link, choose OAuth, and sign in. In a chat, turn on PSS Connect from the + menu. (On Plus/Pro it may only answer questions.)</p>
      <div class="copy-row"><input readonly value="${esc(url)}" aria-label="Connector link"><button type="button" class="btn btn-sm" data-ai-copy="${esc(url)}">Copy</button></div>
    </details>
  </div>`;
}

function openAiApp(app) {
  const typed = ($('#ai-launch-q')?.value || '').trim();
  const question = typed
    ? `Using PSS Connect: ${typed}`
    : 'Using PSS Connect, give me a quick overview: who I am, my contacts, and anything waiting on me.';
  window.open(AI_APPS[app](question), '_blank', 'noopener');
  if ($('#ai-launch-q')) $('#ai-launch-q').value = '';
}

function aiMessageHtml(m) {
  if (m.role === 'user') {
    const files = m.files?.length ? `<div class="ai-attached">${m.files.map((f) => `📎 ${esc(f)}`).join('<br>')}</div>` : '';
    return `<div class="ai-msg user">${files}${esc(m.text)}</div>`;
  }
  const chips = [...new Set(m.tools || [])].map((t) => `<span class="ai-chip">${esc(t)}</span>`)
    .concat((m.failed || []).map((t) => `<span class="ai-chip err">${esc(t)} failed</span>`)).join('');
  const working = m.pending ? `<div class="ai-status"><span class="ai-dots"><i></i><i></i><i></i></span>${esc(m.doing || 'Thinking…')}</div>` : '';
  const error = m.error ? `<div class="ai-error">${esc(m.error)}</div>` : '';
  if (!m.text && !chips && !working && !error) return '';
  return `<div class="ai-msg bot">${chips ? `<div class="ai-tools">${chips}</div>` : ''}${aiMarkdown(m.text)}${working}${error}</div>`;
}

function renderAi(scroll) {
  const nearBottom = aiLog.scrollHeight - aiLog.scrollTop - aiLog.clientHeight < 80;
  $('#ai-form').hidden = ai.enabled === false;
  $('#ai-new').hidden = !ai.enabled;
  if (ai.enabled === false) {
    aiLog.innerHTML = aiLauncherHtml();
    return;
  }
  if (ai.enabled === null) {
    aiLog.innerHTML = '<div class="ai-status"><span class="ai-dots"><i></i><i></i><i></i></span>Loading…</div>';
    return;
  }
  const intro = ai.messages.length ? '' : `<div class="ai-empty">
      <h3>Hi ${esc(state.me?.name.split(' ')[0] || 'there')} 👋</h3>
      <p>Ask about any company or contact, tell me about a meeting, or attach a business card, spreadsheet or list,
        and I’ll update PSS Connect as you. I can also look things up in Wingmate. I can’t delete anything.</p>
      <div class="ai-suggest">${AI_SUGGESTIONS.map((t) => `<button type="button" data-ai-suggest="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    </div>`;
  const notice = ai.notice ? `<div class="ai-notice">${esc(ai.notice)}</div>` : '';
  aiLog.innerHTML = intro + notice + ai.messages.map(aiMessageHtml).join('');
  const left = $('#ai-left');
  left.hidden = ai.left == null || ai.left > 20;
  left.textContent = ai.left === 0 ? 'You’ve used today’s questions. More tomorrow.' : `${ai.left} questions left today`;
  $('#ai-send').disabled = ai.busy || ai.left === 0;
  if (scroll || nearBottom) aiLog.scrollTop = aiLog.scrollHeight;
}

let aiRenderQueued = false;
function renderAiSoon() {
  if (aiRenderQueued) return;
  aiRenderQueued = true;
  requestAnimationFrame(() => { aiRenderQueued = false; renderAi(); });
}

async function sendAi(text) {
  text = text.trim();
  if (ai.busy || (!text && !ai.files.length)) return;
  const files = ai.files;
  ai.busy = true;
  ai.files = [];
  ai.notice = '';
  renderAiFiles();
  aiInput.value = '';
  autosizeAi();
  ai.messages.push({ role: 'user', text, files: files.map((f) => f.name) });
  const bot = { role: 'assistant', text: '', base: '', tools: [], failed: [], pending: true, doing: 'Thinking…' };
  ai.messages.push(bot);
  renderAi(true);
  try {
    const res = await fetch('/api/assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, attachments: files.map(({ name, kind, media_type, data, text: body }) => ({ name, kind, media_type, data, text: body })) }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (body.signed_out) { showSignIn(true); }
      throw new Error(body.error || 'Something went wrong. Try again.');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        handleAiEvent(buffer.slice(0, cut), bot);
        buffer = buffer.slice(cut + 2);
      }
    }
  } catch (err) {
    bot.error = err.message === 'Failed to fetch' ? 'Lost the connection. Try again.' : err.message;
  }
  bot.pending = false;
  ai.busy = false;
  renderAi();
}

function handleAiEvent(chunk, bot) {
  const event = chunk.match(/^event: (.*)$/m)?.[1];
  let data = {};
  try { data = JSON.parse(chunk.match(/^data: (.*)$/m)?.[1] || '{}'); } catch { return; }
  if (event === 'text') {
    bot.text += data.text;
    bot.doing = 'Writing…';
  } else if (event === 'tool') {
    if (bot.text && !bot.text.endsWith('\n\n')) bot.text += '\n\n';
    bot.tools.push(data.label);
    bot.doing = `${data.label}…`;
  } else if (event === 'tool_done') {
    if (!data.ok) bot.failed.push(bot.tools[bot.tools.length - 1]);
    bot.base = bot.text;
    bot.doing = 'Thinking…';
  } else if (event === 'discard') {
    bot.text = bot.base;  // a reply that was withdrawn mid-way
  } else if (event === 'notice') {
    ai.notice = data.text;
  } else if (event === 'error') {
    bot.error = data.text;
  } else if (event === 'done') {
    ai.left = data.left_today;
    if (data.changed) sync();
  }
  renderAiSoon();
}

// Attachments: photos are shrunk in the browser first; CSV and text files go as text.
async function addAiFiles(list) {
  for (const file of list) {
    if (ai.files.length >= 5) { toast('Attach up to 5 files at a time', true); break; }
    const name = file.name || 'photo.jpg';
    try {
      if (file.type.startsWith('image/')) {
        ai.files.push({ name, kind: 'image', media_type: 'image/jpeg', data: await shrinkImage(file) });
      } else if (file.type === 'application/pdf' || /\.pdf$/i.test(name)) {
        if (file.size > 15e6) throw new Error(`${name} is over 15 MB`);
        ai.files.push({ name, kind: 'pdf', media_type: 'application/pdf', data: await fileBase64(file) });
      } else if (/\.(csv|tsv|txt)$/i.test(name) || file.type.startsWith('text/')) {
        if (file.size > 3e5) throw new Error(`${name} is too big; split it into smaller files`);
        ai.files.push({ name, kind: 'text', text: await file.text() });
      } else if (/\.xlsx?$/i.test(name)) {
        throw new Error('Save Excel files as CSV first (File → Save As → CSV)');
      } else {
        throw new Error(`${name} isn’t a photo, PDF or CSV`);
      }
    } catch (err) { toast(err.message, true); }
  }
  renderAiFiles();
}

function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error(`Couldn’t read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function shrinkImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`Couldn’t read ${file.name}`));
      el.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
  } finally {
    URL.revokeObjectURL(url);
  }
}

function renderAiFiles() {
  const box = $('#ai-files');
  box.hidden = !ai.files.length;
  box.innerHTML = ai.files.map((f, i) => `<span class="ai-file"><span>📎 ${esc(f.name)}</span>
    <button type="button" data-ai-unattach="${i}" aria-label="Remove ${esc(f.name)}">×</button></span>`).join('');
}

function autosizeAi() {
  aiInput.style.height = 'auto';
  aiInput.style.height = `${Math.min(aiInput.scrollHeight, 140)}px`;
}

$('#ai-tab').addEventListener('click', () => setAiOpen(true));
$('#ai-close').addEventListener('click', () => setAiOpen(false));
$('#ai-new').addEventListener('click', async () => {
  if (ai.busy) return;
  try {
    await api('DELETE', '/api/assistant');
    ai.messages = [];
    ai.notice = '';
    renderAi(true);
    aiInput.focus();
  } catch (err) { toast(err.message, true); }
});
$('#ai-form').addEventListener('submit', (evt) => { evt.preventDefault(); sendAi(aiInput.value); });
aiInput.addEventListener('input', autosizeAi);
aiLog.addEventListener('keydown', (evt) => {
  if (evt.target.id === 'ai-launch-q' && evt.key === 'Enter' && !evt.shiftKey && !isPhone()) {
    evt.preventDefault();
    openAiApp('claude');
  }
});
aiInput.addEventListener('keydown', (evt) => {
  if (evt.key === 'Enter' && !evt.shiftKey && !isPhone() && !evt.isComposing) {
    evt.preventDefault();
    sendAi(aiInput.value);
  }
});
aiInput.addEventListener('paste', (evt) => {
  const images = [...(evt.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (images.length) { evt.preventDefault(); addAiFiles(images); }
});
$('#ai-file').addEventListener('change', (evt) => { addAiFiles([...evt.target.files]); evt.target.value = ''; });
$('#ai-files').addEventListener('click', (evt) => {
  const i = evt.target.closest('[data-ai-unattach]')?.dataset.aiUnattach;
  if (i != null) { ai.files.splice(Number(i), 1); renderAiFiles(); }
});
aiLog.addEventListener('click', async (evt) => {
  const app = evt.target.closest('[data-ai-open]')?.dataset.aiOpen;
  if (app) { openAiApp(app); return; }
  const copy = evt.target.closest('[data-ai-copy]')?.dataset.aiCopy;
  if (copy) {
    try { await navigator.clipboard.writeText(copy); toast('Connector link copied'); } catch { toast(copy); }
    return;
  }
  const suggestion = evt.target.closest('[data-ai-suggest]')?.dataset.aiSuggest;
  if (suggestion) {
    if (/photo/.test(suggestion)) { $('#ai-file').click(); aiInput.value = 'Add the people on this card.'; }
    else if (/paste a list/.test(suggestion)) { aiInput.value = 'Add these contacts:\n'; aiInput.focus(); }
    else sendAi(suggestion);
    autosizeAi();
    return;
  }
  const goto = evt.target.closest('[data-goto]');
  if (goto) {
    evt.preventDefault();
    const id = Number(goto.dataset.goto);
    if (!state.nodes.has(id)) { toast('That record isn’t on the map yet. It may still be syncing.'); sync(); return; }
    if (isPhone()) setAiOpen(false);
    goToNode(id);
    openNodePanel(id);
  }
});

// ---------- start ----------

buildLegend();
loadMe();


// ---------- outbound flows (admins) ----------
// Apollo-style sequences: a flow is a list of email / call / task steps with waits in days.
// Due steps show up under "To do" with the email already written; nothing is sent from here.

const FLOW_KINDS = { email: 'Email', call: 'Call', linkedin: 'LinkedIn', task: 'Task' };
// Every new flow starts as this sequence; the waits are days after the step before.
const FLOW_TEMPLATE = [
  { kind: 'email', wait_days: 0, subject: '', body: '' },
  { kind: 'call', wait_days: 2, subject: '', body: '' },
  { kind: 'email', wait_days: 0, subject: '', body: '' },  // straight after the call
  { kind: 'linkedin', wait_days: 2, subject: '', body: 'Send a connection request' },
  { kind: 'call', wait_days: 3, subject: '', body: '' },
  { kind: 'email', wait_days: 3, subject: '', body: '' },
  { kind: 'linkedin', wait_days: 3, subject: '', body: 'Hi {{first_name}}, …' },
];
const FLOW_FIELDS = ['first_name', 'last_name', 'name', 'company', 'title', 'city', 'sender'];
const FLOW_STATUS = { active: 'In the flow', replied: 'Replied', meeting: 'Meeting booked', stopped: 'Removed', finished: 'Finished', exited: 'Stage reached' };

function flowById(id) { return state.flows?.flows.find((f) => f.id === id) || null; }

function dueTasks() {
  if (!state.flows) return [];
  return state.flows.enrollments
    .filter((e) => e.status === 'active' && e.due_on && e.due_on <= state.flows.today && state.nodes.has(e.node_id) && flowById(e.flow_id))
    .sort((a, b) => a.due_on.localeCompare(b.due_on) || a.id - b.id);
}

async function loadFlows() {
  if (!state.isAdmin) return;
  try {
    state.flows = await api('GET', '/api/flows');
  } catch { return; }
  renderFlowsBadge();
  if (state.panel?.kind === 'flows' && !state.panelDirty) renderFlowsPanel();
}

function renderFlowsBadge() {
  const n = state.isAdmin ? dueTasks().length : 0;
  $('#btn-flows').hidden = !state.isAdmin;
  $('[data-sheet="flows"]').hidden = !state.isAdmin;
  for (const el of [$('#flows-count'), $('#sheet-flows-count')]) {
    el.textContent = n;
    el.hidden = !n;
  }
}

function fillTemplate(text, n) {
  const company = companyOf(n);
  const parts = n.name.trim().split(/\s+/);
  const values = {
    first_name: parts[0] || '', last_name: parts.length > 1 ? parts[parts.length - 1] : '', name: n.name,
    company: company?.name || '', title: n.title || '', city: cityOf(n) || (company ? cityOf(company) : ''), sender: myName() || '',
  };
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (key in values ? values[key] : m));
}

function dueLabel(due) {
  const today = state.flows.today;
  if (due === today) return 'Due today';
  const days = Math.round((Date.parse(`${today}T12:00:00`) - Date.parse(`${due}T12:00:00`)) / 86400000);
  return days > 0 ? `${plural(days, 'day', 'days')} overdue` : `Due ${due}`;
}

function openFlowsPanel(tab) {
  state.flowsTab = tab || 'todo';
  state.flowEdit = null;
  showPanel({ kind: 'flows' }, '<div id="flows-body"></div>');
  renderFlowsPanel();
  loadFlows();
}

function renderFlowsPanel() {
  const body = $('#flows-body');
  if (!body) return;
  if (!state.flowEdit) state.panelDirty = false;  // half-typed task notes are dropped on purpose here
  const f = state.flows;
  const due = f ? dueTasks() : [];
  const tab = state.flowsTab || 'todo';
  let content;
  if (!f) content = '<p class="muted section">Loading…</p>';
  else if (state.flowEdit) content = flowEditorHtml(state.flowEdit);
  else if (tab === 'flow' && flowById(state.flowView)) content = flowDetailHtml(flowById(state.flowView));
  else if (tab === 'flows' || tab === 'flow') content = flowListHtml();
  else content = due.length ? `<ul class="flow-tasks">${due.map(taskHtml).join('')}</ul>`
    : `<p class="muted section">Nothing due. ${f.flows.length ? 'Steps show up here on the day they come due.' : 'Create a flow in the Flows tab, then add contacts to it.'}</p>`;
  const scroll = panel.scrollTop;
  body.innerHTML = `<div class="panel-head">
      <h2>Outbound flows <span class="pill pill-company">Admin</span></h2>
      <button class="${FLOWS_PAGE ? 'btn btn-sm' : 'icon-btn'}" data-act="close" aria-label="${FLOWS_PAGE ? 'Back to the map' : 'Close'}">${FLOWS_PAGE ? '‹ Map' : '×'}</button>
    </div>
    <div class="dir-controls"><div class="tabs-seg" role="tablist">
      <button type="button" role="tab" class="${tab === 'todo' ? 'on' : ''}" aria-selected="${tab === 'todo'}" data-flow-tab="todo">To do${due.length ? ` (${due.length})` : ''}</button>
      <button type="button" role="tab" class="${tab !== 'todo' ? 'on' : ''}" aria-selected="${tab !== 'todo'}" data-flow-tab="flows">Flows${f ? ` (${f.flows.length})` : ''}</button>
    </div></div>
    ${content}`;
  panel.scrollTop = scroll;
}

function taskHtml(e) {
  const n = state.nodes.get(e.node_id);
  const flow = flowById(e.flow_id);
  const step = flow.steps[Math.min(e.step_index, flow.steps.length - 1)];
  const company = companyOf(n);
  const head = `<div class="flow-task-head">
      <span class="flow-kind kind-${step.kind}">${FLOW_KINDS[step.kind]}</span>
      <b data-goto="${n.id}" class="request-lead">${esc(n.name)}</b>${stageBadge(n)}
      <span class="muted">${esc([n.title, company?.name].filter(Boolean).join(' · '))}</span>
      <span class="flow-meta">${esc(flow.name)} · step ${e.step_index + 1} of ${flow.steps.length} · <span class="${e.due_on < state.flows.today ? 'overdue' : ''}">${esc(dueLabel(e.due_on))}</span></span>
    </div>`;
  let work = '';
  let doneLabel = 'Done ✓';
  if (step.kind === 'email') {
    doneLabel = 'Mark sent ✓';
    work = `${n.email ? `<div class="flow-to">To: <b>${esc(n.email)}</b></div>` : '<div class="flow-to error-text">No email on this contact. Add one, or skip this step.</div>'}
      <input class="flow-subject" value="${esc(fillTemplate(step.subject, n))}" aria-label="Subject" placeholder="Subject">
      <textarea class="flow-body" rows="7" aria-label="Email text">${esc(fillTemplate(step.body, n))}</textarea>
      <div class="row-btns">
        <button type="button" class="btn btn-sm" data-flow-act="mailto" ${n.email ? '' : 'disabled'}>Open in email app</button>
        <button type="button" class="btn btn-sm" data-flow-act="gmail" ${n.email ? '' : 'disabled'}>Open in Gmail</button>
        <button type="button" class="btn btn-sm btn-ghost" data-flow-act="copy">Copy text</button>
      </div>`;
  } else if (step.kind === 'call') {
    doneLabel = 'Log call ✓';
    work = `${n.phone ? `<a class="btn btn-sm" href="tel:${esc(n.phone.replace(/[^\d+]/g, ''))}">📞 Call ${esc(n.phone)}</a>` : '<div class="flow-to error-text">No phone number on this contact.</div>'}
      ${step.body ? `<div class="flow-script">${esc(fillTemplate(step.body, n))}</div>` : ''}
      <select class="flow-outcome" aria-label="How did it go?">${state.flows.outcomes.map((o) => `<option>${esc(o)}</option>`).join('')}</select>`;
  } else if (step.kind === 'linkedin') {
    const find = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent([n.name, company?.name].filter(Boolean).join(' '))}`;
    work = `<textarea class="flow-body" rows="3" aria-label="LinkedIn message">${esc(fillTemplate(step.body, n))}</textarea>
      <div class="row-btns">
        <a class="btn btn-sm" href="${esc(find)}" target="_blank" rel="noopener">Find on LinkedIn</a>
        <button type="button" class="btn btn-sm btn-ghost" data-flow-act="copy">Copy text</button>
      </div>`;
  } else {
    work = step.body ? `<div class="flow-script">${esc(fillTemplate(step.body, n))}</div>` : '';
  }
  return `<li class="flow-task" data-enrollment="${e.id}">${head}${work}
    <input class="flow-note" placeholder="Note for the contact's card (optional)" aria-label="Note">
    <div class="row-btns">
      <button type="button" class="btn btn-sm btn-primary" data-flow-act="done">${doneLabel}</button>
      <button type="button" class="btn btn-sm" data-flow-act="replied">Replied</button>
      <button type="button" class="btn btn-sm" data-flow-act="meeting">Meeting booked</button>
      <button type="button" class="btn btn-sm btn-ghost" data-flow-act="skip">Skip step</button>
      <button type="button" class="btn btn-sm btn-danger-ghost" data-flow-act="stop">Remove</button>
    </div></li>`;
}

function flowCounts(flowId) {
  const counts = {};
  for (const e of state.flows.enrollments) if (e.flow_id === flowId) counts[e.status] = (counts[e.status] || 0) + 1;
  return counts;
}

function flowListHtml() {
  const rows = state.flows.flows.map((f) => {
    const c = flowCounts(f.id);
    const detail = [plural(f.steps.length, 'step', 'steps'), `${c.active || 0} active`,
      c.replied ? `${c.replied} replied` : '', c.meeting ? plural(c.meeting, 'meeting', 'meetings') : ''].filter(Boolean).join(' · ');
    return `<li data-flow-open="${f.id}"><span class="who"><b>${esc(f.name)}</b><span>${esc(detail)}</span></span><span class="muted">›</span></li>`;
  }).join('');
  return `<div class="section">
      <button type="button" class="btn btn-sm btn-primary" data-flow-act="new">+ New flow</button>
      ${rows ? `<ul class="conn-list flow-list">${rows}</ul>` : '<p class="muted">No flows yet. A flow is a series of emails, calls and tasks spaced out over days, like an Apollo sequence.</p>'}
      <p class="muted">Add contacts from a contact's card (<b>Add to flow</b>) or in bulk from the <b>Contacts</b> list.</p>
    </div>`;
}

function stepSummary(s, i) {
  const wait = i === 0 ? (s.wait_days ? `${plural(s.wait_days, 'day', 'days')} after adding` : 'Right away') : `+${plural(s.wait_days, 'day', 'days')}`;
  const text = s.kind === 'email' ? s.subject || s.body : s.body;
  return `<li><span class="flow-kind kind-${s.kind}">${FLOW_KINDS[s.kind]}</span> <span class="muted">${esc(wait)}</span>${text ? ` · ${esc(text.slice(0, 70))}` : ''}</li>`;
}

function flowDetailHtml(f) {
  const people = state.flows.enrollments.filter((e) => e.flow_id === f.id && state.nodes.has(e.node_id))
    .sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || (a.due_on || '').localeCompare(b.due_on || ''));
  const c = flowCounts(f.id);
  const enrolled = people.map((e) => {
    const n = state.nodes.get(e.node_id);
    const status = e.status === 'active'
      ? `Step ${e.step_index + 1} of ${f.steps.length} · ${dueLabel(e.due_on)}`
      : e.ended_reason || FLOW_STATUS[e.status];
    return `<li><span class="who"><b data-goto="${n.id}" class="request-lead">${esc(n.name)}</b>${stageBadge(n)}<span>${esc([companyOf(n)?.name, status].filter(Boolean).join(' · '))}</span></span>
      <button type="button" class="link-btn" data-flow-act="${e.status === 'active' ? 'stop' : 'resume'}" data-enrollment="${e.id}">${e.status === 'active' ? 'Remove' : 'Put back'}</button></li>`;
  }).join('');
  return `<div class="section">
      <button type="button" class="link-btn" data-flow-tab="flows">‹ All flows</button>
      <h3 class="flow-title">${esc(f.name)}</h3>
      <p class="muted">${[`${c.active || 0} active`, c.replied ? `${c.replied} replied` : '', c.meeting ? plural(c.meeting, 'meeting booked', 'meetings booked') : '', c.finished ? `${c.finished} finished` : ''].filter(Boolean).join(' · ')}</p>
      <ol class="flow-steps">${f.steps.map(stepSummary).join('')}</ol>
      ${f.pipeline ? `<p class="muted">${flowSourceText(f)}</p>` : ''}
      ${f.pipeline ? `<p class="muted">${flowPushText(f)}</p>` : ''}
      ${f.exit_stages.length ? `<p class="muted">Contacts leave automatically at: ${f.exit_stages.map((s) => `<span class="stage-chip">${esc(s)}</span>`).join(' ')}</p>` : ''}
      <div class="row-btns">
        <button type="button" class="btn btn-sm" data-flow-act="edit">Edit flow</button>
        <button type="button" class="btn btn-sm btn-danger-ghost" data-flow-act="delete">Delete flow</button>
      </div>
    </div>
    <div class="section">
      <h3>Contacts <span>${people.length}</span></h3>
      ${enrolled ? `<ul class="conn-list">${enrolled}</ul>` : '<p class="muted">No one yet. Use <b>Add to flow</b> on a contact\'s card, or add a filtered list from <b>Contacts</b>.</p>'}
    </div>`;
}

function knownStages() {
  const stages = new Map();
  for (const n of state.nodes.values()) {
    const s = n.type === 'person' ? n.stage.trim() : '';
    if (s) stages.set(s.toLowerCase(), s);
  }
  return [...stages.values()].sort((a, b) => a.localeCompare(b));
}

function flowPipeline(id) {
  return id ? (state.flows?.pipelines || []).find((p) => p.campaign_id === id) || { campaign_id: id, name: 'A removed pipeline', stages: [] } : null;
}

function flowPushText(f) {
  const w = f.wm_push;
  const moves = PUSH_POINTS.filter(([key]) => w[key]).map(([key, label]) => `${label.toLowerCase()} → <b>${esc(w[key])}</b>`);
  const target = w.meeting_pipeline && flowPipeline(w.meeting_pipeline);
  if (target) moves.push(`meeting booked → the <b>${esc(target.name)}</b> pipeline${w.meeting_pipeline_stage ? ` at <b>${esc(w.meeting_pipeline_stage)}</b>` : ''}`);
  const parts = [w.log ? 'each step is logged on the Wingmate lead' : '', moves.length ? `the lead moves: ${moves.join(', ')}` : ''].filter(Boolean);
  return parts.length ? `Wingmate: ${parts.join('; ')}.` : 'Nothing is written back to Wingmate.';
}

function flowSourceText(f) {
  const p = flowPipeline(f.pipeline);
  if (!p) return '';
  const from = f.start_stage ? ` at “${esc(f.start_stage)}”` : '';
  return f.auto_daily
    ? `Adds up to ${f.auto_daily} new contacts a day from the <b>${esc(p.name)}</b> pipeline${from}. Contacts leave when they're no longer in that pipeline.`
    : `Tied to the <b>${esc(p.name)}</b> pipeline (contacts are added by hand). Contacts from it leave when they're no longer in it.`;
}

const PUSH_POINTS = [['first_done', 'After the first step'], ['replied', 'Replied'], ['meeting', 'Meeting booked'], ['finished', 'Finished with no reply']];

// What the flow writes back to the contact's Wingmate lead (when an admin works it).
function flowPushHtml(d, pipe, pipes) {
  const w = d.wm_push;
  const pick = (name, value, stages, none) => `<select name="${name}">
      <option value="">${none}</option>
      ${[...new Set([...stages, ...(value && !stages.includes(value) ? [value] : [])])].map((st) => `<option value="${esc(st)}" ${value === st ? 'selected' : ''}>${esc(st)}</option>`).join('')}
    </select>`;
  const other = pipes.filter((p) => p.campaign_id !== pipe.campaign_id);
  const target = other.find((p) => p.campaign_id === w.meeting_pipeline);
  return `<fieldset class="flow-source flow-push"><legend>Update Wingmate</legend>
      <label class="check"><input type="checkbox" name="wm_log" ${w.log ? 'checked' : ''}> Log each step on the lead (as an Email, Phone or Social update)</label>
      <p class="muted">Move the lead in ${esc(pipe.name)} to this stage:</p>
      ${PUSH_POINTS.map(([key, label]) => `<label class="flow-push-row"><span>${label}</span>${pick(`wm_${key}`, w[key], pipe.stages, 'Leave as is')}</label>`).join('')}
      ${other.length ? `<label class="flow-push-row"><span>Meeting booked: move to pipeline</span>
          <select name="meeting_pipeline" data-flow-pipeline><option value="">Stay in ${esc(pipe.name)}</option>
            ${other.map((p) => `<option value="${esc(p.campaign_id)}" ${w.meeting_pipeline === p.campaign_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select></label>
        ${target ? `<label class="flow-push-row"><span>at stage</span>${pick('meeting_pipeline_stage', w.meeting_pipeline_stage, target.stages, 'Its first stage')}</label>` : ''}` : ''}
      <p class="muted">Sent as soon as you click Done / Replied / Meeting booked, and only when an admin does it. Problems show up right there.</p>
    </fieldset>`;
}

function flowEditorHtml(d) {
  const pipes = state.flows?.pipelines || [];
  const pipe = flowPipeline(d.pipeline);
  // The pipeline's own stages in Wingmate's order; otherwise every stage seen here.
  const stages = [...new Set([...(pipe?.stages.length ? pipe.stages : knownStages()), ...d.exit_stages])];
  const source = `<fieldset class="flow-source"><legend>Where contacts come from</legend>
      <label>Wingmate pipeline
        <select name="pipeline" data-flow-pipeline>
          <option value="">None: add contacts by hand</option>
          ${pipes.map((p) => `<option value="${esc(p.campaign_id)}" ${d.pipeline === p.campaign_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          ${d.pipeline && !pipes.some((p) => p.campaign_id === d.pipeline) ? `<option value="${esc(d.pipeline)}" selected>${esc(pipe.name)}</option>` : ''}
        </select></label>
      <p class="muted">Lists the ${plural(pipes.length, 'pipeline', 'pipelines')} connected in ⚙ → Wingmate. To see another one here, add it there under <b>+ Add another pipeline</b> → <b>Find my pipelines</b>.</p>
      ${pipe ? `<label>Start contacts who are at
          <select name="start_stage"><option value="">Any stage</option>
            ${[...new Set([...stages, ...(d.start_stage ? [d.start_stage] : [])])].map((st) => `<option value="${esc(st)}" ${d.start_stage === st ? 'selected' : ''}>${esc(st)}</option>`).join('')}
          </select></label>
        <label class="flow-daily">Add up to <input name="auto_daily" type="number" min="0" max="500" value="${d.auto_daily}" aria-label="New contacts a day"> new contacts a day automatically (0 = only by hand)</label>
        <p class="muted">New contacts are picked up when Wingmate syncs. Anyone who leaves the pipeline in Wingmate (moved or deleted) leaves the flow too.</p>`
        : pipes.length ? '' : '<p class="muted">Connect pipelines in ⚙ → Wingmate to have a flow fill itself.</p>'}
    </fieldset>
    ${pipe ? flowPushHtml(d, pipe, pipes) : ''}`;
  const steps = d.steps.map((s, i) => `<li class="flow-step-edit" data-step="${i}">
      <div class="flow-step-row">
        <b>${i + 1}.</b>
        <select name="kind" aria-label="Step type">${Object.entries(FLOW_KINDS).map(([k, label]) => `<option value="${k}" ${s.kind === k ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <label class="flow-wait">wait <input name="wait_days" type="number" min="0" max="365" value="${s.wait_days}" aria-label="Days to wait"> ${i === 0 ? 'days after adding' : 'days after the last step'}</label>
        <span class="flow-step-btns">
          <button type="button" class="icon-btn icon-sm" data-step-act="up" ${i ? '' : 'disabled'} aria-label="Move up">↑</button>
          <button type="button" class="icon-btn icon-sm" data-step-act="down" ${i < d.steps.length - 1 ? '' : 'disabled'} aria-label="Move down">↓</button>
          <button type="button" class="icon-btn icon-sm" data-step-act="remove" aria-label="Remove step">×</button>
        </span>
      </div>
      ${s.kind === 'email' ? `<input name="subject" value="${esc(s.subject)}" placeholder="Subject, e.g. Quick question, {{first_name}}" aria-label="Subject">` : ''}
      <textarea name="body" rows="${s.kind === 'email' ? 6 : 3}" placeholder="${s.kind === 'email' ? 'Hi {{first_name}},…' : s.kind === 'call' ? 'Call script or talking points (optional)' : 'What to do, e.g. Connect on LinkedIn'}" aria-label="Step text">${esc(s.body)}</textarea>
    </li>`).join('');
  return `<form class="section rep-form flow-editor" data-form="flow-edit">
      <button type="button" class="link-btn" data-flow-act="cancel-edit">‹ Cancel</button>
      <input name="name" required maxlength="120" value="${esc(d.name)}" placeholder="Flow name, e.g. New HOA outreach" aria-label="Flow name">
      ${source}
      <ol class="flow-step-list">${steps}</ol>
      <div class="row-btns">
        ${Object.entries(FLOW_KINDS).map(([k, label]) => `<button type="button" class="btn btn-sm" data-step-add="${k}">+ ${label}</button>`).join('')}
      </div>
      <p class="muted">Fill-ins: ${FLOW_FIELDS.map((x) => `<code>{{${x}}}</code>`).join(' ')}. <code>{{sender}}</code> is the name of whoever sends it.</p>
      <fieldset class="flow-exits"><legend>Take contacts out when their stage becomes</legend>
        ${stages.length ? stages.map((s) => `<label class="check"><input type="checkbox" name="exit_stage" value="${esc(s)}" ${d.exit_stages.includes(s) ? 'checked' : ''}> ${esc(s)}</label>`).join('')
          : '<p class="muted">No stages yet. They come from Wingmate.</p>'}
        <p class="muted">Marking a contact <b>Replied</b> or <b>Meeting booked</b> always takes them out.</p>
      </fieldset>
      <div class="row-btns"><button type="submit" class="btn btn-sm btn-primary">${d.id ? 'Save flow' : 'Create flow'}</button></div>
    </form>`;
}

// Reads the open editor back into state.flowEdit (before adding, moving or removing steps).
function readFlowEditor() {
  const form = panel.querySelector('[data-form="flow-edit"]');
  const d = state.flowEdit;
  if (!form || !d) return d;
  d.name = form.elements.name.value;
  d.exit_stages = [...form.querySelectorAll('[name="exit_stage"]:checked')].map((x) => x.value);
  d.pipeline = form.elements.pipeline?.value ?? d.pipeline;
  d.start_stage = form.elements.start_stage?.value ?? (d.pipeline ? d.start_stage : '');
  d.auto_daily = form.elements.auto_daily ? Number(form.elements.auto_daily.value) || 0 : (d.pipeline ? d.auto_daily : 0);
  if (form.elements.wm_log) {
    d.wm_push.log = form.elements.wm_log.checked;
    for (const [key] of PUSH_POINTS) d.wm_push[key] = form.elements[`wm_${key}`].value;
    d.wm_push.meeting_pipeline = form.elements.meeting_pipeline?.value || '';
    d.wm_push.meeting_pipeline_stage = form.elements.meeting_pipeline_stage?.value || '';
  }
  form.querySelectorAll('.flow-step-edit').forEach((li) => {
    const s = d.steps[Number(li.dataset.step)];
    s.kind = li.querySelector('[name="kind"]').value;
    s.wait_days = Number(li.querySelector('[name="wait_days"]').value) || 0;
    s.subject = li.querySelector('[name="subject"]')?.value ?? s.subject ?? '';
    s.body = li.querySelector('[name="body"]').value;
  });
  return d;
}

async function flowCall(method, path, body, message) {
  try {
    const r = await api(method, path, body);
    state.flows = r;
    renderFlowsBadge();
    if (message) toast(typeof message === 'function' ? message(r) : message);
    return r;
  } catch (err) {
    toast(err.message, true);
    return null;
  }
}

function enrollMessage(r) {
  const parts = [`Added ${plural(r.added, 'contact', 'contacts')}`];
  if (r.already) parts.push(`${r.already} already in it`);
  if (r.at_exit) parts.push(`${r.at_exit} already at an exit stage`);
  return parts.join(' · ');
}

panel.addEventListener('click', async (evt) => {
  const tabBtn = evt.target.closest('[data-flow-tab]');
  if (tabBtn) { state.flowsTab = tabBtn.dataset.flowTab; state.flowEdit = null; renderFlowsPanel(); loadFlows(); return; }
  const open = evt.target.closest('[data-flow-open]');
  if (open) { state.flowsTab = 'flow'; state.flowView = Number(open.dataset.flowOpen); renderFlowsPanel(); panel.scrollTop = 0; loadFlows(); return; }
  const stepAdd = evt.target.closest('[data-step-add]');
  if (stepAdd) {
    const d = readFlowEditor();
    d.steps.push({ kind: stepAdd.dataset.stepAdd, wait_days: d.steps.length ? 3 : 0, subject: '', body: '' });
    state.panelDirty = true;
    renderFlowsPanel();
    return;
  }
  const stepAct = evt.target.closest('[data-step-act]');
  if (stepAct) {
    const d = readFlowEditor();
    const i = Number(stepAct.closest('[data-step]').dataset.step);
    const j = stepAct.dataset.stepAct === 'up' ? i - 1 : i + 1;
    if (stepAct.dataset.stepAct === 'remove') d.steps.splice(i, 1);
    else [d.steps[i], d.steps[j]] = [d.steps[j], d.steps[i]];
    state.panelDirty = true;
    renderFlowsPanel();
    return;
  }
  const btn = evt.target.closest('[data-flow-act]');
  if (!btn) return;
  const act = btn.dataset.flowAct;
  const flow = flowById(state.flowView);
  if (act === 'new') {
    state.flowEdit = { name: '', exit_stages: [], pipeline: '', start_stage: '', auto_daily: 0, steps: FLOW_TEMPLATE.map((s) => ({ ...s })),
      wm_push: { log: true, first_done: '', replied: '', meeting: '', finished: '', meeting_pipeline: '', meeting_pipeline_stage: '' } };
    renderFlowsPanel();
  } else if (act === 'edit' && flow) {
    state.flowEdit = JSON.parse(JSON.stringify(flow));
    renderFlowsPanel();
  } else if (act === 'cancel-edit') {
    state.flowEdit = null;
    state.panelDirty = false;
    renderFlowsPanel();
  } else if (act === 'delete' && flow) {
    if (!confirm(`Delete the flow “${flow.name}”? Its contacts are taken out of it. Notes already on their cards stay.`)) return;
    if (await flowCall('DELETE', `/api/flows/${flow.id}`, null, 'Flow deleted')) { state.flowsTab = 'flows'; renderFlowsPanel(); }
  } else if (act === 'enroll-card' || act === 'cancel-enroll') {
    state.enrollFor = act === 'enroll-card' && state.enrollFor !== state.panel?.id ? state.panel.id : null;
    if (state.enrollFor && !state.flows) await loadFlows();
    rerenderCard();
  } else {
    const item = btn.closest('[data-enrollment]');
    const id = Number(btn.dataset.enrollment || item?.dataset.enrollment);
    const subject = item?.querySelector('.flow-subject')?.value || '';
    const text = item?.querySelector('.flow-body')?.value || '';
    const e = state.flows?.enrollments.find((x) => x.id === id);
    const n = e && state.nodes.get(e.node_id);
    if (act === 'mailto') {
      window.location.href = `mailto:${encodeURIComponent(n.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
    } else if (act === 'gmail') {
      window.open(`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(n.email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`, '_blank', 'noopener');
    } else if (act === 'copy') {
      try { await navigator.clipboard.writeText(subject ? `${subject}\n\n${text}` : text); toast('Copied'); } catch { toast('Couldn’t copy. Select the text instead.', true); }
    } else if (['done', 'skip', 'replied', 'meeting', 'stop', 'resume'].includes(act)) {
      if (act === 'stop' && !confirm(`Take ${n.name} out of this flow?`)) return;
      const body = { action: act, note: item?.querySelector('.flow-note')?.value || '', outcome: item?.querySelector('.flow-outcome')?.value || '', subject };
      const done = { done: 'Done. Next step scheduled', skip: 'Skipped', replied: `${n.name} marked replied`, meeting: `Meeting booked with ${n.name} 🎉`, stop: `${n.name} removed from the flow`, resume: `${n.name} is back in the flow` }[act];
      const r = await flowCall('POST', `/api/flows/enrollments/${id}`, body, (x) => (x.wingmate?.ok ? `${done} · ${x.wingmate.message}` : done));
      if (r?.wingmate && !r.wingmate.ok) setTimeout(() => toast(r.wingmate.message, true), 1200);
      if (r) {
        renderFlowsPanel();
        if (['done', 'replied', 'meeting'].includes(act)) sync();  // the note on their card
      }
    }
  }
});

// Picking a pipeline redraws the editor with that pipeline's stages (in Wingmate's order).
panel.addEventListener('change', (evt) => {
  if (!evt.target.matches('[data-flow-pipeline]')) return;
  const d = readFlowEditor();
  if (evt.target.name === 'pipeline') {
    d.start_stage = '';
    for (const [key] of PUSH_POINTS) d.wm_push[key] = '';  // stages of the old pipeline
    if (d.pipeline && !d.auto_daily) d.auto_daily = 20;
  } else {
    d.wm_push.meeting_pipeline_stage = '';
  }
  state.panelDirty = true;
  renderFlowsPanel();
});

async function submitFlowForm(form, data) {
  if (form.dataset.form === 'flow-edit') {
    const d = readFlowEditor();
    const body = { name: d.name, exit_stages: d.exit_stages, steps: d.steps, pipeline: d.pipeline, start_stage: d.start_stage, auto_daily: d.auto_daily, wm_push: d.wm_push };
    const r = d.id ? await flowCall('PUT', `/api/flows/${d.id}`, body, 'Flow saved') : await flowCall('POST', '/api/flows', body, 'Flow created');
    if (!r) return;
    state.flowEdit = null;
    state.panelDirty = false;
    state.flowsTab = 'flow';
    state.flowView = d.id || r.id;
    renderFlowsPanel();
  } else if (form.dataset.form === 'flow-enroll') {
    const r = await flowCall('POST', `/api/flows/${data.flow_id}/enroll`, { node_ids: [state.panel.id] }, enrollMessage);
    if (r) { state.enrollFor = null; rerenderCard(); }
  } else if (form.dataset.form === 'flow-bulk') {
    const ids = dirItems().filter(dirMatches).map((n) => n.id);
    const flow = flowById(Number(data.flow_id));
    if (!flow || !confirm(`Add ${plural(ids.length, 'contact', 'contacts')} to “${flow.name}”?`)) return;
    await flowCall('POST', `/api/flows/${flow.id}/enroll`, { node_ids: ids }, enrollMessage);
  }
}

// On a contact's card (admins): which flows they're in, and "Add to flow".
function cardFlowsHtml(n) {
  if (!state.isAdmin || n.type !== 'person' || !state.flows) return '';
  const mine = state.flows.enrollments.filter((e) => e.node_id === n.id && flowById(e.flow_id));
  const lines = mine.filter((e) => e.status === 'active').map((e) => {
    const f = flowById(e.flow_id);
    return `<div class="flow-on-card">In flow <b>${esc(f.name)}</b> · step ${e.step_index + 1} of ${f.steps.length} · ${esc(dueLabel(e.due_on))}</div>`;
  }).join('');
  const box = state.enrollFor === n.id ? (state.flows.flows.length
    ? `<form class="flow-enroll" data-form="flow-enroll">
        <select name="flow_id" aria-label="Flow">${state.flows.flows.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select>
        <button type="submit" class="btn btn-sm btn-primary">Add</button>
        <button type="button" class="btn btn-sm btn-ghost" data-flow-act="cancel-enroll">Cancel</button>
      </form>`
    : '<p class="muted flow-enroll">No flows yet. Create one under <b>Flows</b> first.</p>') : '';
  return lines + box;
}

function bulkFlowHtml(count) {
  if (!state.isAdmin || state.dirTab === 'companies' || !state.flows?.flows.length || !count) return '';
  return `<form class="flow-enroll flow-bulk" data-form="flow-bulk">
      <span>Add ${plural(count, 'contact', 'contacts')} to</span>
      <select name="flow_id" aria-label="Flow">${state.flows.flows.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select>
      <button type="submit" class="btn btn-sm">Add</button>
    </form>`;
}

$('#btn-flows').addEventListener('click', () => {
  if (FLOWS_PAGE) openFlowsPanel();
  else window.open('/flows', 'pss-flows');  // reuses the Flows tab when it's already open
});
})();
