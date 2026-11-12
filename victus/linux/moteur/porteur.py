#!/usr/bin/env python3
"""Porteur d'une session : tient le processus claude et ses tubes, pour que le démon puisse redémarrer
(déploiement, plantage) sans tuer la session.

Lancé par ultron_moteur.py : `python3 porteur.py <cle>`, la description arrive en JSON sur stdin
(jamais en argv : `pgrep -f "--resume <id>"` ne doit pas trouver le porteur). Il se détache (double fork).
  {"cle", "sock", "exe", "args", "cwd", "env", "sessionId", "modele", "effort"}

Le démon se connecte au socket unix `sock` (0600). Trames, une par ligne, préfixées d'un octet :
  porteur → démon : B{json}  bonjour (pid, sessionId, cwd, modele, effort, tour, debutTour)
                    O<ligne> stdout de claude, E<ligne> stderr, F<code> fin du processus
  démon → porteur : I<ligne> à écrire sur stdin, S arrêt propre, K arrêt immédiat
Sans démon connecté, les trames attendent en mémoire (64 Mo au plus : le flux de jetons part d'abord).
Une seule connexion à la fois : la nouvelle remplace l'ancienne. Après la fin de claude, le porteur
attend un démon 10 min au plus pour lui remettre la fin, puis s'en va.
"""
import asyncio
import collections
import json
import os
import signal
import sys
import time

LIMITE = 32 * 1024 * 1024
TAMPON_MAX = 64 * 1024 * 1024


def journal(m):
    print(time.strftime("%H:%M:%S"), "porteur", os.getpid(), m, file=sys.stderr, flush=True)


def type_de(l: bytes):
    """Type d'une ligne stream-json. Le plus souvent la clé vient en tête ; pas toujours (le `result` d'une erreur
    d'authentification commence par "duration_api_ms"), d'où le repli sur le JSON complet."""
    if l.startswith(b'{"type":"'):
        e = l.find(b'"', 9)
        return l[9:e] if e > 0 else None
    try:
        t = json.loads(l).get("type")
        return t.encode() if isinstance(t, str) else None
    except Exception:
        return None


