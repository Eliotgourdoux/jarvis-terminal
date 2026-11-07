#!/usr/bin/env python3
"""Banc d'essai stream-json pour Better Terminal For Claude (agent B).

Lance le vrai binaire claude en mode stream-json (entrée et sortie), joue des
scénarios courts et enregistre tout :
  fixtures/<nom>.jsonl         lignes brutes du stdout de claude
  fixtures/<nom>.entree.jsonl  lignes écrites sur le stdin de claude
  moteur/journal/<nom>.stderr  stderr brut

Usage : python3 -I moteur/essai.py <scenario> [<scenario> ...]
        python3 -I moteur/essai.py liste

Bibliothèque standard uniquement. Chaque processus reçoit BT_TEST=1 et tourne
avec cwd = moteur/bac-a-sable/.
"""

import json
import os
import queue
import subprocess
import sys
import threading
import time
import uuid

ICI = os.path.dirname(os.path.abspath(__file__))
RACINE = os.path.dirname(ICI)
BAC = os.path.join(ICI, "bac-a-sable")
FIXTURES = os.path.join(RACINE, "fixtures")
JOURNAL = os.path.join(ICI, "journal")
CLAUDE = os.path.expanduser("~/.local/bin/claude")

MODELE_ECO = "haiku"


def env_propre():
    """Environnement d'un processus lancé par l'app : sans les variables de la
    session Claude Code parente (sinon le fils croit être un sous-processus)."""
    env = {}
    for k, v in os.environ.items():
        if k.startswith("CLAUDE") or k in ("AI_AGENT",):
            continue
        env[k] = v
    env["BT_TEST"] = "1"
    return env


def arguments(modele=MODELE_ECO, bypass=False, partiels=True, stdio_perm=True,
              session_id=None, reprise=None, effort=None, extra=None):
    args = [CLAUDE,
            "--output-format", "stream-json",
            "--input-format", "stream-json",
            "--verbose"]
    if partiels:
        args.append("--include-partial-messages")
    if stdio_perm:
        args.append("--permission-prompt-tool=stdio")
    if bypass:
        args.append("--dangerously-skip-permissions")
    if modele:
        args += ["--model", modele]
    if effort:
        args += ["--effort", effort]
    if session_id:
        args += ["--session-id", session_id]
    if reprise:
        args += ["--resume", reprise]
    if extra:
        args += list(extra)
    return args


