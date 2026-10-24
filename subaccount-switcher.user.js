// ==UserScript==
// @name         Subaccount Switcher
// @namespace    trading-ui-scripts
// @version      1.3
// @description  Fast subaccount switching plus resting orders / positions on the current market across all subaccounts.
// @match        https://kalshi.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/brian-cai/trading-ui-scripts/main/subaccount-switcher.user.js
// @downloadURL  https://raw.githubusercontent.com/brian-cai/trading-ui-scripts/main/subaccount-switcher.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ───────────────────────── CONFIG ─────────────────────────
  // Subaccount names are NOT stored in this file. They're learned automatically
  // (and kept only in your browser) whenever you open Account → Sub accounts.
  // Until then, subaccounts 0–10 show as "Sub N".
  const FALLBACK_COUNT = 11;
  const NAMES_KEY = 'ksw-names';
  function loadSubaccounts() {
    try {
      const saved = JSON.parse(localStorage.getItem(NAMES_KEY));
      if (Array.isArray(saved) && saved.length) return saved;
    } catch (_) {}
    return Array.from({ length: FALLBACK_COUNT }, (_, n) => ({ n, name: n === 0 ? 'Default' : 'Sub ' + n }));
  }
  let SUBACCOUNTS = loadSubaccounts();
  const API = 'https://api.elections.kalshi.com/trade-api/v2';
  const LS_KEY = 'kalshi-subaccount';     // where Kalshi's web app stores the active subaccount
  const HOTKEYS = true;                    // Alt+0..9 switches to subaccount 0..9; Alt+` toggles panel
  // ──────────────────────────────────────────────────────────

  // ---------- Reuse the site's own API headers (kept in memory only) ----------
  // Kalshi's web app authenticates API calls with your session cookie plus a few
  // headers (CSRF / WAF). We remember the ones the page itself sets so our read-only
  // GETs look identical. Nothing is stored or sent anywhere except Kalshi's API.
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

  async function waitForHeaders(ms = 10000) {
    const t0 = Date.now();
    while (!siteHeaders['x-csrf-token'] && Date.now() - t0 < ms) await sleep(200);
    return !!siteHeaders['x-csrf-token'];
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function api(path) {
    const r = await origFetch(API + path, {
      credentials: 'include',
      headers: { Accept: 'application/json', ...siteHeaders },
    });
    if (!r.ok) {
      let code = r.status;
      try { const j = await r.json(); code = (j.error && (j.error.code || j.error.message)) || code; } catch (_) {}
      throw new Error(code);
    }
    return r.json();
  }

  // ---------- Subaccount get/set ----------
  function currentSub() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)).state.subaccountNumber ?? 0; }
    catch (_) { return 0; }
  }
  function switchTo(n) {
    if (n === currentSub()) return;
    let obj;
    try { obj = JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (_) { obj = {}; }
    obj.state = { ...(obj.state || {}), subaccountNumber: n };
    if (obj.version === undefined) obj.version = 0;
    localStorage.setItem(LS_KEY, JSON.stringify(obj));
    location.reload();
  }
  const subName = (n) => (SUBACCOUNTS.find((s) => s.n === n) || { name: 'Sub ' + n }).name;

  // ---------- Current market from URL ----------
  // /markets/<series>/<slug>/<event-ticker>?marketTicker=<MARKET>
  function marketContext() {
    if (!location.pathname.startsWith('/markets/')) return null;
    const parts = location.pathname.split('/').filter(Boolean);
    const event = parts.length >= 4 ? parts[3].toUpperCase() : null;
    const market = new URLSearchParams(location.search).get('marketTicker');
    if (!event && !market) return null;
    return { event, market: market ? market.toUpperCase() : null };
  }

  // ---------- Data helpers ----------
  const num = (...vals) => { for (const v of vals) if (v !== undefined && v !== null && v !== '') return Number(v); return 0; };
  function orderPriceCents(o) {
    const side = (o.side || '').toLowerCase();
    if (side === 'no') return o.no_price ?? (o.no_price_dollars != null ? Math.round(o.no_price_dollars * 100) : null);
    return o.yes_price ?? (o.yes_price_dollars != null ? Math.round(o.yes_price_dollars * 100) : null);
  }
  function shortTicker(t, event) {
    if (event && t && t.startsWith(event + '-')) return t.slice(event.length + 1);
    return t;
  }

  async function loadSub(n, ctx) {
    const q = ctx.event ? 'event_ticker=' + encodeURIComponent(ctx.event) : 'ticker=' + encodeURIComponent(ctx.market);
    const [o, p] = await Promise.allSettled([
      api(`/portfolio/orders?status=resting&limit=200&subaccount=${n}&${q}`),
      api(`/portfolio/positions?limit=200&count_filter=position&subaccount=${n}&${q}`),
    ]);
    const orders = o.status === 'fulfilled' ? (o.value.orders || []) : null;
    let positions = p.status === 'fulfilled' ? (p.value.market_positions || []) : null;
    if (positions) positions = positions.filter((x) => num(x.position, x.position_fp) !== 0);
    // If the API ignores the subaccount param and returns everything, filter by field when present.
    const keep = (x) => x.subaccount === undefined || x.subaccount === null || Number(x.subaccount) === n;
    return {
      n,
      orders: orders && orders.filter(keep),
      positions: positions && positions.filter(keep),
      error: o.status === 'rejected' ? o.reason.message : (p.status === 'rejected' ? p.reason.message : null),
    };
  }

  // ---------- UI ----------
  const css = `
  #ksw{position:fixed;right:14px;bottom:14px;z-index:2147483647;font:12px/1.35 -apple-system,Segoe UI,Roboto,sans-serif;color:#e8ecef}
  #ksw .box{background:#14181d;border:1px solid #2b323a;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.45);overflow:hidden;min-width:280px;max-width:420px}
  #ksw .hdr{display:flex;align-items:center;gap:8px;padding:7px 10px;background:#1b2128;cursor:pointer;user-select:none}
  #ksw .hdr b{font-weight:600}
  #ksw .cur{background:#00a36c;color:#fff;border-radius:6px;padding:1px 7px;font-weight:600}
  #ksw .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(74px,1fr));gap:5px;padding:8px}
  #ksw button.sub{position:relative;background:#222932;color:#e8ecef;border:1px solid #333c46;border-radius:7px;padding:6px 4px;cursor:pointer;font:inherit;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #ksw button.sub:hover{border-color:#4f5b68}
  #ksw button.sub.active{border-color:#00a36c;background:#123326}
  #ksw button.sub.has{box-shadow:inset 0 -2px 0 #f5a524}
  #ksw .badge{position:absolute;top:-1px;right:-1px;background:#f5a524;color:#111;border-radius:0 6px 0 6px;font-size:10px;font-weight:700;padding:0 4px}
  #ksw .mkt{border-top:1px solid #2b323a;padding:6px 10px 8px;max-height:46vh;overflow:auto}
  #ksw .mkt h4{margin:2px 0 6px;font-size:11px;color:#9aa6b2;font-weight:600;display:flex;justify-content:space-between;align-items:center}
  #ksw .mkt h4 a{color:#7cc4ff;cursor:pointer;text-decoration:none;font-weight:500}
  #ksw table{width:100%;border-collapse:collapse;font-size:12px}
  #ksw td{padding:2px 4px;border-bottom:1px solid #20262d;white-space:nowrap}
  #ksw td.s{color:#9aa6b2}
  #ksw .yes{color:#2fd27f}#ksw .no{color:#ff6b6b}
  #ksw .hl td{background:#1f2a1f}
  #ksw .muted{color:#7d8995}
  #ksw .err{color:#ff8a8a}
  #ksw .grid{grid-template-columns:repeat(auto-fill,minmax(128px,1fr))}
  /* Collapsed by default: only the small header pill shows. Hover to peek, click header to pin open. */
  #ksw .box{min-width:0}
  #ksw:not(.pinned):not(:hover) .grid,#ksw:not(.pinned):not(:hover) .mkt{display:none}
  #ksw:not(.pinned):not(:hover) .box{opacity:.85}
  #ksw:hover .box,#ksw.pinned .box{min-width:300px}
  #ksw .pin{color:#7d8995;font-size:11px}
  #ksw.pinned .pin{color:#00a36c}
  #ksw .dots{display:flex;gap:3px;margin-left:auto}
  #ksw .dot{width:7px;height:7px;border-radius:50%}
  #ksw .dot.o{background:#5aa9ff}#ksw .dot.p{background:#2fd27f}
  #ksw .mkt{max-height:34vh}
  /* Subaccount buttons: blue edge = resting orders, green edge = position */
  #ksw button.sub{text-align:left;padding:5px 7px;display:flex;flex-direction:column;gap:2px}
  #ksw button.sub .nm{overflow:hidden;text-overflow:ellipsis}
  #ksw button.sub .tags{display:flex;gap:4px;flex-wrap:wrap;font-size:10px;font-weight:700;min-height:0}
  #ksw button.sub .tags:empty{display:none}
  #ksw .t-o{background:#173252;color:#8cc4ff;border-radius:4px;padding:0 4px}
  #ksw .t-p{background:#12391f;color:#5fe39a;border-radius:4px;padding:0 4px}
  #ksw button.sub.ord{border-left:3px solid #5aa9ff}
  #ksw button.sub.pos{border-left:3px solid #2fd27f}
  #ksw button.sub.ord.pos{border-left:3px solid #2fd27f;box-shadow:inset 3px 0 0 #5aa9ff}
  /* Top hint: compact chip under the header; buttons only take space while hovered */
  #ksw-top{position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:2147483646;display:none;align-items:center;gap:6px;
    padding:3px 10px;background:rgba(42,33,16,.92);border:1px solid #f5a524;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.35);
    font:12px/1.35 -apple-system,Segoe UI,Roboto,sans-serif;color:#fbe7c0;max-width:min(92vw,900px);flex-wrap:wrap;justify-content:center}
  #ksw-top.show{display:flex}
  #ksw-top .btns{display:none;gap:6px;flex-wrap:wrap}
  #ksw-top:hover,#ksw-top.fresh{border-radius:10px;padding:6px 10px}
  #ksw-top:hover .btns,#ksw-top.fresh .btns{display:flex}
  #ksw-top button{background:#f5a524;color:#111;border:0;border-radius:6px;padding:3px 8px;font:inherit;font-weight:600;cursor:pointer}
  #ksw-top button:hover{background:#ffbc4a}
  #ksw-top button small{font-weight:500;opacity:.8}
  #ksw-top .x{background:transparent;color:#fbe7c0;padding:0 4px;font-weight:400}
  `;

  let root, state = { ctxKey: null, results: {}, loading: false, err: null };

  function build() {
    if (root) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    root = document.createElement('div'); root.id = 'ksw';
    try { if (localStorage.getItem('ksw-pin') === '1') root.classList.add('pinned'); } catch (_) {}
    document.body.appendChild(root);
    topBar = document.createElement('div'); topBar.id = 'ksw-top';
    document.body.appendChild(topBar);
    render();
  }

  // Banner at the top: shown when the ACTIVE subaccount has nothing on this event
  // but other subaccounts do — one button per subaccount to jump straight there.
  let topBar, topDismissedFor = null, topShownFor = null, freshTimer = null;
  function renderTop() {
    if (!topBar) return;
    const ctx = marketContext();
    const done = ctx && !state.loading && Object.keys(state.results).length;
    if (!done || topDismissedFor === state.ctxKey) { topBar.classList.remove('show'); return; }
    const cur = currentSub();
    const mine = summarize(state.results[cur]);
    const others = SUBACCOUNTS.filter((s) => s.n !== cur).map((s) => ({ s, ...summarize(state.results[s.n]) })).filter((x) => x.orders + x.positions > 0);
    if (mine.orders + mine.positions > 0 || !others.length) { topBar.classList.remove('show'); return; }
    topBar.innerHTML = `<span>⚡ Nothing on <b>${esc(subName(cur))}</b> · ${others.length} other sub${others.length === 1 ? '' : 's'} active</span>` +
      `<span class="btns">` + others.map((x) => `<button data-n="${x.s.n}">${esc(x.s.name)} <small>${tagText(x).join(' · ')}</small></button>`).join('') + `</span>` +
      `<button class="x" data-act="dismiss" title="Hide for this market">✕</button>`;
    topBar.classList.add('show');
    // Show the buttons expanded for a few seconds when it first appears, then shrink to a chip.
    if (topShownFor !== state.ctxKey) {
      topShownFor = state.ctxKey;
      topBar.classList.add('fresh');
      clearTimeout(freshTimer);
      freshTimer = setTimeout(() => topBar.classList.remove('fresh'), 5000);
    }
  }

  // Per-subaccount totals for the current event.
  function summarize(r) {
    const out = { orders: 0, positions: 0, contracts: 0, yes: 0, no: 0, exposure: null };
    if (!r) return out;
    out.orders = r.orders ? r.orders.length : 0;
    for (const p of r.positions || []) {
      const pos = num(p.position, p.position_fp);
      out.positions++;
      out.contracts += Math.abs(pos);
      if (pos > 0) out.yes += pos; else out.no += -pos;
      const ex = p.market_exposure_dollars != null ? Number(p.market_exposure_dollars) : (p.market_exposure != null ? Number(p.market_exposure) / 100 : null);
      if (ex != null && !isNaN(ex)) out.exposure = (out.exposure || 0) + ex;
    }
    return out;
  }
  const fmtN = (n) => (n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n * 100) / 100));
  function tagText(x) {
    const t = [];
    if (x.contracts) {
      const side = x.yes && x.no ? `${fmtN(x.yes)}Y/${fmtN(x.no)}N` : x.yes ? `${fmtN(x.yes)} YES` : `${fmtN(x.no)} NO`;
      t.push(side + (x.exposure != null ? ` · $${fmtN(Math.round(x.exposure))}` : ''));
    }
    if (x.orders) t.push(`${x.orders} order${x.orders === 1 ? '' : 's'}`);
    return t;
  }

  function toggleMin() {
    root.classList.toggle('pinned');
    try { localStorage.setItem('ksw-pin', root.classList.contains('pinned') ? '1' : '0'); } catch (_) {}
    render();
  }

  function render() {
    if (!root) return;
    const cur = currentSub();
    const ctx = marketContext();
    const res = state.results;

    let nOrd = 0, nPos = 0;
    const subBtns = SUBACCOUNTS.map((s) => {
      const x = summarize(res[s.n]);
      if (x.orders) nOrd++;
      if (x.contracts) nPos++;
      const posTag = x.contracts ? `<span class="t-p">${esc(tagText({ ...x, orders: 0 })[0])}</span>` : '';
      const ordTag = x.orders ? `<span class="t-o">${x.orders} ord</span>` : '';
      const title = res[s.n] ? `${x.orders} resting orders, ${fmtN(x.contracts)} contracts held on this event` : '';
      return `<button class="sub ${s.n === cur ? 'active' : ''} ${x.orders ? 'ord' : ''} ${x.contracts ? 'pos' : ''}" data-n="${s.n}" title="${s.n}: ${esc(s.name)}${title ? ' — ' + title : ''}">
        <span class="nm">${s.n <= 9 && HOTKEYS ? `<span class="muted">${s.n}</span> ` : ''}${esc(s.name)}</span><span class="tags">${posTag}${ordTag}</span></button>`;
    }).join('');
    const dots = ctx ? `<span class="dots" title="${nPos} subaccounts with positions, ${nOrd} with orders on this event">${'<i class="dot p"></i>'.repeat(nPos)}${'<i class="dot o"></i>'.repeat(nOrd)}</span>` : '';

    let mkt = '';
    if (ctx) {
      const rows = [];
      for (const s of SUBACCOUNTS) {
        const r = res[s.n]; if (!r) continue;
        for (const o of r.orders || []) {
          const side = (o.side || '').toLowerCase();
          const qty = num(o.remaining_count, o.remaining_count_fp);
          const px = orderPriceCents(o);
          const hl = ctx.market && o.ticker === ctx.market;
          rows.push(`<tr class="${hl ? 'hl' : ''}"><td class="s">${esc(s.name)}</td><td>${esc(shortTicker(o.ticker, ctx.event))}</td>
            <td>${esc((o.action || 'buy').toUpperCase())} <span class="${side}">${esc(side.toUpperCase())}</span></td>
            <td>${qty} @ ${px != null ? px + '¢' : '?'}</td></tr>`);
        }
        for (const p of r.positions || []) {
          const pos = num(p.position, p.position_fp);
          const hl = ctx.market && p.ticker === ctx.market;
          rows.push(`<tr class="${hl ? 'hl' : ''}"><td class="s">${esc(s.name)}</td><td>${esc(shortTicker(p.ticker, ctx.event))}</td>
            <td class="muted">position</td><td><span class="${pos > 0 ? 'yes' : 'no'}">${Math.abs(pos)} ${pos > 0 ? 'YES' : 'NO'}</span></td></tr>`);
        }
      }
      const errs = SUBACCOUNTS.map((s) => res[s.n] && res[s.n].error ? `${s.name}: ${res[s.n].error}` : null).filter(Boolean);
      mkt = `<div class="mkt"><h4><span>${esc(ctx.event || ctx.market)} · all subaccounts</span><a data-act="refresh">${state.loading ? 'loading…' : 'refresh'}</a></h4>
        ${state.err ? `<div class="err">${esc(state.err)}</div>` : ''}
        ${rows.length ? `<table>${rows.join('')}</table>` : (state.loading ? '' : '<div class="muted">No resting orders or positions on this event in any subaccount.</div>')}
        ${errs.length ? `<div class="err">${errs.map(esc).join('<br>')}</div>` : ''}</div>`;
    }

    root.innerHTML = `<div class="box">
      <div class="hdr" data-act="min" title="Hover to open · click to pin open"><span class="cur">${cur} · ${esc(subName(cur))}</span>
        ${dots || '<span style="margin-left:auto"></span>'}<span class="pin">${root.classList.contains('pinned') ? '📌' : '▴'}</span></div>
      <div class="grid">${subBtns}</div>${mkt}</div>`;
    renderTop();
  }

  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  async function refresh(force) {
    const ctx = marketContext();
    const key = ctx ? (ctx.event || '') + '|' + (ctx.market || '') : null;
    if (!force && key === state.ctxKey) return;
    state.ctxKey = key; state.results = {}; state.err = null;
    if (!ctx) { render(); return; }
    state.loading = true; render();
    if (!(await waitForHeaders())) {
      state.loading = false; state.err = 'Waiting for Kalshi to make its first API call — click refresh in a moment.'; render(); return;
    }
    const myKey = key;
    await Promise.all(SUBACCOUNTS.map(async (s) => {
      try { const r = await loadSub(s.n, ctx); if (state.ctxKey === myKey) { state.results[s.n] = r; render(); } }
      catch (e) { if (state.ctxKey === myKey) { state.results[s.n] = { n: s.n, orders: [], positions: [], error: e.message }; render(); } }
    }));
    if (state.ctxKey === myKey) { state.loading = false; render(); }
  }

  // ---------- Wiring ----------
  document.addEventListener('click', (e) => {
    if (topBar && topBar.contains(e.target)) {
      const tb = e.target.closest('button');
      if (!tb) return;
      if (tb.dataset.act === 'dismiss') { topDismissedFor = state.ctxKey; renderTop(); }
      else switchTo(Number(tb.dataset.n));
      return;
    }
    if (!root || !root.contains(e.target)) return;
    const b = e.target.closest('button.sub');
    if (b) { switchTo(Number(b.dataset.n)); return; }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'min') toggleMin();
    if (a.dataset.act === 'refresh') refresh(true);
  }, true);

  if (HOTKEYS) {
    window.addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const tag = (e.target && e.target.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable)) return;
      if (e.code === 'Backquote') { e.preventDefault(); toggleMin(); return; }
      const m = /^Digit(\d)$/.exec(e.code);
      if (m && SUBACCOUNTS.some((s) => s.n === Number(m[1]))) { e.preventDefault(); switchTo(Number(m[1])); }
    }, true);
  }

  // Learn subaccount names from Kalshi's own Sub accounts page (/account/sub-accounts).
  // Each card there reads "<name>\nSubaccount <n>", with the first being "Subaccount 0 (default)".
  function learnNames() {
    if (!location.pathname.startsWith('/account/sub-accounts')) return;
    const text = document.body ? document.body.innerText : '';
    const found = [...text.matchAll(/^(.+)\n+Subaccount (\d+)\s*$/gm)]
      .map((m) => ({ n: Number(m[2]), name: m[1].trim() }))
      .filter((x) => x.name && x.n >= 1 && x.n <= 63);
    if (!found.length) return;
    const byN = new Map(found.map((x) => [x.n, x]));
    const list = [{ n: 0, name: 'Default' }, ...[...byN.values()].sort((a, b) => a.n - b.n)];
    const json = JSON.stringify(list);
    if (json === localStorage.getItem(NAMES_KEY)) return;
    try { localStorage.setItem(NAMES_KEY, json); } catch (_) {}
    SUBACCOUNTS = list;
    render();
  }

  function start() {
    build();
    refresh(true);
    learnNames();
    setInterval(learnNames, 1500);
    let last = location.href;               // Kalshi is a SPA — watch for in-app navigation
    setInterval(() => { if (location.href !== last) { last = location.href; refresh(false); } }, 400);
    setInterval(() => { if (marketContext() && !document.hidden) refresh(true); }, 30000); // light auto-refresh
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
