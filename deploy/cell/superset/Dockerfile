# Apache Superset for a cell: the official image plus what it lacks for us — the
# Postgres driver (metadata database) and authlib (login via the cell's Authentik).
# Installed at build time, not at every start: the cell must not depend on PyPI
# being reachable when a container restarts.
FROM apache/superset:6.1.0@sha256:16b50bbef6648912a79e3293d418fefa743ce555d36c5af6b85d859119ed7f88
USER root
RUN uv pip install --python /app/.venv/bin/python --no-cache \
      psycopg2-binary==2.9.10 authlib==1.6.5
COPY superset_config.py /app/zelle/superset_config.py
ENV SUPERSET_CONFIG_PATH=/app/zelle/superset_config.py
USER superset
