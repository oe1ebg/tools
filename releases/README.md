# Release notes

Reviewed end-user release notes live here as `vX.Y.Z.md`. The file name must
match the release tag. Start with a short summary, group notable changes by
tool, explain required update steps and limitations, and link technical PRs
below the user-facing text. Describe user-visible outcomes rather than copying
commit messages. Do not claim all work on a parent issue is complete merely
because a PR is included.

For each release:

1. Compare the intended release commit with the previous stable tag. Include
   only changes that will actually ship.
2. Create and review the notes in a PR before tagging. Use the previous release
   as a structure; update its content and links. Link to the new tag for stable
   technical documentation. These links become available when the tag is pushed.
3. Rebase and merge the PR, then identify the exact release commit on `main`.
4. Create and push the annotated version tag on that commit. For example,
   `git tag -a v0.3.0 <release-commit> -m 'Release v0.3.0'`, then
   `git push origin v0.3.0`. Tagging starts the release workflow.
5. Check the Release workflow. It requires a nonempty matching notes file,
   builds with fresh data and the manuals' screenshots (generated in the pinned Playwright image, not committed; the release fails without them), runs required checks, and validates the exact tarball
   before publishing. The GitHub release uses the notes from the tagged commit
   and appends GitHub's generated PR/contributor list.

The rolling `data-latest` prerelease continues to use the data workflow; it does
not require a separate notes file for every weekly data refresh.
