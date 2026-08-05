#!/bin/bash
# Double-click this file in Finder to publish the site to sailz.org.
#
# It regenerates the site data, checks every changed JavaScript file for
# syntax errors before committing (so a half-finished Cursor edit can
# never take a live client service down), commits, and pushes. Railway
# redeploys automatically in about two minutes.

cd "$(dirname "$0")" || exit 1

echo ""
echo "  Publishing sailz.org"
echo "  ===================="
echo ""

# 1. regenerate site/data.js from brain/agents and brain/blueprints
echo "  [1/5] Regenerating site data"
node scripts/build-site-data.mjs || { echo "  FAILED. Stopping."; read -r -p "  Press return to close."; exit 1; }

# 2. syntax-check every JS file that is about to be committed. Cursor may
#    be mid-edit; committing a broken file would redeploy it to Shine,
#    The Burg and RPRG too.
echo ""
echo "  [2/5] Checking every changed JavaScript file"
BAD=0
for f in $(git status --porcelain | awk '{print $2}' | grep -E '\.js$'); do
  if [ -f "$f" ]; then
    if node --check "$f" 2>/dev/null; then
      echo "        ok   $f"
    else
      echo "        FAIL $f"
      BAD=1
    fi
  fi
done
if [ "$BAD" = "1" ]; then
  echo ""
  echo "  A file has a syntax error. Nothing was committed."
  echo "  Let Cursor finish what it is doing, then run this again."
  read -r -p "  Press return to close."
  exit 1
fi

# 3. show what is going out
echo ""
echo "  [3/5] Files to publish"
git status --short | sed 's/^/        /'

# 4. commit
echo ""
echo "  [4/5] Committing"
git add -A
if git diff --cached --quiet; then
  echo "        Nothing new to commit."
else
  git commit -m "Serve the marketing site at sailz.org from HQ" || {
    echo "  Commit failed. Stopping."; read -r -p "  Press return to close."; exit 1; }
fi

# 5. push
echo ""
echo "  [5/5] Pushing to GitHub"
if git push; then
  echo ""
  echo "  Done. Railway is rebuilding now."
  echo ""
  echo "  In about two minutes:"
  echo "    https://sailz.org      the new site"
  echo "    https://hq.sailz.org   your dashboard, unchanged"
  echo ""
else
  echo ""
  echo "  Push failed. Usually this is a GitHub login prompt."
  echo "  Run 'git push' yourself in this folder and follow the prompt."
  echo ""
fi

read -r -p "  Press return to close."
