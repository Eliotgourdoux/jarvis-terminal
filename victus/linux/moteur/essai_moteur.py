#!/usr/bin/env python3
"""Essai de bout en bout du démon (vrai claude, modèle haiku), dans un dossier de test neuf.

  python3 essai_moteur.py <dossier de test /tmp/...> <dossier de session sous le home>

Le démon est lancé avec ULTRON_SOCK / ULTRON_ETAT dans le dossier de test ; l'essai ne touche qu'aux processus
qu'il a lancés (démon, porteurs, claude de ses sessions).
"""
import json
import os
import queue
import signal
import socket
import subprocess
import sys
import threading
import time

ICI = os.path.dirname(os.path.realpath(__file__))
TEST, CWD = sys.argv[1], sys.argv[2]
SOCK = os.path.join(TEST, "moteur.sock")
ENV = dict(os.environ, ULTRON_SOCK=SOCK, ULTRON_ETAT=os.path.join(TEST, "etat"))
ok_total, ko_total = [], []


def verifier(nom, cond, detail=""):
    (ok_total if cond else ko_total).append(nom)
    print(("  OK  " if cond else "  KO  ") + nom + (f"  — {detail}" if detail and not cond else ""), flush=True)
    return cond


class Demon:
    def __init__(self):
        self.p = None

    def lancer(self):
        self.log = open(os.path.join(TEST, "moteur.log"), "ab")
        self.p = subprocess.Popen([sys.executable, os.path.join(ICI, "ultron_moteur.py")], env=ENV,
                                  stdout=self.log, stderr=self.log)
        for _ in range(100):
            if os.path.exists(SOCK):
                return
            time.sleep(0.1)
        raise SystemExit("démon pas prêt")

    def arreter(self):
        self.p.send_signal(signal.SIGTERM)
        self.p.wait(10)


class Client:
    def __init__(self, genre):
        self.s = socket.socket(socket.AF_UNIX)
        self.s.connect(SOCK)
        self.f = self.s.makefile("rb")
        self.q = queue.Queue()
        self.vus = []
        threading.Thread(target=self._lire, daemon=True).start()
        self.envoyer({"op": "bonjour", "client": genre, "version": 1})
        self.bonjour = self.attendre(lambda o: o.get("ev") == "bonjour")

    def _lire(self):
        for l in self.f:
            try:
                self.q.put(json.loads(l))
            except ValueError:
                pass
        self.q.put({"ev": "_ferme"})

    def envoyer(self, o):
        self.s.sendall(json.dumps(o, ensure_ascii=False).encode() + b"\n")

    def page(self, canal, m):
        self.envoyer({"op": "page", "canal": canal, "message": m})

    def attendre(self, cond, delai=90):
        """Premier évènement ou appel qui satisfait cond (les évènements page sont dépliés en appels)."""
        fin = time.time() + delai
        for i, x in enumerate(self.vus):
            if cond(x):
                del self.vus[:i + 1]
                return x
        while time.time() < fin:
            try:
                o = self.q.get(timeout=max(0.05, fin - time.time()))
            except queue.Empty:
                break
            elems = [o]
            if o.get("ev") == "page":
                elems = [{"ev": "appel", "canal": o["canal"], "f": f, "a": a} for f, a in o["appels"]]
            for i, x in enumerate(elems):
                if cond(x):
                    self.vus.extend(elems[i + 1:])
                    return x
                self.vus.append(x)
            del self.vus[:-5000]
        return None

    def appel(self, canal, f, test=lambda a: True, delai=90):
        x = self.attendre(lambda x: x.get("ev") == "appel" and x["canal"] == canal and x["f"] == f and test(x["a"]),
                          delai)
        return x["a"] if x else None

    def oublier(self):
        self.vus.clear()
        while not self.q.empty():
            self.q.get_nowait()


def ligne_user(t):
    return json.dumps({"type": "user", "session_id": "", "message": {"role": "user", "content": [{"type": "text", "text": t}]},
                       "parent_tool_use_id": None})


def resultat(a):
    try:
        return json.loads(a).get("type") == "result"
    except Exception:
        return False


def session(cli, sid):
    """État actuel de la session (les listes déjà reçues sont écartées)."""
    cli.envoyer({"op": "ping"})
    cli.attendre(lambda o: o.get("ev") == "pong", 5)
    cli.vus = [x for x in cli.vus if x.get("ev") != "liste"]
    cli.envoyer({"op": "abonner"})
    o = cli.attendre(lambda o: o.get("ev") == "liste", 5)
    return next((s for s in o["sessions"] if s["id"] == sid), None) if o else None


