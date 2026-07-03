#!/usr/bin/env bash
# Activeaza reverse proxy nginx pentru Contab (subdomeniu).
# Rulare:  sudo bash /var/www/contab/setup-nginx.sh [subdomeniu]
# Implicit subdomeniul este contab.poetio.site (poate fi dat ca argument).
set -e

SUBDOMAIN="${1:-contab.poetio.site}"
CONF_SRC="/var/www/contab/nginx-contab.conf"
LINK="/etc/nginx/sites-enabled/contab"

if [ "$EUID" -ne 0 ]; then echo "Ruleaza cu sudo: sudo bash $0 [subdomeniu]"; exit 1; fi

# seteaza server_name la subdomeniul ales
sed -i "s/server_name .*/server_name ${SUBDOMAIN};/" "$CONF_SRC"

# activeaza site-ul
ln -sf "$CONF_SRC" "$LINK"
echo ">> nginx -t:"
nginx -t
systemctl reload nginx
echo ">> Activat: http://${SUBDOMAIN}  (proxy -> 127.0.0.1:8080)"

# certificat HTTPS (daca certbot e instalat si DNS-ul rezolva)
if command -v certbot >/dev/null 2>&1; then
  if getent hosts "$SUBDOMAIN" >/dev/null 2>&1; then
    echo ">> Emit certificat HTTPS pentru ${SUBDOMAIN}..."
    certbot --nginx -d "$SUBDOMAIN" --non-interactive --agree-tos --redirect -m "${CERTBOT_EMAIL:-admin@${SUBDOMAIN#*.}}" || \
      echo "!! Certbot a esuat (verifica DNS / email). Poti rula manual: sudo certbot --nginx -d ${SUBDOMAIN}"
  else
    echo "!! DNS pentru ${SUBDOMAIN} nu rezolva inca. Dupa propagare, ruleaza: sudo certbot --nginx -d ${SUBDOMAIN}"
  fi
fi
echo ">> Gata."
