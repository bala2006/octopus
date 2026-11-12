# Contributing to Octopus

Thanks for helping make Octopus more useful and reliable. Code, tests, documentation, reproducible bug reports and
usability improvements are all welcome.

## Before you start

Open an issue for larger changes so the direction can be agreed first. For security problems, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.

## Set up

You need **Node.js 22.22+** (24 recommended, see `.nvmrc`). Everything is TypeScript; there is no other runtime.

```bash
npm install
npm run dev     # hot reload; open http://127.0.0.1:8000
```

The repository is three npm workspaces: `shared/` (the contract), `server/` (the engine and API) and `web/` (the app).
[ARCHITECTURE.md](ARCHITECTURE.md) explains how they fit together.

Tests never need Azure credentials: the server suite runs the real engine against a scripted stand-in for the
Responses API (`server/test/fakeModel.ts`). Never commit API keys, `.env` files, user data or other secrets.

## Making a change

1. Branch from `main` and keep the change focused.
2. Change the contract in `shared/` first when an API or event changes; both sides then fail to compile until they agree.
3. Add or update tests for behaviour you change.
4. Run the checks CI runs:

   ```bash
   npm run typecheck
   npm test
   npm run build
   ```

5. Open a pull request with the template filled in.

## Guidelines

Keep changes consistent with the existing structure and prefer simple, testable code. Protect the project-folder
boundary, the command policy, approvals, secrets and conversation budgets: changes to `server/src/safety/` need a test
for every new rule.
