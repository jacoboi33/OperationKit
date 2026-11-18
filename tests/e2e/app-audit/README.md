# App-wide audit suite (`tests/e2e/app-audit`)

A reusable Playwright suite that boots a throwaway copy of the app on seeded test
data and walks it in four combinations: light and dark, each at desktop
(1440x900) and narrow (390x844). It came out of card #901024.

> **Status: run in a real browser, 2026-11-16.** All four projects ran in headless
> Chromium against a local seeded app (results in `tests/smoke/app-audit/app-audit.md`,
> screenshots next to it). Every test passes or is a marked known bug.

## What it covers

| File | What it checks |
|---|---|
| `api.spec.ts` | No browser needed. Seed is in place, custom brand is served, a repeated chat send is stored once, signed-out and member refusals, JSON 404s. |
| `pages.spec.ts` | Every page renders its landmark in the asked theme, with no console errors, failed requests or sideways scroll. One full-page screenshot per page per project. Old addresses redirect. |
| `board.spec.ts` | Columns and card states, open and edit a card, model picker, Start (one request on a double click), sub-cards, review states (passed / failed / blocked), Approve and Rework. |
| `chat.spec.ts` | Bots page and filter, send once, Enter + click, send while the bot is working, refresh mid-reply, failed send keeps the text. |
| `bot-settings.spec.ts` | Workspace access, Full access, Approve on my behalf, High Agency; a member cannot change them. |
| `knowledge.spec.ts` | Context list, open a page, search (hit and no hit), graph view, setup page. |
| `shell.spec.ts` | Workflows, notifications bell and panel, Jump to page (Ctrl+K and the button). |
| `errors.spec.ts` | Page not found, card not found, not shared with you, server error, offline, signed out. |
| `branding.spec.ts` | Narrow only: Settings → Branding logo rows keep each description at least 160px wide (card #901204). |
| `white-label.spec.ts` | The server runs under the brand "Acme Ops"; no page may show a vendor name. Primary buttons share one accent colour. |

## Run it locally

```sh
cd app && npm ci && npm run build --workspace=client && cd ..
npm i -g @playwright/test && npx playwright install --with-deps chromium   # once; not a repo dependency
bash tests/e2e/app-audit/run.sh                                  # everything
bash tests/e2e/app-audit/run.sh --project=dark-narrow            # one combination
bash tests/e2e/app-audit/run.sh chat.spec.ts --project=light-desktop
bash tests/e2e/app-audit/run.sh api.spec.ts --project=light-desktop   # no browser needed
E2E_SEED_ONLY=1 bash tests/e2e/app-audit/run.sh                  # seed and leave the server up to click around
```

`run.sh` does the whole job: it picks a free port (`E2E_PORT`, default 3922),
makes a temp folder, writes a small knowledge base and a demo bot, starts the
server, seeds the database, runs Playwright and stops the server on exit.

Useful settings: `PW_NODE_PATH` (a `node_modules` that has `@playwright/test`),
`E2E_WORK_ROOT` (where the temp folder goes; set it to an exec-able disk if
`/tmp` is `noexec`), `E2E_SHOTS_DIR` (default `tests/smoke/app-audit/<project>/`),
`E2E_BRAND_NAME` (default `Acme Ops`).

## Safety

- The server starts with `env -i`: no API key, bot token or database URL from
  your shell reaches it. It runs with `CC_SCRATCH_SERVER=1`, so no poller,
  scheduler or reaper starts, and `run.sh` refuses to go on if the scratch line
  is missing from the server log.
- Everything lives in one temp folder: database, knowledge base, bot files, HOME.
- The bot uses the built-in demo provider. No AI account, no paid API.
- Start, Rework, Approve and Reopen are intercepted in the browser
  (`blockStatusChanges` in `helpers.ts`). On the server they would start a real
  worker session even on a scratch instance.
- The suite never saves branding: that writes `config/branding.json` in the repo.

## Seed fixture (`seed.mjs`)

Two users (admin and member), two workspaces (the member is in one), a project,
cards in every state (queue, working, AI review, needs-you with a passed, failed
and blocked review, done, a parent with two sub-cards, one very long title), three
notifications, one demo bot with a short history, one saved workflow and four
knowledge base pages. It uses the app's HTTP API where one exists. Review states
and notifications are written with SQL because there is no safe API for them;
the script says so where it does it. The specs read what was made from the
manifest at `$E2E_SEED_FILE`.

The repo's own `npm run seed` only creates two fixed users (`operator`, `casey`) in
fixed workspaces and no content, so it is not used here.

## Known bugs (expected-fail)

A test for a known bug is marked `test.fail(true, '… fix card #N')`. It stays in
the suite, runs every time, and starts failing the run the day the bug is fixed,
which is the signal to remove the marker. Do not delete or loosen these.

| Test | Tracks |
|---|---|
| `api: unknown /api path returns a JSON 404` | fixed by #901031 |
| `api: bot names and descriptions carry no vendor name under a custom brand` | #901033 |
| `bots page shows no vendor name under a custom brand`, `no vendor name on /agents under a custom brand` | #901033 |
| `narrow screens: a parent card still shows its sub-cards` | fixed by #901198 (was PA-3) |

`PA-n` is a finding number from the audit report
(`decisions/2026-11-15-opkit-playwright-audit.md` in the operationkit knowledge
base). Their fix cards are drafted (`audits/playwright-2026-11-15/fix-card-drafts.md`)
but were not filed when this was written, because the audit session could not
reach the card API. When a card is filed, replace `PA-n` with its number here
and in the specs.

If a known bug also shows up on pages that other tests visit, the shared helpers
may let exactly that symptom through, next to the expected-fail test that tracks
it, so one bug does not turn every page test red: `KNOWN_CONSOLE_ERRORS` in
`helpers.ts` is the place for a console error of that kind. It is empty since
#901199 (former PA-4, the CSP-blocked inline theme script) shipped. Delete each
entry with its fix.

## In a card session (pinned browser)

A card sandbox has one browser: the pinned, sandboxed Chromium behind the egress
guard, started through `$CC_BROWSER_LAUNCHER`. When that variable is set, the
suite's `test` (exported from `helpers.ts`) launches the browser through the
launcher instead of Playwright's own. The runner must be the same Playwright
copy the launcher uses (`$CC_PLAYWRIGHT_MODULE`), so point `playwright` and
`@playwright/test` at it rather than installing another:

```sh
mkdir -p ~/pwshim/node_modules/@playwright/test ~/pwbin
echo "module.exports = require('$CC_PLAYWRIGHT_MODULE/test')" > ~/pwshim/node_modules/@playwright/test/index.js
printf '#!/bin/sh\nexec node %s/cli.js "$@"\n' "$CC_PLAYWRIGHT_MODULE" > ~/pwbin/playwright && chmod +x ~/pwbin/playwright
PATH=~/pwbin:$PATH PW_NODE_PATH=~/pwshim/node_modules E2E_WORK_ROOT=~/scratch bash tests/e2e/app-audit/run.sh
```

The guard allows a local server on ports 1024–65535 except 3002, 3098 and 3099;
the default port 3922 is fine.

## Which tests run in which project

No test opts out at run time (`scripts/test-integrity.py` rejects that, rightly).
Scoping lives in `playwright.config.ts`:

- `api.spec.ts` does not depend on theme or width, so it runs in `light-desktop` only (`testIgnore` on the other three projects).
- Tests tagged `@desktop` (top-bar links, the Ctrl+K shortcut) run in the two desktop projects only; tests tagged `@narrow` run in the two narrow projects only (`grepInvert`).
- Preconditions are asserted, not assumed: the graph test fails if the seed could not enable the knowledge-import pack, and the member notifications test fails if the bell is missing.

## CI

This suite is **not** wired into CI, on purpose. `CLAUDE.md` ("Testing: Vitest
via CLI; no Playwright MCP") says no Playwright suite is executed in CI, and
`.github/workflows/test.yml` runs Vitest only. Changing that is the owner's call.
If it is made, the job is small:

```yaml
# .github/workflows/e2e.yml (NOT added by this PR)
jobs:
  app-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: cd app && npm ci && npm run build --workspace=client
      - run: npm i -g @playwright/test && npx playwright install --with-deps chromium
      - run: bash tests/e2e/app-audit/run.sh
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: app-audit
          path: |
            tests/smoke/app-audit
            /tmp/pw-app-audit
```

Pin `@playwright/test` to the version in `app/server/src/lib/browser-pins.ts`
so the browser matches the one the reviewer sessions use.

## Adding a page

Add one line to `STOPS` in `pages.spec.ts` (name, address, a landmark that
proves it rendered). It then gets all four combinations, a screenshot, and the
console, network and sideways-scroll checks for free.
