# Meal Manager

## Requirements

Meal Manager requires Node.js 22 or newer because `better-sqlite3` is a native
dependency. The repository's exact development version is recorded in `.nvmrc`.

```bash
nvm install
nvm use
npm ci
```

Reinstall dependencies after changing Node versions so native modules are built
or downloaded for the active Node runtime.

## Development

```bash
npm run dev
```

## Tests

```bash
npm test
```

The test suite uses Node's built-in test runner. API tests run the real Express
application against a temporary SQLite database and disable external API calls.

To include a coverage report:

```bash
npm run test:coverage
```