class Session:
    def __init__(self, nom, args, enregistrer=True):
        os.makedirs(FIXTURES, exist_ok=True)
        os.makedirs(JOURNAL, exist_ok=True)
        os.makedirs(BAC, exist_ok=True)
        self.nom = nom
        self.args = args
        self.t0 = time.time()
        self.lignes = []          # (t, obj) tout ce qui est sorti
        self.q = queue.Queue()
        self.n_req = 0
        self.gestionnaire_perm = None   # fonction(req) -> dict response, ou None
        self.perm_vues = []
        if enregistrer:
            self.f_out = open(os.path.join(FIXTURES, nom + ".jsonl"), "w")
            self.f_in = open(os.path.join(FIXTURES, nom + ".entree.jsonl"), "w")
        else:
            self.f_out = open(os.path.join(JOURNAL, nom + ".jsonl"), "w")
            self.f_in = open(os.path.join(JOURNAL, nom + ".entree.jsonl"), "w")
        self.f_err = open(os.path.join(JOURNAL, nom + ".stderr"), "w")
        with open(os.path.join(JOURNAL, nom + ".commande.json"), "w") as f:
            json.dump(args, f, indent=1)
        self.p = subprocess.Popen(args, cwd=BAC, env=env_propre(),
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, bufsize=1)
        threading.Thread(target=self._lire, daemon=True).start()
        threading.Thread(target=self._lire_err, daemon=True).start()

    def log(self, *a):
        print(f"[{self.nom} +{time.time() - self.t0:5.1f}s]", *a, flush=True)

    def _lire_err(self):
        for l in self.p.stderr:
            self.f_err.write(l)
            self.f_err.flush()

    def _lire(self):
        for l in self.p.stdout:
            l = l.rstrip("\n")
            if not l:
                continue
            self.f_out.write(l + "\n")
            self.f_out.flush()
            try:
                o = json.loads(l)
            except Exception:
                o = {"type": "_non_json", "texte": l}
            self.lignes.append((time.time(), o))
            if o.get("type") == "control_request" and \
                    o.get("request", {}).get("subtype") == "can_use_tool":
                self.perm_vues.append(o)
                if self.gestionnaire_perm:
                    rep = self.gestionnaire_perm(o)
                    if rep is not None:
                        self.repondre(o["request_id"], rep)
            self.q.put(o)
        self.q.put(None)

    def ecrire(self, obj):
        l = json.dumps(obj, ensure_ascii=False)
        self.f_in.write(l + "\n")
        self.f_in.flush()
        self.p.stdin.write(l + "\n")
        self.p.stdin.flush()

    def envoyer(self, texte):
        self.log("→ user:", texte[:80])
        self.ecrire({"type": "user", "session_id": "",
                     "message": {"role": "user",
                                 "content": [{"type": "text", "text": texte}]},
                     "parent_tool_use_id": None})

    def controle(self, subtype, **champs):
        self.n_req += 1
        rid = f"bt-{self.n_req}-{uuid.uuid4().hex[:6]}"
        req = {"subtype": subtype}
        req.update(champs)
        self.log("→ control_request", subtype, champs)
        self.ecrire({"type": "control_request", "request_id": rid, "request": req})
        return rid

    def repondre(self, request_id, reponse, erreur=None):
        if erreur:
            r = {"subtype": "error", "request_id": request_id, "error": erreur}
        else:
            r = {"subtype": "success", "request_id": request_id, "response": reponse}
        self.log("→ control_response", json.dumps(reponse, ensure_ascii=False)[:160])
        self.ecrire({"type": "control_response", "response": r})

    def attendre(self, pred, delai=90, quoi=""):
        fin = time.time() + delai
        while True:
            reste = fin - time.time()
            if reste <= 0:
                self.log("!! DÉLAI dépassé en attendant", quoi)
                return None
            try:
                o = self.q.get(timeout=reste)
            except queue.Empty:
                self.log("!! DÉLAI dépassé en attendant", quoi)
                return None
            if o is None:
                self.log("!! processus terminé en attendant", quoi)
                return None
            if pred(o):
                return o

    def attendre_resultat(self, delai=120):
        o = self.attendre(lambda o: o.get("type") == "result", delai, "result")
        if o:
            self.log("← result", o.get("subtype"), "is_error=", o.get("is_error"),
                     "|", str(o.get("result"))[:200].replace("\n", " "))
        return o

    def attendre_controle(self, rid, delai=30):
        o = self.attendre(lambda o: o.get("type") == "control_response" and
                          o.get("response", {}).get("request_id") == rid, delai,
                          "control_response " + rid)
        if o:
            self.log("← control_response", json.dumps(o["response"], ensure_ascii=False)[:300])
        return o

    def fermer(self, delai=15):
        try:
            self.p.stdin.close()
        except Exception:
            pass
        try:
            code = self.p.wait(timeout=delai)
        except subprocess.TimeoutExpired:
            self.log("!! ne s'arrête pas après fermeture de stdin, SIGTERM")
            self.p.terminate()
            code = self.p.wait(timeout=10)
        time.sleep(0.2)
        self.log("processus terminé, code", code)
        self.f_out.close()
        self.f_in.close()
        self.f_err.close()
        return code

    def types(self):
        vus = {}
        for _, o in self.lignes:
            k = o.get("type")
            if o.get("subtype"):
                k += "/" + o["subtype"]
            if k == "stream_event":
                k += "/" + o.get("event", {}).get("type", "?")
            vus[k] = vus.get(k, 0) + 1
        return vus

    def init(self):
        for _, o in self.lignes:
            if o.get("type") == "system" and o.get("subtype") == "init":
                return o
        return None


