# QuaiAxe tracker

Source release: 1.0.5.

A live, read-only page for people who mine to a QuaiAxe deposit address on Quai Network (Cyprus-1). For an address it shows the workers the pool sees, their hashrate and shares, the workshares found, the QUAI still locked and the QUAI already unlocked, an estimate of the next unlock, and how much QAXE the burn vault has destroyed through mining.

It is static HTML, CSS and JavaScript. There is no backend, no cookie, no analytics, no npm dependency, and no wallet or key anywhere. It only reads.

## What it shows

1. **Live miners**: workers online and in total, SHA-256, Scrypt and KawPoW hashrate, valid, stale and invalid shares, a table of the busiest rigs (rig names are typed by the miners and shown as plain text) and a table of workers.
2. **Hashrate**: a line chart with 1h, 24h and 7d tabs (the periods the pool API accepts), with a readout when you point at it.
3. **Workshares**: the count for 24 hours and for 7 days, the best share of the last 24 hours, a luck chart for 24h or 7d, a table of the newest 50, and a strip of the last 48 workshares, newest on the right, hotter when fresher.
4. **Rewards and burn**: locked and unlocked QUAI for the address, an estimate of the next unlock, a schedule of workshares per day with the day each batch should unlock (an estimate: found day plus about 14 days; the pool publishes no reward amounts), and the QAXE burned by mining, read from the burn vault.
5. **Check your own address**: the same page for any other deposit address you paste in, with a button back to the default.

English is at `/` and Turkish at `/tr/`. The page refreshes every 30 seconds while its tab is visible and pauses while the tab is hidden. New workshares are picked up every 10 seconds and announced in a live feed.

## Network calls

These are all of the requests the page makes, from the visitor's browser. The `quaiscan.io` links are ordinary links a visitor can click; the page never fetches from them.

| Host | Request | When | Used for |
| --- | --- | --- | --- |
| `backend.stratumx.org` | `POST /api/miners/batch` with the tracked addresses | on load, then every 30 s | workers, hashrate, shares |
| `backend.stratumx.org` | `GET /api/pool/blocks?addresses=...&period=24h` and `...&period=7d` | same | workshares: the 24-hour count, the 7-day table, the unlock estimate |
| `backend.stratumx.org` | `GET /api/pool/shares?addresses=...&period=24h` or `7d` (the luck range you chose; the 7d choice also asks for `24h`) | same | the luck chart and the best share |
| `backend.stratumx.org` | `GET /api/miner/hashrate/history?addresses=...&period=1h`, `24h` or `7d` (the range you chose) | same | the hashrate chart |
| `backend.stratumx.org` | `GET /api/pool/blocks?addresses=...&period=1h` | every 10 s | new workshares for the live feed and the strip |
| `rpc.quai.network` | `quai_getLockedBalance` and `quai_getBalance`, once per tracked address | same | locked and unlocked QUAI |
| `rpc.quai.network` | `eth_call` to the burn vault, selector `0xd157e301` (`totalTokensBurned()`) | same | QAXE burned by mining |
| `rpc.quai.network` | `quai_blockNumber` | every 12 s | the block height in the header |

One 30 s refresh is 5 requests to the pool and, for the RPC, two reads per tracked address plus one read of the burn vault; the 10 s poll is 1 request to the pool. The pool API rejects any period other than `1h`, `24h` and `7d`, so the page offers no other.

The hosts and the node are not fixed: they come from the config (see below), and the Content-Security-Policy is built from the same config, so the page can contact exactly those two hosts (and the node's secure WebSocket origin, which the policy names for sites that add a live chain feed; this page opens no socket) and no other.

StratumX's API has no public documentation. The page was written against what the service returns. A missing or malformed miner batch clears every miner-derived figure; history over 1,500 points or with invalid timestamps or hashrates makes the chart unavailable. Older responses cannot repaint a newer address or poll. The tests use synthetic responses, so they do not prove current upstream behavior.

## Run it

You need Node 24 or newer. There is nothing to install.

```
npm start        # builds dist/ and serves it at http://127.0.0.1:8080/ (this machine only)
npm run build    # builds dist/ only
npm test         # runs the tests
npm run scan     # checks the source and dist/ for secrets, personal paths, and addresses, hosts and emails that are not on the allowlists
```

To track other addresses, or to use another node or pool, copy `config.example.json` to `config.json` (git ignores that file) and edit it. It holds five keys: `trackedAddresses`, `stratumxApi`, `rpc`, `vault`, `qaxeToken`. The build refuses a config with any other key, a URL that is not https, or an address that is not `0x` and 40 hex digits. `config.example.json` points at QuaiAxe's public default deposit address, which pays nothing out and burns everything.

To publish the page, serve the contents of `dist/` from the root of a host. The pages link to `/assets/...` and `/fonts/...`. A host that reads a `_headers` file (Cloudflare Pages, Netlify) sends the headers in `dist/_headers`. The same Content-Security-Policy is also in a `<meta>` tag in each page, so the page keeps its policy on a host that cannot set headers; only `frame-ancestors` needs a real header.

Layout:

```
src/page.mjs            the page and its Content-Security-Policy
src/strings.json        the text, in English and Turkish
src/lib/tracker-lib.js  small helpers the page script imports
assets/tracker.js       every network call and all the rendering
assets/page.js          the header's block height and the scroll reveal
assets/tracker.css      the stylesheet
scripts/                build, serve, scan-leaks, run-tests
test/                   the tests (node --test)
fonts/                  the self-hosted fonts and their licences
```

## Privacy

- **Nothing is stored in the browser**: no cookie, no local or session storage, no service worker. Nothing is sent to the people who maintain this code. There is no analytics, no telemetry, and no third-party script or font.
- **StratumX and the Quai RPC see the visitor.** The visitor's browser asks them directly, so both can see the visitor's IP address and which addresses are looked up: the ones in the config, and any address typed into "Check your own address". They are third parties with their own policies. To keep that to yourself, point the config at your own node.
- **No Referer is sent** (`Referrer-Policy: no-referrer`), so those hosts do not learn which site serves the page.
- **The host that serves the page** sees ordinary web requests. The local server (`npm start`) logs nothing and listens on 127.0.0.1 only.

## Limits

- Estimates are labelled as estimates. "Next unlock" is the earliest workshare in the last 7 days plus 14 days; it is a guide, not a promise.
- A source that cannot be reached shows "unavailable". The page never fills in a number it did not read.
- The burn tile counts mining burns only. It is the burn vault's own counter, not the token's total burn.
- The numbers come from StratumX's undocumented pool API and from the Quai RPC. Worker names are third-party text and are shown as received, escaped.
- A pasted lowercase or uppercase Quai address is checksummed before RPC reads; a mixed-case address with an invalid checksum is refused.
- This is not financial advice, and mining is a lottery.

## More

[SECURITY.md](SECURITY.md) says how to report a problem. [CONTRIBUTING.md](CONTRIBUTING.md) explains that this repository is a generated copy: issues are welcome, pull requests are off. The licence is MIT; see [LICENSE](LICENSE). The fonts keep their own licences in `fonts/`.

This is an independent project, not affiliated with or endorsed by StratumX, Quai Network or Quaiscan.
