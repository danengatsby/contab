'use strict';

// Doua replici pe ACEEASI gazda: failover de proces si exercitiu local. Pentru failover de gazda,
// ruleaza cate o replica pe fiecare masina, cu alt CONTAB_INSTANCE_ID, acelasi PostgreSQL HA si
// acelasi CONTAB_DATA_DIR partajat. `.env` trebuie sa activeze CONTAB_HA_ENABLED=1 si toate
// preconditiile descrise in docs/rulare.md; aplicatia refuza sa porneasca fail-open.

const base = {
  script: 'server.js',
  cwd: '/var/www/contab',
  instances: 1,
  exec_mode: 'fork',
  autorestart: true,
  watch: false,
  max_memory_restart: '1G',
  merge_logs: true,
  time: true,
};

module.exports = {
  apps: [
    Object.assign({}, base, {
      name: 'contab-a',
      env: { PORT: 8080, HOST: '127.0.0.1', CONTAB_INSTANCE_ID: 'contab-a' },
      error_file: '/var/www/contab/logs/contab-a-error.log',
      out_file: '/var/www/contab/logs/contab-a-out.log',
    }),
    Object.assign({}, base, {
      name: 'contab-b',
      env: { PORT: 8081, HOST: '127.0.0.1', CONTAB_INSTANCE_ID: 'contab-b' },
      error_file: '/var/www/contab/logs/contab-b-error.log',
      out_file: '/var/www/contab/logs/contab-b-out.log',
    }),
  ],
};
