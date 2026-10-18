# Browser controller of a cell (ctl.py). docker-cli is baked in at build time —
# installing it at every start would make the service depend on the package mirror.
FROM python:3.12-alpine
RUN apk add --no-cache docker-cli
COPY ctl.py /ctl.py
USER root
CMD ["python3", "-u", "/ctl.py"]
