#!/usr/bin/env python3
"""ultron-moteur : le démon d'Ultron Terminal sur le Victus (Linux). Il possède les sessions Claude Code.

Spécification : victus/CONTRAT-VICTUS.md (section « Protocole du démon ») et CONTRAT.md (pont page ↔ coque).
Il reprend pour ses sessions le rôle de app/Sources/Session.swift et ClaudeArgs.swift : lancement de claude en
stream-json, file d'appels vers les pages, `pret` → `info` (+ `direct`) puis `historique`, `versClaude`,
`relancer`, `etat`, `question`/`questionClose`, `reprendreIci`, `fermer`, `fin`.

Chaque processus claude est tenu par un « porteur » (porteur.py) : le démon peut redémarrer (déploiement,
plantage) sans tuer les sessions, il se reconnecte aux porteurs au démarrage.

Bibliothèque standard uniquement. Variables d'environnement (tests) :
  ULTRON_SOCK      socket des clients (défaut $XDG_RUNTIME_DIR/ultron-terminal.sock)
  ULTRON_ETAT      dossier d'état (défaut ~/.config/ultron-terminal)
  ULTRON_PORTEURS  sockets des porteurs (défaut <dossier de ULTRON_SOCK>/ultron-porteurs)
  ULTRON_CLAUDE    binaire claude (défaut ~/.local/bin/claude)
"""
import asyncio
import collections
import json
import os
import re
import secrets
import signal
import sys
import time
import uuid

VERSION = 1
VERSION_APP = "1.0"
MACHINE = "victus"
HOME = os.path.realpath(os.path.expanduser("~"))
RUNTIME = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
SOCK = os.environ.get("ULTRON_SOCK") or os.path.join(RUNTIME, "ultron-terminal.sock")
ETAT = os.environ.get("ULTRON_ETAT") or os.path.join(HOME, ".config", "ultron-terminal")
PORTEURS = os.environ.get("ULTRON_PORTEURS") or os.path.join(os.path.dirname(SOCK), "ultron-porteurs")
CLAUDE = os.environ.get("ULTRON_CLAUDE") or os.path.join(HOME, ".local", "bin", "claude")
PORTEUR_PY = os.path.join(os.path.dirname(os.path.realpath(__file__)), "porteur.py")
FICHIER_ETAT = os.path.join(ETAT, "sessions.json")
DISCUSSIONS = os.path.join(HOME, "Claude-Discussions")

LIGNE_MAX = 20 * 1024 * 1024        # une ligne reçue d'un client
TAMPON_CLIENT_MAX = 64 * 1024 * 1024  # au-delà, le client ne lit plus : déconnecté
LOT_MAX = 8 * 1024 * 1024            # un lot d'appels est envoyé sans attendre au-delà
HISTORIQUE_MAX = 18 * 1024 * 1024    # historique tronqué (lignes les plus anciennes) au-delà
REGROUPEMENT = 0.016                 # regroupement des appels vers une page
LISTE_INTERVALLE = 0.3
RECENTES_JOURS = 7
RECENTES_MAX = 40


def journal(m):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), m, file=sys.stderr, flush=True)


def extrait(s, n):
    s = str(s).replace("\n", " ")
    return s if len(s) <= n else s[:n] + "…"


def maintenant_ms():
    return int(time.time() * 1000)


# ---------------------------------------------------------------- validation (ClaudeArgs.swift, Validation)

EFFORTS = {"low", "medium", "high", "xhigh", "max"}
ETATS = {"travaille", "attend", "pret", "termine"}
TYPES_QUESTION = {"permission", "choix", "multi", "texte"}
RE_MODELE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,63}$")
RE_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
RE_ID_QUESTION = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
RE_CANAL = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
RE_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def modele_valide(s):
    return isinstance(s, str) and bool(RE_MODELE.match(s))


def effort_valide(s):
    return isinstance(s, str) and s in EFFORTS


def uuid_valide(s):
    return isinstance(s, str) and bool(RE_UUID.match(s))


def dossier_valide(brut):
    """Dossier existant sous le home, rendu canonique ; None sinon."""
    if not isinstance(brut, str) or not brut or len(brut) > 4096 or "\0" in brut:
        return None
    p = os.path.expanduser(brut)
    if not p.startswith("/"):
        return None
    p = os.path.realpath(p)
    if not os.path.isdir(p):
        return None
    if p != HOME and not p.startswith(HOME + "/"):
        return None
    return p


# ---------------------------------------------------------------- arguments de claude (ClaudeArgs.swift)

# Port au mot près de ClaudeArgs.consigneAffichage (app/Sources/ClaudeArgs.swift). Seules adaptations : l'app
# s'appelle Ultron Terminal et tourne sur le Victus (Linux), pas sur un Mac. Sur le Victus, ~/.claude/CLAUDE.md n'a
# pas la section « Jarvis Terminal » : cette consigne est la seule source de Claude pour les aperçus et les médias.
CONSIGNE_AFFICHAGE = (
    "Tu es affiché dans Ultron Terminal, une app Linux du Victus qui rend le markdown (titres, tableaux, listes, blocs de code). "
    "Quand un visuel apporte vraiment plus que du texte (graphe de données, diagramme, schéma, tableau de bord, maquette d'interface), "
    "tu peux l'afficher directement dans la conversation : "
    "un bloc ```mermaid devient un diagramme ; un bloc ```svg devient une image ; "
    "un bloc dont l'en-tête est exactement ```html apercu est rendu comme une page interactive (HTML, CSS et JavaScript autorisés). "
    "Un bloc ```html sans le mot apercu reste affiché comme du code : utilise-le pour montrer du code, pas pour un visuel. "
    "Dans un aperçu, Chart.js est disponible hors ligne avec <script src=\"chart.js\"></script> (et mermaid avec <script src=\"mermaid.js\"></script>) ; "
    "les CDN en https marchent aussi si le Victus est en ligne. L'aperçu est isolé : aucun accès aux fichiers locaux ni à l'app. "
    "Le fond est sombre (#0C0D10) et le texte clair : choisis des couleurs lisibles dessus (ex. Chart.defaults.color = '#ECECF1'). "
    "Mets tout dans un seul bloc autonome, sans fichier externe local. N'en abuse pas : un visuel seulement quand il aide à comprendre. "
    "Pour montrer des images, vidéos ou sons du Victus (rendus, captures, vocaux), écris simplement leur chemin absolu dans le texte, "
    "un par ligne et hors bloc de code : l'app affiche elle-même un lecteur (les vidéos d'un même message forment un mur, "
    "les photos d'un même message une galerie avec plein écran : cite-les toutes dans le même message ; les vocaux ogg et opus sont lus aussi). "
    "Jamais d'aperçu HTML ni de serveur http local pour ça : l'aperçu ne peut pas les lire. "
    "Au-dessus de la saisie, l'utilisateur voit deux listes numérotées : « Plan de Claude » (tes étapes TodoWrite, numérotées dans l'ordre) "
    "et « À toi » (la to-do du projet, numérotée dans l'ordre exact de `todo list <projet>`). "
    "Quand il parle de « la 3 » ou « la tâche 3 », lance `todo list <projet>` et prends la ligne 3, ou l'étape 3 de ton plan si le contexte l'indique."
)

BASE_ARGS = [
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompt-tool=stdio",
    "--dangerously-skip-permissions",
    "--thinking-display", "summarized",
    "--append-system-prompt", CONSIGNE_AFFICHAGE,
]


def arguments(session_id, reprise, modele, effort):
    a = list(BASE_ARGS)
    if modele_valide(modele):
        a += ["--model", modele]
    if effort_valide(effort):
        a += ["--effort", effort]
    a += ["--resume", session_id] if reprise else ["--session-id", session_id]
    return a


def message_utilisateur(texte):
    return json.dumps({"type": "user", "session_id": "",
                       "message": {"role": "user", "content": [{"type": "text", "text": texte}]},
                       "parent_tool_use_id": None}, ensure_ascii=False, separators=(",", ":"))


