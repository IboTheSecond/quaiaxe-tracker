# Security

The QuaiAxe tracker is a static page that only reads public data. It holds no keys, asks for no wallet and has no backend. It has not been audited.

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

- Use GitHub's "Report a vulnerability" (the Security tab of this repository), or
- write to dev@hartiibiome.com.

Include the version (`package.json`, or the `application-version` meta tag of the page), what you did and what you expected. Do not send real keys, recovery phrases or other people's data. We aim to acknowledge a report within a few days.

## What is in scope

- A way to run script on the page or to get around its Content-Security-Policy: markup that gets in through a value the pool API or the RPC returns (worker names, counters, block heights), through the address box, or through the config.
- Anything that makes the page contact a host the config does not name, or send a visitor's address or IP address anywhere else.
- Anything that stores data in the browser (cookies, local or session storage). The page promises not to.
- A way out of `dist/`, or a listener that is not on 127.0.0.1, in the local server (`npm start`).
- A gap in the leak scan (`npm run scan`) that lets a secret, a personal path, or an address, host or email that is not on its allowlists through.

## What is not

- The accuracy of the data StratumX or the Quai RPC return, or an outage or a change of format on their side (the page then shows "unavailable").
- Anything that needs a hostile browser extension or control of the visitor's machine.
- Problems in third-party services: StratumX, Quai Network, Quaiscan, GitHub.

## Design notes

The README sections "Network calls", "Privacy" and "Limits" describe what the page does and does not do. The Content-Security-Policy is defined in `src/page.mjs` and is tested in `test/headers.test.mjs` and `test/page.test.mjs`.
