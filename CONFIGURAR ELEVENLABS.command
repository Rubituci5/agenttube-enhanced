#!/bin/zsh
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
printf '\n🎙️ Configurar narração ElevenLabs para IAgora\n'
printf 'Cole sua API Key ElevenLabs e pressione Enter. Os caracteres ficarão ocultos.\n'
read -rs "ELEVEN_KEY?API Key: "
printf '\n'
if [[ -z "$ELEVEN_KEY" ]]; then
  echo 'Nenhuma chave informada; nenhuma alteração realizada.'
else
  ELEVENLABS_SETUP_KEY="$ELEVEN_KEY" node scripts/configurar-elevenlabs-local.js
fi
unset ELEVEN_KEY
printf '\nPressione Enter para fechar esta janela...'
read -r