# ---------------------------------------------------------------- scénarios

SCENARIOS = {}


def scenario(f):
    SCENARIOS[f.__name__] = f
    return f


@scenario
def flux():
    """1. un message, deltas partiels, résultat final."""
    s = Session("flux", arguments())
    s.envoyer("Réponds juste : bonjour en trois langues, une par ligne.")
    s.attendre_resultat(60)
    s.fermer()
    s.log("types vus :", s.types())


@scenario
def markdown_riche():
    s = Session("markdown-riche", arguments(modele="sonnet", bypass=True))
    s.envoyer(
        "Sans utiliser aucun outil, écris une courte fiche markdown d'exemple en français "
        "sur « lancer un script ». Elle doit contenir exactement : un titre h1, un h2, un h3, "
        "du **gras**, de l'*italique*, une liste à puces, une liste numérotée, un bloc de code "
        "```bash (3 lignes), un bloc de code ```swift (5 lignes), un tableau de 3 colonnes et "
        "3 lignes, du `code en ligne`, une citation (>), et un lien https://example.com. "
        "Pas d'introduction ni de conclusion.")
    s.attendre_resultat(120)
    s.fermer()
    s.log("types vus :", s.types())


@scenario
def outils():
    s = Session("outils", arguments(bypass=True))
    with open(os.path.join(BAC, "lisez-moi.txt"), "w") as f:
        f.write("Fichier de test du bac à sable.\nLigne 2 : pomme, poire.\n")
    s.envoyer(
        "Dans le dossier courant, fais exactement ceci, dans l'ordre, un outil à la fois : "
        "1) lis lisez-moi.txt avec l'outil Read ; 2) lance la commande Bash `ls -la && echo fini` ; "
        "3) crée notes.md avec l'outil Write contenant '# Notes\\n\\n- un\\n' ; "
        "4) avec l'outil Edit, remplace '- un' par '- un\\n- deux' dans notes.md. "
        "Puis résume en une phrase.")
    s.attendre_resultat(120)
    s.fermer()
    s.log("types vus :", s.types())


@scenario
def permission():
    """3. sans bypass : demande de permission, autoriser puis refuser."""
    for f in ("autorise.txt", "refuse.txt"):
        p = os.path.join(BAC, f)
        if os.path.exists(p):
            os.remove(p)
    s = Session("permission", arguments(bypass=False))
    decisions = []

    def g(req):
        r = req["request"]
        s.log("← can_use_tool", r.get("tool_name"), json.dumps(r.get("input"), ensure_ascii=False)[:150])
        chemin = str(r.get("input", {}).get("file_path", ""))
        if chemin.endswith("refuse.txt"):
            decisions.append("deny")
            return {"behavior": "deny", "message": "Eliot a refusé la création de ce fichier.",
                    "toolUseID": r.get("tool_use_id")}
        decisions.append("allow")
        return {"behavior": "allow", "updatedInput": r.get("input", {}),
                "toolUseID": r.get("tool_use_id")}

    s.gestionnaire_perm = g
    s.envoyer("Crée le fichier autorise.txt dans le dossier courant avec l'outil Write, contenu : ok. Rien d'autre.")
    s.attendre_resultat(90)
    s.envoyer("Maintenant crée refuse.txt avec l'outil Write, contenu : non. Si c'est refusé, n'insiste pas et dis-le.")
    s.attendre_resultat(90)
    s.fermer()
    s.log("décisions :", decisions)
    s.log("autorise.txt existe :", os.path.exists(os.path.join(BAC, "autorise.txt")))
    s.log("refuse.txt existe :", os.path.exists(os.path.join(BAC, "refuse.txt")))
    s.log("types vus :", s.types())


