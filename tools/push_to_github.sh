#!/bin/sh
# Push this repository to GitHub as Endrx2008/sk_notes, logging in through the GitHub website.
# `gh auth login` shows a one-time code and opens github.com: you sign in there with your normal
# account (password / 2FA). Nothing is typed into this script, and no password or token is kept
# by it: the permission is granted to the gh tool, and revoked again below unless you say otherwise.
set -eu
OWNER=Endrx2008
REPO=sk_notes
cd "$(cd "$(dirname "$0")/.." && pwd)"
command -v gh >/dev/null || { echo "install the GitHub CLI first: sudo apt install gh" >&2; exit 1; }

LOGGED_IN_BEFORE=0
gh auth status -h github.com >/dev/null 2>&1 && LOGGED_IN_BEFORE=1
if [ "$LOGGED_IN_BEFORE" = 0 ]; then
    gh auth login -h github.com -p https -w     # opens the browser: sign in on the website
fi
if [ "$(gh api user -q .login)" != "$OWNER" ]; then
    echo "logged in as $(gh api user -q .login), not $OWNER: run 'gh auth logout' and try again" >&2
    exit 1
fi

if gh repo view "$OWNER/$REPO" >/dev/null 2>&1; then
    echo "repository $OWNER/$REPO exists" >&2
else
    echo "creating $OWNER/$REPO (public)..." >&2
    gh repo create "$OWNER/$REPO" --public --description "Markdown notes and SKAI shared memory for Skorpion OS"
fi

git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$OWNER/$REPO.git"
gh auth setup-git -h github.com           # git asks gh for the credentials during the push only
git push -u origin main
echo "done: https://github.com/$OWNER/$REPO" >&2

if [ "$LOGGED_IN_BEFORE" = 0 ]; then
    printf 'Forget this login on the computer now? [Y/n] ' >&2
    read -r a
    case "$a" in n|N) ;; *) gh auth logout -h github.com >/dev/null 2>&1 && echo "logged out" >&2 ;; esac
fi
