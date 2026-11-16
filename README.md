# trading-ui-scripts

Userscripts for Tampermonkey.

## subaccount-switcher.user.js

Install: open the raw file link in Chrome with Tampermonkey installed and click **Install**.
Updates are picked up automatically via `@updateURL`.

Both panels sit in the bottom-right corner and open or close only when you click their header (no hover);
the open/closed state is remembered. Neither polls: data loads once when the page loads (or when you move
to another market in the app), then only when you click **refresh**. The account has one read budget
(~30 GETs/s) shared with every bot and Kalshi's own page, so a 429 just means it was empty for a moment: a
request retries quietly after 1.5, 3 and 6 s, and only if all of those fail do both panels pause (every tab)
for 30 s and say so. Clicking refresh always loads, pause or not.

- One-click / Alt+Shift+0–9 subaccount switching
- On a market page: resting orders and positions on that event across all subaccounts
- Prompt (inside the panel) to jump to a subaccount that has activity on the current market
- On category pages (e.g. /category/elections): open positions and resting bids per subaccount in that category, with suggestions of which subaccount to switch to
- Canceled view: canceled orders on the current market (including Kalshi's archive for resolved markets), current subaccount or all
- History view: recent fills for the current subaccount, with an "All subaccounts" toggle

Subaccount names are read from the site's Sub accounts page and stored only in your browser.

## shard-balances.user.js

Panel in the bottom-right corner, under the switcher (the short panel sits in the corner so the tall switcher
growing or shrinking never moves it). The header shows the **active subaccount**'s total and each shard's
total. Open it for two views (tabs at the bottom):

- **Shards**: for the active subaccount, each exchange shard (General, Combos, Crypto/Commodities, Sports)
  with its available cash, the estimated value of open positions on it, and the total.
- **By subaccount**: every subaccount's cash, positions and total, plus the all-subaccounts total. Click a
  subaccount to expand its shards; click the all-subaccounts row for each shard summed across subaccounts.
  Empty subaccounts are hidden. Loads the first time you open it in a tab (one call per subaccount), then
  only on refresh; the "as of" time says how old the numbers are.

Positions are valued at the mid price when the book has a bid and an offer, else at the last trade (closed
markets waiting to settle), else at cost. Cash comes from `/portfolio/subaccounts/balances`, one read for every
subaccount. Not `/portfolio/balance`: its `balance_breakdown` is the whole account's cash per shard, not the
subaccount's, and its bucket is 1 call/s for the whole account.