@scenario
def permission_bypass():
    """3b. avec bypass : que remonte-t-il encore ?"""
    s = Session("permission-bypass", arguments(bypass=True), enregistrer=False)
    s.gestionnaire_perm = lambda req: (s.log("← can_use_tool (bypass)", req["request"].get("tool_name")),
                                       {"behavior": "allow", "updatedInput": req["request"].get("input", {})})[1]
    s.envoyer("Crée bypass.txt dans le dossier courant avec l'outil Write (contenu : b), puis lance "
              "la commande Bash `cat bypass.txt`. Réponds en une phrase.")
    s.attendre_resultat(90)
    s.fermer()
    s.log("can_use_tool reçus en bypass :", [p["request"].get("tool_name") for p in s.perm_vues])
    s.log("init.permissionMode =", (s.init() or {}).get("permissionMode"))


def _question(nom, bypass, enregistrer):
    s = Session(nom, arguments(bypass=bypass), enregistrer=enregistrer)
    recu = {}

    def g(req):
        r = req["request"]
        s.log("← can_use_tool", r.get("tool_name"))
        if r.get("tool_name") == "AskUserQuestion":
            qs = r["input"]["questions"]
            reponses = {}
            for q in qs:
                labels = [o["label"] for o in q["options"]]
                if q.get("multiSelect"):
                    reponses[q["question"]] = ", ".join(labels[:2])
                else:
                    reponses[q["question"]] = labels[-1]
            recu["questions"] = qs
            recu["reponses"] = reponses
            return {"behavior": "allow",
                    "updatedInput": {"questions": qs, "answers": reponses},
                    "toolUseID": r.get("tool_use_id")}
        return {"behavior": "allow", "updatedInput": r.get("input", {})}

    s.gestionnaire_perm = g
    s.envoyer(
        "Utilise l'outil AskUserQuestion UNE seule fois avec deux questions : "
        "Q1 (choix unique, multiSelect false) « Quel fruit préférez-vous ? » options Pomme, Poire, Kiwi ; "
        "Q2 (choix multiple, multiSelect true) « Quelles couleurs aimez-vous ? » options Rouge, Vert, Bleu. "
        "Ensuite, répète mot pour mot les réponses reçues, au format : FRUIT=<...> ; COULEURS=<...>.")
    res = s.attendre_resultat(120)
    s.fermer()
    s.log("réponses envoyées :", recu.get("reponses"))
    s.log("questions reçues via can_use_tool :", bool(recu))
    s.log("types vus :", s.types())
    return s, res


@scenario
def question():
    _question("question", bypass=False, enregistrer=True)


@scenario
def question_bypass():
    _question("question-bypass", bypass=True, enregistrer=False)


@scenario
def multi_tours():
    """2. plusieurs tours, message envoyé pendant le travail, interruption."""
    s = Session("multi-tours", arguments(bypass=True))
    s.envoyer("Retiens le mot de passe fictif : CITRON. Réponds juste 'noté'.")
    s.attendre_resultat(60)
    s.envoyer("Quel mot t'ai-je demandé de retenir ? Un mot.")
    s.attendre_resultat(60)
    # message pendant que Claude travaille
    s.envoyer("Lance la commande Bash `sleep 6 && echo lent-fini` puis dis 'premier fini'.")
    s.attendre(lambda o: o.get("type") == "assistant" and any(
        c.get("type") == "tool_use" for c in o["message"].get("content", [])), 60, "tool_use")
    s.envoyer("Message envoyé pendant le travail : après ça, dis aussi 'deuxième reçu'.")
    r1 = s.attendre_resultat(90)
    # selon le CLI, le second message peut produire un second result
    r2 = s.attendre_resultat(30)
    # interruption
    s.envoyer("Lance la commande Bash `sleep 30 && echo jamais` puis dis 'trop tard'.")
    s.attendre(lambda o: o.get("type") == "assistant" and any(
        c.get("type") == "tool_use" for c in o["message"].get("content", [])), 60, "tool_use 2")
    time.sleep(1.5)
    rid = s.controle("interrupt")
    s.attendre_controle(rid, 15)
    r3 = s.attendre_resultat(30)
    s.envoyer("Après l'interruption, réponds juste 'toujours là'.")
    r4 = s.attendre_resultat(60)
    s.fermer()
    s.log("types vus :", s.types())


