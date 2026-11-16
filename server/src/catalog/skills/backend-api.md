---
name: backend-api
description: Build an HTTP API or service with validated input, consistent errors, safe data handling and automated tests that pass.
roles: backend, fullstack_dev, developer, data, security
---
# Backend API

## Steps
1. From the design, write the endpoint list: method, path, request schema, response schema, status codes, auth.
2. Validate every input at the boundary (types, ranges, lengths); reject with 400/422 and a clear message.
3. Errors are consistent JSON (`{"error": {"code", "message"}}` or the framework's standard); never leak stack traces
   or secrets. 401 vs 403 vs 404 used correctly.
4. Security: parameterised queries only, secrets from environment, authorisation checked per resource. With accounts, hash
   passwords (bcrypt or argon2) and rate limit the auth endpoints. If clients run on another origin, allow only their exact origins in CORS.
5. If it stores data: explicit schema/migrations, transactions for multi-step writes, indexes for lookups you query by.
6. Tests: one happy path and the main failure paths per endpoint, with the project's test runner or the framework's test client.
   Run them with `shell` and fix until green.
7. Document how to run it (README section): install, env vars, start command, example requests (curl).

## Done when
All tests pass, every endpoint in the design exists with the specified contract, errors are consistent.
