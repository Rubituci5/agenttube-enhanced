#!/bin/zsh
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
echo "Conectar canal do YouTube pelo projeto Google Cloud 259108835778"
echo "Baixe um arquivo JSON OAuth Desktop do projeto e coloque em Downloads antes de continuar."
echo "IMPORTANTE: regenere o Client Secret que foi compartilhado anteriormente."
npm run youtube:novo-projeto
printf "\nPressione Enter para fechar..."
read -r
