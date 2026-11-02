# Runtime reliability evaluation

Historical selected-suite record. Further edits followed this run; it does not certify the PR head. The user stopped verification before publication.

Generated: 2026-11-02T15:24:36.672693+00:00

This report runs deterministic scripted native and fake ACP fixtures, with actual local MCP transport, filesystem, database and subprocess behavior where the selected tests exercise them. No inference calls or model-quality comparisons are performed. Passing checks establish only their asserted behavior.

| Suite | Passed | Failed | Errors | Skipped | Seconds | Exit |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| workflow_matrix | 16 | 0 | 0 | 0 | 31.79 | 0 |
| coordination | 41 | 0 | 0 | 0 | 21.53 | 0 |
| artifacts_and_skills | 41 | 0 | 0 | 0 | 3.44 | 0 |
| acp_transport_and_workers | 22 | 0 | 0 | 0 | 15.11 | 0 |
| diagnostic_scripts | 3 | 0 | 0 | 0 | 3.07 | 0 |

| Fixture (each native and ACP) | Observable acceptance |
| --- | --- |
| Explain | Inspect app.py and record a source-linked answer without changing it |
| Fix | Observe a failing unittest, change the source, rerun a passing current-revision check |
| Build | Record acceptance and design, create app.py, and run the existing unittest against it |
| Review | Inspect externally authored app.py and record a scoped clean verdict without editing |

Eight additional native/ACP cases reject missing passing proof, skipped prerequisite checkpoints, and failure to replay the original reproduction command. These small fixtures verify the workflow machinery; they do not establish complex-task success, independent review quality, or the installed CLI's compliance with prompts.

The historical baseline recorded 25 selected tests passing. Its selector set/revision differs or is unavailable, so counts cannot establish a reliability gain. Model output quality, cost and latency remain unmeasured. A future paired baseline/candidate run must use identical tasks, acceptance checks, model versions, budgets and repetitions; score blind review separately from deterministic reliability. The comparative promotion condition has not been met. Arena and swarm remain optional bounded strategy contracts; this report does not justify making either a default.

Run from the repository root with the existing backend environment:

```powershell
backend\.venv\Scripts\python.exe scripts/evaluate_runtime.py
```

Exact suite commands below run with `backend` as the working directory. The adjacent JSON records source hashes, selector sets, timestamps and failures. JUnit is used for counts, not parsed console text.

- `<repository>\backend\.venv\Scripts\python.exe -m pytest tests/test_engineering_workflows.py -q --tb=short`
- `<repository>\backend\.venv\Scripts\python.exe -m pytest tests/test_runtime_contracts.py tests/test_runtime_store.py tests/test_scoped_memory.py tests/test_runtime_integration.py tests/test_runtime_delivery.py tests/test_legacy_memory.py -q --tb=short`
- `<repository>\backend\.venv\Scripts\python.exe -m pytest tests/test_skill_contracts.py tests/test_revision_evidence.py tests/test_attempt_workspaces.py -q --tb=short`
- `<repository>\backend\.venv\Scripts\python.exe -m pytest tests/test_acp_transport.py tests/test_worker_bridge.py tests/test_opencode_worker.py tests/test_opencode.py -q --tb=short`
- `<repository>\backend\.venv\Scripts\python.exe -m pytest tests/test_runtime_doctor.py -q --tb=short`
