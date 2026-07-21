#!/usr/bin/env bash
# Refuse to commit a manifest.json containing a "key" field.
#
# A local "key" is how a developer makes their unpacked build load under the
# SAME extension id as the published item, so one OAuth client_id works in both
# places. It is useful locally and wrong in the repository: committed, it pins
# every clone and every fork to one person's extension identity, and collides
# with the published extension.
#
# Install:  ln -sf ../../tools/check-no-key.sh .git/hooks/pre-commit
set -euo pipefail

staged=$(git diff --cached --name-only)
echo "$staged" | grep -q '^manifest\.json$' || exit 0

# Inspect the STAGED content, not the working tree -- they differ, and the
# staged version is what would actually enter history.
if git show :manifest.json | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    let m; try { m = JSON.parse(s); } catch { process.exit(0); }
    process.exit("key" in m ? 1 : 0);
  });
'; then
  exit 0
fi

cat >&2 <<'MSG'

BLOCKED: manifest.json has a "key" field staged for commit.

That field pins the extension id. Committing it ties every clone and fork to
one person's extension identity, and this repository is public.

Keep it in your working copy for local development, just do not commit it:

    git restore --staged manifest.json

To commit an unrelated manifest change, temporarily remove the "key" field,
stage, commit, then put it back.

MSG
exit 1
