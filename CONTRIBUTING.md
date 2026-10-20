# Contributing

Issues are welcome: a bug, a change in what StratumX or the Quai RPC return, a wrong or missing translation, a question about what the page does.

This repository is a generated copy. The code is developed elsewhere and published here as one snapshot per release, so a pull request cannot be merged here and pull requests are turned off. If you have a fix, put the diff or a description of it in an issue; it is applied upstream and arrives in the next release.

## When you open an issue

- Say what you saw and what you expected, and give the version (`package.json`, or the page's `application-version` meta tag).
- Use made-up addresses and made-up worker names. Do not paste keys, recovery phrases, tokens, or other people's wallet addresses.
- For anything security-related, follow SECURITY.md instead of opening an issue.

## Checks

```
npm test         # all tests, Node 24, nothing to install
npm run build    # writes dist/
npm run scan     # leak scan of the source and dist/
```

The code has no dependencies and uses only Node's built-in modules. Keep it that way: a new dependency is a new place for something to go wrong, and `test/package.test.mjs` fails if one appears.
