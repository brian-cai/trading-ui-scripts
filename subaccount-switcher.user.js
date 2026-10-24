// ==UserScript==
// @name         Subaccount Switcher
// @namespace    trading-ui-scripts
// @version      2.1
// @description  Fast subaccount switching, resting orders / positions on the current market across all subaccounts, and per-subaccount fill history.
// @match        https://kalshi.com/*
// @run-at       document-start
// @grant        none
// @noframes
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
  const API = 'https://api.elections.kalshi.com/trade-api/v2';
  const LS_KEY = 'kalshi-subaccount';     // where Kalshi's web app stores the active subaccount
  const HOTKEYS = true;                    // Alt+Shift+0..9 switches to subaccount 0..9; Alt+Shift+` pins/unpins
  const HISTORY_LIMIT = 50;                // fills fetched per subaccount
  // ──────────────────────────────────────────────────────────

  function loadSubaccounts() {
    try {
      const saved = JSON.parse(localStorage.getItem(NAMES_KEY));
      if (Array.isArray(saved) && saved.length) {
        const clean = saved
          .map((x) => ({ n: Math.trunc(Number(x && x.n)), name: String((x && x.name) || '').slice(0, 60) }))
          .filter((x) => Number.isFinite(x.n) && x.n >= 0 && x.n <= 63);
        if (clean.length) return clean;
      }
    } catch (_) {}
    return Array.from({ length: FALLBACK_COUNT }, (_, n) => ({ n, name: n === 0 ? 'Default' : 'Sub ' + n }));
  }
  let SUBACCOUNTS = loadSubaccounts();

  // ---------- Reuse the site's own API headers (kept in memory only) ----------
  // Kalshi's web app authenticates API calls with your session cookie plus a few
  // headers (CSRF / WAF). We remember the ones the page itself sets so our read-only
  // GETs look identical. Nothing is stored or sent anywhere except Kalshi's API.
  const REPLAY = /^(x-csrf-token|x-aws-waf-token)$/i;
  const API_ORIGIN = 'https://api.elections.kalshi.com/';
  const siteHeaders = {};
  // Only XHR is hooked (that's what Kalshi's app uses), and only headers on requests
  // going to Kalshi's own API are remembered. Nothing is stored or sent anywhere else.
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, url) {
    try { this.__tusKalshi = String(url || '').startsWith(API_ORIGIN); } catch (_) { this.__tusKalshi = false; }
    return origOpen.apply(this, arguments);
  };
  const origSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__tusKalshi && REPLAY.test(k)) siteHeaders[k.toLowerCase()] = v;
    return origSet.apply(this, arguments);
  };
  const origFetch = window.fetch.bind(window);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitForHeaders(ms = 10000) {
    const t0 = Date.now();
    while (!siteHeaders['x-csrf-token'] && Date.now() - t0 < ms) await sleep(200);
    return !!siteHeaders['x-csrf-token'];
  }
  // Read-only GETs to Kalshi's API only. At most MAX_CONCURRENT in flight so we never
  // burst your account's rate limit (which your other tools/bots may share); on HTTP 429
  // all background refreshing pauses for a couple of minutes.
  const MAX_CONCURRENT = 3;
  let inFlight = 0; const waiters = [];
  let pausedUntil = 0;
  const isPaused = () => Date.now() < pausedUntil;
  async function api(path) {
    while (inFlight >= MAX_CONCURRENT) await new Promise((r) => waiters.push(r));
    if (isPaused()) { const w = waiters.shift(); if (w) w(); throw new Error('paused (rate limited)'); }
    inFlight++;
    try { return await apiNow(path); }
    finally { inFlight--; const w = waiters.shift(); if (w) w(); }
  }
  async function apiNow(path) {
    const r = await origFetch(API + path, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json', ...siteHeaders },
    });
    if (r.status === 429) { pausedUntil = Date.now() + 120000; throw new Error('Rate limited — pausing auto-refresh for 2 min'); }
    if (!r.ok) {
      let code = r.status;
      try { const j = await r.json(); code = (j.error && (j.error.code || j.error.message)) || code; } catch (_) {}
      throw new Error(code);
    }
    return r.json();
  }

  // ---------- Subaccount get/set ----------
  function currentSub() {
    try { const n = Math.trunc(Number(JSON.parse(localStorage.getItem(LS_KEY)).state.subaccountNumber)); return Number.isFinite(n) && n >= 0 ? n : 0; }
    catch (_) { return 0; }
  }
  function switchTo(n) {
    if (n === currentSub()) return;
    let obj;
    try { obj = JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (_) { obj = {}; }
    obj.state = { ...(obj.state || {}), subaccountNumber: n };   // change only this field
    localStorage.setItem(LS_KEY, JSON.stringify(obj));
    location.reload();
  }
  const subName = (n) => (SUBACCOUNTS.find((s) => s.n === n) || { name: n === 0 ? 'Default' : 'Sub ' + n }).name;

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

  // ---------- Helpers ----------
  const num = (...vals) => { for (const v of vals) if (v !== undefined && v !== null && v !== '') return Number(v); return 0; };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtN = (n) => (n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n * 100) / 100));
  function priceCents(o) {
    const side = (o.side || '').toLowerCase();
    const raw = side === 'no'
      ? (o.no_price ?? (o.no_price_dollars != null ? o.no_price_dollars * 100 : null))
      : (o.yes_price ?? (o.yes_price_dollars != null ? o.yes_price_dollars * 100 : null));
    const v = Math.round(Number(raw));
    return raw == null || !Number.isFinite(v) ? null : v;
  }
  const sideCls = (v) => (String(v || '').toLowerCase() === 'no' ? 'no' : String(v || '').toLowerCase() === 'yes' ? 'yes' : '');
  function shortTicker(t, event) {
    if (event && t && t.startsWith(event + '-')) return t.slice(event.length + 1);
    return t;
  }
  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (_) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

  // ---------- Market data (orders + positions per subaccount) ----------
  async function loadSub(n, ctx) {
    const q = ctx.event ? 'event_ticker=' + encodeURIComponent(ctx.event) : 'ticker=' + encodeURIComponent(ctx.market);
    const [o, p] = await Promise.allSettled([
      api(`/portfolio/orders?status=resting&limit=200&subaccount=${n}&${q}`),
      // settlement_status=all + total_traded: includes flat and settled markets, for P&L on closed markets
      api(`/portfolio/positions?limit=200&count_filter=total_traded&settlement_status=all&subaccount=${n}&${q}`),
    ]);
    // If the API ignores the subaccount param and returns everything, filter by field when present.
    const keep = (x) => {
      const s = x.subaccount ?? x.subaccount_number;
      return s === undefined || s === null || Number(s) === n;
    };
    const orders = o.status === 'fulfilled' ? (o.value.orders || []).filter(keep) : null;
    const traded = p.status === 'fulfilled' ? (p.value.market_positions || []).filter(keep) : null;
    const positions = traded && traded.filter((x) => num(x.position, x.position_fp) !== 0);
    return {
      n, orders, positions, traded,
      error: o.status === 'rejected' ? o.reason.message : (p.status === 'rejected' ? p.reason.message : null),
    };
  }

  // Settlements are only needed for the P&L tab, so they're fetched on demand.
  const settle = { key: null, bySub: {}, loading: false };
  async function loadSettlements(force) {
    const ctx = marketContext();
    if (!ctx) return;
    const key = state.ctxKey;
    if (!force && settle.key === key) return;
    settle.key = key; settle.bySub = {}; settle.loading = true; render();
    if (!(await waitForHeaders())) { settle.loading = false; render(); return; }
    const q = ctx.event ? 'event_ticker=' + encodeURIComponent(ctx.event) : 'ticker=' + encodeURIComponent(ctx.market);
    // Only subaccounts that traded this event can have a settlement on it.
    const subs = SUBACCOUNTS.filter((s) => { const r = state.results[s.n]; return !r || !r.traded || r.traded.length; }).map((s) => s.n);
    await Promise.all(subs.map(async (n) => {
      try {
        const j = await api(`/portfolio/settlements?limit=200&subaccount=${n}&${q}`);
        if (settle.key === key) settle.bySub[n] = (j.settlements || []).filter((x) => { const s = x.subaccount ?? x.subaccount_number; return s == null || Number(s) === n; });
      } catch (_) {}
    }));
    if (settle.key === key) { settle.loading = false; render(); }
  }

  // Per-market P&L for one subaccount: realized trading P&L from positions, plus the
  // settlement result (payout − cost of contracts held at settlement − fees) when settled.
  function pnlFor(r) {
    const out = { traded: 0, realized: 0, settle: 0, fees: 0, settled: false, result: null, any: false, total: 0 };
    if (!r) return out;
    for (const p of r.traded || []) {
      out.any = true;
      out.traded += num(p.total_traded_dollars, p.total_traded != null ? p.total_traded / 100 : null);
      out.realized += num(p.realized_pnl_dollars, p.realized_pnl != null ? p.realized_pnl / 100 : null);
      out.fees += num(p.fees_paid_dollars, p.fees_paid != null ? p.fees_paid / 100 : null);
    }
    for (const s of (settle.key === state.ctxKey && settle.bySub[r.n]) || []) {
      out.any = true; out.settled = true; out.result = s.market_result || out.result;
      const cost = num(s.yes_total_cost_dollars, s.yes_total_cost != null ? s.yes_total_cost / 100 : null)
                 + num(s.no_total_cost_dollars, s.no_total_cost != null ? s.no_total_cost / 100 : null);
      out.settle += num(s.revenue) / 100 - cost - num(s.fee_cost);
    }
    out.total = out.realized + out.settle;
    return out;
  }
  const pnlStr = (v) => (v >= 0 ? '+' : '−') + '$' + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
  function tagText(x) {
    const t = [];
    if (x.contracts) {
      const side = x.yes && x.no ? `${fmtN(x.yes)}Y/${fmtN(x.no)}N` : x.yes ? `${fmtN(x.yes)} YES` : `${fmtN(x.no)} NO`;
      t.push(side + (x.exposure != null ? ` · $${fmtN(Math.round(x.exposure))}` : ''));
    }
    if (x.orders) t.push(`${x.orders} order${x.orders === 1 ? '' : 's'}`);
    return t;
  }

  // ---------- History (fills) ----------
  const hist = { key: null, rows: null, loading: false, err: null };
  async function loadHistory(force) {
    const all = lsGet('ksw-hist-all', '0') === '1';
    const ctx = marketContext();
    const onlyMarket = !!ctx && lsGet('ksw-hist-mkt', '0') === '1';
    const key = `${all ? 'all' : currentSub()}|${onlyMarket ? (ctx.market || ctx.event) : ''}`;
    if (!force && hist.key === key && hist.rows) return;
    hist.key = key; hist.loading = true; hist.err = null; render();
    try {
      if (!(await waitForHeaders())) throw new Error('Waiting for Kalshi to load — try refresh.');
      const filt = onlyMarket && ctx.market ? `&ticker=${encodeURIComponent(ctx.market)}` : '';
      const subs = all ? SUBACCOUNTS.map((s) => s.n) : [currentSub()];
      const rows = [];
      const errs = [];
      await Promise.all(subs.map(async (n) => {
        try {
          const j = await api(`/portfolio/fills?limit=${HISTORY_LIMIT}&subaccount=${n}${filt}`);
          for (const f of j.fills || []) {
            const s = f.subaccount ?? f.subaccount_number;
            if (s !== undefined && s !== null && Number(s) !== n) continue;
            if (onlyMarket && !ctx.market && ctx.event && f.ticker && !f.ticker.startsWith(ctx.event)) continue;
            rows.push({ ...f, _n: n });
          }
        } catch (e) { errs.push(`${subName(n)}: ${e.message}`); }
      }));
      rows.sort((a, b) => String(b.created_time || '').localeCompare(String(a.created_time || '')));
      if (hist.key === key) { hist.rows = rows; hist.err = errs.length ? errs.join(' · ') : null; }
    } catch (e) {
      if (hist.key === key) hist.err = e.message;
    }
    if (hist.key === key) { hist.loading = false; render(); }
  }
  function fmtTime(t) {
    if (!t) return '';
    const d = new Date(t);
    if (isNaN(d)) return '';
    const today = new Date();
    return d.toDateString() === today.toDateString()
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  // ---------- UI ----------
  const css = `
  #ksw{order:2;font:12px/1.35 -apple-system,Segoe UI,Roboto,sans-serif;color:#e8ecef}
  #ksw .box{background:#14181d;border:1px solid #2b323a;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.45);overflow:hidden;max-width:440px}
  #ksw .hdr{display:flex;align-items:center;gap:8px;padding:7px 10px;background:#1b2128;cursor:pointer;user-select:none;white-space:nowrap}
  #ksw .cur{background:#00a36c;color:#fff;border-radius:6px;padding:1px 7px;font-weight:600;max-width:200px;overflow:hidden;text-overflow:ellipsis}
  #ksw .alert{background:#f5a524;color:#111;border-radius:6px;padding:1px 6px;font-weight:700}
  #ksw .dots{display:flex;gap:3px;margin-left:auto}
  #ksw .dot{width:7px;height:7px;border-radius:50%}
  #ksw .dot.o{background:#5aa9ff}#ksw .dot.p{background:#2fd27f}
  #ksw .pin{color:#7d8995;font-size:11px}
  #ksw.pinned .pin{color:#00a36c}
  /* Collapsed by default. Hover opens it; clicking inside keeps it open until you click
     elsewhere or press Esc; clicking the header pins it open across page loads. */
  #ksw:not(.pinned):not(.open) .body{display:none}
  #ksw:not(.pinned):not(.open) .box{opacity:.85}
  #ksw.open .box,#ksw.pinned .box{min-width:320px}
  #ksw .stale{background:#3d1717;color:#ffd0d0;padding:6px 10px;border-bottom:1px solid #6b2525}
  #ksw .stale a{color:#fff;text-decoration:underline;cursor:pointer;font-weight:600}
  #ksw .note{color:#f5a524;font-size:11px;padding:4px 10px 0}
  /* "Jump to" section at the top of the panel */
  #ksw .jump{padding:7px 10px;background:#2a2110;border-bottom:1px solid #4a3a14;color:#fbe7c0}
  #ksw .jump .lbl{margin-bottom:5px}
  #ksw .jump .btns{display:flex;flex-wrap:wrap;gap:5px}
  #ksw .jump button{background:#f5a524;color:#111;border:0;border-radius:6px;padding:3px 8px;font:inherit;font-weight:600;cursor:pointer}
  #ksw .jump button:hover{background:#ffbc4a}
  #ksw .jump button small{font-weight:500;opacity:.8}
  /* Subaccount grid */
  #ksw .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:5px;padding:8px}
  #ksw button.sub{background:#222932;color:#e8ecef;border:1px solid #333c46;border-radius:7px;padding:5px 7px;cursor:pointer;font:inherit;text-align:left;white-space:nowrap;overflow:hidden;display:flex;flex-direction:column;gap:2px}
  #ksw button.sub:hover{border-color:#4f5b68}
  #ksw button.sub.active{border-color:#00a36c;background:#123326}
  #ksw button.sub .nm{overflow:hidden;text-overflow:ellipsis}
  #ksw button.sub .tags{display:flex;gap:4px;flex-wrap:wrap;font-size:10px;font-weight:700}
  #ksw button.sub .tags:empty{display:none}
  #ksw .t-o{background:#173252;color:#8cc4ff;border-radius:4px;padding:0 4px}
  #ksw .t-p{background:#12391f;color:#5fe39a;border-radius:4px;padding:0 4px}
  #ksw button.sub.ord{border-left:3px solid #5aa9ff}
  #ksw button.sub.pos{border-left:3px solid #2fd27f}
  #ksw button.sub.ord.pos{border-left:3px solid #2fd27f;box-shadow:inset 3px 0 0 #5aa9ff}
  /* View tabs */
  #ksw .tabs{display:flex;gap:2px;padding:0 8px;border-top:1px solid #2b323a}
  #ksw .tabs a{padding:6px 8px;color:#9aa6b2;cursor:pointer;border-bottom:2px solid transparent;font-weight:600}
  #ksw .tabs a.on{color:#e8ecef;border-bottom-color:#00a36c}
  #ksw .tabs .sp{flex:1}
  #ksw .tabs .rf{color:#7cc4ff;font-weight:500}
  #ksw .view{padding:6px 10px 8px;max-height:30vh;overflow:auto}
  #ksw .opts{display:flex;gap:12px;color:#9aa6b2;margin-bottom:6px;flex-wrap:wrap}
  #ksw .opts label{display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none}
  #ksw .opts input{margin:0;accent-color:#00a36c}
  #ksw table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
  #ksw td{padding:2px 4px;border-bottom:1px solid #20262d;white-space:nowrap}
  #ksw td.s{color:#9aa6b2;max-width:110px;overflow:hidden;text-overflow:ellipsis}
  #ksw td.t{color:#7d8995}
  #ksw td.tk{max-width:150px;overflow:hidden;text-overflow:ellipsis}
  #ksw .yes{color:#2fd27f}#ksw .no{color:#ff6b6b}
  #ksw .hl td{background:#1f2a1f}
  #ksw .muted{color:#7d8995}
  #ksw .err{color:#ff8a8a}
  #ksw .t-up{background:#12391f;color:#5fe39a;border-radius:4px;padding:0 4px}
  #ksw .t-dn{background:#3d1717;color:#ff8a8a;border-radius:4px;padding:0 4px}
  #ksw .up{color:#2fd27f}#ksw .dn{color:#ff6b6b}
  #ksw tr.go{cursor:pointer}
  #ksw tr.go:hover td{background:#1c232b}
  #ksw tr.me td{background:#123326}
  #ksw th{color:#9aa6b2;font-weight:600;font-size:11px;text-align:right;padding:2px 4px;border-bottom:1px solid #2b323a;white-space:nowrap}
  #ksw th:first-child,#ksw .pl td:first-child{text-align:left}
  #ksw .pl td{text-align:right}
  #ksw .pl tfoot td{font-weight:700;border-top:1px solid #2b323a;border-bottom:0}
  `;

  let root, state = { ctxKey: null, results: {}, loading: false, err: null }, jumpDismissedFor = null;
  const view = () => lsGet('ksw-view', 'market');


  // Shared bottom-right stack used by all trading-ui-scripts panels, so they never overlap:
  // each panel grows upward and pushes the ones above it out of the way.
  function getDock() {
    let d = document.getElementById('tus-dock');
    if (!d) {
      d = document.createElement('div'); d.id = 'tus-dock';
      const st = document.createElement('style'); st.id = 'tus-dock-css';
      st.textContent = '#tus-dock{position:fixed;right:14px;bottom:14px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;gap:6px;pointer-events:none;max-height:calc(100vh - 28px);max-width:calc(100vw - 28px)}#tus-dock>*{pointer-events:auto;max-width:100%}';
      document.head.appendChild(st);
      document.body.appendChild(d);
    }
    return d;
  }

  function build() {
    if (root) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    root = document.createElement('div'); root.id = 'ksw';
    if (lsGet('ksw-pin', '0') === '1') root.classList.add('pinned');
    getDock().appendChild(root);
    makeOpenable(root, () => {
      render();
      if (root.classList.contains('open')) backgroundTick(true);
    });
    render();
  }

  function togglePin() {
    root.classList.toggle('pinned');
    lsSet('ksw-pin', root.classList.contains('pinned') ? '1' : '0');
    if (!root.classList.contains('pinned')) root._minH = 0;
    render();
  }

  function marketView(ctx) {
    if (!ctx) return '<div class="muted">Open a market to see orders and positions on it across all subaccounts.</div>';
    const res = state.results;
    const rows = [];
    for (const s of SUBACCOUNTS) {
      const r = res[s.n]; if (!r) continue;
      for (const o of r.orders || []) {
        const side = (o.side || '').toLowerCase();
        const px = priceCents(o);
        const hl = ctx.market && o.ticker === ctx.market;
        rows.push(`<tr class="${hl ? 'hl' : ''}"><td class="s">${esc(s.name)}</td><td class="tk">${esc(shortTicker(o.ticker, ctx.event))}</td>
          <td>${esc((o.action || 'buy').toUpperCase())} <span class="${sideCls(side)}">${esc(side.toUpperCase())}</span></td>
          <td>${num(o.remaining_count, o.remaining_count_fp)} @ ${px != null ? px + '¢' : '?'}</td></tr>`);
      }
      for (const p of r.positions || []) {
        const pos = num(p.position, p.position_fp);
        const hl = ctx.market && p.ticker === ctx.market;
        rows.push(`<tr class="${hl ? 'hl' : ''}"><td class="s">${esc(s.name)}</td><td class="tk">${esc(shortTicker(p.ticker, ctx.event))}</td>
          <td class="muted">position</td><td><span class="${pos > 0 ? 'yes' : 'no'}">${Math.abs(pos)} ${pos > 0 ? 'YES' : 'NO'}</span></td></tr>`);
      }
    }
    const errs = SUBACCOUNTS.map((s) => res[s.n] && res[s.n].error ? `${s.name}: ${res[s.n].error}` : null).filter(Boolean);
    return `${state.err ? `<div class="err">${esc(state.err)}</div>` : ''}
      ${rows.length ? `<table>${rows.join('')}</table>` : (state.loading ? '<div class="muted">Loading…</div>' : (SUBACCOUNTS.some((s) => pnlFor(res[s.n]).any) ? '<div class="muted">Nothing open on this event. <a data-view="pnl" style="color:#7cc4ff;cursor:pointer">See P&amp;L by subaccount →</a></div>' : '<div class="muted">No resting orders or positions on this event in any subaccount.</div>'))}
      ${errs.length ? `<div class="err">${errs.map(esc).join('<br>')}</div>` : ''}`;
  }

  function pnlView(ctx) {
    if (!ctx) return '<div class="muted">Open a market to see each subaccount\'s P&amp;L on it.</div>';
    const res = state.results, cur = currentSub();
    const rows = SUBACCOUNTS.map((s) => ({ s, ...pnlFor(res[s.n]), held: summarize(res[s.n]).contracts })).filter((x) => x.any);
    if (!rows.length) return state.loading ? '<div class="muted">Loading…</div>' : '<div class="muted">No subaccount has traded this event.</div>';
    const tot = rows.reduce((a, x) => ({ traded: a.traded + x.traded, realized: a.realized + x.realized, settle: a.settle + x.settle, total: a.total + x.total }), { traded: 0, realized: 0, settle: 0, total: 0 });
    const settledAny = rows.some((x) => x.settled);
    const cell = (v) => `<td class="${v > 0 ? 'up' : v < 0 ? 'dn' : 'muted'}">${pnlStr(v)}</td>`;
    const result = rows.find((x) => x.result);
    return `${result ? `<div class="muted" style="margin-bottom:4px">Market result: <b>${esc(String(result.result).toUpperCase())}</b></div>` : ''}
      <table class="pl"><thead><tr><th>Subaccount</th><th>Traded</th>${settledAny ? '<th>Trading</th><th>Settlement</th>' : '<th>Realized</th>'}<th>P&amp;L</th></tr></thead><tbody>` +
      rows.map((x) => `<tr class="go ${x.s.n === cur ? 'me' : ''}" data-n="${x.s.n}" title="Click to switch to ${esc(x.s.name)}${x.held ? ' · still holding ' + fmtN(x.held) + ' contracts' : ''}">
        <td class="s">${esc(x.s.name)}</td><td>$${fmtN(Math.round(x.traded * 100) / 100)}</td>${settledAny ? cell(x.realized) + cell(x.settle) : cell(x.realized)}${cell(x.total)}</tr>`).join('') +
      `</tbody><tfoot><tr><td>All</td><td>$${fmtN(Math.round(tot.traded * 100) / 100)}</td>${settledAny ? cell(tot.realized) + cell(tot.settle) : cell(tot.realized)}${cell(tot.total)}</tr></tfoot></table>`;
  }

  function historyView(ctx) {
    const all = lsGet('ksw-hist-all', '0') === '1';
    const onlyMkt = lsGet('ksw-hist-mkt', '0') === '1';
    const opts = `<div class="opts">
      <label title="Include fills from every subaccount, not just the current one"><input type="checkbox" data-opt="ksw-hist-all" ${all ? 'checked' : ''}> All subaccounts</label>
      ${ctx ? `<label title="Only fills on the market you're viewing"><input type="checkbox" data-opt="ksw-hist-mkt" ${onlyMkt ? 'checked' : ''}> This market only</label>` : ''}
    </div>`;
    let body;
    if (hist.loading && !hist.rows) body = '<div class="muted">Loading…</div>';
    else if (!hist.rows || !hist.rows.length) body = hist.loading ? '<div class="muted">Loading…</div>' : `<div class="muted">No recent fills${all ? '' : ' on ' + esc(subName(currentSub()))}.</div>`;
    else body = `<table>${hist.rows.map((f) => {
      const side = (f.side || '').toLowerCase();
      const px = priceCents(f);
      const qty = num(f.count, f.count_fp);
      return `<tr><td class="t">${esc(fmtTime(f.created_time))}</td>${all ? `<td class="s">${esc(subName(f._n))}</td>` : ''}
        <td class="tk" title="${esc(f.ticker)}">${esc(ctx ? shortTicker(f.ticker, ctx.event) : f.ticker)}</td>
        <td>${esc((f.action || '').toUpperCase())} <span class="${sideCls(side)}">${esc(side.toUpperCase())}</span></td>
        <td>${qty} @ ${px != null ? px + '¢' : '?'}</td></tr>`;
    }).join('')}</table>`;
    return opts + (hist.err ? `<div class="err">${esc(hist.err)}</div>` : '') + body;
  }

  function render() {
    if (!root) return;
    SUBACCOUNTS = loadSubaccounts();
    const cur = currentSub();
    if (shownSub === null) shownSub = cur;
    const stale = staleFrom !== null && cur !== staleFrom;
    const ctx = marketContext();
    const res = state.results;

    // Subaccount grid
    let nOrd = 0, nPos = 0;
    const subBtns = SUBACCOUNTS.map((s) => {
      const x = summarize(res[s.n]);
      if (x.orders) nOrd++;
      if (x.contracts) nPos++;
      const posTag = x.contracts ? `<span class="t-p">${esc(tagText({ ...x, orders: 0 })[0])}</span>` : '';
      const ordTag = x.orders ? `<span class="t-o">${x.orders} ord</span>` : '';
      const pl = pnlFor(res[s.n]);
      const plTag = !x.orders && !x.contracts && pl.any && Math.abs(pl.total) >= 0.005 ? `<span class="${pl.total >= 0 ? 't-up' : 't-dn'}">${pnlStr(pl.total)}</span>` : '';
      const title = res[s.n] ? ` — ${x.orders} resting orders, ${fmtN(x.contracts)} contracts held on this event` : '';
      return `<button class="sub ${s.n === cur ? 'active' : ''} ${x.orders ? 'ord' : ''} ${x.contracts ? 'pos' : ''}" data-n="${s.n}" title="${s.n}: ${esc(s.name)}${title}">
        <span class="nm">${s.n <= 9 && HOTKEYS ? `<span class="muted">${s.n}</span> ` : ''}${esc(s.name)}</span><span class="tags">${posTag}${ordTag}${plTag}</span></button>`;
    }).join('');

    // "Jump to" — current subaccount has nothing here but others do
    let jump = '', alert = '';
    if (ctx && !state.loading && Object.keys(res).length && jumpDismissedFor !== state.ctxKey) {
      const mine = summarize(res[cur]);
      const others = SUBACCOUNTS.filter((s) => s.n !== cur)
        .map((s) => ({ s, ...summarize(res[s.n]), pl: pnlFor(res[s.n]) }))
        .filter((x) => x.orders + x.positions > 0 || x.pl.any);
      if (others.length) {
        const mineEmpty = mine.orders + mine.positions === 0 && !pnlFor(res[cur]).any;
        alert = `<span class="alert" title="Other subaccounts have activity on this market">⚡ ${others.length}</span>`;
        const lbl = mineEmpty ? `Nothing here on <b>${esc(subName(cur))}</b> — switch to:` : `Also active on:`;
        jump = `<div class="jump"><div class="lbl">${lbl} <a data-act="dismiss" class="muted" style="float:right;cursor:pointer" title="Hide for this market">✕</a></div>
          <div class="btns">${others.map((x) => `<button data-jump="${x.s.n}">${esc(x.s.name)} <small>${(tagText(x).length ? tagText(x) : [pnlStr(x.pl.total) + ' P&amp;L']).join(' · ')}</small></button>`).join('')}</div></div>`;
      }
    }

    const dots = ctx ? `<span class="dots" title="${nPos} subaccounts with positions, ${nOrd} with orders on this event">${'<i class="dot p"></i>'.repeat(nPos)}${'<i class="dot o"></i>'.repeat(nOrd)}</span>` : '<span style="margin-left:auto"></span>';
    const v = view();
    const busy = v === 'history' ? hist.loading : state.loading;

    const isOpen = root.classList.contains('open') || root.classList.contains('pinned');
    const prevBox = root.firstElementChild;
    if (isOpen && prevBox) root._minH = Math.max(root._minH || 0, prevBox.offsetHeight);
    root.innerHTML = `<div class="box">
      <div class="hdr" data-act="pin" title="Hover to open · click to pin open"><span class="cur">${cur} · ${esc(subName(cur))}</span>${alert}${dots}<span class="pin">${root.classList.contains('pinned') ? '📌' : '▴'}</span></div>
      ${stale ? `<div class="stale">Subaccount changed to <b>${esc(subName(cur))}</b> in another tab — this page may still be trading on <b>${esc(subName(staleFrom))}</b>. <a data-act="reload">Reload</a></div>` : ''}
      <div class="body">${isPaused() ? '<div class="note">Kalshi rate-limited us — auto-refresh paused for a moment.</div>' : ''}${jump}<div class="grid">${subBtns}</div>
        <div class="tabs"><a data-view="market" class="${v === 'market' ? 'on' : ''}">This market</a><a data-view="pnl" class="${v === 'pnl' ? 'on' : ''}">P&amp;L</a><a data-view="history" class="${v === 'history' ? 'on' : ''}">History</a>
          <span class="sp"></span><a class="rf" data-act="refresh">${busy ? 'loading…' : 'refresh'}</a></div>
        <div class="view">${v === 'history' ? historyView(ctx) : v === 'pnl' ? pnlView(ctx) : marketView(ctx)}</div>
      </div></div>`;
    // Never shrink under the cursor while open (that used to close the panel).
    if (isOpen && root._minH) root.firstElementChild.style.minHeight = root._minH + 'px';
  }

  // Open/close controller shared by the panels.
  function makeOpenable(el, onChange) {
    let held = false, timer = null;
    const open = () => { clearTimeout(timer); if (!el.classList.contains('open')) { el.classList.add('open'); onChange(); } };
    const close = () => { clearTimeout(timer); held = false; if (el.classList.contains('open')) { el.classList.remove('open'); el._minH = 0; onChange(); } };
    el.addEventListener('mouseenter', open);
    el.addEventListener('mouseleave', () => { if (!held) { clearTimeout(timer); timer = setTimeout(close, 300); } });
    el.addEventListener('pointerdown', () => { held = true; open(); }, true);
    document.addEventListener('pointerdown', (e) => { if (!el.contains(e.target)) close(); }, true);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); }, true);
    return { close };
  }

  async function refresh(force) {
    const ctx = marketContext();
    const key = ctx ? (ctx.event || '') + '|' + (ctx.market || '') : null;
    if (!force && key === state.ctxKey) return;
    if (state.loading && key === state.ctxKey) return;
    const sameMarket = key === state.ctxKey;
    state.ctxKey = key; state.err = null;
    if (!sameMarket) { state.results = {}; jumpDismissedFor = null; }
    if (!ctx) { render(); return; }
    state.loading = true; render();
    if (!(await waitForHeaders())) {
      state.loading = false; state.err = 'Waiting for Kalshi to make its first API call — click refresh in a moment.'; render(); return;
    }
    const myKey = key;
    const fresh = {};
    await Promise.all(SUBACCOUNTS.map(async (s) => {
      try { fresh[s.n] = await loadSub(s.n, ctx); }
      catch (e) { fresh[s.n] = { n: s.n, orders: [], positions: [], error: e.message }; }
      if (state.ctxKey === myKey && !sameMarket) { state.results[s.n] = fresh[s.n]; render(); }
    }));
    if (state.ctxKey === myKey) {
      state.results = fresh; state.loading = false; render();
      if (view() === 'pnl') loadSettlements(!sameMarket ? true : false);
    }
  }

  // ---------- Wiring ----------
  document.addEventListener('click', (e) => {
    if (!root || !root.contains(e.target)) return;
    const j = e.target.closest('[data-jump]');
    if (j) { switchTo(Number(j.dataset.jump)); return; }
    const pr = e.target.closest('tr.go');
    if (pr) { switchTo(Number(pr.dataset.n)); return; }
    const b = e.target.closest('button.sub');
    if (b) { switchTo(Number(b.dataset.n)); return; }
    const tab = e.target.closest('[data-view]');
    if (tab) {
      lsSet('ksw-view', tab.dataset.view);
      if (tab.dataset.view === 'history') loadHistory(false);
      if (tab.dataset.view === 'pnl') loadSettlements(false);
      render(); return;
    }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'pin') togglePin();
    if (a.dataset.act === 'reload') location.reload();
    if (a.dataset.act === 'dismiss') { jumpDismissedFor = state.ctxKey; render(); }
    if (a.dataset.act === 'refresh') {
      if (view() === 'history') loadHistory(true);
      else { refresh(true); if (view() === 'pnl') loadSettlements(true); }
    }
  }, true);
  document.addEventListener('change', (e) => {
    if (!root || !root.contains(e.target)) return;
    const opt = e.target.dataset && e.target.dataset.opt;
    if (opt) { lsSet(opt, e.target.checked ? '1' : '0'); loadHistory(true); }
  }, true);

  // If another tab switches subaccount, this tab's trading UI may still be on the old one.
  let staleFrom = null;
  window.addEventListener('storage', (e) => {
    if (e.key !== LS_KEY) return;
    if (staleFrom === null) staleFrom = shownSub;
    render();
  });
  let shownSub = null;

  if (HOTKEYS) {
    window.addEventListener('keydown', (e) => {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;   // Alt+Shift only, to avoid accidental reloads
      const tag = (e.target && e.target.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable)) return;
      if (e.code === 'Backquote') { e.preventDefault(); togglePin(); return; }
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
    if (json === lsGet(NAMES_KEY, null)) return;
    lsSet(NAMES_KEY, json);
    render();
  }

  let lastTick = 0;
  function backgroundTick(onOpen) {
    if (document.hidden || isPaused()) return;
    if (!root || !(root.classList.contains('open') || root.classList.contains('pinned'))) return;
    if (onOpen && Date.now() - lastTick < 20000) return;   // just refreshed; don't refetch on every hover
    lastTick = Date.now();
    if (marketContext()) refresh(true);
    if (view() === 'history') loadHistory(true);
  }

  function start() {
    build();
    refresh(true);                          // one load per market so the ⚡ indicator is right
    lastTick = Date.now();
    learnNames();
    setInterval(learnNames, 1500);
    let last = location.href, navTimer = null;               // Kalshi is a SPA — watch for in-app navigation
    setInterval(() => {
      if (location.href !== last) {
        last = location.href;
        clearTimeout(navTimer);
        navTimer = setTimeout(() => refresh(false), 1200);   // wait until you settle on a market
        if (view() === 'history' && lsGet('ksw-hist-mkt', '0') === '1') loadHistory(false);
      }
    }, 400);
    // Background refresh: only while the panel is open/pinned and the tab is visible.
    setInterval(() => backgroundTick(false), 45000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
