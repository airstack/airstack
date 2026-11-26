# GitHub workflows (not active yet)

`ci.yml` and `release.yml` belong in `.github/workflows/`. They wait here because the token that
pushed them has no `workflow` scope.

To turn them on:

1. `mkdir -p .github/workflows`
2. `git mv devutils/github-workflows/*.yml .github/workflows/`
3. Commit and push with a token or SSH key that may change workflows.
