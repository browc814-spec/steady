# Steady

Idiot-proof paycheck budgeting with Paycheck 1/2, a Cash box, paycheck History, savings goals, and yearly spending stats.

Optional **sync** across devices (and a finance agent) through a private Google Sheet + Apps Script: see [`sync/README.md`](sync/README.md). Settings also has JSON export/import.

## Local

```bash
npm install
npm run dev
npm test            # unit tests (merge logic, Apps Script via shim)
npm run build && npm run test:e2e   # multi-device sync E2E against a mock endpoint
```

## Live

- **GitHub Pages:** https://browc814-spec.github.io/steady/
- **Netlify (claimed):** https://snazzy-centaur-606f26.netlify.app

## Deploy

```bash
npm run build
```

- **GitHub Pages:** publish the `dist` folder on the `gh-pages` branch
- **Netlify:** build command `npm run build`, publish folder `dist`
