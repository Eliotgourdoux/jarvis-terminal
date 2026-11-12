#!/usr/bin/env python3
"""Ultron Terminal — l'app de bureau du Victus (GTK 4 + WebKitGTK 6.0).

Équivalent Linux de la coque Swift (app/Sources/FenetrePrincipale.swift, FenetreSession.swift, Medias.swift,
Apercu.swift, Entrees.swift) : une seule fenêtre « Ultron Terminal », la barre ui/sessions.html à gauche, les pages
ui/index.html empilées à droite (une par session ouverte). Ce n'est qu'un client : les sessions et les processus
claude appartiennent au démon ultron-moteur (agent A), joint par le socket unix du protocole de
victus/CONTRAT-VICTUS.md. L'app garde seulement les actions locales : presse-papiers, liens, terminal, fichiers
joints, médias (btmedia://) et aperçus (btapercu://).

Point d'entrée : ~/.local/share/ultron-terminal/app/ultron_app.py (appelé par `ultron-terminal app`).
Variables : ULTRON_SOCK (chemin du socket, tests), ULTRON_UI_DIR (dossier ui/).
"""
import base64
import json
import mimetypes
import os
import re
import secrets
import shlex
import stat
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlsplit


def _bac_a_sable():
    """Ubuntu 24.10 interdit les espaces de noms non privilégiés (AppArmor) : bwrap ne démarre pas, et WebKitGTK
    s'arrête net. Dans ce cas seulement, on coupe le bac à sable de WebKit. La page reste protégée par sa CSP,
    le pont n'accepte que les messages du cadre principal, et la vue ne navigue jamais hors de sa page."""
    if os.environ.get("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS"):
        return
    try:
        r = subprocess.run(["bwrap", "--ro-bind", "/", "/", "--", "/bin/true"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
        ok = r.returncode == 0
    except Exception:
        ok = False
    if not ok:
        os.environ["WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS"] = "1"


_bac_a_sable()

import gi  # noqa: E402

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("WebKit", "6.0")
gi.require_version("Soup", "3.0")
from gi.repository import Gdk, Gio, GLib, Gtk, Soup, WebKit  # noqa: E402

APP_ID = "fr.eliot.UltronTerminal"
TITRE = "Ultron Terminal"
HOME = str(Path.home())
HOME_REEL = os.path.realpath(HOME)
CLAUDE = os.path.join(HOME, ".local/bin/claude")
LARGEUR_BARRE = 248
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
MODELE_RE = re.compile(r"^[A-Za-z0-9._\[\]-]{1,80}$")
ENV_A_RETIRER = ("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "BT_APP", "BT_TEST", "BT_MACHINE")
DOSSIER_DISCUSSIONS = os.path.join(HOME, "Claude-Discussions")
FOND = (0x0B / 255, 0x0A / 255, 0x0C / 255)

# ---------------------------------------------------------------------------------------------------------------
# Journal et chemins
# ---------------------------------------------------------------------------------------------------------------

_JOURNAL = Path(os.environ.get("XDG_STATE_HOME", os.path.join(HOME, ".local/state"))) / "ultron-terminal" / "app.log"


def journal(msg):
    ligne = time.strftime("%H:%M:%S") + " " + str(msg)
    print(ligne, file=sys.stderr, flush=True)
    try:
        _JOURNAL.parent.mkdir(parents=True, exist_ok=True)
        if _JOURNAL.exists() and _JOURNAL.stat().st_size > 2_000_000:
            _JOURNAL.write_text("")
        with _JOURNAL.open("a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d ") + ligne + "\n")
    except OSError:
        pass


def dossier_ui():
    candidats = [os.environ.get("ULTRON_UI_DIR"),
                 str(Path(__file__).resolve().parent.parent / "ui"),          # installé : …/ultron-terminal/ui
                 str(Path(__file__).resolve().parents[3] / "ui") if len(Path(__file__).resolve().parents) > 3 else None]
    for d in candidats:
        if d and os.path.isfile(os.path.join(d, "index.html")):
            return os.path.realpath(d)
    return os.path.realpath(candidats[1])


def chemin_socket():
    if os.environ.get("ULTRON_SOCK"):
        return os.environ["ULTRON_SOCK"]
    run = os.environ.get("XDG_RUNTIME_DIR") or "/run/user/%d" % os.getuid()
    return os.path.join(run, "ultron-terminal.sock")


def fichier_etat():
    base = os.environ.get("XDG_CONFIG_HOME", os.path.join(HOME, ".config"))
    return Path(base) / "ultron-terminal" / "app.json"


def lire_etat():
    try:
        return json.loads(fichier_etat().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def ecrire_etat(d):
    try:
        p = fichier_etat()
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(d), encoding="utf-8")
        tmp.replace(p)
    except OSError:
        pass


def sous_home(p, reel=False):
    h = HOME_REEL if reel else HOME
    return p == h or p.startswith(h + os.sep)


def dossier_valide(p):
    """Dossier existant sous le home (règle du démon), chemin réel ; None sinon."""
    if not isinstance(p, str) or not p.startswith("/") or "\0" in p or len(p.encode()) > 4096:
        return None
    r = os.path.realpath(p)
    return r if os.path.isdir(r) and sous_home(r, reel=True) else None


def lancer(argv, cwd=None):
    """Lance un programme détaché, sans les variables propres à l'app ; le processus est récolté à sa fin."""
    l = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE)
    for v in ENV_A_RETIRER:
        l.unsetenv(v)
    if cwd:
        l.set_cwd(cwd)
    try:
        p = l.spawnv(argv)
    except GLib.Error as e:
        journal("lancement impossible %s : %s" % (argv[0], e.message))
        return False
    _ENFANTS.add(p)
    p.wait_async(None, lambda s, r, *a: _ENFANTS.discard(s))
    return True


_ENFANTS = set()



# ---------------------------------------------------------------------------------------------------------------
# Pont page → app : gestionnaire « bt » (et « barre », « medias ») réservé au cadre principal
# ---------------------------------------------------------------------------------------------------------------
# WebKitGTK expose window.webkit.messageHandlers dans tous les cadres, y compris l'iframe sandbox des aperçus,
# et ne dit pas d'où vient un message. Le vrai gestionnaire porte donc un nom secret (les noms ne sont pas
# énumérables) ; un script injecté dans le seul cadre principal, avant tout script de la page, remplace
# window.webkit par un objet dont messageHandlers.bt / .barre / .medias postent vers ce nom secret, avec un jeton.
# La page garde son API habituelle (window.webkit.messageHandlers.bt.postMessage) ; un aperçu ne peut rien envoyer.

def _script_pont(secret, jeton, noms):
    return ("(function(){'use strict';"
            "var mh=window.webkit&&window.webkit.messageHandlers;if(!mh)return;"
            "var reel=mh[%s];if(!reel)return;"
            "function pont(n){return Object.freeze({postMessage:function(m){"
            "reel.postMessage(JSON.stringify({j:%s,h:n,m:m}));}});}"
            "var h={};%s.forEach(function(n){h[n]=pont(n);});"
            "window.webkit=Object.freeze({messageHandlers:Object.freeze(h)});})();"
            % (json.dumps(secret), json.dumps(jeton), json.dumps(list(noms))))


class Pont:
    def __init__(self, noms, recevoir):
        self.noms = set(noms)
        self.recevoir = recevoir
        self.secret = "ut_" + secrets.token_hex(16)
        self.jeton = secrets.token_hex(16)
        self.ucm = WebKit.UserContentManager()
        self.ucm.register_script_message_handler(self.secret, None)
        self.ucm.connect("script-message-received::" + self.secret, self._message)
        self.ucm.add_script(WebKit.UserScript.new(
            _script_pont(self.secret, self.jeton, sorted(self.noms)),
            WebKit.UserContentInjectedFrames.TOP_FRAME, WebKit.UserScriptInjectionTime.START, None, None))

    def _message(self, _ucm, valeur):
        try:
            brut = valeur.to_string() if valeur.is_string() else None
            if not brut or len(brut) > 64_000_000:
                raise ValueError("taille")
            o = json.loads(brut)
        except Exception:
            journal("pont : message illisible refusé")
            return
        if not isinstance(o, dict) or o.get("j") != self.jeton or o.get("h") not in self.noms:
            journal("pont : message refusé (jeton ou gestionnaire)")
            return
        m = o.get("m")
        if not isinstance(m, dict) or not isinstance(m.get("type"), str):
            journal("pont : message sans type refusé")
            return
        try:
            self.recevoir(o["h"], m)
        except Exception as e:  # une erreur de traitement ne doit jamais casser le pont
            journal("pont : erreur sur « %s » — %r" % (m.get("type", "")[:30], e))


def _meme_page(uri, page):
    try:
        u = urlsplit(uri)
    except ValueError:
        return False
    return u.scheme == "file" and os.path.normpath(unquote(u.path)) == page


def creer_vue(pont, page, fenetre):
    """Vue web avec les réglages de la coque Mac : pas de fenêtre ouverte par la page, pas de plein écran,
    lecture des médias seulement au clic, aucune navigation hors de sa page (liens http(s) → navigateur)."""
    vue = WebKit.WebView(user_content_manager=pont.ucm)
    s = vue.get_settings()
    s.set_javascript_can_open_windows_automatically(False)
    s.set_javascript_can_access_clipboard(False)
    s.set_allow_file_access_from_file_urls(False)
    s.set_allow_universal_access_from_file_urls(False)
    s.set_media_playback_requires_user_gesture(True)
    s.set_enable_fullscreen(False)
    s.set_enable_back_forward_navigation_gestures(False)
    s.set_enable_developer_extras(True)   # clic droit → Inspecter l'élément, comme isInspectable sur le Mac
    rgba = Gdk.RGBA()
    rgba.red, rgba.green, rgba.blue, rgba.alpha = FOND[0], FOND[1], FOND[2], 1.0
    vue.set_background_color(rgba)

    def politique(v, decision, genre):
        if genre == WebKit.PolicyDecisionType.RESPONSE:
            decision.use()
            return True
        action = decision.get_navigation_action()
        uri = action.get_request().get_uri() or ""
        if genre == WebKit.PolicyDecisionType.NAVIGATION_ACTION:
            if _meme_page(uri, page) or uri.startswith("about:") or uri == "btapercu://app/apercu.html":
                decision.use()
                return True
        if action.get_navigation_type() == WebKit.NavigationType.LINK_CLICKED and re.match(r"^https?://", uri, re.I):
            fenetre.ouvrir_lien(uri)     # un lien cliqué s'ouvre dans le navigateur, jamais dans la vue
        else:
            journal("navigation bloquée : %s" % uri[:200])
        decision.ignore()
        return True

    vue.connect("decide-policy", politique)
    vue.connect("create", lambda *a: None)
    return vue


# ---------------------------------------------------------------------------------------------------------------
# Schémas btmedia:// (Medias.swift) et btapercu:// (Apercu.swift)
# ---------------------------------------------------------------------------------------------------------------

TYPES_MEDIA = {
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
    "heic": "image/heic",
    "mp4": "video/mp4", "m4v": "video/x-m4v", "mov": "video/quicktime", "webm": "video/webm",
    "mp3": "audio/mpeg", "m4a": "audio/mp4", "aac": "audio/aac", "wav": "audio/wav", "flac": "audio/flac",
    "ogg": "audio/ogg", "oga": "audio/ogg", "opus": "audio/ogg",   # GStreamer lit l'Ogg : pas de conversion ici
}
MORCEAU_MAX = 32 * 1024 * 1024


def media_autorise(demande):
    """(chemin réel, type, taille) d'un fichier média autorisé, ou None : sous le home, extension image / vidéo /
    audio connue sur le chemin demandé ET sur le chemin réel (liens résolus), fichier ordinaire. Pas de SVG."""
    if not isinstance(demande, str) or not demande.startswith("/") or "\0" in demande or len(demande.encode()) > 4096:
        return None
    norm = os.path.normpath(demande)
    reel = os.path.realpath(norm)
    if not sous_home(norm) or not sous_home(reel, reel=True):
        return None
    ext = os.path.splitext(norm)[1][1:].lower()
    ext_reel = os.path.splitext(reel)[1][1:].lower()
    if ext not in TYPES_MEDIA or ext_reel not in TYPES_MEDIA:
        return None
    try:
        st = os.stat(reel)
    except OSError:
        return None
    if not stat.S_ISREG(st.st_mode):
        return None
    return reel, TYPES_MEDIA[ext], st.st_size


def plage(entete, taille):
    """None : en-tête illisible (tout le fichier) ; (None,) : plage hors du fichier (416) ; ((a, b),) sinon."""
    e = (entete or "").strip().lower()
    if not e.startswith("bytes="):
        return None
    premiere = e[6:].split(",")[0]
    if "-" not in premiere:
        return None
    a, b = [x.strip() for x in premiere.split("-", 1)]
    if a == "":
        if not b.isdigit() or int(b) <= 0:
            return None
        n = int(b)
        return (None,) if taille == 0 else ((taille - min(n, taille), taille - 1),)
    if not a.isdigit():
        return None
    a = int(a)
    if a >= taille:
        return (None,)
    fin = taille - 1
    if b:
        if not b.isdigit() or int(b) < a:
            return None
        fin = min(int(b), taille - 1)
    return ((a, fin),)


def repondre(requete, statut, flux=None, longueur=0, type_=None, entetes=None):
    if flux is None:
        flux, longueur = Gio.MemoryInputStream.new(), 0
    rep = WebKit.URISchemeResponse.new(flux, longueur)
    rep.set_status(statut, None)
    if type_:
        rep.set_content_type(type_)
    h = Soup.MessageHeaders.new(Soup.MessageHeadersType.RESPONSE)
    for k, v in (entetes or {}).items():
        h.append(k, v)
    rep.set_http_headers(h)
    requete.finish_with_response(rep)


def servir_media(requete):
    try:
        u = urlsplit(requete.get_uri())
        chemin = unquote(u.path)
        hote = (u.netloc or "").lower()
        if hote == "fichier":
            demande = chemin
        elif hote == "maison":
            demande = HOME + chemin
        else:
            journal("medias : refusé (hôte)")
            return repondre(requete, 404)
        f = media_autorise(demande)
        if not f:
            journal("medias : refusé (fichier non autorisé ou absent)")
            return repondre(requete, 404)
        reel, type_, taille = f
        entetes = {"Accept-Ranges": "bytes", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff"}
        h = requete.get_http_headers()
        r = plage(h.get_one("Range") if h else None, taille)
        debut, fin, partiel = 0, max(taille - 1, 0), False
        if r is not None:
            if r[0] is None:
                entetes["Content-Range"] = "bytes */%d" % taille
                return repondre(requete, 416, entetes=entetes)
            debut, fin = r[0]
            fin = min(fin, debut + MORCEAU_MAX - 1) if fin < taille - 1 else fin
            partiel = True
        longueur = 0 if taille == 0 else fin - debut + 1
        if partiel:
            entetes["Content-Range"] = "bytes %d-%d/%d" % (debut, fin, taille)
        if (requete.get_http_method() or "GET").upper() == "HEAD" or longueur == 0:
            return repondre(requete, 206 if partiel else 200, type_=type_, entetes=entetes)
        if fin == taille - 1:
            # jusqu'à la fin du fichier : flux lu par morceaux par WebKit, jamais chargé entier en mémoire
            flux = Gio.File.new_for_path(reel).read(None)
            if debut:
                flux.seek(debut, GLib.SeekType.SET, None)
        else:
            with open(reel, "rb") as fh:
                fh.seek(debut)
                donnees = fh.read(longueur)
            longueur = len(donnees)
            flux = Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(donnees))
        repondre(requete, 206 if partiel else 200, flux, longueur, type_, entetes)
    except Exception as e:
        journal("medias : erreur %r" % e)
        try:
            repondre(requete, 500)
        except Exception:
            pass


FICHIERS_APERCU = {
    "apercu.html": "text/html; charset=utf-8",
    "cadre.js": "text/javascript; charset=utf-8",
    "mermaid.js": "text/javascript; charset=utf-8",
    "chart.js": "text/javascript; charset=utf-8",
}
CSP_APERCU = ("default-src 'none'; script-src btapercu: 'unsafe-inline' 'unsafe-eval' https:; "
              "style-src btapercu: 'unsafe-inline' https:; img-src btapercu: data: blob: https:; "
              "font-src btapercu: data: https:; media-src data: blob: https:; connect-src https:; "
              "frame-src 'none'; form-action 'none'; object-src 'none'")
_CACHE_APERCU = {}


def servir_apercu(requete):
    """Cadre d'aperçu et ses bibliothèques, et rien d'autre : liste fermée de fichiers de ui/apercu/."""
    try:
        u = urlsplit(requete.get_uri())
        nom = u.path.rsplit("/", 1)[-1]
        if u.netloc != "app" or u.path != "/" + nom or nom not in FICHIERS_APERCU:
            return repondre(requete, 404)
        if nom not in _CACHE_APERCU:
            with open(os.path.join(dossier_ui(), "apercu", nom), "rb") as fh:
                _CACHE_APERCU[nom] = fh.read()
        d = _CACHE_APERCU[nom]
        repondre(requete, 200, Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(d)), len(d), FICHIERS_APERCU[nom],
                 {"Content-Security-Policy": CSP_APERCU, "Cache-Control": "max-age=3600"})
    except Exception as e:
        journal("apercu : erreur %r" % e)
        try:
            repondre(requete, 404)
        except Exception:
            pass