@scenario
def modele():
    """5. changement de modèle en cours de session."""
    s = Session("modele", arguments(modele="haiku", bypass=True), enregistrer=False)
    s.envoyer("Réponds juste 'un'.")
    s.attendre_resultat(60)
    rid = s.controle("set_model", model="sonnet")
    s.attendre_controle(rid)
    s.envoyer("Réponds juste 'deux'.")
    s.attendre_resultat(60)
    s.fermer()
    for _, o in s.lignes:
        if o.get("type") == "assistant":
            s.log("assistant.message.model =", o["message"].get("model"))
        if o.get("type") == "result":
            s.log("result.modelUsage =", list((o.get("modelUsage") or {}).keys()))


@scenario
def effort():
    """6. changement d'effort en cours de session."""
    s = Session("effort", arguments(modele="sonnet", bypass=True, effort="low"), enregistrer=False)
    s.envoyer("Lance la commande Bash `echo effort=$CLAUDE_EFFORT` et recopie la sortie exacte.")
    s.attendre_resultat(60)
    rid = s.controle("apply_flag_settings", settings={"effortLevel": "high"})
    s.attendre_controle(rid)
    s.envoyer("Relance la commande Bash `echo effort=$CLAUDE_EFFORT` et recopie la sortie exacte.")
    s.attendre_resultat(60)
    rid = s.controle("set_max_thinking_tokens", max_thinking_tokens=2048)
    s.attendre_controle(rid)
    s.envoyer("Réponds juste 'ok'.")
    s.attendre_resultat(60)
    s.fermer()


@scenario
def reprise():
    """7. session imposée, reprise en -p, reprise en stream-json."""
    sid = str(uuid.uuid4())
    s = Session("reprise", arguments(bypass=True, session_id=sid), enregistrer=False)
    s.envoyer("Retiens le code fictif ZEBRE-42. Réponds juste 'noté'.")
    s.attendre_resultat(60)
    s.fermer()
    s.log("session_id imposé :", sid, "| init.session_id =", (s.init() or {}).get("session_id"))
    out = subprocess.run([CLAUDE, "-p", "--model", MODELE_ECO, "--resume", sid,
                          "Quel code t'ai-je demandé de retenir ? Juste le code."],
                         cwd=BAC, env=env_propre(), capture_output=True, text=True, timeout=90)
    s.log("claude -p --resume →", out.stdout.strip()[:200], "| code", out.returncode)
    s2 = Session("reprise-stream", arguments(bypass=True, reprise=sid), enregistrer=False)
    s2.envoyer("Rappelle-moi le code, et dis combien de fois je te l'ai demandé.")
    s2.attendre_resultat(60)
    s2.fermer()
    s2.log("init.session_id après --resume =", (s2.init() or {}).get("session_id"))
    with open(os.path.join(JOURNAL, "reprise.sid"), "w") as f:
        f.write(sid)


@scenario
def erreur():
    """Erreurs : modèle inconnu, puis outil qui échoue."""
    s = Session("erreur", arguments(modele="modele-qui-n-existe-pas", bypass=True))
    s.envoyer("Réponds juste 'ok'.")
    s.attendre_resultat(60)
    s.fermer()
    s.log("types vus :", s.types())


@scenario
def erreur_outil():
    s = Session("erreur-outil", arguments(bypass=True), enregistrer=False)
    s.envoyer("Lis le fichier n-existe-pas.txt avec l'outil Read, puis lance la commande Bash "
              "`ls /dossier-inexistant`. Dis en une phrase ce qui s'est passé.")
    s.attendre_resultat(90)
    s.fermer()


