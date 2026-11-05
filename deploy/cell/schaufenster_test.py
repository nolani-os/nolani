#!/usr/bin/env python3
"""Schaufenster-Lauf auf der Zelle — über run_tests.sh (Wegwerfkonto, Aufräumen per trap):

    ./run_tests.sh schaufenster                              # Kern-Apps + Nolani (Zelle mit Gehirn)
    SCHAUFENSTER_TEIL=business ./run_tests.sh schaufenster   # Business-Apps (Wegwerf-Zelle)
    SCHAUFENSTER_TEIL=nolani-business ./run_tests.sh schaufenster   # Nolani in den Business-Apps

Benennt das Testkonto für die Bilder um, legt Demo-Daten an und nimmt im Playwright-Container
auf. Ergebnis in ./schaufenster-MMDD-HHMM/ (Rohmaterial für docs/assets, schaufenster_schnitt.sh).
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
TEIL = os.environ.get("SCHAUFENSTER_TEIL", "kern")
if TEIL in ("business", "nolani-business"):
    # Invented companies, parts, contacts and employees — throwaway cells only.
    subprocess.run(["bash", "seed_business.sh"], check=False)
else:
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
    f">/dev/null 2>&1; python3 browser_schaufenster.py {DOM} {USER} /w/{OUT} {TEIL}"]).returncode
subprocess.run(["chown", "-R", f"{os.getuid()}:{os.getgid()}", OUT], check=False)
sys.exit(rc)
