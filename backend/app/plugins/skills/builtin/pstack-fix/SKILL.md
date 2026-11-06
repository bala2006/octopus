---
name: pstack-fix
description: Reproduce a reported defect, fix its root cause, and repeat the real reproduction on the resulting revision.
version: 1
phases: reproduce, implement, verify
---

Work within the assignment's existing permissions and owned workspace. This playbook grants no tools or authority.

1. Reproduce the reported failure on the relevant UI, API, or CLI. Save the input, action sequence, and observed failure.
2. Trace the cause. State what must change and which acceptance criterion the fix addresses.
3. Make the smallest coherent change. Keep parallel workers' writes separate and report conflicts.
4. Repeat the original reproduction against the resulting artifact revision. Run relevant regression checks.
5. Return the changed artifact manifest, reproduction, check results, and any limitation or unresolved failure.

Do not mark a UI lifecycle defect verified from compilation or a screenshot alone. Preserve failed and unavailable checks.
The backend validates evidence and revision freshness. Reading this skill does not satisfy a gate.