def interruption():
    return json.dumps({"type": "control_request", "request_id": "bt-arret-" + secrets.token_hex(4),
                       "request": {"subtype": "interrupt"}}, separators=(",", ":"))


def effort_reglages(cwd):
    for f in (os.path.join(cwd, ".claude", "settings.local.json"), os.path.join(cwd, ".claude", "settings.json"),
              os.path.join(HOME, ".claude", "settings.json")):
        try:
            with open(f, encoding="utf-8") as fh:
                e = json.load(fh).get("effortLevel")
            if effort_valide(e):
                return e
        except Exception:
            continue
    return None


# ---------------------------------------------------------------- environnement du shell de connexion

def a_retirer(k):
    if k == "CLAUDE_CONFIG_DIR":
        return False
    return (k.startswith("CLAUDE") or k in ("AI_AGENT", "TG_BOT_NAME", "BT_TEST", "BT_APP", "BT_MACHINE",
                                            "PWD", "OLDPWD", "SHLVL", "_", "INVOCATION_ID", "JOURNAL_STREAM",
                                            "NOTIFY_SOCKET", "MANAGERPID", "SYSTEMD_EXEC_PID")
            or k.startswith("ULTRON_"))


def propre(e):
    return {k: v for k, v in e.items() if not a_retirer(k)}


