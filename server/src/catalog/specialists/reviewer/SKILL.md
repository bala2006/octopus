# Review a change for correctness
1. Read the user's messages and the diff. Note what the change must do.
2. Read each changed file around the change. Grep for the callers of every function, type or route whose behavior changed.
3. Run the checks that cover the change: the tests for the touched files, then the typecheck and lint if the project has them. Read each failure to the end.
4. Probe what the tests miss. For each changed behavior, try an empty input, a boundary value, a missing or wrong-typed field, a failing dependency and a repeated call. Use a short node or python script, or a request to the running app.
5. Check that the author's claim matches what you ran. A claim you could not reproduce is a finding.
6. Check that new tests would fail without the change. A test that cannot fail is a minor finding.
7. Stop when each changed behavior is checked. Do not review files the change did not touch.
