---
name: research-brief
description: Answer a concrete question with sources, compare the options and end in one recommendation the team can act on.
roles: researcher, research_director, ux_researcher, data_analyst, growth_analyst, seo_specialist
phases: research
---
# Research brief

Output: `.octopus/work/research.md`. Research exists to unblock a decision, not to collect links.

## Steps
1. Write the question(s) as decisions: "Which X should we use for Y, given Z?" Max 3 questions.
2. Search broadly first (`web_search`, the browser for docs), then go deep on the 2-4 most credible sources: official
   docs, specifications, peer-reviewed papers, maintained repositories. Note dates and versions.
3. For each option record: what it is, fit for our constraints, cost/effort, risks, evidence (link).
4. Compare in a table, then **recommend one** and say what would change your mind.
5. Add the concrete facts the builder needs: API names, versions, install lines, snippets, limits, gotchas.

## Template
```markdown
# Research: <question>
## Answer (2-3 sentences, the recommendation)
## Options compared
| Option | Fit | Effort | Risks | Source |
## Facts for the builder
## Open questions / confidence
```

## Rules
- Never invent a source or a version. If you couldn't verify it, say so.
- Prefer primary sources over blog posts; prefer recent over old for fast-moving tools.
