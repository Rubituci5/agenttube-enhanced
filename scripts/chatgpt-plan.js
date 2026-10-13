'use strict';
const { login, status } = require('../utils/chatgpt-plan-auth');
const mode = process.argv[2] || 'status';
(async () => {
  if (mode === 'login') {
    await login();
    console.log('Conectado com sucesso. Reinicie o AgentTube para ativar o uso do plano ChatGPT.');
  } else if (mode === 'status') {
    const s = status();
    console.log(`ChatGPT plan: ${s.connected ? 'CONECTADO' : 'AGUARDANDO LOGIN'}`);
    if (s.email) console.log(`Conta: ${s.email}`);
    console.log('Permissão de uso do plano:', s.planGranted ? 'SIM' : 'NÃO');
  } else throw new Error('Use: npm run chatgpt:login ou npm run chatgpt:status');
})().catch(e => { console.error('Falha:', e.message); process.exitCode = 1; });
