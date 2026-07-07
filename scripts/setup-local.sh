#!/usr/bin/env bash
# One-line local setup for Dailies, so it can read footage straight off this
# computer's disk (only possible when the app is actually running on the
# machine that has the footage -- a hosted deployment can't reach a local
# hard drive at all). Meant to be run as:
#
#   curl -fsSL https://raw.githubusercontent.com/Sukkiiee/abh-footage-pipeline/main/scripts/setup-local.sh | bash
#
# Safe to re-run any time -- it updates the existing install instead of
# duplicating it, and won't overwrite an existing .env.local.
set -euo pipefail

APP_DIR="$HOME/dailies-app"
REPO_URL="https://github.com/Sukkiiee/abh-footage-pipeline.git"

echo "== Dailies local setup =="
echo ""

# --- 0. Find Node/npm even if this shell doesn't have them on PATH yet -----
# `curl | bash` runs in a fresh, non-interactive shell that doesn't load
# ~/.zshrc, ~/.bashrc, etc. -- so if Node was installed via nvm or Homebrew
# (both extremely common, and both set PATH from those files), a real,
# already-installed Node can still be invisible to this script and get
# wrongly reported as missing. Try the well-known install locations before
# concluding it's actually absent.
if ! command -v node >/dev/null 2>&1; then
  # Official nvm way to make it available in a non-interactive script.
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  # Homebrew's own bin dirs (Apple Silicon and Intel) aren't always on a
  # non-interactive shell's default PATH either.
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
fi

# --- 1. Check prerequisites -------------------------------------------------
# Deliberately just check-and-explain rather than silently installing system
# packages (which would need sudo and could surprise someone) -- one clear
# instruction, then re-run this script.
if ! command -v git >/dev/null 2>&1; then
  echo "Git isn't installed yet."
  echo "  Mac: run 'xcode-select --install' in Terminal, then re-run this."
  echo "  Windows: install Git from https://git-scm.com/downloads, then re-run this from Git Bash."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Can't find Node.js."
  echo "  If you've genuinely never installed it: get it from https://nodejs.org (LTS version), then re-run this."
  echo "  If you HAVE installed it before (e.g. via nvm or Homebrew) and this still shows up, open a new"
  echo "  terminal window/tab first (so it picks up your normal setup), then re-run this from there."
  exit 1
fi

NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js 18 or newer is required (found $(node -v))."
  echo "  Install a current version from https://nodejs.org, then re-run this."
  exit 1
fi

# --- 2. Get the code ---------------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  echo "Updating the app already installed at $APP_DIR..."
  git -C "$APP_DIR" pull --ff-only
else
  echo "Downloading the app to $APP_DIR..."
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"

# --- 3. Install dependencies -------------------------------------------------
echo ""
echo "Installing dependencies (this can take a minute the first time)..."
npm install

# --- 4. Set up .env.local ----------------------------------------------------
if [ ! -f ".env.local" ]; then
  echo ""
  echo "No .env.local found yet. These are the same values already used for the"
  echo "hosted site -- ask whoever set that up to send them to you, then paste"
  echo "each one below and press Enter."
  echo ""

  # Prompting for input works differently depending on how this script is
  # being run: piped straight from curl (the one-liner in the README),
  # stdin here is the script itself, not the terminal, so reads must come
  # from /dev/tty instead. Downloaded-then-run directly, plain stdin
  # already is the terminal. Fall back gracefully rather than crashing if
  # /dev/tty genuinely isn't available (some restricted/non-interactive
  # environments don't have one at all).
  # A plain "-r /dev/tty" file-permission check isn't reliable here: the
  # device can look readable while still having no controlling terminal
  # actually attached (e.g. a backgrounded/detached process), which fails
  # only once something tries to open it. Attempt the real open instead.
  if exec 3<>/dev/tty 2>/dev/null; then
    exec 3<&-
    READ_SRC=/dev/tty
  else
    READ_SRC=/dev/stdin
  fi
  read -rp "GOOGLE_CLIENT_ID: " GOOGLE_CLIENT_ID < "$READ_SRC"
  read -rp "GOOGLE_CLIENT_SECRET: " GOOGLE_CLIENT_SECRET < "$READ_SRC"
  read -rp "GROQ_API_KEY: " GROQ_API_KEY < "$READ_SRC"
  read -rp "SESSION_SECRET: " SESSION_SECRET < "$READ_SRC"

  cat > .env.local <<EOF
GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET
GROQ_API_KEY=$GROQ_API_KEY
LLM_PROVIDER=groq
SESSION_SECRET=$SESSION_SECRET
APP_URL=http://localhost:3000
ENABLE_LOCAL_FOOTAGE=true
EOF
  echo ""
  echo ".env.local created."
else
  echo ""
  echo "Found an existing .env.local -- leaving your values as they are."
  if ! grep -q '^ENABLE_LOCAL_FOOTAGE=true' .env.local; then
    echo "ENABLE_LOCAL_FOOTAGE=true" >> .env.local
    echo "Added ENABLE_LOCAL_FOOTAGE=true to it (needed for local-folder footage)."
  fi
fi

# --- 5. Start the app ---------------------------------------------------------
echo ""
echo "Starting the app -- it'll open at http://localhost:3000"
echo "Leave this window open while you use it. Press Ctrl+C here to stop it."
echo ""

# Best-effort auto-open in the default browser once the server's had a
# moment to come up; harmless no-op if neither command exists (e.g. a
# headless machine) -- the URL above still works, just needs opening by hand.
( sleep 3
  if command -v open >/dev/null 2>&1; then open http://localhost:3000
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open http://localhost:3000
  fi
) &

npm run dev