class Porteur:
    def __init__(self, spec):
        self.spec = spec
        self.proc = None
        self.client = None          # StreamWriter du démon connecté
        self.attente = collections.deque()
        self.taille = 0
        self.code = None
        self.fin_remise = asyncio.Event()
        self.arret = False
        self.tour = False
        self.debut_tour = None

    # --- trames vers le démon

    def emettre(self, trame: bytes):
        if self.client is not None and not self.client.is_closing():
            try:
                self.client.write(trame)
                return
            except Exception:
                self.client = None
        self.attente.append(trame)
        self.taille += len(trame)
        if self.taille > TAMPON_MAX:
            # le flux de jetons est redondant (les lignes assistant le remplacent)
            garde = collections.deque(t for t in self.attente if not t.startswith(b'O{"type":"stream_event"'))
            self.attente = garde
            self.taille = sum(len(t) for t in garde)
            while self.taille > TAMPON_MAX and self.attente:
                self.taille -= len(self.attente.popleft())

    def noter_sortie(self, l: bytes):
        t = type_de(l)
        if t == b"result":
            self.tour, self.debut_tour = False, None
        elif t in (b"stream_event", b"assistant"):
            if not self.tour:
                self.debut_tour = time.time() * 1000
            self.tour = True

    async def lire(self, flux, prefixe: bytes):
        while True:
            try:
                l = await flux.readuntil(b"\n")
            except asyncio.IncompleteReadError as e:
                l = e.partial
                if l:
                    self.emettre(prefixe + l.rstrip(b"\r\n").replace(b"\n", b" ") + b"\n")
                return
            except asyncio.LimitOverrunError as e:
                # ligne démesurée : on la jette (elle ne passerait pas dans la page de toute façon)
                await flux.readexactly(e.consumed)
                continue
            l = l.rstrip(b"\r\n")
            if not l:
                continue
            if prefixe == b"O":
                self.noter_sortie(l)
            self.emettre(prefixe + l + b"\n")

    # --- connexion du démon

    async def connexion(self, r, w):
        ancien = self.client
        self.client = w
        if ancien is not None and ancien is not w:
            try:
                ancien.close()
            except Exception:
                pass
        b = {"pid": self.proc.pid if self.proc else None, "sessionId": self.spec.get("sessionId"),
             "cwd": self.spec.get("cwd"), "modele": self.spec.get("modele"), "effort": self.spec.get("effort"),
             "tour": self.tour, "debutTour": self.debut_tour, "cle": self.spec.get("cle"),
             "fini": self.code is not None}
        w.write(b"B" + json.dumps(b).encode() + b"\n")
        while self.attente:
            t = self.attente.popleft()
            self.taille -= len(t)
            w.write(t)
        try:
            await w.drain()
        except Exception:
            pass
        if self.code is not None:
            self.fin_remise.set()
        try:
            while True:
                try:
                    l = await r.readuntil(b"\n")
                except asyncio.LimitOverrunError as e:
                    await r.readexactly(e.consumed)
                    continue
                except asyncio.IncompleteReadError:
                    break
                l = l.rstrip(b"\r\n")
                if not l:
                    continue
                k, corps = l[:1], l[1:]
                if k == b"I":
                    await self.ecrire(corps)
                elif k == b"S":
                    self.arreter()
                elif k == b"K":
                    self.tuer()
        except (ConnectionError, OSError):
            pass
        finally:
            if self.client is w:
                self.client = None

    async def ecrire(self, ligne: bytes):
        p = self.proc
        if p is None or p.returncode is not None or p.stdin is None or p.stdin.is_closing():
            return
        if ligne.startswith(b'{"type":"user"'):
            if not self.tour:
                self.debut_tour = time.time() * 1000
            self.tour = True
        try:
            p.stdin.write(ligne + b"\n")
            await p.stdin.drain()
        except (ConnectionError, OSError, RuntimeError):
            pass

    # --- arrêt

    def signaler(self, sig):
        p = self.proc
        if p is None or p.returncode is not None:
            return
        for f in (lambda: os.killpg(p.pid, sig), lambda: os.kill(p.pid, sig)):
            try:
                f()
            except (ProcessLookupError, PermissionError):
                pass

    def arreter(self):
        """Fin de stdin (claude termine de lui-même), SIGTERM au groupe après 2 s, SIGKILL après 5 s."""
        if self.arret or self.proc is None or self.proc.returncode is not None:
            return
        self.arret = True
        journal("arrêt : fin de stdin")
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        boucle = asyncio.get_running_loop()
        boucle.call_later(2, self.signaler, signal.SIGTERM)
        boucle.call_later(5, self.signaler, signal.SIGKILL)

    def tuer(self):
        self.arret = True
        self.signaler(signal.SIGKILL)

    # --- vie du porteur

    async def principal(self):
        s = self.spec
        sock = s["sock"]
        try:
            os.unlink(sock)
        except FileNotFoundError:
            pass
        ancien = os.umask(0o177)
        try:
            serveur = await asyncio.start_unix_server(self.connexion, path=sock, limit=LIMITE)
        finally:
            os.umask(ancien)
        os.chmod(sock, 0o600)
        self.proc = await asyncio.create_subprocess_exec(
            s["exe"], *s["args"], cwd=s["cwd"], env=s["env"],
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            start_new_session=True, limit=LIMITE)
        journal(f"claude pid {self.proc.pid} lancé ({s.get('sessionId')})")
        lectures = [asyncio.create_task(self.lire(self.proc.stdout, b"O")),
                    asyncio.create_task(self.lire(self.proc.stderr, b"E"))]
        rc = await self.proc.wait()
        # un petit-enfant peut garder stdout ouvert : pas plus d'1 s d'attente des lectures
        await asyncio.wait(lectures, timeout=1)
        self.code = rc if rc >= 0 else 128 - rc
        if self.arret:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)   # ménage : enfants restés dans le groupe
            except (ProcessLookupError, PermissionError):
                pass
        journal(f"claude terminé, code {self.code}")
        self.emettre(b"F" + str(self.code).encode() + b"\n")
        if self.client is not None:
            try:
                await self.client.drain()
            except Exception:
                pass
            self.fin_remise.set()
        try:
            await asyncio.wait_for(self.fin_remise.wait(), timeout=600)
        except asyncio.TimeoutError:
            journal("fin non remise (aucun démon en 10 min)")
        await asyncio.sleep(0.3)
        serveur.close()
        try:
            os.unlink(sock)
        except FileNotFoundError:
            pass


def main():
    spec = json.loads(sys.stdin.buffer.read().decode())
    sys.stdin.close()
    # détaché du démon : le parent rend la main tout de suite, l'enfant est adopté par le gestionnaire systemd
    if os.fork() > 0:
        os._exit(0)
    try:
        os.setsid()
    except OSError:
        pass
    # le démon peut redémarrer : on ne meurt pas avec lui
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    asyncio.run(Porteur(spec).principal())


if __name__ == "__main__":
    main()
