#!/usr/bin/env node
/* Banc de la fin d'énoncé intelligente (mode vocal mains libres), dans Chrome headless, sans son.
 *   python3 -m http.server 8792   (racine du projet, en arrière-plan)
 *   node ui/tests/banc-enonce.js [port]      (code de sortie 1 si un contrôle échoue)
 * Simule la coque (bt.vocalDirect / bt.transcription) et claude (lignes stream-json) :
 *   1. attente → « … j’attends la suite », partiel pendant l'attente, reprise, fini → une seule vraie bulle ;
 *   2. filet : message vocal, debut suite:true sans texte de Claude → interrupt, fragment retiré, UN message fusionné
 *      (2b : la transcription arrive avant le result de l'interruption) ;
 *   3. Claude a déjà écrit → pas d'interruption, deux messages ;
 *   4. annule après l'interruption → le fragment repart seul.
 * Captures : /tmp/bt-enonce-*.png */
'use strict';
const { chromium } = require('/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright');

const PORT = process.argv[2] || '8792';
const URL = `http://localhost:${PORT}/ui/index.html?fixture=aucune&vocal=1&vitesse=0&auto=0`;
let ko = 0;
function controle(nom, vrai, detail) {
  if (!vrai) ko++;
  console.log(`${vrai ? ' ok ' : ' KO '} ${nom}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/* Faux claude, installé dans la page : capte ce que la page écrit et répond selon T.mode. */
function installer() {
  const BT = window.BT, T = window.T = { lignes: [], mode: 'silence', delaiInterruption: 80 };
  const vers = (o) => window.bt.depuisClaude(JSON.stringify(o));
  T.vers = vers;
  T.finTour = () => vers({ type: 'result', subtype: 'success', is_error: false, duration_ms: 500 });
  T.texteClaude = (t) => {
    const id = 'msg_' + Date.now();
    vers({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
    vers({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    vers({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } });
  };
  const orig = BT.fauxPont.recevoir;
  BT.fauxPont.recevoir = function (msg) {
    if (msg.type !== 'versClaude') return orig(msg);
    const o = JSON.parse(msg.ligne);
    T.lignes.push(o);
    if (o.type === 'control_request') {
      const st = o.request.subtype;
      vers({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: st === 'initialize' ? { commands: [], account: {} } : {} } });
      if (st === 'interrupt') {
        setTimeout(() => {
          vers({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null });
          vers({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', duration_ms: 0 });
        }, T.delaiInterruption);
      }
      return;
    }
    if (o.type === 'user') {
      vers({ type: 'system', subtype: 'status', status: 'requesting' });
      if (T.mode === 'texte') T.texteClaude('Je regarde.');
    }
  };
  T.users = () => T.lignes.filter((o) => o.type === 'user')
    .map((o) => o.message.content.map((c) => c.text || '').join('').split('\n\n<mode-vocal>')[0]);
  T.interrupts = () => T.lignes.filter((o) => o.type === 'control_request' && o.request.subtype === 'interrupt').length;
  T.bulles = () => Array.from(document.querySelectorAll('#fil > .tour-eliot:not(.vd-fantome)'))
    .filter((n) => getComputedStyle(n).display !== 'none').map((n) => (n.querySelector('.bulle-texte') || n).textContent.trim());
  T.fantome = () => BT.app.vocalDirect.etatTest();
  T.vd = (d) => window.bt.vocalDirect(d);
  T.tr = (d) => window.bt.transcription(d);
}

(async () => {
  const navigateur = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
  const page = await navigateur.newPage({ viewport: { width: 900, height: 700 } });
  const erreurs = [];
  page.on('pageerror', (e) => erreurs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) erreurs.push(m.text()); }); // 404 : fixture « aucune », voulu
  await page.goto(URL);
  await page.waitForFunction(() => document.documentElement.classList.contains('lecture-finie'));
  await page.evaluate(installer);
  const ev = (f, a) => page.evaluate(f, a);

  /* ---------- 1. attente / reprise ---------- */
  console.log('1. attente et reprise');
  await ev(() => { T.mode = 'texte'; T.vd({ id: 1, etat: 'debut', source: 'mainsLibres' }); T.vd({ id: 1, etat: 'partiel', texte: 'Est-ce que tu peux' }); });
  await pause(500);
  await ev(() => T.vd({ id: 1, etat: 'attente', texte: 'Est-ce que tu peux' }));
  await pause(350);
  let f = await ev(() => Object.assign(T.fantome(), { classe: document.querySelector('.vd-fantome').className }));
  controle('libellé « … j’attends la suite »', f && f.libelle === '… j’attends la suite' && f.etat === 'attente', f && f.libelle);
  controle('classe vd-attend, sans animation en boucle', /vd-attend/.test(f.classe) &&
    (await ev(() => document.querySelector('.vd-fantome').getAnimations({ subtree: true }).filter((a) => a.effect.getTiming().iterations === Infinity).length)) === 0);
  await page.screenshot({ path: '/tmp/bt-enonce-attente.png' });
  await ev(() => T.vd({ id: 1, etat: 'partiel', texte: 'Est-ce que tu peux regarder' }));
  await pause(500);
  f = await ev(() => T.fantome());
  controle('partiel pendant l’attente : texte mis à jour, toujours en attente', f.texte.trim() === 'Est-ce que tu peux regarder' && f.etat === 'attente', f.texte);
  await ev(() => T.vd({ id: 1, etat: 'reprise' }));
  f = await ev(() => T.fantome());
  controle('reprise → « Jarvis écoute »', f.libelle === 'Jarvis écoute' && f.etat === 'ecoute', f.libelle);
  await ev(() => { T.vd({ id: 1, etat: 'partiel', texte: 'Est-ce que tu peux regarder le fichier' }); T.vd({ id: 1, etat: 'attente' }); T.vd({ id: 1, etat: 'transcription' }); T.vd({ id: 1, etat: 'reprise' }); });
  f = await ev(() => T.fantome());
  controle('reprise après transcription → écoute', f.etat === 'ecoute');
  await pause(600);
  await ev(() => { T.vd({ id: 1, etat: 'transcription' }); T.vd({ id: 1, etat: 'fini', texte: 'Est-ce que tu peux regarder le fichier ?' }); T.tr({ texte: 'Est-ce que tu peux regarder le fichier ?' }); });
  await pause(400);
  let r = await ev(() => ({ bulles: T.bulles(), fantome: T.fantome(), users: T.users(), fantomes: document.querySelectorAll('.vd-fantome').length }));
  controle('fini → une seule vraie bulle, plus de fantôme', r.bulles.length === 1 && !r.fantome && r.fantomes === 0 && r.users.length === 1, r.bulles);
  await ev(() => T.finTour());
  await pause(200);

  /* ---------- 2. filet : raccord ---------- */
  async function messageVocal(id, texte) {
    await ev(([id, texte]) => { T.vd({ id, etat: 'debut', source: 'mainsLibres' }); T.vd({ id, etat: 'partiel', texte }); T.vd({ id, etat: 'transcription' }); T.vd({ id, etat: 'fini', texte }); T.tr({ texte }); }, [id, texte]);
  }
  for (const lent of [false, true]) {
    console.log(lent ? '2b. raccord, transcription avant le result de l’interruption' : '2. raccord (filet de sécurité)');
    await ev((lent) => { T.mode = 'silence'; T.delaiInterruption = lent ? 1500 : 80; T.lignes.length = 0; }, lent);
    const id = lent ? 20 : 10;
    await messageVocal(id, 'Regarde le fichier');
    await pause(500);
    const avant = await ev(() => T.bulles());
    await ev((id) => T.vd({ id: id + 1, etat: 'debut', source: 'mainsLibres', suite: true }), id);
    await pause(lent ? 50 : 300);
    r = await ev(() => ({ interrupts: T.interrupts(), bulles: T.bulles(), fantome: T.fantome() }));
    controle('interrupt envoyé', r.interrupts === 1, r.interrupts);
    controle('la bulle du fragment a quitté le fil', r.bulles.length === avant.length - 1, r.bulles);
    controle('la fantôme montre le fragment en préfixe', r.fantome && r.fantome.texte.trim() === 'Regarde le fichier' && r.fantome.prefixe === 'Regarde le fichier', r.fantome && r.fantome.texte);
    await ev((id) => T.vd({ id: id + 1, etat: 'partiel', texte: 'de configuration du serveur' }), id);
    await pause(700);
    r = await ev(() => T.fantome());
    controle('la phrase complète grandit dans la fantôme', r.texte.trim() === 'Regarde le fichier de configuration du serveur', r.texte);
    if (!lent) await page.screenshot({ path: '/tmp/bt-enonce-fusion-direct.png' });
    await ev((id) => { T.vd({ id: id + 1, etat: 'transcription' }); T.vd({ id: id + 1, etat: 'fini', texte: 'de configuration du serveur.' }); T.tr({ texte: 'de configuration du serveur.', suite: true }); }, id);
    if (lent) {
      await pause(100);
      r = await ev(() => ({ fantome: T.fantome(), users: T.users() }));
      controle('en attente du result : fantôme gardée, rien d’envoyé', r.fantome && r.fantome.attendRaccord && r.users.length === 1, r);
      await pause(1700);
    } else await pause(400);
    r = await ev(() => ({ users: T.users(), bulles: T.bulles(), fantome: T.fantome(), fantomes: document.querySelectorAll('.vd-fantome').length,
      items: BT.app.session.items.filter((x) => x.genre === 'eliot').map((x) => x.texte) }));
    controle('UN message fusionné écrit vers claude', r.users.length === 2 && r.users[1] === 'Regarde le fichier de configuration du serveur.', r.users);
    controle('fil : une seule bulle fusionnée, pas de fragment', r.bulles.length === avant.length && r.bulles[r.bulles.length - 1] === 'Regarde le fichier de configuration du serveur.' &&
      r.bulles.filter((b) => b === 'Regarde le fichier').length === 0, r.bulles.slice(-2));
    controle('plus de fantôme', !r.fantome && r.fantomes === 0);
    if (!lent) await page.screenshot({ path: '/tmp/bt-enonce-fusion.png' });
    await ev(() => T.finTour());
    await pause(200);
  }

  /* ---------- 3. Claude a déjà écrit ---------- */
  console.log('3. Claude a déjà écrit');
  await ev(() => { T.mode = 'texte'; T.delaiInterruption = 80; T.lignes.length = 0; });
  await messageVocal(30, 'Lance les tests');
  await pause(400);
  await ev(() => T.vd({ id: 31, etat: 'debut', source: 'mainsLibres', suite: true }));
  await pause(200);
  r = await ev(() => ({ interrupts: T.interrupts(), fantome: T.fantome() }));
  controle('pas d’interruption, pas de préfixe', r.interrupts === 0 && r.fantome && !r.fantome.prefixe, r);
  await ev(() => { T.vd({ id: 31, etat: 'partiel', texte: 'et le banc vocal' }); T.vd({ id: 31, etat: 'transcription' }); T.vd({ id: 31, etat: 'fini', texte: 'et le banc vocal' }); T.tr({ texte: 'et le banc vocal', suite: true }); });
  await pause(300);
  r = await ev(() => ({ users: T.users(), bulles: T.bulles() }));
  controle('deux messages séparés', r.users.length === 2 && r.users[0] === 'Lance les tests' && r.users[1] === 'et le banc vocal', r.users);
  await ev(() => T.finTour());
  await pause(200);

  /* ---------- 4. annule après interruption ---------- */
  console.log('4. annule après l’interruption');
  await ev(() => { T.mode = 'silence'; T.lignes.length = 0; });
  await messageVocal(40, 'Ouvre le cockpit');
  await pause(400);
  await ev(() => { T.vd({ id: 41, etat: 'debut', source: 'mainsLibres', suite: true }); });
  await pause(50);
  await ev(() => T.vd({ id: 41, etat: 'annule', raison: 'bruit' }));
  await pause(500);
  r = await ev(() => ({ users: T.users(), interrupts: T.interrupts(), bulles: T.bulles(), fantome: T.fantome() }));
  controle('interrupt puis fragment renvoyé seul', r.interrupts === 1 && r.users.length === 2 && r.users[1] === 'Ouvre le cockpit', r.users);
  controle('fil : le fragment une seule fois', r.bulles.filter((b) => b === 'Ouvre le cockpit').length === 1, r.bulles.slice(-2));
  await ev(() => T.finTour());
  await pause(200);

  controle('aucune erreur JS dans la page', erreurs.length === 0, erreurs);
  await navigateur.close();
  console.log(ko ? `\n${ko} contrôle(s) en échec.` : '\nTout passe.');
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
