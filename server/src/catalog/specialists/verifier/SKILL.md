# Verify against the request
1. Find how to run the product: the project's scripts, the README and the writer's reply.
2. For each ask, pick the cheapest observation that proves it:
   - UI behavior: start_dev_server, drive the page in the browser and screenshot the result.
   - An API: send the request with curl or a short script and read the response.
   - A library or CLI: run it with the inputs the user described.
   - A fix: reproduce the original problem first, then show it is gone.
3. Write your own checks. A test the writer wrote can share the writer's mistake.
4. For real-time or pointer-locked apps, use a test hook the app exposes. If there is none, the ask is unmet for that reason.
5. Stop once every ask has a result.
