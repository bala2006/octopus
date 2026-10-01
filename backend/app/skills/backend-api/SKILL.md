---
name: backend-api
description: Build an HTTP API or service with validated input, consistent errors, safe data handling and automated tests that pass.
roles: backend, fullstack_dev, developer, data_engineer, security_engineer
phases: build
---
# Backend API

## Steps
1. From the design, write the endpoint list: method, path, request schema, response schema, status codes, auth.
2. Validate every input at the boundary (types, ranges, lengths); reject with 400/422 and a clear message.
3. Errors are consistent JSON (`{"error": {"code", "message"}}` or the framework's standard); never leak stack traces
   or secrets. 401 vs 403 vs 404 used correctly.
4. Security: parameterised queries only, hash passwords (bcrypt/argon2), secrets from environment, authorisation checked
   per resource, rate limits on auth endpoints, CORS restricted.
5. Data: explicit schema/migrations, transactions for multi-step writes, indexes for lookups you query by.
6. Tests: one happy path and the main failure paths per endpoint (pytest + test client, or the framework's equivalent).
   Run them with `run_code` and fix until green.
7. Document how to run it (README section): install, env vars, start command, example requests (curl).

## Done when
All tests pass, every endpoint in the design exists with the specified contract, errors are consistent.