# ---------------------------------------------------------------------------------------------------------------
# Connexion au démon (lignes JSON sur le socket unix)
# ---------------------------------------------------------------------------------------------------------------

class Demon:
    def __init__(self, recevoir, etat):
        self.recevoir = recevoir          # ev (dict)
        self.etat = etat                  # (connecte: bool, texte: str)
        self.conn = None
        self.entree = None
        self.sortie = None
        self.file = []
        self.ecriture = False
        self.gen = 0
        self.canaux = 0
        self.dernier_demarrage = 0.0
        self.essai_programme = False
        self.debut_attente = None

    @property
    def connecte(self):
        return self.conn is not None

    def nouveau_canal(self):
        self.canaux += 1
        return "c%d" % self.canaux

    def connecter(self):
        self.essai_programme = False
        if self.conn:
            return
        chemin = chemin_socket()
        try:
            conn = Gio.SocketClient.new().connect(Gio.UnixSocketAddress.new(chemin), None)
        except GLib.Error as e:
            self._echec(chemin, e.message)
            return
        self.gen += 1
        self.conn = conn
        self.entree = Gio.DataInputStream.new(conn.get_input_stream())
        self.entree.set_newline_type(Gio.DataStreamNewlineType.LF)
        self.sortie = conn.get_output_stream()
        self.file, self.ecriture, self.debut_attente = [], False, None
        journal("démon : connecté (%s)" % chemin)
        self._lire(self.gen)
        self.envoyer({"op": "bonjour", "client": "gtk", "version": 1})
        self.envoyer({"op": "abonner"})
        self.etat(True, "")

    def _echec(self, chemin, raison):
        maintenant = time.monotonic()
        if self.debut_attente is None:
            self.debut_attente = maintenant
            journal("démon : injoignable (%s) — %s" % (chemin, raison))
        # Pas de socket : on démarre le service (sauf socket de test), puis on attend jusqu'à 5 s.
        if not os.environ.get("ULTRON_SOCK") and maintenant - self.dernier_demarrage > 30:
            self.dernier_demarrage = maintenant
            journal("démon : systemctl --user start ultron-moteur")
            lancer(["systemctl", "--user", "start", "ultron-moteur"])
        attente = maintenant - self.debut_attente
        self.etat(False, "Connexion au moteur Ultron…" if attente < 5 else
                  "Le moteur Ultron ne répond pas.\nNouvel essai toutes les 3 secondes.")
        self._programmer(250 if attente < 5 else 3000)

    def _programmer(self, ms):
        if self.essai_programme:
            return
        self.essai_programme = True
        GLib.timeout_add(ms, lambda: (self.connecter(), False)[1])

    def _lire(self, gen):
        self.entree.read_line_async(GLib.PRIORITY_DEFAULT, None, self._ligne, gen)

    def _ligne(self, source, res, gen):
        if gen != self.gen:
            return
        try:
            ligne, _n = source.read_line_finish_utf8(res)
        except GLib.Error as e:
            self._coupure("lecture : " + e.message)
            return
        if ligne is None:
            self._coupure("fin de flux")
            return
        if ligne.strip():
            try:
                ev = json.loads(ligne)
            except ValueError:
                journal("démon : ligne illisible ignorée (%d o)" % len(ligne))
                ev = None
            if isinstance(ev, dict) and isinstance(ev.get("ev"), str):
                try:
                    self.recevoir(ev)
                except Exception as e:
                    journal("démon : erreur sur « %s » — %r" % (ev.get("ev"), e))
        if gen == self.gen and self.entree:
            self._lire(gen)

    def envoyer(self, obj):
        if not self.sortie:
            return False
        self.file.append((json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
        if not self.ecriture:
            self._ecrire(self.gen)
        return True

    def _ecrire(self, gen):
        if not self.file or not self.sortie:
            self.ecriture = False
            return
        self.ecriture = True
        donnees = self.file.pop(0)
        self.sortie.write_all_async(donnees, GLib.PRIORITY_DEFAULT, None, self._ecrit, gen)

    def _ecrit(self, source, res, gen):
        if gen != self.gen:
            return
        try:
            source.write_all_finish(res)
        except GLib.Error as e:
            self._coupure("écriture : " + e.message)
            return
        self._ecrire(gen)

    def _coupure(self, raison):
        if not self.conn:
            return
        journal("démon : connexion perdue (%s)" % raison)
        self.gen += 1
        try:
            self.conn.close(None)
        except GLib.Error:
            pass
        self.conn = self.entree = self.sortie = None
        self.file, self.ecriture = [], False
        self.etat(False, "Connexion au moteur Ultron perdue.\nReconnexion…")
        self._programmer(1000)

    def fermer(self):
        self.gen += 1
        if self.conn:
            try:
                self.conn.close(None)
            except GLib.Error:
                pass
        self.conn = self.entree = self.sortie = None


# ---------------------------------------------------------------------------------------------------------------
# Une session affichée : page ui/index.html attachée à un canal du démon
# ---------------------------------------------------------------------------------------------------------------

LOT_JS = """
const lot = JSON.parse(lotJson);
const bt = window.bt;
if (!bt) { console.warn('window.bt absent'); return 0; }
let n = 0;
for (const [f, a] of lot) {
  try { if (typeof bt[f] === 'function') { bt[f](a); n++; } else console.warn('bt.' + f + ' absent'); }
  catch (e) { console.error('bt.' + f, e); }
}
return n;
"""

LOCALES = {"copier", "ouvrirLien", "ouvrirTerminal", "ouvrirShell", "choisirFichiers", "collerFichiers",
           "enregistrerPiece", "montrerFichier", "fermer"}


class PageSession:
    def __init__(self, fenetre, sid):
        self.f = fenetre
        self.id = sid
        self.canal = None
        self.prete = False
        self.file = []
        self.libere = False
        self.terminal = None              # passage au terminal en cours : {"cwd", "modele", "limite"}
        self.page = os.path.join(dossier_ui(), "index.html")
        self.pont = Pont(["bt", "medias"], self._message)
        self.vue = creer_vue(self.pont, self.page, fenetre)
        self.vue.connect("load-changed", self._chargement)
        self.vue.connect("web-process-terminated", self._crash)
        self.attacher()
        self.vue.load_uri(GLib.filename_to_uri(self.page, None))

    # -- démon --------------------------------------------------------------------------------------------------

    def attacher(self):
        if self.canal:
            self.f.canaux.pop(self.canal, None)
        self.canal = None
        if not self.f.demon.connecte:
            return
        self.canal = self.f.demon.nouveau_canal()
        self.f.canaux[self.canal] = self
        self.f.demon.envoyer({"op": "attacher", "sessionId": self.id, "canal": self.canal})

    def rattacher(self):
        """Après une reconnexion : nouveau canal, puis page rechargée (nouveau pret, le démon rejoue tout)."""
        self.attacher()
        self.prete = False
        self.file = []
        self.vue.reload()

    def detacher(self):
        if self.canal and self.f.demon.connecte:
            self.f.demon.envoyer({"op": "detacher", "canal": self.canal})
        self.f.canaux.pop(self.canal, None)
        self.canal = None

    def liberer(self):
        if self.libere:
            return
        self.libere = True
        self.detacher()
        try:
            self.vue.stop_loading()
        except Exception:
            pass

    def _chargement(self, vue, ev):
        if ev == WebKit.LoadEvent.STARTED:
            self.prete = False          # rechargement : la page enverra un nouveau « pret »

    def _crash(self, vue, raison):
        journal("session %s : processus web terminé (%s), rechargement" % (self.id[:8], raison))
        self.prete = False
        GLib.idle_add(lambda: (self.libere or self.vue.reload(), False)[1])

    # -- démon → page -------------------------------------------------------------------------------------------

    def appels(self, lot):
        if not isinstance(lot, list):
            return
        propres = []
        for x in lot:
            if not (isinstance(x, list) and len(x) == 2 and isinstance(x[0], str)):
                continue
            nom, arg = x
            if nom == "info" and isinstance(arg, dict):
                # La fenêtre GTK a sa propre barre de titre : pas de bande de 28 px pour les feux macOS.
                arg = dict(arg)
                arg["barreTitre"] = {"hauteur": 0, "gauche": 0}
                self.f.noter_info(self.id, arg)
            if nom == "fin" and isinstance(arg, dict) and arg.get("raison") == "terminal":
                GLib.idle_add(lambda: (self._ouvrir_terminal_pret(), False)[1])
            propres.append([nom, arg])
        if not propres:
            return
        if self.prete:
            self.executer(propres)
        else:
            self.file.extend(propres)

    def executer(self, lot):
        if self.libere or not lot:
            return
        args = GLib.Variant("a{sv}", {"lotJson": GLib.Variant("s", json.dumps(lot, ensure_ascii=False))})
        self.vue.call_async_javascript_function(LOT_JS, -1, args, None, None, None, self._lot_fini, len(lot))

    def _lot_fini(self, vue, res, n):
        try:
            vue.call_async_javascript_function_finish(res)
        except GLib.Error as e:
            journal("page : lot de %d appels en échec — %s" % (n, e.message))

    def pousser(self, nom, arg):
        """Appel local (fichiers, stderr) : direct si la page est prête, sinon en file."""
        if self.prete:
            self.executer([[nom, arg]])
        else:
            self.file.append([nom, arg])

    # -- page → app / démon -------------------------------------------------------------------------------------

    def _message(self, gestionnaire, m):
        if gestionnaire == "medias":
            if m.get("type") == "ouvrir":
                self.f.ouvrir_media(m.get("chemin"))
            return
        t = m["type"]
        if t == "pret":
            self.prete = True
            if not self.canal:
                self.attacher()
            if self.canal:
                self.f.demon.envoyer({"op": "page", "canal": self.canal, "message": m})
            f, self.file = self.file, []
            self.executer(f)
            return
        if t in LOCALES:
            self._locale(t, m)
            return
        if self.canal:
            self.f.demon.envoyer({"op": "page", "canal": self.canal, "message": m})
        else:
            journal("session %s : « %s » perdu, pas de canal" % (self.id[:8], t[:30]))
            if t == "versClaude":
                self.pousser("stderr", "Le moteur Ultron est injoignable : message non envoyé.\n")

    def _locale(self, t, m):
        f = self.f
        if t == "copier":
            texte = m.get("texte")
            if isinstance(texte, str) and len(texte) <= 20_000_000:
                f.copier(texte)
        elif t == "ouvrirLien":
            url = m.get("url")
            if isinstance(url, str) and re.match(r"^https?://[^/\s]+", url, re.I):
                f.ouvrir_lien(url)
        elif t == "ouvrirShell":
            cwd = dossier_valide(f.cwd_de(self.id) or "")
            if not cwd:
                self.pousser("stderr", "Dossier du projet introuvable.\n")
            elif not lancer(["gnome-terminal", "--working-directory=" + cwd]):
                self.pousser("stderr", "Le terminal n'a pas pu s'ouvrir.\n")
        elif t == "ouvrirTerminal":
            self._ceder()
        elif t == "fermer":
            f.fermer_session(self.id)
        elif t == "choisirFichiers":
            d = Gtk.FileDialog(title="Fichiers à envoyer à Claude", accept_label="Joindre", modal=True)
            d.open_multiple(f, None, self._fichiers_choisis)
        elif t == "collerFichiers":
            f.get_clipboard().read_value_async(Gdk.FileList, GLib.PRIORITY_DEFAULT, None, self._fichiers_colles)
        elif t == "enregistrerPiece":
            self._enregistrer_piece(m)
        elif t == "montrerFichier":
            c = m.get("chemin")
            if isinstance(c, str) and c.startswith("/") and len(c.encode()) <= 4096 and os.path.exists(c):
                Gtk.FileLauncher.new(Gio.File.new_for_path(c)).open_containing_folder(f, None, None)

    # -- fichiers joints ----------------------------------------------------------------------------------------

    def fichiers_recus(self, chemins, origine):
        images = {"image/png", "image/jpeg", "image/gif", "image/webp"}
        liste = []
        for p in chemins[:40]:
            try:
                st = os.stat(p)
            except OSError:
                continue
            dossier = stat.S_ISDIR(st.st_mode)
            mime = "" if dossier else (mimetypes.guess_type(p)[0] or "")
            d = {"chemin": p, "nom": os.path.basename(p) or p, "dossier": dossier, "mime": mime, "taille": st.st_size}
            if not dossier and mime in images and st.st_size <= 25_000_000:
                try:
                    with open(p, "rb") as fh:
                        d["donnees"] = base64.b64encode(fh.read()).decode("ascii")
                except OSError:
                    pass
            liste.append(d)
        journal("session %s : %d fichier(s) joint(s) (%s)" % (self.id[:8], len(liste), origine))
        self.pousser("fichiers", {"origine": origine, "liste": liste})

    def _fichiers_choisis(self, dialogue, res):
        try:
            modele = dialogue.open_multiple_finish(res)
        except GLib.Error:
            return    # annulé
        chemins = [modele.get_item(i).get_path() for i in range(modele.get_n_items())]
        self.fichiers_recus([c for c in chemins if c], "bouton")

    def _fichiers_colles(self, presse, res):
        try:
            valeur = presse.read_value_finish(res)
            fichiers = valeur.get_files() if hasattr(valeur, "get_files") else list(valeur or [])
            chemins = [x.get_path() for x in fichiers if x.get_path()]
        except Exception:
            chemins = []     # pas de fichier copié : la page garde ce qu'elle a
        self.fichiers_recus(chemins, "collage")

    def _enregistrer_piece(self, m):
        nom, b64 = m.get("nom"), m.get("donnees")
        if not isinstance(nom, str) or not isinstance(b64, str) or len(b64) > 60_000_000:
            journal("enregistrerPiece : invalide")
            return
        try:
            donnees = base64.b64decode(b64, validate=False)
        except (ValueError, TypeError):
            return
        propre = os.path.basename(nom).replace(":", "-")
        if not propre or propre.startswith(".") or len(propre.encode()) > 200:
            propre = "fichier"
        cache = os.environ.get("XDG_CACHE_HOME", os.path.join(HOME, ".cache"))
        dossier = os.path.join(cache, "ultron-terminal", "pieces", secrets.token_hex(4))
        try:
            os.makedirs(dossier, exist_ok=True)
            chemin = os.path.join(dossier, propre)
            with open(chemin, "wb") as fh:
                fh.write(donnees)
        except OSError as e:
            journal("enregistrerPiece : %s" % e)
            return
        self.fichiers_recus([chemin], "copie")

    # -- continuer dans un terminal -----------------------------------------------------------------------------

    def _ceder(self):
        if self.terminal or not UUID_RE.match(self.id):
            return
        cwd = dossier_valide(self.f.cwd_de(self.id) or "")
        if not cwd:
            self.pousser("stderr", "Dossier du projet introuvable : le terminal ne peut pas reprendre la session.\n")
            return
        if not self.f.demon.envoyer({"op": "ceder", "sessionId": self.id}):
            self.pousser("stderr", "Le moteur Ultron est injoignable.\n")
            return
        # Le démon arrête claude ; on attend sa confirmation (fin « terminal » ou dansTerminal dans la liste)
        # avant de relancer la même session dans le terminal. Au plus 8 s.
        self.terminal = {"cwd": cwd, "modele": self.f.modele_de(self.id)}
        GLib.timeout_add(8000, lambda: (self._ouvrir_terminal_pret(), False)[1])

    def _ouvrir_terminal_pret(self):
        t, self.terminal = self.terminal, None
        if not t:
            return
        transcript = any(p.is_file() for p in Path(HOME, ".claude/projects").glob("*/%s.jsonl" % self.id))
        cmd = "cd %s && %s --dangerously-skip-permissions %s %s" % (
            shlex.quote(t["cwd"]), shlex.quote(CLAUDE), "--resume" if transcript else "--session-id", shlex.quote(self.id))
        if t["modele"] and MODELE_RE.match(t["modele"]):
            cmd += " --model " + shlex.quote(t["modele"])
        cmd += "; exec bash -l"
        ok = lancer(["gnome-terminal", "--working-directory=" + t["cwd"], "--", "bash", "-lc", cmd])
        journal("session %s : terminal → %s" % (self.id[:8], "ok" if ok else "échec"))
        if not ok:
            self.pousser("stderr", "Le terminal n'a pas pu s'ouvrir.\n")

    def terminal_en_attente(self):
        return self.terminal is not None


# ---------------------------------------------------------------------------------------------------------------
# La fenêtre
# ---------------------------------------------------------------------------------------------------------------

CSS = b"""
window.ut-principale { background: #0B0A0C; color: #EFE9DD; }
.ut-trait { background: rgba(157, 180, 200, .28); min-width: 1px; }
.ut-vide { color: #8C8476; font-size: 14px; }
"""


class FenetreUltron(Gtk.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title=TITRE, default_width=1220, default_height=820)
        self.add_css_class("ut-principale")
        self.set_size_request(760, 420)
        self.set_icon_name("ultron-terminal")
        self.sessions = []            # dernière liste du démon
        self.pages = {}               # sessionId → PageSession
        self.canaux = {}              # canal → PageSession
        self.recentes = {}            # sessionId → instant d'ouverture (la liste peut arriver juste après)
        self.selection = None
        self.non_lues = set()
        self.etats = {}
        self.infos = {}
        self.demandes = {}
        self.req = 0
        self.barre_prete = False
        self.premiere_liste = True
        self.memoire = lire_etat()
        self.maj_prevue = False

        self.demon = Demon(self._ev, self._etat_demon)

        racine = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        self.page_barre = os.path.join(dossier_ui(), "sessions.html")
        self.pont_barre = Pont(["barre"], self._message_barre)
        self.barre = creer_vue(self.pont_barre, self.page_barre, self)
        self.barre.set_size_request(LARGEUR_BARRE, -1)
        self.barre.set_hexpand(False)
        self.barre.connect("load-changed", self._barre_charge)
        self.barre.connect("web-process-terminated", lambda v, r: (setattr(self, "barre_prete", False), v.reload()))
        trait = Gtk.Box()
        trait.add_css_class("ut-trait")
        self.pile = Gtk.Stack(hexpand=True, vexpand=True, transition_type=Gtk.StackTransitionType.NONE)
        self.vide = Gtk.Label(label="Connexion au moteur Ultron…", justify=Gtk.Justification.CENTER)
        self.vide.add_css_class("ut-vide")
        self.pile.add_named(self.vide, "vide")
        racine.append(self.barre)
        racine.append(trait)
        racine.append(self.pile)
        self.set_child(racine)
        self._raccourcis()
        self.connect("notify::is-active", lambda *a: self._fenetre_active())
        self.connect("close-request", self._fermeture)
        self.barre.load_uri(GLib.filename_to_uri(self.page_barre, None))
        GLib.idle_add(lambda: (self.demon.connecter(), False)[1])

    # -- démon --------------------------------------------------------------------------------------------------

    def _etat_demon(self, connecte, texte):
        if connecte:
            for p in list(self.pages.values()):
                p.rattacher()
            self._maj_vide()
        else:
            for p in self.pages.values():
                p.canal = None
            self.canaux.clear()
            for req, cb in list(self.demandes.items()):
                self.demandes.pop(req, None)
                cb({"ev": "erreur", "message": "Connexion au moteur Ultron perdue."})
            self.vide.set_label(texte)
            if not self.pages:
                self.pile.set_visible_child_name("vide")

    def _ev(self, ev):
        e = ev["ev"]
        if e == "liste":
            self._liste(ev.get("sessions"))
        elif e == "page":
            p = self.canaux.get(ev.get("canal"))
            if p:
                p.appels(ev.get("appels"))
        elif e in ("ouverte", "erreur", "dossiers") and ev.get("req") in self.demandes:
            self.demandes.pop(ev["req"])(ev)
        elif e == "erreur":
            journal("démon : erreur — %s" % str(ev.get("message"))[:300])
        elif e == "bonjour":
            journal("démon : bonjour (machine %s, version %s)" % (ev.get("machine"), ev.get("version")))

    def demander(self, obj, rappel):
        self.req += 1
        req = "r%d" % self.req
        obj = dict(obj, req=req)
        self.demandes[req] = rappel
        if not self.demon.envoyer(obj):
            self.demandes.pop(req, None)
            rappel({"ev": "erreur", "message": "Le moteur Ultron est injoignable."})

    # -- sessions -----------------------------------------------------------------------------------------------

    def _liste(self, sessions):
        sessions = [s for s in (sessions or []) if isinstance(s, dict) and UUID_RE.match(str(s.get("id", "")))]
        for s in sessions:
            s["id"] = s["id"].lower()
        ids = {s["id"] for s in sessions}
        maintenant = time.monotonic()
        for s in sessions:
            avant = self.etats.get(s["id"])
            if avant == "travaille" and s.get("etat") in ("pret", "attend", "termine") and \
                    not (s["id"] == self.selection and self.is_active()):
                self.non_lues.add(s["id"])
            self.etats[s["id"]] = s.get("etat")
            p = self.pages.get(s["id"])
            if p and p.terminal_en_attente() and s.get("dansTerminal"):
                p._ouvrir_terminal_pret()
        self.sessions = sessions
        for sid in list(self.pages):
            if sid not in ids and maintenant - self.recentes.get(sid, 0) > 5:
                self._retirer_page(sid)
        self.non_lues &= ids | set(self.pages)
        if self.premiere_liste:
            self.premiere_liste = False
            voulue = self.memoire.get("page")
            if voulue in ids:
                self.choisir(voulue)
            elif sessions:
                self.choisir(sessions[0]["id"])
        elif self.selection is None and sessions and not self.pages:
            pass
        self._maj_vide()
        self.planifier_maj()

    def _connue(self, sid):
        return sid in self.pages or any(s["id"] == sid for s in self.sessions)

    def choisir(self, sid):
        if not isinstance(sid, str) or not UUID_RE.match(sid):
            return
        sid = sid.lower()
        if not self._connue(sid) and sid not in self.recentes:
            return
        p = self.pages.get(sid)
        if not p:
            p = PageSession(self, sid)
            self.pages[sid] = p
            self.pile.add_named(p.vue, sid)
        self.selection = sid
        self.pile.set_visible_child(p.vue)
        self.non_lues.discard(sid)
        p.vue.grab_focus()
        self.memoire["page"] = sid
        ecrire_etat(self.memoire)
        self.planifier_maj()

    def _retirer_page(self, sid):
        p = self.pages.pop(sid, None)
        if not p:
            return
        p.liberer()
        self.pile.remove(p.vue)
        self.recentes.pop(sid, None)
        if self.selection == sid:
            self.selection = None
            reste = [s["id"] for s in self.sessions if s["id"] != sid]
            if reste:
                self.choisir(reste[0])
        self._maj_vide()

    def _maj_vide(self):
        if self.selection is None:
            if self.demon.connecte:
                self.vide.set_label("Aucune session ouverte.\nCtrl+N pour en ouvrir une." if not self.sessions
                                    else "Choisissez une session à gauche.")
            self.pile.set_visible_child_name("vide")

    def ouvrir_session(self, cwd, prompt=None, rappel=None):
        """op ouvrir ; rappel(None) si la session est ouverte, rappel(texte d'erreur) sinon (alerte par défaut)."""
        def recu(ev):
            if ev.get("ev") == "ouverte" and isinstance(ev.get("sessionId"), str) and UUID_RE.match(ev["sessionId"]):
                sid = ev["sessionId"].lower()
                self.recentes[sid] = time.monotonic()
                self.choisir(sid)
                if rappel:
                    rappel(None)
            else:
                texte = str(ev.get("message") or "Le moteur Ultron a refusé la session.")
                if rappel:
                    rappel(texte)
                else:
                    self.alerte("Session impossible", texte)
        self.demander({"op": "ouvrir", "cwd": cwd, "resume": None, "prompt": prompt, "modele": None, "effort": None},
                      recu)

    def fermer_session(self, sid):
        if isinstance(sid, str) and UUID_RE.match(sid):
            self.demon.envoyer({"op": "fermer", "sessionId": sid.lower()})

    def nouvelle(self):
        """Ctrl+N : le panneau « Nouvelle session » de la barre (sessions.js, agent C) fait le travail."""
        if self.barre_prete:
            self.barre_js("document.getElementById('nouvelle').click();")

    def barre_js(self, code, **valeurs):
        """Exécute du JS dans la barre ; les valeurs passent en JSON (chaînes), jamais collées dans le code."""
        if not self.barre_prete:
            return
        args = GLib.Variant("a{sv}", {k: GLib.Variant("s", json.dumps(v, ensure_ascii=False)) for k, v in valeurs.items()})
        self.barre.call_async_javascript_function(code, -1, args, None, None, None, self._maj_finie, None)

    def _barre_dossiers(self):
        def recu(ev):
            r = {"home": HOME, "liste": []}
            if ev.get("ev") == "dossiers":
                r["liste"] = [d for d in ev.get("liste") or [] if isinstance(d, dict) and isinstance(d.get("cwd"), str)]
            else:
                r["erreur"] = str(ev.get("message") or "Dossiers récents indisponibles.")
            self.barre_js("if (window.barreSessions) window.barreSessions.dossiers(JSON.parse(r));", r=r)
        self.demander({"op": "dossiers"}, recu)

    def _barre_nouvelle(self, cwd):
        def erreur(texte):
            self.barre_js("if (window.barreSessions) window.barreSessions.erreur(JSON.parse(t));", t=texte)
        if not isinstance(cwd, str):
            return erreur("Chemin manquant.")
        cwd = cwd.strip()
        if cwd == "~" or cwd.startswith("~/"):
            cwd = HOME + cwd[1:]
        c = dossier_valide(cwd)
        if not c:
            return erreur("Dossier introuvable ou hors de %s : %s" % (HOME, cwd.replace(HOME, "~", 1)))
        if not self.demon.connecte:
            return erreur("Le moteur Ultron est injoignable.")

        def fini(texte):
            if texte:
                erreur(texte)
            else:
                self.barre_js("if (window.barreSessions) window.barreSessions.ouverte(JSON.parse(c));", c=c)
        self.ouvrir_session(c, rappel=fini)

    def nouvelle_discussion(self):
        try:
            os.makedirs(DOSSIER_DISCUSSIONS, exist_ok=True)
            consigne = os.path.join(DOSSIER_DISCUSSIONS, "CLAUDE.md")
            if not os.path.exists(consigne):
                with open(consigne, "w", encoding="utf-8") as fh:
                    fh.write("# Discussions libres\n\nCe dossier n'est pas un projet : ce sont des conversations libres "
                             "avec Eliot (questions, idées, recherche). Pas de to-do de projet ici. Ne crée pas de "
                             "fichiers dans ce dossier sauf si Eliot le demande.\n")
        except OSError as e:
            self.alerte("Discussion impossible", "Le dossier %s ne peut pas être créé : %s" % (DOSSIER_DISCUSSIONS, e))
            return
        self.ouvrir_session(os.path.realpath(DOSSIER_DISCUSSIONS))

    def noter_info(self, sid, info):
        self.infos[sid] = info

    def _session(self, sid):
        return next((s for s in self.sessions if s["id"] == sid), None)

    def cwd_de(self, sid):
        s = self._session(sid)
        return (s or {}).get("cwd") or self.infos.get(sid, {}).get("cwd")

    def modele_de(self, sid):
        s = self._session(sid)
        return (s or {}).get("modele") or self.infos.get(sid, {}).get("modele")

    def decaler(self, pas):
        ids = [s["id"] for s in self.sessions]
        if not ids:
            return
        i = ids.index(self.selection) if self.selection in ids else (-1 if pas > 0 else 0)
        self.choisir(ids[(i + pas) % len(ids)])

    # -- barre des sessions -------------------------------------------------------------------------------------

    def _barre_charge(self, vue, ev):
        if ev == WebKit.LoadEvent.STARTED:
            self.barre_prete = False

    def _message_barre(self, _g, m):
        t = m["type"]
        if t == "pret":
            self.barre_prete = True
            # Config posée par sessions.js (agent C) : titre « Ultron Terminal », pas de choix Mac / Victus.
            self.barre_js("if (window.barreSessions && window.barreSessions.config) "
                          "window.barreSessions.config({app:'ultron-terminal', machine:'victus', choixMachine:false});")
            self.envoyer_liste()
        elif t == "choisir":
            self.choisir(m.get("id"))
        elif t == "fermer":
            self.fermer_session(m.get("id"))
        elif t == "dossiers":
            self._barre_dossiers()
        elif t == "nouvelle":
            if "cwd" in m:
                self._barre_nouvelle(m.get("cwd"))
            else:
                self.nouvelle()     # barre du Mac (choixMachine) : n'arrive pas ici, le panneau s'ouvre seul
        elif t == "discussion":
            self.nouvelle_discussion()
        elif t == "jarvis":
            pass   # pas de conversation Telegram sur le Victus
        else:
            journal("barre : type inconnu « %s »" % t[:30])

    def planifier_maj(self):
        if self.maj_prevue:
            return
        self.maj_prevue = True

        def faire():
            self.maj_prevue = False
            self.envoyer_liste()
            return False
        GLib.timeout_add(80, faire)

    def envoyer_liste(self):
        if not self.barre_prete:
            return
        liste = []
        for i, s in enumerate(self.sessions):
            d = dict(s)
            d.update(numero=i + 1, actif=s["id"] == self.selection, nonLu=s["id"] in self.non_lues)
            liste.append(d)
        args = GLib.Variant("a{sv}", {"liste": GLib.Variant("s", json.dumps(liste, ensure_ascii=False))})
        self.barre.call_async_javascript_function(
            "if (window.barreSessions) window.barreSessions.maj(JSON.parse(liste), null);",
            -1, args, None, None, None, self._maj_finie, None)

    def _maj_finie(self, vue, res, _d):
        try:
            vue.call_async_javascript_function_finish(res)
        except GLib.Error as e:
            journal("barre : mise à jour en échec — %s" % e.message)

    # -- actions locales ----------------------------------------------------------------------------------------

    def copier(self, texte):
        presse = self.get_clipboard()
        try:
            presse.set(texte)
        except Exception:
            presse.set_content(Gdk.ContentProvider.new_for_bytes("text/plain;charset=utf-8",
                                                                  GLib.Bytes.new(texte.encode("utf-8"))))

    def ouvrir_lien(self, url):
        if not re.match(r"^https?://[^/\s]+", url or "", re.I):
            return

        def fini(l, res, *a):
            try:
                l.launch_finish(res)
            except GLib.Error as e:
                journal("lien : ouverture en échec — %s" % e.message)
        Gtk.UriLauncher.new(url).launch(self, None, fini)

    def ouvrir_media(self, chemin):
        if not isinstance(chemin, str):
            return
        if chemin.startswith("~/"):
            chemin = HOME + chemin[1:]
        f = media_autorise(chemin)
        if not f:
            journal("medias : ouverture refusée")
            return
        Gtk.FileLauncher.new(Gio.File.new_for_path(f[0])).launch(self, None, None)

    def alerte(self, titre, texte):
        journal("alerte : %s — %s" % (titre, texte))
        d = Gtk.AlertDialog(message=titre, detail=texte, modal=True)
        d.show(self)

    # -- fenêtre ------------------------------------------------------------------------------------------------

    def _raccourcis(self):
        c = Gtk.ShortcutController(propagation_phase=Gtk.PropagationPhase.CAPTURE)

        def ajouter(declencheur, fonction):
            c.add_shortcut(Gtk.Shortcut(trigger=Gtk.ShortcutTrigger.parse_string(declencheur),
                                        action=Gtk.CallbackAction.new(lambda *a: (fonction(), True)[1])))
        ajouter("<Control>n", self.nouvelle)
        ajouter("<Control><Shift>n", self.nouvelle_discussion)
        ajouter("<Control>Tab", lambda: self.decaler(1))
        ajouter("<Control><Shift>ISO_Left_Tab", lambda: self.decaler(-1))
        ajouter("<Control>Page_Down", lambda: self.decaler(1))
        ajouter("<Control>Page_Up", lambda: self.decaler(-1))
        ajouter("<Control><Shift>w", lambda: self.selection and self.fermer_session(self.selection))
        ajouter("<Control>r", lambda: self.selection in self.pages and self.pages[self.selection].vue.reload())
        ajouter("<Control>q", self.close)
        for n in range(1, 10):
            ajouter("<Control>%d" % n, lambda n=n: len(self.sessions) >= n and self.choisir(self.sessions[n - 1]["id"]))
        self.add_controller(c)

    def _fenetre_active(self):
        if self.is_active() and self.selection in self.non_lues:
            self.non_lues.discard(self.selection)
            self.planifier_maj()

    def _fermeture(self, *_a):
        # Les sessions vivent dans le démon : fermer la fenêtre ne les arrête pas.
        for p in list(self.pages.values()):
            p.liberer()
        self.demon.fermer()
        return False


class UltronApp(Gtk.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.DEFAULT_FLAGS)
        self.fenetre = None

    def do_startup(self):
        Gtk.Application.do_startup(self)
        GLib.set_application_name(TITRE)
        reglages = Gtk.Settings.get_default()
        if reglages:
            reglages.set_property("gtk-application-prefer-dark-theme", True)
        css = Gtk.CssProvider()
        css.load_from_data(CSS, len(CSS))
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
                                                  Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        ctx = WebKit.WebContext.get_default()
        ctx.register_uri_scheme("btmedia", servir_media)
        ctx.register_uri_scheme("btapercu", servir_apercu)
        journal("app : démarrage (ui %s, socket %s, bac à sable WebKit %s)" % (
            dossier_ui(), chemin_socket(),
            "coupé" if os.environ.get("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS") else "actif"))

    def do_activate(self):
        if not self.fenetre:
            self.fenetre = FenetreUltron(self)
        self.fenetre.present()


def main():
    return UltronApp().run([sys.argv[0]])


if __name__ == "__main__":
    sys.exit(main())
