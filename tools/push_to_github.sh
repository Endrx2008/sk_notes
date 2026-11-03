#!/bin/bash
# Push this repository to GitHub as Endrx2008/sk_notes.
# Asks for a GitHub personal access token (GitHub no longer accepts account passwords for git),
# uses it only for this run and forgets it: it is never written to disk, to the git config or to
# the command line, and the variable and the temporary helper are removed on exit.
#   Token: GitHub -> Settings -> Developer settings -> Personal access tokens, scope "repo".
set -eu
OWNER=Endrx2008
REPO=sk_notes
cd "$(cd "$(dirname "$0")/.." && pwd)"

printf 'GitHub token for %s (input hidden): ' "$OWNER" >&2
IFS= read -rs SKN_PUSH_TOKEN
printf '\n' >&2
[ -n "$SKN_PUSH_TOKEN" ] || { echo "no token given" >&2; exit 1; }
export SKN_PUSH_TOKEN

ASKPASS=$(mktemp)
chmod 700 "$ASKPASS"
cleanup() { rm -f "$ASKPASS"; unset SKN_PUSH_TOKEN; }
trap cleanup EXIT
cat > "$ASKPASS" <<'SH'
#!/bin/sh
case "$1" in
  Username*) printf '%s\n' "$SKN_PUSH_USER" ;;
  *) printf '%s\n' "$SKN_PUSH_TOKEN" ;;
esac
SH
export SKN_PUSH_USER="$OWNER" GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0

# create the repository when it does not exist yet (token passed to curl on stdin, not as an argument)
code=$(printf 'header = "Authorization: Bearer %s"\n' "$SKN_PUSH_TOKEN" |
  curl -sS -K - -o /dev/null -w '%{http_code}' "https://api.github.com/repos/$OWNER/$REPO") || code=000
case "$code" in
  200) echo "repository $OWNER/$REPO exists" >&2 ;;
  404)
    echo "creating $OWNER/$REPO (public)..." >&2
    printf 'header = "Authorization: Bearer %s"\n' "$SKN_PUSH_TOKEN" |
      curl -sS -K - -f -o /dev/null -X POST https://api.github.com/user/repos \
        -d "{\"name\":\"$REPO\",\"description\":\"Markdown notes and SKAI shared memory for Skorpion OS\",\"private\":false}" ;;
  401|403) echo "GitHub refused the token (HTTP $code)" >&2; exit 1 ;;
  *) echo "cannot reach GitHub (HTTP $code)" >&2; exit 1 ;;
esac

git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$OWNER/$REPO.git"
git push -u origin main
echo "done: https://github.com/$OWNER/$REPO" >&2