def pids_claude(sid):
    out = subprocess.run(["pgrep", "-f", f"(resume|session-id)[ =]{sid}"], capture_output=True, text=True).stdout
    return [int(x) for x in out.split()]


def main():
    d = Demon()
    d.lancer()
    print("1. bonjour, abonner, ouvrir (prompt sans page)")
    a = Client("cli")
    verifier("bonjour", a.bonjour.get("machine") == "victus" and a.bonjour.get("home") == os.path.expanduser("~"))
    a.envoyer({"op": "ping"})
    verifier("ping", a.attendre(lambda o: o.get("ev") == "pong", 5) is not None)
    a.envoyer({"op": "abonner"})
    verifier("liste", a.attendre(lambda o: o.get("ev") == "liste", 5) is not None)
    a.envoyer({"op": "ouvrir", "cwd": "/etc", "req": "x"})
    verifier("cwd hors home refusé", a.attendre(lambda o: o.get("ev") == "erreur" and o.get("req") == "x", 5) is not None)
    a.envoyer({"op": "attacher", "sessionId": "../../etc", "canal": "z"})
    verifier("id invalide refusé", a.attendre(lambda o: o.get("ev") == "erreur", 5) is not None)
    a.envoyer({"op": "ouvrir", "cwd": CWD, "resume": None, "prompt": "Réponds seulement le mot : un", "modele": "haiku",
               "effort": None, "req": "r1"})
    o = a.attendre(lambda o: o.get("ev") == "ouverte" and o.get("req") == "r1", 10)
    sid = o["sessionId"]
    print("   session", sid)
    o = a.attendre(lambda o: o.get("ev") == "liste" and any(s["id"] == sid and s["etat"] == "pret" and s.get("dernierMessage")
                                                           for s in o["sessions"]), 90)
    s = next(s for s in o["sessions"] if s["id"] == sid) if o else {}
    verifier("prompt de lancement traité sans page", bool(o), str(s))
    verifier("liste : champs du contrat", all(k in s for k in ("id", "projet", "emoji", "cwd", "etat", "resume", "dernierMessage",
                                                               "modele", "effort", "dansTerminal", "maj", "machine")))
    print("   dernierMessage :", s.get("dernierMessage"))
    verifier("BT_APP/BT_MACHINE dans l'env de claude", any(
        b"BT_MACHINE=victus" in open(f"/proc/{p}/environ", "rb").read() and b"BT_APP=1" in open(f"/proc/{p}/environ", "rb").read()
        for p in pids_claude(sid)))

    print("2. deux pages (mac + gtk) : info + historique, versClaude diffusé")
    m, g = Client("mac"), Client("gtk")
    for c, k in ((m, "c1"), (g, "c2")):
        c.envoyer({"op": "attacher", "sessionId": sid, "canal": k})
        verifier(f"attache {k}", c.attendre(lambda o: o.get("ev") == "attache" and o.get("canal") == k, 5) is not None)
        c.page(k, {"type": "pret"})
        i = c.appel(k, "info", delai=10)
        verifier(f"info {k} (machine, app, vocal, direct)", bool(i) and i.get("machine") == "victus"
                 and i.get("app") == "ultron-terminal" and i.get("vocal") is False and "direct" in i, str(i)[:300])
        h = c.appel(k, "historique", delai=10)
        verifier(f"historique {k}", isinstance(h, list) and len(h) >= 2, str(h)[:200])
    m.page("c1", {"type": "versClaude", "ligne": ligne_user("Réponds seulement le mot : deux")})
    verifier("utilisateurAilleurs sur l'autre page", g.appel("c2", "utilisateurAilleurs", lambda a: a.get("source") == "mac", 10) is not None)
    r1, r2 = m.appel("c1", "depuisClaude", resultat), g.appel("c2", "depuisClaude", resultat)
    verifier("depuisClaude (result) sur les deux pages", bool(r1 and r2))
    print("   résultat :", json.loads(r1).get("result") if r1 else None)

    print("3. question relayée (AskUserQuestion)")
    m.page("c1", {"type": "versClaude", "ligne": ligne_user(
        "Utilise tout de suite l'outil AskUserQuestion pour me demander si je préfère rouge ou bleu "
        "(question 'Couleur ?', options Rouge et Bleu). Rien d'autre.")})
    est_demande = lambda a: isinstance(a, str) and '"can_use_tool"' in a and a.startswith('{"type":"control_request"')
    q1, q2 = m.appel("c1", "depuisClaude", est_demande, 90), g.appel("c2", "depuisClaude", est_demande, 10)
    if verifier("demande can_use_tool sur les deux pages", bool(q1 and q2)):
        req = json.loads(q1)
        rid, entree = req["request_id"], req["request"].get("input") or {}
        print("   outil :", req["request"].get("tool_name"))
        # une troisième page arrive pendant la question : elle la retrouve dans info.direct.enAttente
        t = Client("gtk")
        t.envoyer({"op": "attacher", "sessionId": sid, "canal": "c3"})
        t.page("c3", {"type": "pret"})
        i = t.appel("c3", "info", delai=10)
        verifier("info.direct.enAttente pour une page arrivée en cours", bool(i) and len((i.get("direct") or {}).get("enAttente") or []) == 1,
                 str(i.get("direct") if i else None)[:300])
        t.envoyer({"op": "detacher", "canal": "c3"})
        for c, k in ((m, "c1"), (g, "c2")):
            c.page(k, {"type": "question", "id": "qtest-p", "typeQuestion": "choix", "texte": "Couleur ?", "options": ["Rouge", "Bleu"]})
            c.page(k, {"type": "etat", "etat": "attend"})
        rep = {"type": "control_response", "response": {"subtype": "success", "request_id": rid, "response": {
            "behavior": "allow", "updatedInput": dict(entree, answers={"Couleur ?": "Rouge"})}}}
        g.page("c2", {"type": "versClaude", "ligne": json.dumps(rep)})
        g.page("c2", {"type": "questionClose", "id": "qtest-p", "reponse": ["Rouge"]})
        x = m.appel("c1", "reponseExterne", delai=10)
        verifier("reponseExterne vers l'autre page (source victus)", bool(x) and x.get("source") == "victus" and x.get("reponse") == ["Rouge"], str(x))
        m.page("c1", {"type": "versClaude", "ligne": json.dumps(rep)})        # la page mac répond aussi : doublon jeté
        m.page("c1", {"type": "questionClose", "id": "qtest-p", "reponse": ["Rouge"]})
        verifier("pas de reponseExterne en retour", g.appel("c2", "reponseExterne", delai=2) is None)
        r = m.appel("c1", "depuisClaude", resultat, 90)
        verifier("tour terminé après la réponse", bool(r))
        if r:
            print("   résultat :", json.loads(r).get("result"))
        time.sleep(0.5)
        log = open(os.path.join(TEST, "moteur.log"), encoding="utf-8").read()
        verifier("réponse en double jetée", f"réponse en double à {rid}" in log)

    print("4. etat, relancer (modèle + effort)")
    m.page("c1", {"type": "etat", "etat": "pret", "resume": "Essai du démon"})
    time.sleep(0.5)
    s = session(a, sid)
    verifier("etat + resume dans la liste", s and s["resume"] == "Essai du démon" and s["etat"] == "pret", str(s))
    avant = pids_claude(sid)
    m.page("c1", {"type": "relancer", "modele": "haiku", "effort": "low"})
    i = g.appel("c2", "info", lambda a: a.get("effort") == "low", 20)
    apres = pids_claude(sid)
    verifier("relance : info poussée, nouveau processus --resume", bool(i) and apres and set(apres).isdisjoint(avant)
             and i.get("modele") == "haiku", f"{avant} → {apres}")
    verifier("pas de fin pendant la relance", g.attendre(lambda x: x.get("f") == "fin", 1) is None)

    print("5. ceder, reprendreIci")
    m.oublier(); g.oublier()
    a.envoyer({"op": "ceder", "sessionId": sid, "req": "r5"})
    f1, f2 = m.appel("c1", "fin", delai=15), g.appel("c2", "fin", delai=5)
    verifier("fin {raison: terminal} sur les deux pages", bool(f1 and f2) and f1.get("raison") == "terminal", f"{f1} {f2}")
    c = a.attendre(lambda o: o.get("ev") == "cede", 5)
    verifier("cede (pour le client qui ouvre le terminal)", bool(c) and c.get("reprise") is True, str(c))
    time.sleep(0.5)
    verifier("processus arrêté", not pids_claude(sid))
    s = session(a, sid)
    verifier("dansTerminal dans la liste", s and s["dansTerminal"] is True and s["etat"] == "termine", str(s))
    m.page("c1", {"type": "versClaude", "ligne": ligne_user("ne doit pas partir")})
    verifier("versClaude refusé pendant le terminal", m.appel("c1", "stderr", delai=3) is not None)
    m.page("c1", {"type": "reprendreIci"})
    rc = m.attendre(lambda o: o.get("ev") == "recharger", 30)
    verifier("reprendreIci : recharger + processus relancé", bool(rc) and len(pids_claude(sid)) == 1)
    m.oublier()
    m.page("c1", {"type": "pret"})
    i = m.appel("c1", "info", delai=10)
    verifier("après reprise : info sans dansTerminal, avec direct", bool(i) and not i.get("dansTerminal") and "direct" in i, str(i)[:200])
    m.appel("c1", "historique", delai=10)

    print("6. redémarrage du démon : la session continue")
    pid_avant = pids_claude(sid)
    d.arreter()
    time.sleep(0.5)
    verifier("claude toujours vivant après l'arrêt du démon", pids_claude(sid) == pid_avant, str(pids_claude(sid)))
    d.lancer()
    a, m = Client("cli"), Client("mac")
    s = session(a, sid)
    verifier("session retrouvée, processus actif", s and s.get("enCours") is True, str(s))
    m.envoyer({"op": "attacher", "sessionId": sid, "canal": "c1"})
    m.page("c1", {"type": "pret"})
    i = m.appel("c1", "info", delai=10)
    verifier("info.direct après redémarrage", bool(i) and "direct" in i)
    m.appel("c1", "historique", delai=10)
    m.page("c1", {"type": "versClaude", "ligne": ligne_user("Réponds seulement le mot : trois")})
    r = m.appel("c1", "depuisClaude", resultat, 90)
    verifier("tour après redémarrage", bool(r))
    if r:
        print("   résultat :", json.loads(r).get("result"))

    print("7. démon arrêté + claude terminé pendant ce temps : reprise --resume au retour")
    d.arreter()
    for p in pids_claude(sid):
        os.kill(p, signal.SIGTERM)
    time.sleep(2)
    d.lancer()
    a, m = Client("cli"), Client("mac")
    time.sleep(0.5)
    s = session(a, sid)
    verifier("session « termine » après redémarrage", s and s["etat"] == "termine" and not s.get("enCours"), str(s))
    m.envoyer({"op": "attacher", "sessionId": sid, "canal": "c1"})
    m.page("c1", {"type": "pret"})
    i = m.appel("c1", "info", delai=10)
    h = m.appel("c1", "historique", delai=10)
    verifier("pret sur session terminée : info + historique + fin", bool(i) and isinstance(h, list) and len(h) > 4
             and m.appel("c1", "fin", delai=5) is not None)
    m.page("c1", {"type": "versClaude", "ligne": ligne_user("Quel mot as-tu répondu en dernier ? Un seul mot.")})
    time.sleep(3)
    verifier("message → relancée avec --resume", any("--resume" in open(f"/proc/{p}/cmdline").read().replace("\0", " ")
                                                      for p in pids_claude(sid)))
    r = m.appel("c1", "depuisClaude", resultat, 90)
    verifier("la conversation continue (mémoire)", bool(r) and "trois" in (json.loads(r).get("result") or "").lower(),
             json.loads(r).get("result") if r else "")

    print("8. envoyer (op Jarvis), dossiers, fermer")
    a.envoyer({"op": "envoyer", "sessionId": sid, "texte": "Réponds seulement le mot : quatre", "req": "r8"})
    verifier("envoyer accepté", (a.attendre(lambda o: o.get("ev") == "envoye", 5) or {}).get("ok") is True)
    t = m.appel("c1", "texteAEnvoyer", delai=5)
    verifier("texteAEnvoyer confié à la page", bool(t) and t.get("source") == "jarvis", str(t))
    r = m.appel("c1", "depuisClaude", resultat, 90)       # la page de l'essai ne l'envoie pas : repli direct à 4 s
    verifier("repli : texte écrit directement", bool(r) and "quatre" in (json.loads(r).get("result") or "").lower())
    a.envoyer({"op": "dossiers", "req": "r9"})
    o = a.attendre(lambda o: o.get("ev") == "dossiers", 10)
    verifier("dossiers", bool(o) and any(x["cwd"] == CWD for x in o["liste"]), str(o)[:300])
    a.envoyer({"op": "fermer", "sessionId": sid, "req": "r10"})
    verifier("fin {raison: fermee} sur la page", (m.appel("c1", "fin", delai=10) or {}).get("raison") == "fermee")
    time.sleep(6)
    verifier("processus arrêté après fermer", not pids_claude(sid))
    verifier("session retirée de la liste", session(a, sid) is None)
    d.arreter()
    print(f"\n{len(ok_total)} OK, {len(ko_total)} KO" + (f" : {ko_total}" if ko_total else ""))
    sys.exit(1 if ko_total else 0)


if __name__ == "__main__":
    main()
