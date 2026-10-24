# trading-ui-scripts

Userscripts for Tampermonkey.

## subaccount-switcher.user.js

Install: open the raw file link in Chrome with Tampermonkey installed and click **Install**.
Updates are picked up automatically via `@updateURL`.

- One-click / Alt+Shift+0–9 subaccount switching
- On a market page: resting orders and positions on that event across all subaccounts
- Prompt (inside the panel) to jump to a subaccount that has activity on the current market
- Canceled view: canceled orders on the current market (including Kalshi's archive for resolved markets), current subaccount or all
- History view: recent fills for the current subaccount, with an "All subaccounts" toggle

Subaccount names are read from the site's Sub accounts page and stored only in your browser.

## shard-balances.user.js

Hover panel (stacked above the switcher, bottom-right) for the **active subaccount**: each exchange shard (General, Combos, Crypto/Commodities, Sports) with its available cash, the estimated value of open positions on that shard (contracts × mid price), and the total. The footer shows unrealized P&L vs cost. Click the header to pin it open.
