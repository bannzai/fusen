---
paths:
  - ".github/workflows/*.{yml,yaml}"
---

# Pin GitHub Actions to a commit SHA

Reference every `uses:` action by its full commit SHA with the version as a trailing comment, not by a tag. Tags are mutable, so a compromised action repository can repoint a tag to malicious code (GitHub's security hardening guide recommends SHA pinning).

- Format: `uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`
- Resolve a tag to its commit SHA with `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha` (this dereferences annotated tags)
- Sub-directory actions (for example `actions/cache/restore`) take the SHA from the parent repository's tag
- After changing a workflow, run it once on a pull request and confirm it passes

Reference: https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#using-third-party-actions
