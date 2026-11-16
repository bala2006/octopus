# Security review of a change
1. List the entry points the change touches: routes, handlers, CLI arguments, file paths, message handlers and environment variables.
2. Follow each input to where it is used, and check:
   - Injection: SQL or NoSQL built from strings, shell commands built from input, template rendering, eval.
   - Paths: input in file paths, including ../, encoded %2e%2e, absolute paths and symlinks.
   - Output: user text rendered as HTML without escaping, and headers built from input.
   - Access: every route that reads or changes data checks who the caller is and what they may do.
   - Secrets: keys, tokens or passwords in code, logs, error messages or the client bundle.
   - Server-side requests to a URL taken from input.
   - Merging parsed JSON into objects (prototype pollution) and unsafe deserialization.
   - New dependencies: run npm audit --omit=dev or the project's equivalent when it is available.
3. Prove each finding with a request, a test or a short script against the running code when you can.
