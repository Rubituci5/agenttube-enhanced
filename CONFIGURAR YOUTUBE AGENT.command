#!/bin/zsh
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
echo "Assistente de configuracao: YouTube e provedor de IA"
echo "Tenha as credenciais OAuth do YouTube e uma chave de IA disponiveis."
npm run walkthrough
printf '\nPressione Enter para fechar...'
read -r