@scenario
def slash():
    """10. commande slash envoyée comme texte."""
    s = Session("slash", arguments(bypass=True), enregistrer=False)
    s.envoyer("/context")
    s.attendre_resultat(60)
    s.envoyer("/cost")
    s.attendre_resultat(60)
    s.fermer()
    s.log("types vus :", s.types())


@scenario
def initialize():
    """Le control_request initialize que le SDK envoie : réponse ?"""
    s = Session("initialize", arguments(bypass=True), enregistrer=False)
    rid = s.controle("initialize", hooks=None)
    s.attendre_controle(rid, 30)
    s.envoyer("Réponds juste 'ok'.")
    s.attendre_resultat(60)
    s.fermer()


@scenario
def silence():
    """Démarrage : que sort-il avant le premier message ?"""
    s = Session("silence", arguments(bypass=True), enregistrer=False)
    time.sleep(5)
    s.log("lignes reçues avant tout envoi :", len(s.lignes), [o.get("type") + "/" + str(o.get("subtype")) for _, o in s.lignes])
    s.envoyer("Réponds juste 'ok'.")
    s.attendre_resultat(60)
    s.fermer()


@scenario
def sans_verbose():
    out = subprocess.run([CLAUDE, "--output-format", "stream-json", "--input-format", "stream-json"],
                         cwd=BAC, env=env_propre(), input="", capture_output=True, text=True, timeout=30)
    print("code", out.returncode, "| stdout", out.stdout[:300], "| stderr", out.stderr[:300])


@scenario
def nommage():
    """8. règle de nommage du dossier de transcript."""
    d = os.path.join(BAC, "Dossier test_é.v2 (x)")
    os.makedirs(d, exist_ok=True)
    sid = str(uuid.uuid4())
    out = subprocess.run([CLAUDE, "-p", "--model", MODELE_ECO, "--session-id", sid, "Réponds juste ok."],
                         cwd=d, env=env_propre(), capture_output=True, text=True, timeout=60)
    print("code", out.returncode)
    base = os.path.expanduser("~/.claude/projects")
    for n in os.listdir(base):
        if os.path.exists(os.path.join(base, n, sid + ".jsonl")):
            print("cwd     :", d)
            print("dossier :", n)


@scenario
def reflexion():
    """Texte de réflexion visible ?"""
    s = Session("reflexion", arguments(modele="sonnet", bypass=True, effort="high",
                                        extra=["--thinking-display", "summarized"]), enregistrer=False)
    s.envoyer("Réfléchis soigneusement avant de répondre (pas d'outil) : trouve le plus petit entier n > 1 tel que n² + n + 41 ne soit pas premier, et justifie en une ligne.")
    s.attendre_resultat(90)
    s.fermer()
    for _, o in s.lignes:
        if o.get("type") == "assistant":
            for c in o["message"]["content"]:
                if c.get("type") == "thinking":
                    s.log("thinking =", repr(c.get("thinking", ""))[:300])
        if o.get("type") == "stream_event" and o["event"].get("type") == "message_start":
            s.log("thinking_display =", o.get("thinking_display"))


@scenario
def reprise_inverse():
    """Session créée en -p (comme au terminal), reprise en stream-json."""
    sid = str(uuid.uuid4())
    out = subprocess.run([CLAUDE, "-p", "--model", MODELE_ECO, "--session-id", sid,
                          "Retiens le code fictif HIBOU-7. Réponds juste noté."],
                         cwd=BAC, env=env_propre(), capture_output=True, text=True, timeout=60)
    print("création -p : code", out.returncode)
    s = Session("reprise-inverse", arguments(bypass=True, reprise=sid), enregistrer=False)
    time.sleep(3)
    s.log("lignes avant envoi (historique rejoué ?) :", len(s.lignes))
    s.envoyer("Quel code t'ai-je demandé de retenir ? Juste le code.")
    s.attendre_resultat(60)
    s.fermer()
    s.log("init.session_id =", (s.init() or {}).get("session_id"), "attendu", sid)


