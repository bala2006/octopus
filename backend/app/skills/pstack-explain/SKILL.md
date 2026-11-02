---
name: pstack-explain
description: Inspect authoritative sources and answer a scoped question with references and uncertainty.
version: 1
phases: inspect, answer
---

Work within the assignment's existing permissions. This playbook grants no tools or authority.

1. Identify the question and authoritative sources. Trace the actual behavior when explaining code.
2. Record source references and distinguish observed facts from inference and open questions.
3. Answer the question concisely. Preserve source references so the reader can recover details.
4. Return an answer and source references. Do not claim runtime verification from source inspection alone.

The backend's evidence validator determines completion. Reading this skill does not satisfy a gate.