class Environnement:
    cache = None
    verrou = None

    @classmethod
    async def charger(cls):
        if cls.cache is not None:
            return cls.cache
        if cls.verrou is None:
            cls.verrou = asyncio.Lock()
        async with cls.verrou:
            if cls.cache is None:
                cls.cache = await cls._lire()
        return cls.cache

    @staticmethod
    async def _lire():
        base = propre(dict(os.environ))
        marque = "__BT_ENV__"
        zsh = next((z for z in ("/usr/bin/zsh", "/bin/zsh") if os.access(z, os.X_OK)), None)
        if zsh:
            for opts in ("-lic", "-lc"):
                try:
                    p = await asyncio.create_subprocess_exec(
                        zsh, opts, f"printf '{marque}\\0'; /usr/bin/env -0", env=base, cwd=HOME,
                        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.DEVNULL, start_new_session=True)
                    try:
                        out, _ = await asyncio.wait_for(p.communicate(), 8)
                    except asyncio.TimeoutError:
                        try:
                            os.killpg(p.pid, signal.SIGKILL)
                        except Exception:
                            pass
                        journal(f"environnement : zsh {opts} trop lent")
                        continue
                    s = out.decode("utf-8", "replace")
                    i = s.find(marque + "\0")
                    if i < 0:
                        continue
                    e = {}
                    for morceau in s[i + len(marque) + 1:].split("\0"):
                        if "=" in morceau:
                            k, v = morceau.split("=", 1)
                            e[k] = v
                    if not e.get("PATH"):
                        continue
                    journal(f"environnement : zsh {opts}, {len(e)} variables, PATH={extrait(e['PATH'], 200)}")
                    return propre(e)
                except Exception as x:
                    journal(f"environnement : zsh {opts} : {x}")
        e = dict(base)
        e["PATH"] = ":".join([HOME + "/.local/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])
        journal("environnement : repli sur l'environnement du démon + PATH standard")
        return e


# ---------------------------------------------------------------- transcripts et projets

def dossier_projet(cwd):
    """Règle de claude : chaque unité UTF-16 non alphanumérique ASCII du cwd devient « - »."""
    u = cwd.encode("utf-16-le")
    r = []
    for i in range(0, len(u), 2):
        c = u[i] | (u[i + 1] << 8)
        r.append(chr(c) if (48 <= c <= 57 or 65 <= c <= 90 or 97 <= c <= 122) else "-")
    return "".join(r)


def chemin_transcript(cwd, sid):
    racine = os.path.join(HOME, ".claude", "projects")
    direct = os.path.join(racine, dossier_projet(cwd), sid + ".jsonl")
    if os.path.isfile(direct):
        return direct
    try:
        for d in os.listdir(racine):
            p = os.path.join(racine, d, sid + ".jsonl")
            if os.path.isfile(p):
                return p
    except OSError:
        pass
    return None


def lignes_transcript(cwd, sid):
    p = chemin_transcript(cwd, sid)
    if not p:
        return []
    try:
        with open(p, "rb") as fh:
            d = fh.read()
    except OSError:
        return []
    lignes = [l.decode("utf-8", "replace") for l in d.split(b"\n") if l.strip()]
    lignes = [l for l in lignes if not l.startswith('{"type":"api-request')]
    total = sum(len(l) + 4 for l in lignes)
    if total > HISTORIQUE_MAX:
        i = 0
        while total > HISTORIQUE_MAX and i < len(lignes):
            total -= len(lignes[i]) + 4
            i += 1
        journal(f"historique {sid} : {i} lignes anciennes retirées (trop volumineux)")
        lignes = lignes[i:]
    return lignes


def info_projet(cwd):
    """(nom, emoji) : registre ~/.config/projets/registry.json s'il existe (comme sur le Mac), sinon le dossier."""
    if cwd == DISCUSSIONS:
        return "Discussion", "💬"
    defaut = ("Dossier personnel", "🏠") if cwd == HOME else (os.path.basename(cwd) or cwd, "📁")
    try:
        with open(os.path.join(HOME, ".config", "projets", "registry.json"), encoding="utf-8") as fh:
            liste = json.load(fh)
        projets = []
        for p in liste:
            c = p.get("chemin")
            if c:
                projets.append((os.path.realpath(os.path.expanduser(c)), p.get("nom") or "", p.get("emoji") or ""))
    except Exception:
        return defaut

    def vers(p):
        return (p[1] or defaut[0], p[2] or defaut[1])

    for p in projets:
        if p[0] == cwd:
            return vers(p)
    parents = {c for c, _, _ in projets if any(q.startswith(c + "/") for q, _, _ in projets)}
    cands = [p for p in projets if p[0] not in parents and cwd.startswith(p[0] + "/")]
    if cands:
        return vers(max(cands, key=lambda p: len(p[0])))
    return defaut


def cwd_du_dossier(d):
    """Le vrai cwd d'un dossier de ~/.claude/projects : lu dans le transcript le plus récent (champ cwd)."""
    try:
        fichiers = [os.path.join(d, f) for f in os.listdir(d) if f.endswith(".jsonl")]
    except OSError:
        return None, 0
    if not fichiers:
        return None, 0
    fichiers.sort(key=lambda f: os.path.getmtime(f), reverse=True)
    maj = os.path.getmtime(fichiers[0])
    for f in fichiers[:3]:
        try:
            with open(f, "rb") as fh:
                tete = fh.read(262144)
        except OSError:
            continue
        for l in tete.split(b"\n"):
            if b'"cwd"' not in l:
                continue
            try:
                c = json.loads(l).get("cwd")
            except Exception:
                continue
            if isinstance(c, str) and c:
                return c, maj
    # repli : décodage naïf (« - » → « / »), vérifié sur le disque
    naif = os.path.basename(d).replace("-", "/")
    return (naif if os.path.isdir(naif) else None), maj


def analyser(l):
    """Le strict nécessaire pour le démon (Session.analyser) ; None pour le flux de jetons et le reste."""
    if l.startswith('{"type":"stream_event"'):
        return None
    try:
        o = json.loads(l)
    except Exception:
        return None
    if not isinstance(o, dict):
        return None
    t = o.get("type")
    a = {}
    if t == "system":
        st = o.get("subtype")
        if st == "init":
            a["idInit"] = o.get("session_id")
        elif st == "status" and o.get("status") == "requesting":
            a["activite"] = True
        elif st == "session_state_changed" and o.get("state") == "running":
            a["activite"] = True
        else:
            return None
    elif t == "assistant":
        a["activite"] = True
        if o.get("parent_tool_use_id") is None:
            c = (o.get("message") or {}).get("content")
            if isinstance(c, list):
                textes = [x.get("text") for x in c if isinstance(x, dict) and x.get("type") == "text" and isinstance(x.get("text"), str)]
                if textes:
                    a["texte"] = sans_ansi("\n".join(textes))
    elif t == "result":
        a["finTour"] = True
        if isinstance(o.get("result"), str):
            a["resultat"] = sans_ansi(o["result"])
    elif t == "control_request":
        rid = o.get("request_id")
        if not isinstance(rid, str):
            return None
        a["requete"] = rid
        if (o.get("request") or {}).get("subtype") == "can_use_tool":
            a["demande"] = rid
    elif t == "control_cancel_request":
        if not isinstance(o.get("request_id"), str):
            return None
        a["annulation"] = o["request_id"]
    elif t == "control_response":
        r = o.get("response") or {}
        if not isinstance(r.get("request_id"), str):
            return None
        a["reponseId"] = r["request_id"]
        a["reponseSucces"] = r.get("subtype") == "success"
        a["reponseContenu"] = r.get("response") if isinstance(r.get("response"), dict) else None
    else:
        return None
    return a


def sans_ansi(s):
    s = RE_ANSI.sub("", s)
    garde = [x for x in s.split("\n") if not x.startswith("━━━ Claude") and not (x.startswith("────") and set(x) == {"─"})]
    return "\n".join(garde).strip()


def dumps(o):
    return json.dumps(o, ensure_ascii=False, separators=(",", ":"))


# ---------------------------------------------------------------- lien avec un porteur

class Lien:
    def __init__(self, cle, r, w, bonjour):
        self.cle, self.r, self.w = cle, r, w
        self.pid = bonjour.get("pid")
        self.porteur_pid = bonjour.get("porteur")
        self.bonjour = bonjour
        self.fini = False
        self.code = None
        self.apres_fin = []
        self.arret_demande = False
        self.tache = None

    def ecrire(self, ligne):
        if self.fini or self.w.is_closing():
            return False
        self.w.write(b"I" + ligne.encode("utf-8") + b"\n")
        return True

    def arreter(self, ensuite=None):
        """Fin de stdin, SIGTERM 2 s, SIGKILL 5 s (dans le porteur) ; filet : SIGKILL demandé à 8 s."""
        if self.fini:
            if ensuite:
                ensuite()
            return
        if ensuite:
            self.apres_fin.append(ensuite)
        if self.arret_demande:
            return
        self.arret_demande = True
        try:
            self.w.write(b"S\n")
        except Exception:
            pass
        asyncio.get_running_loop().call_later(8, self._filet)

    def _filet(self):
        if not self.fini and not self.w.is_closing():
            journal(f"porteur {self.cle} : toujours vivant 8 s après l'arrêt → K")
            self.w.write(b"K\n")

    def terminer(self, code):
        if self.fini:
            return
        self.fini, self.code = True, code
        suite, self.apres_fin = self.apres_fin, []
        for f in suite:
            try:
                f()
            except Exception as e:
                journal(f"après fin : {e!r}")
        try:
            self.w.close()
        except Exception:
            pass


async def connecter_porteur(cle, delai=5.0):
    sock = os.path.join(PORTEURS, cle + ".sock")
    fin = time.monotonic() + delai
    while True:
        try:
            r, w = await asyncio.open_unix_connection(sock, limit=32 * 1024 * 1024)
            l = await asyncio.wait_for(r.readline(), 3)
            if not l.startswith(b"B"):
                w.close()
                raise ConnectionError("bonjour du porteur absent")
            return Lien(cle, r, w, json.loads(l[1:]))
        except (FileNotFoundError, ConnectionRefusedError):
            if time.monotonic() > fin:
                raise
            await asyncio.sleep(0.1)


# ---------------------------------------------------------------- canaux (pages) et clients

class Canal:
    def __init__(self, client, nom, session):
        self.client, self.nom, self.session = client, nom, session
        self.pret = False
        self.file = []
        self.taille = 0
        self.prevu = None
        self.tampon = None      # pendant la lecture de l'historique : appels gardés pour après

    def envoyer(self, fonction, argument):
        """Appel vers la page de ce canal (si elle est prête), regroupé par lots d'environ 16 ms."""
        if not self.pret:
            return
        if self.tampon is not None:
            if fonction == "depuisClaude" and isinstance(argument, str) and argument.startswith('{"type":"stream_event"'):
                return
            self.tampon.append([fonction, argument])
            if len(self.tampon) > 10000:
                del self.tampon[:len(self.tampon) - 10000]
            return
        self._file(fonction, argument)

    def _file(self, fonction, argument):
        self.file.append([fonction, argument])
        self.taille += len(argument) if isinstance(argument, str) else 256
        if self.taille > LOT_MAX:
            self.vider()
        elif self.prevu is None:
            self.prevu = asyncio.get_running_loop().call_later(REGROUPEMENT, self.vider)

    def envoyer_direct(self, fonction, argument):
        """Hors tampon (info, historique) : dans l'ordre de la file."""
        if self.pret:
            self._file(fonction, argument)

    def vider(self):
        if self.prevu is not None:
            self.prevu.cancel()
            self.prevu = None
        if not self.file:
            return
        lot, self.file, self.taille = self.file, [], 0
        self.client.envoyer({"ev": "page", "canal": self.nom, "appels": lot})

    @property
    def source(self):
        return "mac" if self.client.genre == "mac" else "victus"


class Client:
    n = 0

    def __init__(self, moteur, r, w):
        Client.n += 1
        self.num = Client.n
        self.moteur, self.r, self.w = moteur, r, w
        self.genre = "?"
        self.abonne = False
        self.canaux = {}
        self.ferme = False

    def envoyer(self, o):
        if self.ferme or self.w.is_closing():
            return
        try:
            self.w.write(dumps(o).encode("utf-8") + b"\n")
        except Exception:
            self.fermer("écriture impossible")
            return
        if self.w.transport.get_write_buffer_size() > TAMPON_CLIENT_MAX:
            self.fermer("ne lit plus (tampon > 64 Mo)")

    def fermer(self, pourquoi=""):
        if self.ferme:
            return
        self.ferme = True
        journal(f"client {self.num} ({self.genre}) : déconnecté {pourquoi}")
        for c in list(self.canaux.values()):
            c.session.retirer_canal(c)
        self.canaux.clear()
        try:
            self.w.transport.abort() if pourquoi.startswith("ne lit") else self.w.close()
        except Exception:
            pass
        self.moteur.clients.discard(self)


# ---------------------------------------------------------------- session

class Session:
    def __init__(self, moteur, cwd, sid=None, reprise=False, prompt=None, modele=None, effort=None):
        self.moteur = moteur
        self.cwd = cwd
        self.id = (sid or str(uuid.uuid4())).lower()
        self.reprise_demandee = reprise
        self.projet, self.emoji = info_projet(cwd)
        self.modele = modele if modele_valide(modele) else None
        self.effort = effort if effort_valide(effort) else None
        self.etat = "pret"
        self.resume = None
        self.dernier = None
        self.dans_terminal = False
        self.maj = time.time()
        self.prompts = []               # textes à envoyer dès que le processus tourne
        if prompt:
            self.prompts.append((prompt, "lancement"))
        self.lien = None
        self.cle = None
        self.lancement = False          # lancement en cours (environnement, porteur)
        self.demarre = False
        self.fermee = False
        self.arret_voulu = None         # "relance", "terminal", "fermer"
        self.dernier_code = None
        self.canaux = set()
        self.avant_lancement = []
        # suivi du processus pour une page qui arrive en cours de route (comme ⌘R sur le Mac)
        self.tour_en_cours = False
        self.debut_tour = None
        self.id_initialize = None
        self.reponse_initialize = None
        self.modes_demandes = {}
        self.demandes_attente = []      # [(request_id, ligne)] can_use_tool pas encore répondus
        self.requetes_claude = set()    # control_request émis par claude, pas encore répondus
        self.repondues = collections.OrderedDict()   # request_id déjà répondus : les réponses en double sont jetées
        self.questions = {}             # id → question annoncée par une page (pas de Telegram dans cette version)
        self.envois = []                # envoyerTexte demandés à une page : [{texte, canal, vu, minuteur}]
        self.attente_prompt = None

    # --- état

    @property
    def vivant(self):
        return self.lien is not None and not self.lien.fini

    def apercu(self):
        return {"id": self.id, "projet": self.projet, "emoji": self.emoji, "cwd": self.cwd, "etat": self.etat,
                "resume": self.resume, "dernierMessage": (self.dernier or "")[:600] or None,
                "modele": self.modele, "effort": self.effort, "dansTerminal": self.dans_terminal,
                "maj": int(self.maj * 1000), "machine": MACHINE, "enCours": self.vivant,
                "pages": len([c for c in self.canaux if c.pret])}

    def persistant(self):
        return {"id": self.id, "cwd": self.cwd, "modele": self.modele, "effort": self.effort, "etat": self.etat,
                "resume": self.resume, "dernierMessage": (self.dernier or "")[:600] or None,
                "dansTerminal": self.dans_terminal, "maj": self.maj, "cle": self.cle if self.vivant else None}

    def signaler(self):
        self.moteur.liste_changee()

    def info(self):
        return {"cwd": self.cwd, "projet": self.projet, "emoji": self.emoji, "sessionId": self.id,
                "modele": self.modele, "effort": self.effort, "effortDefaut": effort_reglages(self.cwd),
                "reprise": self.reprise_demandee, "dansTerminal": self.dans_terminal,
                "app": "ultron-terminal", "version": VERSION_APP, "machine": MACHINE, "vocal": False}

    def info_avec_direct(self):
        i = self.info()
        if self.vivant and self.arret_voulu is None and not self.dans_terminal:
            i["direct"] = {"tourEnCours": self.tour_en_cours, "debutTour": self.debut_tour,
                           "initialise": self.reponse_initialize,
                           "enAttente": [l for _, l in self.demandes_attente]}
        return i

    def canaux_prets(self, sauf=None):
        return [c for c in self.canaux if c.pret and c is not sauf]

    def pousser(self, fonction, argument, sauf=None):
        for c in self.canaux_prets(sauf):
            c.envoyer(fonction, argument)

    def retirer_canal(self, c):
        self.canaux.discard(c)
        for e in self.envois:
            if e["canal"] is c and not e["vu"]:
                self._envoi_direct(e)
        self.signaler()

    # --- messages des pages

    def recevoir(self, canal, o):
        if not isinstance(o, dict) or not isinstance(o.get("type"), str):
            return self.refuser("message sans type")
        t = o["type"]
        if t == "pret":
            return self.sur_pret(canal)     # attendu par l'appelant : l'ordre des messages de la page est gardé
        elif t == "versClaude":
            self.vers_claude(canal, o.get("ligne"))
        elif t == "relancer":
            m, e = self.modele, self.effort
            if "modele" in o:
                v = o["modele"]
                if v is None:
                    m = None
                elif modele_valide(v):
                    m = v
                else:
                    return self.refuser("relancer : modele invalide")
            if "effort" in o:
                v = o["effort"]
                if v is None:
                    e = None
                elif effort_valide(v):
                    e = v
                else:
                    return self.refuser("relancer : effort invalide")
            self.relancer(m, e)
        elif t == "etat":
            self.changer_etat(o)
        elif t == "question":
            self.question(canal, o)
        elif t == "questionClose":
            self.question_close(canal, o)
        elif t == "reprendreIci":
            asyncio.get_running_loop().create_task(self.reprendre_ici())
        elif t == "ouvrirTerminal":
            self.ceder(canal.client, None)
        elif t == "fermer":
            self.fermer()
        elif t in ("copier", "ouvrirLien", "ouvrirShell", "choisirFichiers", "collerFichiers", "enregistrerPiece",
                   "montrerFichier"):
            self.refuser(f"« {t} » est une action locale du client, jamais envoyée au démon")
        else:
            # vocal, dictee, todo, agents, modeVocal… : pas sur le Victus dans cette version
            journal(f"session {self.id} : « {extrait(t, 40)} » ignoré")

    def refuser(self, pourquoi):
        journal(f"session {self.id} : refusé — {pourquoi}")

    async def sur_pret(self, canal):
        if canal not in self.canaux or self.fermee:
            return
        journal(f"session {self.id} : page {canal.client.genre}/{canal.nom} prête")
        canal.pret = True
        canal.file.clear()
        canal.taille = 0
        canal.tampon = None
        if not (self.demarre or self.lancement or self.dans_terminal):
            canal.envoyer_direct("info", self.info())
            if self.reprise_demandee:
                await self.envoyer_historique(canal)
            self.demarrer()
        else:
            # page qui arrive en cours de route : la conversation est reconstruite depuis le transcript,
            # `info.direct` dit où en est le processus, puis ce qui est arrivé pendant la lecture suit.
            canal.envoyer_direct("info", self.info_avec_direct())
            await self.envoyer_historique(canal)
            if canal.pret and canal in self.canaux:
                if self.dans_terminal:
                    canal.envoyer("fin", {"code": 0, "raison": "terminal"})
                elif not self.vivant and not self.lancement and self.arret_voulu is None:
                    canal.envoyer("fin", {"code": self.dernier_code if self.dernier_code is not None else 0})
        self.signaler()
        self.livrer_prompts()

    async def envoyer_historique(self, canal):
        canal.tampon = []
        try:
            lignes = await asyncio.to_thread(lignes_transcript, self.cwd, self.id)
        except Exception as e:
            journal(f"session {self.id} : historique illisible {e!r}")
            lignes = []
        gardes, canal.tampon = canal.tampon or [], None
        if not canal.pret or canal not in self.canaux:
            return
        journal(f"session {self.id} : historique {len(lignes)} lignes → {canal.client.genre}/{canal.nom}")
        canal.envoyer_direct("historique", lignes)
        for f, a in gardes:
            canal.envoyer_direct(f, a)
        canal.vider()

    def vers_claude(self, canal, l):
        if not isinstance(l, str) or len(l) > LIGNE_MAX or "\n" in l or "\r" in l:
            return self.refuser("versClaude : ligne invalide")
        try:
            o = json.loads(l)
        except Exception:
            return self.refuser("versClaude : JSON invalide")
        if not isinstance(o, dict):
            return self.refuser("versClaude : pas un objet")
        typ = o.get("type")
        if typ == "control_response":
            rid = (o.get("response") or {}).get("request_id")
            if isinstance(rid, str) and rid in self.repondues:
                journal(f"session {self.id} : réponse en double à {rid} ({canal.source}) jetée")
                return
        if self.vivant and self.arret_voulu is None:
            self.lien.ecrire(l)
            self.noter_envoi(o, canal)
        elif not self.fermee and not self.dans_terminal and (self.lien is None or self.lien.fini or self.arret_voulu == "relance"):
            self.avant_lancement.append(l)
            if typ == "user":
                self.noter_vu(canal)
            journal(f"session {self.id} : ligne gardée jusqu'au lancement ({typ})")
            if not self.demarre and not self.lancement:
                self.demarrer()
            elif self.demarre and not self.vivant and not self.lancement and self.arret_voulu is None:
                # processus terminé : on le reprend pour ce message
                asyncio.get_running_loop().create_task(self.lancer(chemin_transcript(self.cwd, self.id) is not None))
        else:
            journal(f"session {self.id} : refusé — versClaude alors que le processus est arrêté")
            canal.envoyer("stderr", "Le processus claude est arrêté : message non envoyé.\n")
            return
        if typ == "user":
            # les autres pages n'affichent pas en direct un message envoyé ailleurs : on le leur donne
            self.pousser("utilisateurAilleurs", {"ligne": l, "source": canal.source}, sauf=canal)

    def noter_vu(self, canal):
        for e in self.envois:
            if e["canal"] is canal and not e["vu"]:
                e["vu"] = True
                if e["minuteur"]:
                    e["minuteur"].cancel()
                break
        self.envois = [e for e in self.envois if not e["vu"]]

    def noter_envoi(self, o, canal=None):
        t = o.get("type")
        if t == "user":
            self.marquer_tour(True)
            if canal is not None:
                self.noter_vu(canal)
        elif t == "control_response":
            rid = (o.get("response") or {}).get("request_id")
            if isinstance(rid, str):
                self.demandes_attente = [x for x in self.demandes_attente if x[0] != rid]
                if rid in self.requetes_claude:
                    self.requetes_claude.discard(rid)
                    self.repondues[rid] = True
                    while len(self.repondues) > 500:
                        self.repondues.popitem(last=False)
        elif t == "control_request":
            rid, r = o.get("request_id"), o.get("request") or {}
            st = r.get("subtype")
            if st == "initialize":
                self.id_initialize = rid
            elif st == "set_permission_mode" and isinstance(r.get("mode"), str):
                self.modes_demandes[rid] = r["mode"]
            elif st == "set_model":
                m = r.get("model")
                self.modele = m if modele_valide(m) else None
                self.signaler()
            elif st == "apply_flag_settings":
                e = (r.get("settings") or {}).get("effortLevel")
                if effort_valide(e) or e is None:
                    self.effort = e
                    self.signaler()

    # --- lancement

    def demarrer(self):
        if self.demarre or self.lancement or self.fermee or self.dans_terminal:
            return
        self.demarre = True
        asyncio.get_running_loop().create_task(self.lancer(self.reprise_demandee))

    async def lancer(self, reprise):
        if self.lancement or self.fermee:
            return False
        self.lancement = True
        try:
            return await self._lancer(reprise)
        finally:
            self.lancement = False

    async def _lancer(self, reprise):
        env = await Environnement.charger()
        if self.fermee:
            return False
        if not os.access(CLAUDE, os.X_OK):
            self.pousser("stderr", f"Binaire claude introuvable ({CLAUDE}).\n")
            self.pousser("fin", {"code": -1})
            self.etat = "termine"
            self.signaler()
            return False
        e = dict(env)
        e["BT_APP"] = "1"
        e["BT_MACHINE"] = MACHINE
        e["PWD"] = self.cwd
        args = arguments(self.id, reprise, self.modele, self.effort)
        cle = secrets.token_hex(6)
        spec = {"cle": cle, "sock": os.path.join(PORTEURS, cle + ".sock"), "exe": CLAUDE, "args": args,
                "cwd": self.cwd, "env": e, "sessionId": self.id, "modele": self.modele, "effort": self.effort}
        try:
            os.makedirs(PORTEURS, mode=0o700, exist_ok=True)
            os.makedirs(ETAT, mode=0o700, exist_ok=True)
            await asyncio.to_thread(lancer_porteur, cle, dumps(spec).encode("utf-8"), self.cwd)
            lien = await connecter_porteur(cle, 5)
        except Exception as x:
            journal(f"session {self.id} : lancement impossible — {x!r}")
            self.pousser("stderr", f"Lancement de claude impossible : {x}\n")
            self.pousser("fin", {"code": -1})
            self.etat = "termine"
            self.signaler()
            return False
        if self.fermee:
            lien.arreter()
            return False
        journal(f"session {self.id} : claude pid {lien.pid} (porteur {cle}) {'--resume' if reprise else '--session-id'}"
                f" modele {self.modele or 'défaut'} effort {self.effort or 'défaut'}")
        self.attacher_lien(lien)
        return True

    def attacher_lien(self, lien):
        self.lien = lien
        self.cle = lien.cle
        self.arret_voulu = None
        self.dernier_code = None
        self.oublier_processus()
        if lien.bonjour.get("tour"):
            self.tour_en_cours = True
            self.debut_tour = lien.bonjour.get("debutTour")
        lien.tache = asyncio.get_running_loop().create_task(self.lire_porteur(lien))
        attente, self.avant_lancement = self.avant_lancement, []
        for l in attente:
            lien.ecrire(l)
            try:
                self.noter_envoi(json.loads(l))
            except Exception:
                pass
        if attente:
            journal(f"session {self.id} : {len(attente)} ligne(s) gardée(s) → stdin")
        if self.etat == "termine":
            self.etat = "travaille" if self.tour_en_cours else "pret"
        self.maj = time.time()
        self.moteur.sauver_bientot(0)
        self.signaler()
        self.livrer_prompts()

    async def lire_porteur(self, lien):
        code = None
        try:
            while True:
                try:
                    l = await lien.r.readuntil(b"\n")
                except asyncio.LimitOverrunError as e:
                    await lien.r.readexactly(e.consumed)
                    continue
                except asyncio.IncompleteReadError:
                    break
                k, corps = l[:1], l[1:].rstrip(b"\r\n")
                if k == b"O":
                    self.ligne_claude(corps.decode("utf-8", "replace"), lien)
                elif k == b"E":
                    s = corps.decode("utf-8", "replace")
                    journal(f"session {self.id} : stderr {extrait(s, 300)}")
                    self.pousser("stderr", s + "\n")
                elif k == b"F":
                    try:
                        code = int(corps)
                    except ValueError:
                        code = -1
                    break
        except asyncio.CancelledError:
            raise
        except (ConnectionError, OSError) as e:
            journal(f"session {self.id} : porteur {lien.cle} perdu {e!r}")
        if self.moteur.arret_en_cours:
            return
        if code is None:
            code = -1
            journal(f"session {self.id} : porteur {lien.cle} parti sans fin")
        self.fin_processus(lien, code)

    def ligne_claude(self, l, lien):
        self.pousser("depuisClaude", l)
        actuel = lien is self.lien
        a = analyser(l)
        if a is None:
            if actuel and l.startswith('{"type":"stream_event"'):
                self.marquer_tour(True)
            return
        if actuel:
            self.suivre(a, l)
        i = a.get("idInit")
        if uuid_valide(i) and i.lower() != self.id:
            journal(f"session {self.id} : init annonce l'id {i}, adopté")
            self.moteur.renommer(self, i.lower())
        if a.get("texte"):
            self.dernier = a["texte"]
            self.maj = time.time()
            self.signaler()
        if a.get("finTour"):
            if a.get("resultat"):
                self.dernier = a["resultat"]
            self.maj = time.time()
            self.signaler()

    def suivre(self, a, l):
        if a.get("activite"):
            self.marquer_tour(True)
        if a.get("finTour"):
            self.marquer_tour(False)
        rid = a.get("requete")
        if rid:
            self.requetes_claude.add(rid)
        d = a.get("demande")
        if d and not any(x[0] == d for x in self.demandes_attente):
            self.demandes_attente.append((d, l))
            del self.demandes_attente[:-50]
        an = a.get("annulation")
        if an:
            self.demandes_attente = [x for x in self.demandes_attente if x[0] != an]
            if an in self.requetes_claude:
                self.requetes_claude.discard(an)
                self.repondues[an] = True
        r = a.get("reponseId")
        if r:
            if r == self.id_initialize:
                self.id_initialize = None
                if a.get("reponseSucces") and a.get("reponseContenu") is not None:
                    self.reponse_initialize = a["reponseContenu"]
            m = self.modes_demandes.pop(r, None)
            if m and a.get("reponseSucces") and self.reponse_initialize is not None:
                self.reponse_initialize["current_permission_mode"] = (a.get("reponseContenu") or {}).get("mode") or m
        # sans page pour le dire (session pilotée par Jarvis en ligne de commande), le démon déduit l'état
        if not self.canaux_prets():
            e = "attend" if self.demandes_attente else ("travaille" if self.tour_en_cours else "pret")
            if e != self.etat:
                self.etat = e
                self.maj = time.time()
                self.signaler()

    def marquer_tour(self, v):
        if v and not self.tour_en_cours:
            self.debut_tour = maintenant_ms()
        if not v:
            self.debut_tour = None
        self.tour_en_cours = v

    def oublier_processus(self):
        self.tour_en_cours = False
        self.debut_tour = None
        self.id_initialize = None
        self.reponse_initialize = None
        self.modes_demandes.clear()
        self.demandes_attente = []
        self.requetes_claude.clear()

    def fin_processus(self, lien, code):
        journal(f"session {self.id} : claude terminé, code {code}{' (' + self.arret_voulu + ')' if self.arret_voulu else ''}")
        lien.terminer(code)
        if lien is not self.lien:
            return
        self.oublier_processus()
        self.dernier_code = code
        self.moteur.sauver_bientot()
        if self.arret_voulu is not None:
            return      # relance / terminal / fermeture : géré par l'action elle-même
        self.questions.clear()
        self.pousser("fin", {"code": code})
        self.etat = "termine"
        self.maj = time.time()
        self.signaler()

    # --- envoi d'un texte (prompt de lancement, Jarvis)

    def envoyer_texte(self, texte, source):
        """Comme Session.envoyerTexte : par une page prête si possible (elle affiche et construit le message),
        sinon écrit directement. Session arrêtée : le texte attend le lancement."""
        if self.fermee or self.dans_terminal:
            return False
        self.prompts.append((texte, source))
        if not self.vivant and not self.lancement:
            if not self.demarre:
                self.demarrer()
            elif self.arret_voulu is None:
                asyncio.get_running_loop().create_task(self.lancer(chemin_transcript(self.cwd, self.id) is not None))
        self.livrer_prompts()
        return True

    def livrer_prompts(self):
        if not self.prompts or not self.vivant or self.arret_voulu is not None:
            return
        canaux = [c for c in self.canaux_prets() if c.tampon is None]
        if not canaux:
            # pas encore de page : on lui laisse 1,5 s pour arriver, puis écriture directe
            if self.attente_prompt is None:
                self.attente_prompt = asyncio.get_running_loop().call_later(1.5, self._prompts_directs)
            return
        if self.attente_prompt is not None:
            self.attente_prompt.cancel()
            self.attente_prompt = None
        c = sorted(canaux, key=lambda x: (x.client.genre != "gtk", x.client.num))[0]
        prompts, self.prompts = self.prompts, []
        boucle = asyncio.get_running_loop()
        for texte, source in prompts:
            e = {"texte": texte, "source": source, "canal": c, "vu": False, "minuteur": None}
            # la page appelle bt.envoyerTexte(texte, {source}) ; sans réponse en 4 s, écriture directe
            e["minuteur"] = boucle.call_later(4, self._envoi_direct, e)
            self.envois.append(e)
            c.envoyer("texteAEnvoyer", {"texte": texte, "source": source})
            journal(f"session {self.id} : texte ({source}) confié à la page {c.client.genre}/{c.nom}")

    def _prompts_directs(self):
        self.attente_prompt = None
        if not self.vivant:
            return
        prompts, self.prompts = self.prompts, []
        for texte, source in prompts:
            self._ecrire_texte(texte, source)

    def _envoi_direct(self, e):
        if e["vu"]:
            return
        e["vu"] = True
        if e["minuteur"]:
            e["minuteur"].cancel()
        self.envois = [x for x in self.envois if not x["vu"]]
        journal(f"session {self.id} : la page n'a pas envoyé le texte ({e['source']}) → écriture directe")
        self._ecrire_texte(e["texte"], e["source"])

    def _ecrire_texte(self, texte, source):
        l = message_utilisateur(texte)
        if self.vivant and self.arret_voulu is None:
            self.lien.ecrire(l)
            self.marquer_tour(True)
        else:
            self.avant_lancement.append(l)
        journal(f"session {self.id} : → stdin (direct, {source}) {extrait(texte, 60)}")
        self.pousser("utilisateurAilleurs", {"ligne": l, "source": source})

    # --- relancer, terminal, reprendre, fermer

    def relancer(self, m, e):
        if self.fermee or self.dans_terminal:
            return
        self.modele, self.effort = m, e
        journal(f"session {self.id} : relance (modele {m or 'défaut'}, effort {e or 'défaut'})")

        async def suite():
            if self.fermee:
                return
            self.demarre = True
            if await self.lancer(chemin_transcript(self.cwd, self.id) is not None):
                self.pousser("info", self.info())

        if self.vivant:
            self.arret_voulu = "relance"
            self.arreter_processus(lambda: asyncio.get_running_loop().create_task(suite()))
        else:
            asyncio.get_running_loop().create_task(suite())

    def arreter_processus(self, ensuite=None):
        self.lien.ecrire(interruption())
        self.lien.arreter(ensuite)

    def ceder(self, client, req):
        """« Continuer dans un terminal » : arrêt du processus, puis `cede` au client qui ouvre le terminal."""
        if self.fermee:
            return

        def fait():
            if self.fermee:
                return
            self.dans_terminal = True
            self.etat = "termine"
            self.maj = time.time()
            self.questions.clear()
            self.pousser("info", self.info())
            self.pousser("fin", {"code": 0, "raison": "terminal"})
            self.signaler()
            self.moteur.sauver_bientot(0)
            if client is not None:
                client.envoyer({"ev": "cede", "req": req, "sessionId": self.id, "cwd": self.cwd,
                                "reprise": chemin_transcript(self.cwd, self.id) is not None,
                                "modele": self.modele, "claude": CLAUDE})
            journal(f"session {self.id} : cédée au terminal")

        if self.dans_terminal:
            fait()
        elif self.vivant:
            self.arret_voulu = "terminal"
            self.arreter_processus(fait)
        else:
            self.arret_voulu = "terminal" if self.lancement else self.arret_voulu
            fait()

    async def reprendre_ici(self):
        """La session passée dans un terminal (ou terminée) revient : le claude externe sur cette session est
        arrêté d'abord, puis reprise --resume ; les pages sont invitées à se recharger (`recharger`)."""
        if self.fermee or self.lancement:
            return
        if self.vivant and self.arret_voulu is None:
            return
        sauf = {os.getpid()}
        for s in self.moteur.sessions.values():
            if s.lien is not None:
                for p in (s.lien.pid, s.lien.porteur_pid):
                    if isinstance(p, int):
                        sauf.add(p)
        arretes = await asyncio.to_thread(arreter_claude_externe, self.id, sauf)
        if arretes:
            journal(f"session {self.id} : claude externe arrêté (pid {', '.join(map(str, arretes))})")
        if self.fermee:
            return
        self.dans_terminal = False
        self.arret_voulu = None
        self.demarre = True
        self.etat = "pret"
        self.maj = time.time()
        self.signaler()
        if await self.lancer(chemin_transcript(self.cwd, self.id) is not None):
            self.pousser("info", self.info())
            for c in self.canaux_prets():
                c.vider()
                c.client.envoyer({"ev": "recharger", "canal": c.nom, "sessionId": self.id})

    def fermer(self):
        if self.fermee:
            return
        self.fermee = True
        self.arret_voulu = "fermer"
        self.avant_lancement.clear()
        self.prompts.clear()
        self.questions.clear()
        for e in self.envois:
            if e["minuteur"]:
                e["minuteur"].cancel()
        self.envois = []
        journal(f"session {self.id} : fermeture")
        self.pousser("fin", {"code": 0, "raison": "fermee"})
        clients = set()
        for c in list(self.canaux):
            c.vider()
            clients.add(c.client)
            c.client.canaux.pop(c.nom, None)
        for cl in clients:
            cl.envoyer({"ev": "fermee", "sessionId": self.id})
        self.canaux.clear()
        if self.vivant:
            self.arreter_processus()
        self.moteur.retirer(self)

    # --- état et questions

    def changer_etat(self, o):
        e = o.get("etat")
        if e not in ETATS:
            return self.refuser("etat invalide")
        if e == "pret" and self.tour_en_cours and self.vivant and self.arret_voulu is None:
            e = "travaille"
        if "resume" in o:
            r = o["resume"]
            self.resume = r[:500] if isinstance(r, str) else None
        if e != self.etat:
            self.maj = time.time()
        self.etat = e
        self.signaler()

    def question(self, canal, message):
        o = message
        if isinstance(message.get("question"), dict):
            o = dict(message["question"])
            o["typeQuestion"] = o.get("type")
        qid, typ, texte = o.get("id"), o.get("typeQuestion"), o.get("texte")
        if not (isinstance(qid, str) and RE_ID_QUESTION.match(qid) and typ in TYPES_QUESTION
                and isinstance(texte, str) and len(texte) <= 50000):
            return self.refuser("question invalide")
        if qid not in self.questions:
            self.questions[qid] = {"id": qid, "type": typ, "texte": texte, "source": canal.source,
                                   "cree": maintenant_ms()}
            journal(f"session {self.id} : question {qid} ({typ}) annoncée par {canal.client.genre}/{canal.nom}")

    def question_close(self, canal, o):
        qid = o.get("id")
        if not (isinstance(qid, str) and RE_ID_QUESTION.match(qid)):
            return self.refuser("questionClose : id invalide")
        r = o.get("reponse")
        if isinstance(r, str):
            r = [r[:20000]]   # en liste : l'autre page la lit comme un libellé (pas de traduction « vocale »)
        elif not (isinstance(r, list) and all(isinstance(x, str) for x in r)):
            return self.refuser("questionClose : reponse invalide")
        if self.questions.pop(qid, None) is None:
            return
        journal(f"session {self.id} : question {qid} répondue ({canal.source}) → autres pages")
        self.pousser("reponseExterne", {"id": qid, "reponse": r, "source": canal.source}, sauf=canal)


def lancer_porteur(cle, spec, cwd):
    """Le porteur se détache lui-même (double fork) : le démon ne le possède pas, un arrêt du démon ne le tue pas
    (un sous-processus asyncio serait tué à la fermeture de la boucle)."""
    import subprocess
    with open(os.path.join(ETAT, "porteurs.log"), "ab") as log:
        p = subprocess.Popen([sys.executable, PORTEUR_PY, cle], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                             stderr=log, cwd=cwd, start_new_session=True, close_fds=True)
    try:
        p.communicate(spec, timeout=10)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()
        raise RuntimeError("porteur bloqué au démarrage")
    if p.returncode != 0:
        raise RuntimeError(f"porteur sorti en erreur ({p.returncode})")


def arreter_claude_externe(sid, sauf):
    """Arrête les `claude … --resume <id>` lancés hors du démon (terminal). Renvoie les pid arrêtés."""
    import subprocess

    def pids():
        try:
            out = subprocess.run(["pgrep", "-f", f"(resume|session-id)[ =]{sid}"], capture_output=True,
                                 text=True, timeout=5).stdout
        except Exception:
            return []
        return [int(x) for x in out.split() if x.strip().isdigit() and int(x) not in sauf]

    cibles = pids()
    if not cibles:
        return []
    for p in cibles:
        try:
            os.kill(p, signal.SIGTERM)
        except OSError:
            pass
    for _ in range(30):
        if not pids():
            return cibles
        time.sleep(0.1)
    for p in pids():
        try:
            os.kill(p, signal.SIGKILL)
        except OSError:
            pass
    time.sleep(0.2)
    return cibles


# ---------------------------------------------------------------- le démon

class Moteur:
    def __init__(self):
        self.sessions = {}
        self.clients = set()
        self.liste_prevue = None
        self.liste_derniere = 0.0
        self.sauvegarde_prevue = None
        self.arret_en_cours = False
        self.serveur = None

    # --- liste et état persistant

    def liste(self):
        return sorted((s.apercu() for s in self.sessions.values()), key=lambda x: -x["maj"])

    def liste_changee(self):
        self.sauver_bientot()
        if self.liste_prevue is not None:
            return
        boucle = asyncio.get_running_loop()
        delai = max(0.0, self.liste_derniere + LISTE_INTERVALLE - boucle.time())
        self.liste_prevue = boucle.call_later(delai, self.diffuser_liste)

    def diffuser_liste(self):
        self.liste_prevue = None
        self.liste_derniere = asyncio.get_running_loop().time()
        l = self.liste()
        for c in list(self.clients):
            if c.abonne:
                c.envoyer({"ev": "liste", "sessions": l})

    def sauver_bientot(self, delai=1.0):
        if self.arret_en_cours:
            return
        if self.sauvegarde_prevue is not None:
            if delai > 0:
                return
            self.sauvegarde_prevue.cancel()
        self.sauvegarde_prevue = asyncio.get_running_loop().call_later(delai, self.sauver)

    def sauver(self):
        self.sauvegarde_prevue = None
        os.makedirs(ETAT, mode=0o700, exist_ok=True)
        d = {"version": 1, "sessions": [s.persistant() for s in self.sessions.values()]}
        tmp = FICHIER_ETAT + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(d, fh, ensure_ascii=False, indent=1)
            os.chmod(tmp, 0o600)
            os.replace(tmp, FICHIER_ETAT)
        except OSError as e:
            journal(f"état non écrit : {e!r}")

    async def restaurer(self):
        """Sessions récentes de l'état (terminées, reprises avec --resume à l'ouverture) puis porteurs encore vivants."""
        try:
            with open(FICHIER_ETAT, encoding="utf-8") as fh:
                d = json.load(fh)
        except FileNotFoundError:
            d = {"sessions": []}
        except Exception as e:
            journal(f"état illisible : {e!r}")
            d = {"sessions": []}
        limite = time.time() - RECENTES_JOURS * 86400
        connues = sorted((x for x in d.get("sessions", []) if isinstance(x, dict)), key=lambda x: -(x.get("maj") or 0))
        for x in connues[:RECENTES_MAX]:
            sid, cwd = x.get("id"), dossier_valide(x.get("cwd"))
            if not uuid_valide(sid) or not cwd or (x.get("maj") or 0) < limite and not x.get("cle"):
                continue
            s = Session(self, cwd, sid.lower(), reprise=chemin_transcript(cwd, sid.lower()) is not None,
                        modele=x.get("modele"), effort=x.get("effort"))
            s.etat = "termine"
            s.resume = x.get("resume") if isinstance(x.get("resume"), str) else None
            s.dernier = x.get("dernierMessage") if isinstance(x.get("dernierMessage"), str) else None
            s.dans_terminal = bool(x.get("dansTerminal"))
            s.maj = float(x.get("maj") or time.time())
            self.sessions[s.id] = s
        # porteurs vivants : la session continue comme si de rien n'était
        try:
            socks = [f[:-5] for f in os.listdir(PORTEURS) if f.endswith(".sock")]
        except FileNotFoundError:
            socks = []
        for cle in socks:
            try:
                lien = await connecter_porteur(cle, 0)
            except (ConnectionRefusedError, FileNotFoundError):
                journal(f"porteur {cle} : socket mort, retiré")
                try:
                    os.unlink(os.path.join(PORTEURS, cle + ".sock"))
                except OSError:
                    pass
                continue
            except Exception as e:
                journal(f"porteur {cle} : injoignable ({e!r})")
                continue
            b = lien.bonjour
            sid = (b.get("sessionId") or "").lower()
            s = self.sessions.get(sid)
            if s is None:
                cwd = dossier_valide(b.get("cwd"))
                if not uuid_valide(sid) or not cwd:
                    lien.w.close()
                    continue
                s = Session(self, cwd, sid, reprise=True, modele=b.get("modele"), effort=b.get("effort"))
                self.sessions[sid] = s
            s.demarre = True
            s.dans_terminal = False
            s.attacher_lien(lien)
            journal(f"session {sid} : porteur {cle} retrouvé (claude pid {lien.pid}{', fini' if b.get('fini') else ''})")
        journal(f"{len(self.sessions)} session(s) restaurée(s)")
        self.sauver()

    def renommer(self, s, nouveau):
        self.sessions.pop(s.id, None)
        s.id = nouveau
        self.sessions[nouveau] = s
        self.sauver_bientot(0)
        self.liste_changee()

    def retirer(self, s):
        if self.sessions.get(s.id) is s:
            del self.sessions[s.id]
        self.sauver_bientot(0)
        self.liste_changee()

    # --- clients

    async def client(self, r, w):
        c = Client(self, r, w)
        self.clients.add(c)
        try:
            while not c.ferme:
                try:
                    l = await r.readuntil(b"\n")
                except asyncio.IncompleteReadError:
                    break
                except asyncio.LimitOverrunError:
                    c.fermer("ligne de plus de 20 Mo")
                    break
                l = l.strip()
                if not l:
                    continue
                try:
                    o = json.loads(l)
                except Exception:
                    c.envoyer({"ev": "erreur", "message": "JSON invalide"})
                    continue
                if not isinstance(o, dict):
                    continue
                try:
                    await self.traiter(c, o)
                except Exception as e:
                    journal(f"client {c.num} : erreur sur {extrait(o.get('op'), 30)} : {e!r}")
                    c.envoyer({"ev": "erreur", "req": o.get("req"), "message": "erreur interne"})
        except (ConnectionError, OSError):
            pass
        finally:
            c.fermer()

    async def traiter(self, c, o):
        op = o.get("op")
        req = o.get("req") if isinstance(o.get("req"), (str, int)) else None

        def erreur(m, **k):
            c.envoyer(dict({"ev": "erreur", "req": req, "op": op, "message": m}, **k))

        if op == "ping":
            c.envoyer({"ev": "pong"})
        elif op == "bonjour":
            g = o.get("client")
            c.genre = g if g in ("gtk", "mac", "cli") else "?"
            journal(f"client {c.num} : bonjour ({c.genre})")
            c.envoyer({"ev": "bonjour", "machine": MACHINE, "version": VERSION, "home": HOME})
        elif op == "abonner":
            c.abonne = True
            c.envoyer({"ev": "liste", "sessions": self.liste()})
        elif op == "ouvrir":
            cwd = dossier_valide(o.get("cwd"))
            if not cwd:
                return erreur("dossier invalide (dossier existant sous " + HOME + ")")
            resume = o.get("resume")
            if resume is not None and not uuid_valide(resume):
                return erreur("resume invalide")
            prompt = o.get("prompt")
            if prompt is not None and (not isinstance(prompt, str) or len(prompt) > LIGNE_MAX):
                return erreur("prompt invalide")
            m, e = o.get("modele"), o.get("effort")
            if m is not None and not modele_valide(m):
                return erreur("modele invalide")
            if e is not None and not effort_valide(e):
                return erreur("effort invalide")
            if resume:
                s = self.sessions.get(resume.lower())
                if s is not None:
                    if prompt and prompt.strip():
                        s.envoyer_texte(prompt, "lancement")
                    return c.envoyer({"ev": "ouverte", "req": req, "sessionId": s.id})
            s = Session(self, cwd, resume, reprise=bool(resume), prompt=prompt if prompt and prompt.strip() else None,
                        modele=m, effort=e)
            self.sessions[s.id] = s
            journal(f"session {s.id} : ouverte dans {cwd} ({s.emoji} {s.projet}){' [reprise]' if resume else ''} par {c.genre}")
            s.demarrer()
            self.liste_changee()
            c.envoyer({"ev": "ouverte", "req": req, "sessionId": s.id})
        elif op == "attacher":
            sid, nom = o.get("sessionId"), o.get("canal")
            if not isinstance(nom, str) or not RE_CANAL.match(nom):
                return erreur("canal invalide")
            s = self.sessions.get(sid.lower()) if uuid_valide(sid) else None
            if s is None:
                return erreur("session inconnue", canal=nom)
            ancien = c.canaux.pop(nom, None)
            if ancien is not None:
                ancien.session.retirer_canal(ancien)
            k = Canal(c, nom, s)
            c.canaux[nom] = k
            s.canaux.add(k)
            c.envoyer({"ev": "attache", "canal": nom, "sessionId": s.id})
        elif op == "page":
            k = c.canaux.get(o.get("canal"))
            if k is None:
                return erreur("canal inconnu", canal=o.get("canal"))
            if k.session.fermee:
                return
            r = k.session.recevoir(k, o.get("message"))
            if asyncio.iscoroutine(r):
                await r
        elif op == "detacher":
            k = c.canaux.pop(o.get("canal"), None)
            if k is not None:
                k.session.retirer_canal(k)
        elif op in ("ceder", "fermer", "envoyer"):
            sid = o.get("sessionId")
            s = self.sessions.get(sid.lower()) if uuid_valide(sid) else None
            if s is None:
                return erreur("session inconnue")
            if op == "ceder":
                s.ceder(c, req)
            elif op == "fermer":
                s.fermer()
                c.envoyer({"ev": "fermee", "req": req, "sessionId": s.id})
            else:
                t = o.get("texte")
                if not isinstance(t, str) or not t.strip() or len(t) > LIGNE_MAX:
                    return erreur("texte invalide")
                src = o.get("source") if isinstance(o.get("source"), str) and len(o.get("source")) <= 32 else "jarvis"
                ok = s.envoyer_texte(t, src)
                c.envoyer({"ev": "envoye", "req": req, "sessionId": s.id, "ok": ok})
        elif op == "dossiers":
            l = await asyncio.to_thread(self.dossiers)
            c.envoyer({"ev": "dossiers", "req": req, "liste": l})
        else:
            erreur("op inconnue")

    def dossiers(self):
        vus = {}
        racine = os.path.join(HOME, ".claude", "projects")
        try:
            noms = os.listdir(racine)
        except OSError:
            noms = []
        for n in noms:
            cwd, maj = cwd_du_dossier(os.path.join(racine, n))
            cwd = dossier_valide(cwd) if cwd else None
            if cwd:
                vus[cwd] = max(vus.get(cwd, 0), maj)
        for s in list(self.sessions.values()):
            if os.path.isdir(s.cwd):
                vus[s.cwd] = max(vus.get(s.cwd, 0), s.maj)
        l = [{"cwd": c, "nom": info_projet(c)[0], "emoji": info_projet(c)[1], "maj": int(m * 1000)} for c, m in vus.items()]
        l.sort(key=lambda x: -x["maj"])
        return l[:60]

    # --- vie du démon

    async def principal(self):
        os.makedirs(os.path.dirname(SOCK), exist_ok=True)
        os.makedirs(PORTEURS, mode=0o700, exist_ok=True)
        os.makedirs(ETAT, mode=0o700, exist_ok=True)
        if os.path.exists(SOCK):
            try:
                _, w = await asyncio.open_unix_connection(SOCK)
                w.close()
                journal(f"un démon répond déjà sur {SOCK} : abandon")
                sys.exit(1)
            except (ConnectionRefusedError, FileNotFoundError, OSError):
                os.unlink(SOCK)
        await self.restaurer()
        ancien = os.umask(0o177)
        try:
            self.serveur = await asyncio.start_unix_server(self.client, path=SOCK, limit=LIGNE_MAX + 1024 * 1024)
        finally:
            os.umask(ancien)
        os.chmod(SOCK, 0o600)
        journal(f"ultron-moteur prêt sur {SOCK} (état {ETAT}, porteurs {PORTEURS}, pid {os.getpid()})")
        fin = asyncio.Event()
        boucle = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            boucle.add_signal_handler(sig, fin.set)
        boucle.add_signal_handler(signal.SIGHUP, lambda: None)
        await fin.wait()
        # arrêt du démon : les sessions continuent dans leurs porteurs (redémarrage sans perte)
        self.arret_en_cours = True
        journal("arrêt du démon (les sessions continuent dans leurs porteurs)")
        if self.sauvegarde_prevue is not None:
            self.sauvegarde_prevue.cancel()
        self.sauver()
        self.serveur.close()
        try:
            os.unlink(SOCK)
        except OSError:
            pass
        for c in list(self.clients):
            c.fermer("arrêt du démon")


def main():
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    asyncio.run(Moteur().principal())


if __name__ == "__main__":
    main()
