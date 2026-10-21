# Contributing to Octopus

Thanks for helping make Octopus more useful and reliable. Contributions of code, tests, documentation, reproducible bug reports, and usability improvements are welcome.

## Before you start

- Read the [README](README.md) and [architecture](ARCHITECTURE.md).
- Check existing [issues](https://github.com/bala2006/octopus/issues) and [pull requests](https://github.com/bala2006/octopus/pulls) to avoid duplicate work.
- For substantial or breaking changes, propose the approach in an issue first so maintainers can discuss scope.
- Follow our [Code of Conduct](CODE_OF_CONDUCT.md). **Do not report exploitable security issues publicly**; see [SECURITY.md](SECURITY.md).

## Development setup

Use **Python 3.11+** and a supported **Node.js** release (Node 24.15+, Node 22.22.2+, or Node 26+).

On macOS/Linux:

```bash
make setup
make dev
```

On Windows (PowerShell):

```powershell
.\octopus.ps1 setup
.\octopus.ps1 start
```

You can use **Demo Mode** for testing without Azure credentials. For details and environment configuration, consult the README. Never commit API keys, .env files, user data, model credentials, or other secrets.

## Submitting a change

1. Fork the project or create a short-lived branch.
2. Keep your pull request focused. Add or update tests for behavioral changes.
3. Run the checks relevant to your change. On macOS/Linux:
   ```bash
   make test-backend
   make test-frontend
   ```
   For UI behavior changes, also run `make e2e` (Playwright browsers must be installed). On Windows, `.\octopus.ps1 test` runs the supported backend and frontend checks.
4. Update user-facing docs when functionality, configuration, or behavior changes.
5. Submit a pull request to `main` using the PR template. Include what changed, why, how you verified it, and any known limitations.

Please keep changes consistent with the existing Python/FastAPI and React/TypeScript architecture. Prefer straightforward, testable implementations; protect project-folder boundaries, permission gates, sensitive data, and agent budgets.

## Review and attribution

Maintainers may request changes before merging. A submitted PR is not a promise of immediate review or acceptance. By contributing, you agree that your contribution can be distributed under the project's [MIT License](LICENSE) and affirm that you have the rights necessary to submit it. Third-party dependencies and assets retain their own licenses.
