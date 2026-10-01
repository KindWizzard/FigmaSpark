#!/bin/zsh
cd -- "${0:A:h}"
if ! command -v node >/dev/null; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
fi
if ! command -v node >/dev/null && [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
fi
if ! command -v node >/dev/null; then
  print 'Install Node.js 22 or newer, then reopen this launcher.'
  read -k 1
  exit 1
fi
exec node scripts/service.mjs start
