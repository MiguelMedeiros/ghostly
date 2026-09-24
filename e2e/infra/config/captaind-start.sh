#!/bin/sh
# captaind 0.7.1's own /root/captaind/start.sh, made patient: it gives Postgres two seconds to start, which an
# emulated amd64 image on a busy host does not get done in, and a restart after that finds a half-made database
# and fails on initdb forever. Here Postgres is waited for (pg_ctl -w) and initdb runs only on an empty directory.
set -e
export RUST_BACKTRACE=full
CONFIG_PATH="${CAPTAIND_CONFIG:-/root/captaind/captaind.toml}"
PGDATA=/var/lib/postgresql/data
export PATH=/usr/lib/postgresql/16/bin:${PATH}
mkdir -p /run/postgresql/
chown -R postgres:postgres /run/postgresql/
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  chmod 0700 "$PGDATA"
  chown -R postgres:postgres "$PGDATA"
  su postgres -s /bin/sh -c "initdb $PGDATA"
  echo "host all  all    0.0.0.0/0  md5" >> "$PGDATA/pg_hba.conf"
  echo "listen_addresses='*'" >> "$PGDATA/postgresql.conf"
fi
rm -f "$PGDATA/postmaster.pid"
su postgres -s /bin/sh -c "pg_ctl start -w -t 180 -D $PGDATA -l /var/lib/postgresql/log.log"
if [ ! -f /data/captaind/mnemonic ]; then
  psql -U postgres -c "ALTER USER postgres WITH ENCRYPTED PASSWORD 'postgres';"
  echo "Creating new config at /data/captaind/ using ${CONFIG_PATH}"
  /usr/local/bin/captaind --config "${CONFIG_PATH}" create
fi
echo "Booting captaind"
exec /usr/local/bin/captaind --config "${CONFIG_PATH}" start
