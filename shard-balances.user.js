// ==UserScript==
// @name         Shard Balances
// @namespace    trading-ui-scripts
// @version      1.0
// @description  Hover panel showing cash on each exchange shard for every subaccount.
// @match        https://kalshi.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/brian-cai/trading-ui-scripts/main/shard-balances.user.js
// @downloadURL  https://raw.githubusercontent.com/brian-cai/trading-ui-scripts/main/shard-balances.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ───────────────────────── CONFIG ─────────────────────────
  const API = 'https://api.elections.kalshi.com/trade-api/v2';
  const SHARDS = [
    { i: 0, name: 'General' },
    { i: 1, name: 'Combos' },
    { i: 2, name: 'Crypto/Cmdty' },
    { i: 3, name: 'Sports' },
  ];
  const REFRESH_MS = 30000;
  const LS_SUB = 'kalshi-subaccount'; // the site's active-subaccount setting
  const NAMES_KEY = 'ksw-names';      // names learned by the Subaccount Switcher script
  // ──────────────────────────────────────────────────────────

  // Reuse the page's own API headers (in memory only), same as the switcher script.
  const REPLAY = /^(x-csrf-token|x-aws-waf-token)$/i;
  const siteHeaders = {};
  const origSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (REPLAY.test(k)) siteHeaders[k.toLowerCase()] = v;
    return origSet.apply(this, arguments);
  };
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const h = init && init.headers;
      if (h) {
        const entries = h instanceof Headers ? [...h.entries()] : Object.entries(h);
        for (const [k, v] of entries) if (REPLAY.test(k)) siteHeaders[k.toLowerCase()] = v;
      }
    } catch (_) {}
    return origFetch.apply(this, arguments);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitForHeaders(ms = 10000) {
    const t0 = Date.now();
    while (!siteHeaders['x-csrf-token'] && Date.now() - t0 < ms) await sleep(200);
    return !!siteHeaders['x-csrf-token'];
  }
  async function api(path) {
    const r = await origFetch(API + path, { credentials: 'include', headers: { Accept: 'application/json', ...siteHeaders } });
    if (!r.ok) {
      let code = r.status;
      try { const j = await r.json(); code = (j.error && (j.error.code || j.error.message)) || code; } catch (_) {}
      throw new Error(code);
    }
    return r.json();
  }

  function names() {
    try { const s = JSON.parse(localStorage.getItem(NAMES_KEY)); if (Array.isArray(s) && s.length) return s; } catch (_) {}
    return null;
  }
  const subName = (n) => { const s = (names() || []).find((x) => x.n === n); return s ? s.name : (n === 0 ? 'Default' : 'Sub ' + n); };
  function currentSub() {
    try { return JSON.parse(localStorage.getItem(LS_SUB)).state.subaccountNumber ?? 0; } catch (_) { return 0; }
  }
  function switchTo(n) {
    if (n === currentSub()) return;
    let obj; try { obj = JSON.parse(localStorage.getItem(LS_SUB)) || {}; } catch (_) { obj = {}; }
    obj.state = { ...(obj.state || {}), subaccountNumber: n };
    if (obj.version === undefined) obj.version = 0;
    localStorage.setItem(LS_SUB, JSON.stringify(obj));
    location.reload();
  }

  // ---------- Data ----------
  // rows: Map<subaccount, { [shard]: dollars }>
  let data = null, err = null, loading = false, lastAt = 0;

  async function load() {
    if (loading) return;
    loading = true; render();
    try {
      if (!(await waitForHeaders())) throw new Error('waiting for Kalshi to load');
      const rows = new Map();
      try {
        // One call for every (subaccount, shard) pair.
        const j = await api('/portfolio/subaccounts/balances');
        for (const b of j.subaccount_balances || []) {
          const n = Number(b.subaccount_number), i = Number(b.exchange_index);
          if (!rows.has(n)) rows.set(n, {});
          rows.get(n)[i] = (rows.get(n)[i] || 0) + Number(b.balance);
        }
        if (!rows.size) throw new Error('empty');
      } catch (e) {
        // Fallback: per-subaccount balance with its per-shard breakdown.
        const subs = (names() || Array.from({ length: 11 }, (_, n) => ({ n }))).map((s) => s.n);
        await Promise.all(subs.map(async (n) => {
          try {
            const j = await api(`/portfolio/balance?subaccount=${n}`);
            const row = {};
            if (Array.isArray(j.balance_breakdown) && j.balance_breakdown.length) {
              for (const b of j.balance_breakdown) row[Number(b.exchange_index)] = Number(b.balance);
            } else {
              row[0] = j.balance_dollars != null ? Number(j.balance_dollars) : Number(j.balance) / 100;
            }
            rows.set(n, row);
          } catch (_) {}
        }));
        if (!rows.size) throw e;
      }
      // Make sure every known subaccount shows, even at $0.
      for (const s of names() || []) if (!rows.has(s.n)) rows.set(s.n, {});
      data = rows; err = null; lastAt = Date.now();
    } catch (e) {
      err = e.message || String(e);
    }
    loading = false; render();
  }

  // ---------- UI ----------
  const css = `
  #ksb{position:fixed;left:14px;bottom:14px;z-index:2147483645;font:12px/1.35 -apple-system,Segoe UI,Roboto,sans-serif;color:#e8ecef}
  #ksb .box{background:#14181d;border:1px solid #2b323a;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.45);overflow:hidden}
  #ksb .hdr{display:flex;align-items:center;gap:8px;padding:7px 10px;background:#1b2128;cursor:pointer;user-select:none;white-space:nowrap}
  #ksb .tot{background:#2a3340;color:#fff;border-radius:6px;padding:1px 7px;font-weight:600}
  #ksb .mini{display:flex;gap:6px;color:#9aa6b2;font-size:11px}
  #ksb .mini b{color:#cfd6dd;font-weight:600}
  #ksb .pin{color:#7d8995;font-size:11px}
  #ksb .body{padding:6px 8px 8px;max-height:60vh;overflow:auto}
  #ksb:not(.pinned):not(:hover) .body{display:none}
  #ksb:not(.pinned):not(:hover) .box{opacity:.85}
  #ksb table{border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
  #ksb th{color:#9aa6b2;font-weight:600;font-size:11px;text-align:right;padding:3px 8px;border-bottom:1px solid #2b323a;white-space:nowrap}
  #ksb th:first-child{text-align:left}
  #ksb td{padding:3px 8px;text-align:right;border-bottom:1px solid #20262d;white-space:nowrap}
  #ksb td:first-child{text-align:left;max-width:170px;overflow:hidden;text-overflow:ellipsis}
  #ksb tr.sub{cursor:pointer}
  #ksb tr.sub:hover td{background:#1c232b}
  #ksb tr.active td{background:#123326}
  #ksb tr.active td:first-child{box-shadow:inset 3px 0 0 #00a36c}
  #ksb td.z{color:#4c5661}
  #ksb td.rowtot{font-weight:700;color:#fff}
  #ksb tfoot td{font-weight:700;border-top:1px solid #2b323a;border-bottom:0;color:#fff}
  #ksb .foot{display:flex;justify-content:space-between;color:#7d8995;font-size:11px;margin-top:6px}
  #ksb .foot a{color:#7cc4ff;cursor:pointer}
  #ksb .err{color:#ff8a8a;padding:4px 2px}
  #ksb .muted{color:#7d8995}
  `;

  let root;
  const money = (v) => {
    if (!v) return '$0';
    const a = Math.abs(v);
    const s = a >= 100000 ? '$' + Math.round(a / 1000) + 'k' : '$' + a.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return v < 0 ? '-' + s : s;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function render() {
    if (!root) return;
    const cur = currentSub();
    const shardTot = {}; let grand = 0;
    const rows = data ? [...data.entries()].sort((a, b) => a[0] - b[0]) : [];
    for (const [, r] of rows) for (const s of SHARDS) { const v = r[s.i] || 0; shardTot[s.i] = (shardTot[s.i] || 0) + v; grand += v; }

    const mini = data ? SHARDS.map((s) => `<span title="${esc(s.name)}">${esc(s.name.split('/')[0])} <b>${money(shardTot[s.i] || 0)}</b></span>`).join('') : '';
    const body = !data
      ? (err ? `<div class="err">${esc(err)}</div>` : '<div class="muted">Loading…</div>')
      : `<table><thead><tr><th>Subaccount</th>${SHARDS.map((s) => `<th>${esc(s.name)}</th>`).join('')}<th>Total</th></tr></thead><tbody>` +
        rows.map(([n, r]) => {
          const t = SHARDS.reduce((a, s) => a + (r[s.i] || 0), 0);
          return `<tr class="sub ${n === cur ? 'active' : ''}" data-n="${n}" title="Click to switch to this subaccount"><td>${n} · ${esc(subName(n))}</td>` +
            SHARDS.map((s) => `<td class="${r[s.i] ? '' : 'z'}">${money(r[s.i] || 0)}</td>`).join('') + `<td class="rowtot">${money(t)}</td></tr>`;
        }).join('') +
        `</tbody><tfoot><tr><td>All</td>${SHARDS.map((s) => `<td>${money(shardTot[s.i] || 0)}</td>`).join('')}<td>${money(grand)}</td></tr></tfoot></table>` +
        (err ? `<div class="err">${esc(err)}</div>` : '') +
        `<div class="foot"><span>${lastAt ? 'Updated ' + new Date(lastAt).toLocaleTimeString() : ''}</span><a data-act="refresh">${loading ? 'loading…' : 'refresh'}</a></div>`;

    root.innerHTML = `<div class="box"><div class="hdr" data-act="pin" title="Hover to open · click to pin open">
      <span class="tot">Cash ${data ? money(grand) : '…'}</span><span class="mini">${mini}</span>
      <span class="pin">${root.classList.contains('pinned') ? '📌' : '▴'}</span></div><div class="body">${body}</div></div>`;
  }

  function build() {
    if (root) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    root = document.createElement('div'); root.id = 'ksb';
    try { if (localStorage.getItem('ksb-pin') === '1') root.classList.add('pinned'); } catch (_) {}
    document.body.appendChild(root);
    render();
  }

  document.addEventListener('click', (e) => {
    if (!root || !root.contains(e.target)) return;
    const row = e.target.closest('tr.sub');
    if (row) { switchTo(Number(row.dataset.n)); return; }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'refresh') load();
    if (a.dataset.act === 'pin') {
      root.classList.toggle('pinned');
      try { localStorage.setItem('ksb-pin', root.classList.contains('pinned') ? '1' : '0'); } catch (_) {}
      render();
    }
  }, true);

  function start() {
    build();
    load();
    setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    if (root) root.addEventListener('mouseenter', () => { if (Date.now() - lastAt > 10000) load(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