@scenario
def mode_permission():
    """set_permission_mode en cours de session."""
    for f in ("mode1.txt", "mode2.txt"):
        p = os.path.join(BAC, f)
        if os.path.exists(p):
            os.remove(p)
    s = Session("mode-permission", arguments(bypass=False), enregistrer=False)
    s.gestionnaire_perm = lambda req: (s.log("← can_use_tool", req["request"].get("tool_name")),
                                       {"behavior": "allow", "updatedInput": req["request"].get("input", {})})[1]
    s.envoyer("Crée mode1.txt avec l'outil Write (contenu : 1). Rien d'autre.")
    s.attendre_resultat(60)
    n1 = len(s.perm_vues)
    rid = s.controle("set_permission_mode", mode="bypassPermissions")
    s.attendre_controle(rid)
    s.envoyer("Crée mode2.txt avec l'outil Write (contenu : 2). Rien d'autre.")
    s.attendre_resultat(60)
    s.fermer()
    s.log("permissions demandées avant/après passage en bypass :", n1, len(s.perm_vues) - n1)
    s.log("permissionMode des init :", [o.get("permissionMode") for _, o in s.lignes if o.get("subtype") == "init"])


@scenario
def mode_permission_allow():
    """Lancé avec --allow-dangerously-skip-permissions, puis passage en bypass."""
    s = Session("mode-permission-allow", arguments(bypass=False, extra=["--allow-dangerously-skip-permissions"]), enregistrer=False)
    s.gestionnaire_perm = lambda req: (s.log("← can_use_tool", req["request"].get("tool_name")),
                                       {"behavior": "allow", "updatedInput": req["request"].get("input", {})})[1]
    rid = s.controle("set_permission_mode", mode="bypassPermissions")
    s.attendre_controle(rid)
    s.envoyer("Crée mode3.txt avec l'outil Write (contenu : 3). Rien d'autre.")
    s.attendre_resultat(60)
    s.fermer()
    s.log("permissions demandées :", len(s.perm_vues))
    s.log("permissionMode des init :", [o.get("permissionMode") for _, o in s.lignes if o.get("subtype") == "init"])


@scenario
def question_variantes():
    """AskUserQuestion : refus, puis réponse en texte libre."""
    s = Session("question-variantes", arguments(bypass=True), enregistrer=False)
    etape = {"n": 0}

    def g(req):
        r = req["request"]
        if r.get("tool_name") != "AskUserQuestion":
            return {"behavior": "allow", "updatedInput": r.get("input", {})}
        etape["n"] += 1
        qs = r["input"]["questions"]
        if etape["n"] == 1:
            return {"behavior": "deny", "message": "Eliot a fermé la question sans répondre.",
                    "toolUseID": r.get("tool_use_id")}
        return {"behavior": "allow", "updatedInput": {"questions": qs,
                "answers": {qs[0]["question"]: "Aucun : je préfère la mangue"}},
                "toolUseID": r.get("tool_use_id")}

    s.gestionnaire_perm = g
    s.envoyer("Utilise AskUserQuestion pour me demander mon fruit préféré (options Pomme, Poire). "
              "Si la question est refusée, dis REFUS et arrête-toi.")
    s.attendre_resultat(60)
    s.envoyer("Repose la même question avec AskUserQuestion, puis recopie exactement ma réponse.")
    s.attendre_resultat(60)
    s.fermer()


@scenario
def rejeu():
    """--replay-user-messages : écho des messages envoyés ?"""
    s = Session("rejeu", arguments(bypass=True, extra=["--replay-user-messages"]), enregistrer=False)
    s.envoyer("Réponds juste 'ok'.")
    s.attendre_resultat(60)
    s.fermer()
    s.log("lignes user :", [json.dumps(o, ensure_ascii=False)[:200] for _, o in s.lignes if o.get("type") == "user"])


