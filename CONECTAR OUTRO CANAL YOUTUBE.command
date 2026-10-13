#!/bin/zsh
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
echo "Conectando outro canal do YouTube ao AgentTube..."
npm run youtube:outro-canal
printf "\nPressione Enter para fechar..."
read -r
