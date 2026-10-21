# Security Policy

Octopus can execute agent-selected tools and local project operations. Please treat security reports responsibly.

## Supported versions

The `main` branch is the actively maintained development version. This project does not currently promise separate security maintenance for older commits, tags, or forks.

## Reporting a vulnerability

**Do not open public issues or pull requests containing exploitable vulnerability details, credentials, or private user data.**

1. Visit the repository's [Security](https://github.com/bala2006/octopus/security) page. If **Report a vulnerability** or private vulnerability reporting is available, use that option.
2. If it is unavailable, contact the maintainer privately using a contact method listed on the [GitHub profile](https://github.com/bala2006). If no private channel is available, open a public issue requesting a private security contact **without including technical exploit details**.
3. Describe the affected version/commit, impact, reproduction steps, and suggested mitigation if known. Use a minimal non-destructive proof of concept.

The maintainer will review reports and coordinate a fix and disclosure as resources permit. **No fixed response or remediation SLA is promised.** Please allow time for a fix before discussing details publicly.

## Security reminders

- Demo Mode can be used without external model credentials.
- Do not commit `.env` files, API keys, access tokens, personal data, or logs containing secrets.
- Run Octopus only on machines and folders you trust; check permission settings before enabling tool execution, browser automation, or third-party MCP servers.
- See the security section of the [README](README.md) for the app's currently documented sandbox and access model.

Third-party dependency vulnerabilities should also be disclosed to their upstream maintainers where appropriate.
