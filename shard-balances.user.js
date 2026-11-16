// ==UserScript==
// @name         Shard Balances
// @namespace    trading-ui-scripts
// @version      4.2
// @description  Click-to-open panel: cash and estimated position value on each exchange shard, for the active subaccount or every subaccount.
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
  // No background polling: the active subaccount loads once per page (a subaccount switch reloads
  // the page, so a load under FRESH_MS old is reused), the "By subaccount" view loads the first time
  // you open it in this tab, and after that numbers change only when you click refresh.
  const FRESH_MS = 60000;
  const LS_SUB = 'kalshi-subaccount'; // the site's active-subaccount setting
  const NAMES_KEY = 'ksw-names';      // names learned by the Subaccount Switcher script
  const STORE_KEY = 'ksb-store-v4';   // this tab's last loads (sessionStorage: survives reloads, not shared)
  const VIEW_KEY = 'ksb-view';        // 'shards' (active subaccount) | 'subs' (every subaccount)
  const OPEN_KEY = 'ksb-pin';
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
  // Read-only GETs to Kalshi's API only, one at a time, at least 200 ms apart. On HTTP 429 every
  // trading-ui-scripts panel in every Kalshi tab pauses (shared with the Subaccount Switcher).
  const PAUSE_KEY = 'tus-pause-until';
  const pausedUntil = () => { try { return Number(localStorage.getItem(PAUSE_KEY)) || 0; } catch (_) { return 0; } };
  function pauseFor(ms) { try { localStorage.setItem(PAUSE_KEY, String(Math.max(pausedUntil(), Date.now() + ms))); } catch (_) {} }
  const RATE_MSG = 'Kalshi kept rate-limiting us (the account is busy) — wait 30 s, then click refresh';
  let lastReq = 0;
  // A 429 means the account's shared read budget (~30 GETs/s for every bot, Kalshi's page and these panels) was
  // empty for a moment; it refills in about a second and Kalshi sends no Retry-After. So retry quietly after 1.5, 3
  // and 6 s (as the bots do) and only pause the panels, for 30 s, if all of those fail too. It used to pause every
  // panel in every tab for 2 minutes and show the notice on the first 429 (2026-11-16).
  const RETRY_WAITS = [1500, 3000, 6000];
  const FAIL_PAUSE_MS = 30000;
  async function api(path) {
    const wait = lastReq + 200 - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq = Date.now();
    if (Date.now() < pausedUntil()) throw new Error(RATE_MSG);
    let r;
    for (let i = 0; ; i++) {
      r = await origFetch(API + path, { method: 'GET', credentials: 'include', headers: { Accept: 'application/json', ...siteHeaders } });
      if (r.status !== 429) break;
      if (i >= RETRY_WAITS.length) {
        const ra = Number(r.headers.get('retry-after'));
        pauseFor(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 600000) : FAIL_PAUSE_MS);
        throw new Error(RATE_MSG);
      }
      await sleep(RETRY_WAITS[i]);
      lastReq = Date.now();
    }
    if (!r.ok) {
      let code = r.status;
      try { const j = await r.json(); code = (j.error && (j.error.code || j.error.message)) || code; } catch (_) {}
      throw new Error(code);
    }
    return r.json();
  }
  const isRate = (e) => e && e.message === RATE_MSG;

  // ---------- Helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const numOr = (v, d = null) => { const n = Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(n) ? d : n; };
  const money = (v) => {
    if (!v) return '$0';
    const a = Math.abs(v);
    const s = '$' + (a >= 100000 ? Math.round(a).toLocaleString() : a.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    return v < 0 ? '−' + s : s;
  };
  const signed = (v) => (v >= 0 ? '+' : '−') + money(Math.abs(v));
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
  function fmtAt(t) {
    if (!t) return '';
    const d = new Date(t), hm = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? hm : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + hm;
  }
  const shardName = (i) => (SHARDS.find((s) => s.i === i) || { name: 'Shard ' + i }).name;

  // ---------- Data ----------
  // store.subs[n] = { at, cash: {shard: $}, pos: {shard: {value, cost, count, unpriced}} }: one snapshot
  // per subaccount, its cash and positions from the same load. store.allAt = last load of every subaccount.
  function readStore() {
    try {
      const s = JSON.parse(sessionStorage.getItem(STORE_KEY));
      if (s && typeof s === 'object' && s.subs && typeof s.subs === 'object') return { subs: s.subs, allAt: Number(s.allAt) || 0, known: Array.isArray(s.known) ? s.known : [] };
    } catch (_) {}
    return { subs: {}, allAt: 0, known: [] };
  }
  let store = readStore();
  function saveStore() { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (_) {} }

  // Cash per (subaccount, shard), dollars, every subaccount in one ordinary read.
  // Not /portfolio/balance: its balance_breakdown is the whole account's cash per shard (summed over
  // every subaccount, checked 2026-11-16), not the subaccount's, and it has a 1-call/s bucket shared
  // by the whole account, bots included.
  async function loadCash() {
    const j = await api('/portfolio/subaccounts/balances');
    const cash = {};
    for (const b of j.subaccount_balances || []) {
      const n = Math.trunc(Number(b.subaccount_number)), i = Math.trunc(numOr(b.exchange_index, 0)), v = numOr(b.balance);
      if (!Number.isFinite(n) || n < 0 || n > 63 || !Number.isFinite(i) || v === null) continue;
      const c = cash[n] || (cash[n] = {});
      c[i] = (c[i] || 0) + v;
    }
    if (!Object.keys(cash).length) throw new Error('Kalshi returned no subaccount balances — try refresh');
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

  // Estimated value of one position: contracts × mid price of the side held, when the book has
  // both a bid and an offer. Otherwise (a closed market waiting to settle shows bid 0 / ask 1, whose
  // "mid" of 50¢ means nothing) the last traded price, then cost basis.
  function valuePosition(p, m) {
    const count = numOr(p.position_fp, numOr(p.position, 0));
    const qty = Math.abs(count), yes = count > 0;
    const cost = numOr(p.market_exposure_dollars, numOr(p.market_exposure, 0) / 100) || 0;
    if (m) {
      const bid = numOr(yes ? m.yes_bid_dollars : m.no_bid_dollars);
      const ask = numOr(yes ? m.yes_ask_dollars : m.no_ask_dollars);
      if (bid !== null && ask !== null && bid > 0 && ask < 1 && ask >= bid) return { value: qty * (bid + ask) / 2, cost, priced: true };
      const last = numOr(m.last_price_dollars);
      if (last !== null && last > 0) return { value: qty * (yes ? last : 1 - last), cost, priced: true };
    }
    return { value: cost, cost, priced: false };
  }
  function aggregate(positions, prices) {
    const pos = {};
    for (const p of positions) {
      const m = prices[p.ticker];
      const i = Math.trunc(numOr(p.exchange_index, numOr(m && m.exchange_index, 0)));
      const v = valuePosition(p, m);
      const s = pos[i] || (pos[i] = { value: 0, cost: 0, count: 0, unpriced: 0 });
      s.value += v.value; s.cost += v.cost; s.count++;
      if (!v.priced) s.unpriced++;
    }
    return pos;
  }

  // kind 'one' = the active subaccount; 'all' = every subaccount.
  // A load asked for by the page (not a refresh click) while another runs waits its turn.
  let loading = null, err = null, queued = null;
  async function load(kind, queue) {
    if (loading) { if (queue) queued = queued === 'all' || kind === 'all' ? 'all' : 'one'; return; }
    if (Date.now() < pausedUntil()) { err = RATE_MSG; render(); return; }
    const cur = currentSub();
    loading = { kind, done: 0, total: 0 }; err = null; render();
    try {
      if (!(await waitForHeaders())) throw new Error('Kalshi hasn’t finished loading — click refresh in a moment');
      const cash = await loadCash();
      const subs = kind === 'all'
        ? [...new Set([...Object.keys(cash).map(Number), ...names().map((x) => x.n), cur])].sort((a, b) => a - b)
        : [cur];
      loading.total = subs.length; render();
      const held = {}, fails = [];
      for (const n of subs) {
        try { held[n] = await loadPositions(n); }
        catch (e) { if (isRate(e)) throw e; fails.push(`${subName(n)}: ${e.message}`); }
        loading.done++; render();
      }
      let prices = {};
      try { prices = await loadPrices([...new Set(Object.values(held).flat().map((p) => p.ticker).filter(Boolean))]); }
      catch (e) { if (isRate(e)) throw e; }          // unpriced positions show at cost
      const at = Date.now();
      for (const n of subs) if (held[n]) store.subs[n] = { at, cash: cash[n] || {}, pos: aggregate(held[n], prices) };
      if (kind === 'all') { store.allAt = at; store.known = subs; }
      saveStore();
      if (fails.length) err = 'Positions failed for ' + fails.join('; ');
    } catch (e) {
      err = e.message || String(e);
    }
    loading = null; render();
    if (queued) { const q = queued; queued = null; load(q); }
  }

  // Load what's on screen if this page hasn't yet: the active subaccount always (the header
  // shows its total), every subaccount only once the "By subaccount" view is open.
  const seenHere = new Set();
  const isOpen = () => !!root && root.classList.contains('pinned');
  const view = () => { try { return localStorage.getItem(VIEW_KEY) === 'subs' ? 'subs' : 'shards'; } catch (_) { return 'shards'; } };
  function ensure() {
    const cur = currentSub();
    if (isOpen() && view() === 'subs' && !seenHere.has('all')) {
      seenHere.add('all');
      if (!store.allAt) { seenHere.add('one:' + cur); load('all', true); return; }   // covers the active one too
    }
    if (!seenHere.has('one:' + cur)) {
      seenHere.add('one:' + cur);
      const s = store.subs[cur];
      if (!s || Date.now() - s.at >= FRESH_MS) load('one', true);
    }
  }

  // ---------- UI ----------
  const css = `
  #tus-dock > #ksb{position:static}
  #ksb{order:2;font:12px/1.35 -apple-system,Segoe UI,Roboto,sans-serif;color:#e8ecef}
  /* Header sits at the bottom so it stays put while the panel opens upward. */
  #ksb .box{display:flex;flex-direction:column-reverse;background:#14181d;border:1px solid #2b323a;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.45);overflow:hidden}
  #ksb .hdr{display:flex;align-items:center;gap:8px;padding:7px 10px;background:#1b2128;cursor:pointer;user-select:none;white-space:nowrap}
  #ksb .tot{background:#2a3340;color:#fff;border-radius:6px;padding:1px 7px;font-weight:600}
  #ksb .who{color:#9aa6b2;font-size:11px;max-width:160px;overflow:hidden;text-overflow:ellipsis}
  #ksb .mini{display:flex;gap:6px;color:#9aa6b2;font-size:11px}
  #ksb .mini b{color:#cfd6dd;font-weight:600}
  #ksb .pin{color:#9aa6b2;font-size:14px;line-height:1;width:20px;height:18px;display:inline-flex;align-items:center;justify-content:center;border-radius:5px;margin-left:2px}
  #ksb .hdr:hover .pin{background:#2b333d;color:#fff}
  #ksb .body{padding:6px 8px 8px;max-height:45vh;overflow:auto}
  #ksb:not(.pinned) .body{display:none}
  #ksb:not(.pinned) .box{opacity:.85}
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
  #ksb tr[data-exp]{cursor:pointer}
  #ksb tr[data-exp]:hover td{background:#1c232b}
  #ksb .car{display:inline-block;width:12px;color:#7d8995;font-weight:400}
  #ksb .num{color:#7d8995;font-weight:400}
  #ksb tr.me td:first-child{color:#5fe39a}
  #ksb tr.sh td,#ksb tfoot tr.sh td{font-weight:400;color:#9aa6b2;font-size:11px;border-top:0;border-bottom:1px solid #1a1f25}
  #ksb tr.sh td:first-child{padding-left:26px}
  #ksb tr.sh td.z{color:#4c5661}
  #ksb tr.sh td.rowtot{color:#cfd6dd}
  #ksb .sum{color:#7d8995;font-size:11px;margin-top:6px}
  #ksb .bar{display:flex;align-items:center;gap:10px;margin-top:6px;color:#7d8995;font-size:11px;white-space:nowrap}
  #ksb .bar .tabs{display:flex;gap:2px;margin-right:auto}
  #ksb .bar .tabs a{padding:2px 7px;border-radius:5px;color:#9aa6b2;cursor:pointer;font-weight:600}
  #ksb .bar .tabs a.on{background:#2a3340;color:#fff}
  #ksb .bar a[data-act]{color:#7cc4ff;cursor:pointer}
  #ksb .err{color:#ff8a8a;padding:4px 2px}
  #ksb .muted{color:#7d8995}
  `;

  const EMPTY = { value: 0, cost: 0, count: 0, unpriced: 0 };
  // Shard indexes to show: the four known ones plus any other a snapshot mentions.
  function shardList(snaps) {
    const set = new Set(SHARDS.map((s) => s.i));
    for (const s of snaps) for (const k of [...Object.keys(s.cash || {}), ...Object.keys(s.pos || {})]) { const i = Number(k); if (Number.isFinite(i)) set.add(i); }
    return [...set].sort((a, b) => a - b);
  }
  // Cash + positions on one shard, summed over the given snapshots.
  function shardSum(snaps, i) {
    const o = { cash: 0, value: 0, cost: 0, count: 0, unpriced: 0 };
    for (const s of snaps) {
      o.cash += (s.cash || {})[i] || 0;
      const p = (s.pos || {})[i] || EMPTY;
      o.value += p.value; o.cost += p.cost; o.count += p.count; o.unpriced += p.unpriced;
    }
    return o;
  }
  function totalOf(snaps, idx) {
    const o = { cash: 0, value: 0, cost: 0, count: 0, unpriced: 0 };
    for (const i of idx) { const x = shardSum(snaps, i); for (const k in o) o[k] += x[k]; }
    return o;
  }
  // One table row: label, cash, positions (est.), total.
  function row(label, x, attrs = '', cls = '') {
    const pnl = x.value - x.cost;
    const tip = x.count ? `${x.count} position${x.count === 1 ? '' : 's'} · cost ${money(x.cost)} · ${signed(pnl)} unrealized${x.unpriced ? ` · ${x.unpriced} at cost (no price)` : ''}` : '';
    return `<tr class="${cls}" ${attrs}><td>${label}</td>
      <td class="${x.cash ? '' : 'z'}">${money(x.cash)}</td>
      <td class="${x.count ? '' : 'z'}" title="${esc(tip)}">${money(x.value)}${x.count ? ` <small>(${x.count})</small>` : ''}</td>
      <td class="rowtot">${money(x.cash + x.value)}</td></tr>`;
  }
  const summary = (t, extra = '') => `<div class="sum">Positions at mid price (last trade if the book is empty)${t.value || t.cost ? ` · <span class="${t.value - t.cost >= 0 ? 'up' : 'dn'}">${signed(t.value - t.cost)}</span> vs cost` : ''}${t.unpriced ? ` · ${t.unpriced} at cost (no price)` : ''}${extra}</div>`;

  function shardsView(snap) {
    if (!snap) return '';
    const idx = shardList([snap]);
    const t = totalOf([snap], idx);
    return `<table><thead><tr><th>Shard</th><th>Cash</th><th>Positions (est.)</th><th>Total</th></tr></thead><tbody>` +
      idx.map((i) => row(esc(shardName(i)), shardSum([snap], i))).join('') +
      `</tbody><tfoot>${row('All shards', t)}</tfoot></table>` + summary(t);
  }

  // Every subaccount: one row each (click to expand its shards), plus the all-subaccounts total
  // (click to expand into per-shard totals across subaccounts).
  const expanded = new Set();
  function subsView(cur) {
    if (!store.allAt) return '';            // never a partial table: wait for the first all-subaccounts load
    const ns = [...new Set([...store.known, ...Object.keys(store.subs).map(Number)])].filter((n) => store.subs[n]).sort((a, b) => a - b);
    if (!ns.length) return '';
    const snaps = ns.map((n) => store.subs[n]);
    const idx = shardList(snaps);
    let hidden = 0, body = '';
    for (const n of ns) {
      const s = store.subs[n], t = totalOf([s], idx);
      if (!t.cash && !t.count && n !== cur) { hidden++; continue; }
      const open = expanded.has(String(n));
      body += row(`<span class="car">${open ? '▾' : '▸'}</span><span class="num">${n}</span> ${esc(subName(n))}`, t,
        `data-exp="${n}" title="${esc(subName(n))}${n === cur ? ' (active)' : ''} · as of ${esc(fmtAt(s.at))} · click for shards"`, n === cur ? 'me' : '');
      if (open) body += idx.map((i) => row(esc(shardName(i)), shardSum([s], i), '', 'sh')).join('');
    }
    const all = totalOf(snaps, idx), allOpen = expanded.has('all');
    const foot = row(`<span class="car">${allOpen ? '▾' : '▸'}</span>All subaccounts`, all, 'data-exp="all" title="Click for each shard across all subaccounts"') +
      (allOpen ? idx.map((i) => row(esc(shardName(i)), shardSum(snaps, i), '', 'sh')).join('') : '');
    return `<table><thead><tr><th>Subaccount</th><th>Cash</th><th>Positions (est.)</th><th>Total</th></tr></thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>` +
      summary(all, hidden ? ` · ${hidden} empty subaccount${hidden === 1 ? '' : 's'} hidden` : '');
  }

  let root;
  function render() {
    if (!root) return;
    const cur = currentSub(), v = view(), open = isOpen();
    const me = store.subs[cur];
    const idx = me ? shardList([me]) : [];
    const meTot = me ? totalOf([me], idx) : null;
    const mini = me ? SHARDS.map((s) => { const x = shardSum([me], s.i); return `<span title="${esc(s.name)}: cash + est. positions">${esc(s.name.split('/')[0])} <b>${money(x.cash + x.value)}</b></span>`; }).join('') : '';

    let content, at;
    if (v === 'subs') {
      content = subsView(cur);
      const ats = Object.values(store.subs).map((s) => s.at).filter(Boolean);
      at = store.allAt ? Math.min(store.allAt, ...ats) : 0;
    } else { content = shardsView(me); at = me ? me.at : 0; }
    if (!content) content = loading ? `<div class="muted">Loading${loading.total > 1 ? ` ${loading.done}/${loading.total} subaccounts` : ''}…</div>` : (err ? '' : '<div class="muted">Not loaded yet — click refresh.</div>');
    const busy = loading ? (loading.total > 1 ? `loading ${loading.done}/${loading.total}…` : 'loading…') : 'refresh';
    const bar = `<div class="bar"><span class="tabs"><a data-view="shards" class="${v === 'shards' ? 'on' : ''}" title="Each shard for ${esc(subName(cur))}">Shards</a><a data-view="subs" class="${v === 'subs' ? 'on' : ''}" title="Every subaccount">By subaccount</a></span>` +
      `${at ? `<span title="${v === 'subs' ? 'Oldest load shown' : 'Last load'} — numbers only change when you click refresh">as of ${esc(fmtAt(at))}</span>` : ''}<a data-act="refresh" title="${v === 'subs' ? 'Reload every subaccount' : 'Reload ' + esc(subName(cur))}">${busy}</a></div>`;

    root.innerHTML = `<div class="box"><div class="hdr" data-act="pin" title="${open ? 'Click to minimize' : 'Click to open'}">
      <span class="tot">${meTot ? money(meTot.cash + meTot.value) : '…'}</span><span class="who">${esc(subName(cur))}</span><span class="mini">${mini}</span>
      <span class="pin">${open ? '–' : '+'}</span></div><div class="body">${content}${err ? `<div class="err">${esc(err)}</div>` : ''}${bar}</div></div>`;
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
    try { if (localStorage.getItem(OPEN_KEY) === '1') root.classList.add('pinned'); } catch (_) {}
    getDock().appendChild(root);
    render();
  }

  // Opens and closes only by clicking the header (no hover).
  document.addEventListener('click', (e) => {
    if (!root || !root.contains(e.target)) return;
    const tab = e.target.closest('[data-view]');
    if (tab) {
      try { localStorage.setItem(VIEW_KEY, tab.dataset.view); } catch (_) {}
      render(); ensure(); return;
    }
    const ex = e.target.closest('[data-exp]');
    if (ex) { const k = ex.dataset.exp; if (expanded.has(k)) expanded.delete(k); else expanded.add(k); render(); return; }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'refresh') load(view() === 'subs' ? 'all' : 'one');
    if (a.dataset.act === 'pin') {
      root.classList.toggle('pinned');
      try { localStorage.setItem(OPEN_KEY, isOpen() ? '1' : '0'); } catch (_) {}
      render(); ensure();
    }
  }, true);
  // Subaccount switched in another tab → show the new one (loading it once if this page hasn't).
  window.addEventListener('storage', (e) => { if (e.key === LS_SUB) { render(); if (!document.hidden) ensure(); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ensure(); });

  function start() {
    build();
    ensure();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
