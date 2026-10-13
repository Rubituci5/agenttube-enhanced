#!/bin/zsh
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
echo 'Conectar AgentTube ao ChatGPT Pro pelo login oficial (OpenAI)'
echo 'Uma janela de navegador será aberta para sua autorização.'
npm run chatgpt:login
result=$?
if [ "$result" -eq 0 ]; then
  echo 'Conexão autorizada! Para carregar a nova conexão, reinicie o AgentTube.'
else
  echo 'Não foi possível concluir a autorização. Você pode executar este atalho novamente.'
fi
echo 'Pressione Enter para fechar.'
read -r
exit "$result"