@scenario
def markdown_riche_propre():
    """Même demande, hooks désactivés (état cible quand le hook MessageDisplay ignore BT_APP)."""
    s = Session("markdown-riche-propre", arguments(modele="sonnet", bypass=True,
                extra=["--settings", '{"disableAllHooks": true}']))
    s.envoyer(
        "Sans utiliser aucun outil, écris une courte fiche markdown d'exemple en français "
        "sur « lancer un script ». Elle doit contenir exactement : un titre h1, un h2, un h3, "
        "du **gras**, de l'*italique*, une liste à puces, une liste numérotée, un bloc de code "
        "```bash (3 lignes), un bloc de code ```swift (5 lignes), un tableau de 3 colonnes avec "
        "une ligne d'en-tête et 3 lignes de données, du `code en ligne`, une citation (>), et un lien https://example.com. "
        "Pas d'introduction ni de conclusion.")
    s.attendre_resultat(120)
    s.fermer()


@scenario
def sous_agent():
    """Messages d'un sous-agent (parent_tool_use_id non nul)."""
    s = Session("sous-agent", arguments(bypass=True), enregistrer=False)
    s.envoyer("Utilise l'outil Agent (sous-agent general-purpose, modèle haiku) pour lister les fichiers "
              "du dossier courant avec Bash `ls`, puis donne la liste en une ligne.")
    s.attendre_resultat(120)
    s.fermer()
    for _, o in s.lignes:
        if o.get("parent_tool_use_id"):
            s.log("ligne de sous-agent :", o.get("type"), (o.get("event") or {}).get("type", ""),
                  json.dumps(o, ensure_ascii=False)[:160])
    s.log("types vus :", s.types())


@scenario
def fermeture_pendant():
    """Fermer stdin pendant que Claude travaille : le tour va-t-il au bout ?"""
    s = Session("fermeture-pendant", arguments(bypass=True), enregistrer=False)
    s.envoyer("Lance la commande Bash `sleep 4; echo fini-quand-meme` puis dis 'termine'.")
    s.attendre(lambda o: o.get("type") == "assistant" and any(
        c.get("type") == "tool_use" for c in o["message"].get("content", [])), 60, "tool_use")
    s.log("fermeture de stdin pendant l'outil")
    t = time.time()
    code = s.fermer(delai=40)
    s.log("sortie après", round(time.time() - t, 1), "s ; result reçu :",
          [o.get("subtype") for _, o in s.lignes if o.get("type") == "result"])


@scenario
def attente_longue():
    """Permission et question laissées sans réponse 150 s : délai côté claude ?"""
    s = Session("attente-longue", arguments(bypass=True), enregistrer=False)
    s.envoyer("Utilise AskUserQuestion pour me demander : « Thé ou café ? » (options Thé, Café). Puis recopie ma réponse.")
    req = s.attendre(lambda o: o.get("type") == "control_request", 60, "question")
    s.log("question reçue, j'attends 150 s sans répondre")
    n0 = len(s.lignes)
    time.sleep(150)
    pendant = [o for _, o in s.lignes[n0:]]
    s.log("lignes reçues pendant l'attente :", [(o.get("type"), o.get("subtype") or (o.get("event") or {}).get("type")) for o in pendant])
    s.log("processus vivant :", s.p.poll() is None)
    r = req["request"]
    s.repondre(req["request_id"], {"behavior": "allow", "updatedInput": {
        "questions": r["input"]["questions"], "answers": {r["input"]["questions"][0]["question"]: "Café"}},
        "toolUseID": r.get("tool_use_id")})
    s.attendre_resultat(60)
    s.fermer()


@scenario
def liste():
    for k, f in SCENARIOS.items():
        print(k, "-", (f.__doc__ or "").strip().splitlines()[0] if f.__doc__ else "")


if __name__ == "__main__":
    noms = sys.argv[1:] or ["liste"]
    for n in noms:
        n = n.replace("-", "_")
        if n not in SCENARIOS:
            print("scénario inconnu :", n)
            sys.exit(2)
        SCENARIOS[n]()
