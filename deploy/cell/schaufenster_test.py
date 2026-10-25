#!/usr/bin/env python3
"""Schaufenster-Lauf auf der Zelle — über run_tests.sh (Wegwerfkonto, Aufräumen per trap):

    ./run_tests.sh schaufenster

Benennt das Testkonto für die Bilder um, legt Demo-Daten an und nimmt im Playwright-Container
auf. Ergebnis in ./schaufenster-MMDD-HHMM/ (Bilder für das README, docs/assets).
"""
import os
import subprocess
import sys
import time

DOM, USER = sys.argv[1], sys.argv[2]
OUT = time.strftime("schaufenster-%m%d-%H%M")  # new dir per run: old ones are root-owned
os.makedirs(OUT)

umbenennen = ("from authentik.core.models import User\n"
              f"print('UMBENANNT', User.objects.filter(username='{USER}').update(name='Alex Morgan'))\n")
subprocess.run(["docker", "compose", "exec", "-T", "authentik", "ak", "shell"],
               input=umbenennen, text=True, check=False)
with open("seed_demo.py") as f:
    subprocess.run(["docker", "compose", "exec", "-T", "claraos-api", "python3", "-", USER],
                   stdin=f, check=False)
# Demo team in the Teams app (Matrix; runs in claraos-api with the Synapse admin login).
with open("seed_teams.py") as f:
    subprocess.run(["docker", "compose", "exec", "-T", "claraos-api", "python3", "-", USER],
                   stdin=f, check=False)
rc = subprocess.run([
    "docker", "run", "--rm", "-e", "ZELLE_TEST_PW", "-v", f"{os.getcwd()}:/w", "-w", "/w",
    "mcr.microsoft.com/playwright/python:v1.52.0-noble", "sh", "-c",
    "pip install -q playwright==1.52.0 >/dev/null 2>&1; playwright install --with-deps chrome "
    f">/dev/null 2>&1; python3 browser_schaufenster.py {DOM} {USER} /w/{OUT}"]).returncode
subprocess.run(["chown", "-R", f"{os.getuid()}:{os.getgid()}", OUT], check=False)
sys.exit(rc)
