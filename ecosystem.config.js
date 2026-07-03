// Configurare PM2 pentru aplicatia Contab.
// Pornire:   pm2 start ecosystem.config.js
// Salvare:   pm2 save           (re-pornire la boot: pm2 startup — necesita sudo)
module.exports = {
  apps: [
    {
      name: 'contab',
      script: 'server.js',
      cwd: '/var/www/contab',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        PORT: 8080,
        HOST: '0.0.0.0',
        // Pentru extragerea cu AI, decomenteaza si completeaza:
        // ANTHROPIC_API_KEY: 'sk-ant-...',
      },
      error_file: '/var/www/contab/logs/contab-error.log',
      out_file: '/var/www/contab/logs/contab-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
