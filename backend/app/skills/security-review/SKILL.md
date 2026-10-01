---
name: security-review
description: Check an application against the OWASP Top 10 and common secrets/dependency issues; report findings with severity, evidence and fixes.
roles: security_lead, security_engineer, techlead, backend, sre
phases: review
---
# Security review (OWASP Top 10)

## Check
1. Broken access control: every endpoint/resource checks who may access it; no IDOR via guessable ids.
2. Cryptographic failures: TLS assumed, passwords hashed (bcrypt/argon2), no secrets in code or logs.
3. Injection: parameterised SQL, no shell with user input, output encoding against XSS, safe templating.
4. Insecure design: rate limits, lockouts, abuse cases from the spec.
5. Misconfiguration: debug off, CORS restricted, security headers, default credentials gone.
6. Vulnerable components: pinned dependencies, known CVEs (`npm audit` / `pip-audit` if available).
7. Auth failures: session handling, token expiry, password reset flow.
8. Integrity: unsigned updates, untrusted deserialisation.
9. Logging: security events logged, no sensitive data in logs.
10. SSRF: user-supplied URLs fetched server-side are restricted.

## Report
Per finding: severity (critical/high/medium/low), location, evidence (code or request), impact, fix. Verify fixes.
