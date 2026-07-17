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
      // Plasa contra scurgerilor de memorie, NU dimensionare de lucru: baza sta in RAM prin
      // design, dar graful de date e minuscul (~sute de KB) — RSS-ul de ~130MB e runtime-ul
      // Node + bibliotecile. 300M lasa doar ~170MB pentru varfuri legitime (PDF/ZIP/SAF-T,
      // adm-zip construieste arhiva in memorie) si ucidea procesul in mijlocul cererii.
      // 1G pe un server de 7.7G = protectie reala contra leak-urilor, fara kill pe varfuri.
      // Avertizare INAINTE de limita: jobul memory-watch (src/jobs.js, CONTAB_MEM_WARN_MB).
      // ATENTIE: schimbarea se aplica doar cu `pm2 startOrReload ecosystem.config.js` + `pm2 save`
      // (un simplu `pm2 restart contab` NU reciteste fisierul).
      max_memory_restart: '1G',
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
