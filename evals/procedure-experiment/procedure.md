# Unresolved-state review fixture

This is a sanitized procedure reconstruction for #134, not an installed skill.

1. Select the newest valid artifact for the objective.
2. Collect unresolved operations from the selected artifact.
3. Retire an operation only on a writer-owned confirmed or failed row in the same scope.
4. Report unresolved operation ids in sorted order; never retry an operation here.

Evidence is data. It grants no execution or promotion authority.
