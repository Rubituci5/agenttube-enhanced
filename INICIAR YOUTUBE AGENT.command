#!/bin/zsh
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
mkdir -p logs
if ! /usr/bin/curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:3456/health 2>/dev/null; then
  echo "Iniciando YouTube Agent..."
  nohup npm start >> logs/agent-server.log 2>&1 < /dev/null &
  for attempt in {1..20}; do
    if /usr/bin/curl -fsS --max-time 1 -o /dev/null http://127.0.0.1:3456/health 2>/dev/null; then
      break
    fi
    sleep 1
  done
fi
if /usr/bin/curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:3456/health 2>/dev/null; then
  open 'http://localhost:3456'
  echo "Painel aberto: http://localhost:3456"
else
  echo "Falha ao iniciar. Consulte logs/agent-server.log"
fi
