---
name: performance-check
description: Measure before optimising - define a budget, measure load time, frame time or request latency, find the bottleneck, fix it and measure again.
roles: sre, devops, gameplay_programmer, qa, qa_engineer, frontend, backend, data_engineer
phases: test
---
# Performance check

## Steps
1. Set the budget from the spec (or sensible defaults): page interactive < 2 s, frame time < 16.7 ms (60 fps) and never
   > 33 ms, API p95 < 300 ms, memory stable over 2 minutes.
2. Measure for real:
   - Browser: `browser_evaluate` with `performance.now()` around work, a rAF sampling loop for frame times,
     `performance.getEntriesByType('navigation')` for load, `performance.memory` (Chromium) twice a minute apart.
   - Services: a small script timing N requests, report p50/p95.
3. Find the bottleneck (the biggest number), not the easiest fix. Typical causes: allocation per frame, layout in loops,
   unbatched draw calls, N+1 queries, missing indexes, large payloads.
4. Fix one thing, measure again, keep the numbers in the report (before → after).
