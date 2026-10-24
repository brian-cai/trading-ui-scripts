// ==UserScript==
// @name         Shard Balances
// @namespace    trading-ui-scripts
// @version      3.0
// @description  Hover panel showing, for the active subaccount, cash and estimated position value on each exchange shard.
// @match        https://kalshi.com/*
// @run-at       document-start
// @grant        none
// @noframes
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
  const REFRESH_MS = 60000;           // background refresh while the tab is visible
  const LS_SUB = 'kalshi-subaccount'; // the site's active-subaccount setting
  const NAMES_KEY = 'ksw-names';      // names learned by the Subaccount Switcher script
  // ──────────────────────────────────────────────────────────

  // Reuse the page's own API headers (in memory only), same as the switcher script.
  // Only XHR is hooked (that's what Kalshi's app uses), and only headers on requests
  // going to Kalshi's own API are remembered. Nothing is stored or sent anywhere else.
  const REPLAY = /^(x-csrf-token|x-aws-waf-token)$/i;
  const API_ORIGIN = 'https://api.elections.kalshi.com/';
  const siteHeaders = {};
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
  // Read-only GETs to Kalshi's API only, one at a time. On HTTP 429, refreshing pauses for 2 minutes.
  let pausedUntil = 0;
  async function api(path) {
    if (Date.now() < pausedUntil) throw new Error('paused (rate limited)');
    const r = await origFetch(API + path, { method: 'GET', credentials: 'include', headers: { Accept: 'application/json', ...siteHeaders } });
    if (r.status === 429) { pausedUntil = Date.now() + 120000; throw new Error('Rate limited — pausing refresh for 2 min'); }
    if (!r.ok) {
      let code = r.status;
      try { const j = await r.json(); code = (j.error && (j.error.code || j.error.message)) || code; } catch (_) {}
      throw new Error(code);
    }
    return r.json();
  }

  // ---------- Helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const numOr = (v, d = null) => { const n = Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(n) ? d : n; };
  const money = (v) => {
    if (!v) return '$0';
    const a = Math.abs(v);
    const s = a >= 100000 ? '$' + Math.round(a / 1000) + 'k' : '$' + a.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return v < 0 ? '−' + s : s;
  };
  function names() {
    try {
      const s = JSON.parse(localStorage.getItem(NAMES_KEY));
      if (Array.isArray(s) && s.length) {
        return s.map((x) => ({ n: Math.trunc(Number(x && x.n)), name: String((x && x.name) || '').slice(0, 60) }))
          .filter((x) => Number.isFinite(x.n) && x.n >= 0 && x.n <= 63);
      }
    } catch (_) {}
    return [];
  }
  const subName = (n) => { const s = names().find((x) => x.n === n); return s ? s.name : (n === 0 ? 'Default' : 'Sub ' + n); };
  function currentSub() {
    try { const n = Math.trunc(Number(JSON.parse(localStorage.getItem(LS_SUB)).state.subaccountNumber)); return Number.isFinite(n) && n >= 0 ? n : 0; } catch (_) { return 0; }
  }

  // ---------- Data (active subaccount only) ----------
  // cash[shard] = available cash; pos[shard] = { value, cost, count, priced }
  let data = null, err = null, loading = false, lastAt = 0, dataSub = null;

  async function loadCash(sub) {
    const cash = {};
    try {
      const j = await api(`/portfolio/balance?subaccount=${sub}`);
      if (Array.isArray(j.balance_breakdown) && j.balance_breakdown.length) {
        for (const b of j.balance_breakdown) {
          const i = Math.trunc(Number(b.exchange_index)), v = numOr(b.balance);
          if (Number.isFinite(i) && v !== null) cash[i] = (cash[i] || 0) + v;
        }
        return cash;
      }
    } catch (e) { if (/rate limited|paused/i.test(e.message)) throw e; }
    // Fallback: the all-subaccounts endpoint, filtered to this one.
    const j = await api('/portfolio/subaccounts/balances');
    for (const b of j.subaccount_balances || []) {
      if (Math.trunc(Number(b.subaccount_number)) !== sub) continue;
      const i = Math.trunc(Number(b.exchange_index)), v = numOr(b.balance);
      if (Number.isFinite(i) && v !== null) cash[i] = (cash[i] || 0) + v;
    }
    return cash;
  }

  async function loadPositions(sub) {
    const out = []; let cursor = '';
    for (let page = 0; page < 5; page++) {
      const j = await api(`/portfolio/positions?limit=1000&count_filter=position&subaccount=${sub}` + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      out.push(...(j.market_positions || []));
      cursor = j.cursor || '';
      if (!cursor) break;
    }
    return out.filter((p) => numOr(p.position_fp, numOr(p.position, 0)) !== 0);
  }

  async function loadPrices(tickers) {
    const prices = {};
    for (let k = 0; k < tickers.length; k += 100) {
      const chunk = tickers.slice(k, k + 100);
      const j = await api(`/markets?limit=1000&tickers=${encodeURIComponent(chunk.join(','))}`);
      for (const m of j.markets || []) prices[m.ticker] = m;
    }
    return prices;
  }

  // Estimated value of one position: contracts × mid price of the side held.
  // Falls back to last traded price, then to cost basis if the market has no prices.
  function valuePosition(p, m) {
    const count = numOr(p.position_fp, numOr(p.position, 0));
    const qty = Math.abs(count), yes = count > 0;
    const cost = numOr(p.market_exposure_dollars, numOr(p.market_exposure, 0) / 100) || 0;
    if (m) {
      const bid = numOr(yes ? m.yes_bid_dollars : m.no_bid_dollars);
      const ask = numOr(yes ? m.yes_ask_dollars : m.no_ask_dollars);
      if (bid !== null && ask !== null && ask > 0 && ask >= bid) return { value: qty * (bid + ask) / 2, cost, priced: true };
      const last = numOr(m.last_price_dollars);
      if (last !== null && last > 0) return { value: qty * (yes ? last : 1 - last), cost, priced: true };
    }
    return { value: cost, cost, priced: false };
  }

  async function load() {
    if (loading || Date.now() < pausedUntil) return;
    loading = true; render();
    const sub = currentSub();
    try {
      if (!(await waitForHeaders())) throw new Error('waiting for Kalshi to load');
      const cash = await loadCash(sub);
      const positions = await loadPositions(sub);
      let prices = {};
      try { prices = await loadPrices([...new Set(positions.map((p) => p.ticker).filter(Boolean))]); } catch (_) {}
      const pos = {};
      for (const p of positions) {
        const m = prices[p.ticker];
        const i = Math.trunc(numOr(p.exchange_index, numOr(m && m.exchange_index, 0)));
        const v = valuePosition(p, m);
        const s = pos[i] || (pos[i] = { value: 0, cost: 0, count: 0, unpriced: 0 });
        s.value += v.value; s.cost += v.cost; s.count++;
        if (!v.priced) s.unpriced++;
      }
      data = { cash, pos }; dataSub = sub; err = null;
    } catch (e) {
      err = e.message || String(e);
    }
    lastAt = Date.now();                       // back off after errors too
    loading = false; render();
  }

  // ---------- UI ----------
  const css = `
  #tus-dock > #ksb{position:static}
  #ksb{order:1;font:12px/1.35 -apple-system,Segoe UI,Roboto,sans-serif;color:#e8ecef}
  #ksb .box{background:#14181d;border:1px solid #2b323a;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.45);overflow:hidden}
  #ksb .hdr{display:flex;align-items:center;gap:8px;padding:7px 10px;background:#1b2128;cursor:pointer;user-select:none;white-space:nowrap}
  #ksb .tot{background:#2a3340;color:#fff;border-radius:6px;padding:1px 7px;font-weight:600}
  #ksb .who{color:#9aa6b2;font-size:11px;max-width:160px;overflow:hidden;text-overflow:ellipsis}
  #ksb .mini{display:flex;gap:6px;color:#9aa6b2;font-size:11px}
  #ksb .mini b{color:#cfd6dd;font-weight:600}
  #ksb .pin{color:#7d8995;font-size:11px}
  #ksb .body{padding:6px 8px 8px;max-height:40vh;overflow:auto}
  #ksb:not(.pinned):not(.open) .body{display:none}
  #ksb:not(.pinned):not(.open) .box{opacity:.85}
  #ksb table{border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums;width:100%}
  #ksb th{color:#9aa6b2;font-weight:600;font-size:11px;text-align:right;padding:3px 8px;border-bottom:1px solid #2b323a;white-space:nowrap}
  #ksb th:first-child{text-align:left}
  #ksb td{padding:3px 8px;text-align:right;border-bottom:1px solid #20262d;white-space:nowrap}
  #ksb td:first-child{text-align:left}
  #ksb td.z{color:#4c5661}
  #ksb td.rowtot{font-weight:700;color:#fff}
  #ksb td small{color:#7d8995;font-weight:400}
  #ksb .up{color:#2fd27f}#ksb .dn{color:#ff6b6b}
  #ksb tfoot td{font-weight:700;border-top:1px solid #2b323a;border-bottom:0;color:#fff}
  #ksb .foot{display:flex;justify-content:space-between;gap:10px;color:#7d8995;font-size:11px;margin-top:6px}
  #ksb .foot a{color:#7cc4ff;cursor:pointer}
  #ksb .err{color:#ff8a8a;padding:4px 2px}
  #ksb .muted{color:#7d8995}
  `;

  let root;
  function render() {
    if (!root) return;
    const cur = currentSub();
    const fresh = data && dataSub === cur;
    const cash = fresh ? data.cash : {}, pos = fresh ? data.pos : {};
    let tCash = 0, tVal = 0, tCost = 0, tUnpriced = 0;
    const rows = SHARDS.map((s) => {
      const c = cash[s.i] || 0, p = pos[s.i] || { value: 0, cost: 0, count: 0, unpriced: 0 };
      tCash += c; tVal += p.value; tCost += p.cost; tUnpriced += p.unpriced;
      const pnl = p.value - p.cost;
      return `<tr><td>${esc(s.name)}</td>
        <td class="${c ? '' : 'z'}">${money(c)}</td>
        <td class="${p.count ? '' : 'z'}" title="${p.count ? `${p.count} position${p.count === 1 ? '' : 's'} · cost ${money(p.cost)} · ${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))} unrealized` : ''}">${money(p.value)}${p.count ? ` <small>(${p.count})</small>` : ''}</td>
        <td class="rowtot">${money(c + p.value)}</td></tr>`;
    }).join('');
    const tPnl = tVal - tCost;
    const grand = tCash + tVal;
    const mini = fresh ? SHARDS.map((s) => `<span title="${esc(s.name)}: cash + est. positions">${esc(s.name.split('/')[0])} <b>${money((cash[s.i] || 0) + ((pos[s.i] || {}).value || 0))}</b></span>`).join('') : '';

    const body = !fresh
      ? (err ? `<div class="err">${esc(err)}</div>` : '<div class="muted">Loading…</div>')
      : `<table><thead><tr><th>Shard</th><th>Cash</th><th>Positions (est.)</th><th>Total</th></tr></thead><tbody>${rows}</tbody>
          <tfoot><tr><td>All shards</td><td>${money(tCash)}</td><td>${money(tVal)}</td><td>${money(grand)}</td></tr></tfoot></table>` +
        (err ? `<div class="err">${esc(err)}</div>` : '') +
        `<div class="foot"><span>Positions at mid price${tVal || tCost ? ` · <span class="${tPnl >= 0 ? 'up' : 'dn'}">${tPnl >= 0 ? '+' : '−'}${money(Math.abs(tPnl))}</span> vs cost` : ''}${tUnpriced ? ` · ${tUnpriced} at cost (no price)` : ''}${lastAt ? ' · ' + new Date(lastAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''}</span><a data-act="refresh">${loading ? 'loading…' : 'refresh'}</a></div>`;

    const isOpen = root.classList.contains('open') || root.classList.contains('pinned');
    const prevBox = root.firstElementChild;
    if (isOpen && prevBox) root._minH = Math.max(root._minH || 0, prevBox.offsetHeight);
    root.innerHTML = `<div class="box"><div class="hdr" data-act="pin" title="Hover to open · click to pin open">
      <span class="tot">${fresh ? money(grand) : '…'}</span><span class="who">${esc(subName(cur))}</span><span class="mini">${mini}</span>
      <span class="pin">${root.classList.contains('pinned') ? '📌' : '▴'}</span></div><div class="body">${body}</div></div>`;
    if (isOpen && root._minH) root.firstElementChild.style.minHeight = root._minH + 'px';
  }

  // Hover opens; clicking inside keeps it open until you click elsewhere or press Esc.
  function makeOpenable(el, onChange) {
    let held = false, timer = null;
    const open = () => { clearTimeout(timer); if (!el.classList.contains('open')) { el.classList.add('open'); onChange(); } };
    const close = () => { clearTimeout(timer); held = false; if (el.classList.contains('open')) { el.classList.remove('open'); el._minH = 0; onChange(); } };
    el.addEventListener('mouseenter', open);
    el.addEventListener('mouseleave', () => { if (!held) { clearTimeout(timer); timer = setTimeout(close, 300); } });
    el.addEventListener('pointerdown', () => { held = true; open(); }, true);
    document.addEventListener('pointerdown', (e) => { if (!el.contains(e.target)) close(); }, true);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); }, true);
  }

  // Shared bottom-right stack used by all trading-ui-scripts panels, so they never overlap.
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
    root = document.createElement('div'); root.id = 'ksb';
    try { if (localStorage.getItem('ksb-pin') === '1') root.classList.add('pinned'); } catch (_) {}
    getDock().appendChild(root);
    makeOpenable(root, () => {
      render();
      if (root.classList.contains('open') && Date.now() - lastAt > 15000) load();
    });
    render();
  }

  document.addEventListener('click', (e) => {
    if (!root || !root.contains(e.target)) return;
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'refresh') load();
    if (a.dataset.act === 'pin') {
      root.classList.toggle('pinned');
      try { localStorage.setItem('ksb-pin', root.classList.contains('pinned') ? '1' : '0'); } catch (_) {}
      if (!root.classList.contains('pinned')) root._minH = 0;
      render();
    }
  }, true);
  // Subaccount switched in another tab → reload numbers for the new one.
  window.addEventListener('storage', (e) => { if (e.key === LS_SUB) { render(); load(); } });

  function start() {
    build();
    load();
    setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
