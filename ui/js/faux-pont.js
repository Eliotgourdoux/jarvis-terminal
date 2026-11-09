/* Better Terminal For Claude — faux pont, pour développer dans un navigateur.
 * Actif SEULEMENT si window.webkit est absent (jamais dans l'app).
 * Rejoue un enregistrement de fixtures/ (stdout brut de claude) et simule claude :
 * pause à chaque fin de tour (jusqu'au message suivant) et à chaque question (jusqu'à la réponse).
 *
 * Lancer depuis la racine du projet :  python3 -m http.server 8765
 * puis ouvrir  http://localhost:8765/ui/index.html?fixture=markdown-riche
 *
 * Paramètres : fixture=<nom>   enregistrement fixtures/<nom>.jsonl (+ <nom>.entree.jsonl)
 *              historique=<nom> transcript à charger avant (ex. transcript-exemple)
 *              vitesse=1        0 = instantané (captures)
 *              auto=1           0 = attendre que l'on tape soi-même les messages
 *              telegram=1       simule une réponse Telegram 2 s après chaque question
 *              ouvrir=1         déplie tous les outils à la fin
 *              recherche=<mot>  ouvre la recherche à la fin
 *              haut=1           remonte en haut à la fin
 *              fin=1            simule l'arrêt du processus à la fin
 *              fond=clair|sombre  faux bureau derrière la fenêtre
 *   Mode vocal (simule la coque : file d'attente, voix, micro, transcription) :
 *              vocal=1          mode Jarvis actif dès le départ
 *              dicte=1          les messages enregistrés arrivent comme s'ils étaient dictés (bt.transcription)
 *              reponseVocale=a|b  réponses dictées aux questions lues par Jarvis, dans l'ordre (« kiwi|rouge et vert »)
 *              dicter=<texte>   à la fin de l'enregistrement, Eliot dicte ce message
 *              vocalEtat=ecoute|parle|transcription|pret  état figé (captures), avec enLigne=1 pour cette session
 *              raccourci=⌥Espace  raccourci affiché dans les aides
 *   Console : BT.fauxPont.dicter('deux') répond à la dernière question lue ; BT.fauxPont.vocaux = messages reçus ;
 *              BT.fauxPont.parler('texte', { pas: 250, annule: 'bruit' }) joue les mots en direct (bt.vocalDirect). */
(function () {
  'use strict';
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bt) return;
  var BT = window.BT = window.BT || {};
  var P = new URLSearchParams(location.search);
  var NOM = P.get('fixture') || 'markdown-riche';
  var VITESSE = P.has('vitesse') ? Math.max(0, parseFloat(P.get('vitesse')) || 0) : 1;
  var AUTO = P.get('auto') !== '0';
  var TELEGRAM = P.get('telegram') === '1';
  var DICTE = P.get('dicte') === '1';
  var FIGE = P.get('vocalEtat');
  var VOCAL = P.get('vocal') === '1' || !!FIGE;

  document.documentElement.classList.add('dev');
  document.documentElement.dataset.fond = P.get('fond') || 'sombre';

  var MODELES = [
    { value: 'default', resolvedModel: 'claude-fable-5-1', displayName: 'Default (recommended)', description: 'Fable 5.1', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'claude-opus-4-8', resolvedModel: 'claude-opus-4-8', displayName: 'Opus 4.8', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }
  ];

  var sortie = [], entree = [], utilisateurs = [], interruptions = [];
  var p = 0, enPause = true, attenteReq = null, envoyes = 0, finie = false, apres = false, interruptionRejouee = false;

  function log() { if (window.console) console.info.apply(console, ['[faux pont]'].concat([].slice.call(arguments))); }

  function lireJsonl(t) {
    return String(t || '').split('\n').filter(function (l) { return l.trim(); }).map(function (l) {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
  }

  function charger(nom) {
    function essai(url) {
      return fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); });
    }
    return essai('../fixtures/' + nom + '.jsonl')
      .then(lireJsonl)
      .catch(function () { return null; });
  }

  function versPage(obj) { window.bt.depuisClaude(JSON.stringify(obj)); }

  BT.fauxPont = {
    recevoir: function (msg) {
      switch (msg.type) {
        case 'pret': demarrer(); break;
        case 'versClaude':
          var o = null;
          try { o = JSON.parse(msg.ligne); } catch (e) { log('ligne invalide', msg.ligne); return; }
          log('→ stdin', o.type, o.request ? o.request.subtype : '', o.response ? o.response.response && o.response.response.behavior : '');
          depuisPage(o);
          break;
        case 'question':
          log('question pour Telegram', msg);
          if (TELEGRAM) setTimeout(function () { simulerTelegram(msg); }, 2000);
          break;
        case 'vocal': case 'vocalAnnule': case 'modeVocal':
          BT.fauxPont.vocaux.push(JSON.parse(JSON.stringify(msg)));
          vocalRecu(msg);
          break;
        case 'copier':
          if (navigator.clipboard) navigator.clipboard.writeText(msg.texte).catch(function () {});
          break;
        case 'ouvrirLien':
          window.open(msg.url, '_blank', 'noopener');
          break;
        default:
          log(msg.type, msg);
      }
    },
    vocaux: [],
    /* Eliot dicte : avec questionId (par défaut, la dernière question lue), c'est une réponse. */
    dicter: function (texte, questionId) { dicter(texte, questionId === undefined ? derniereQuestion : questionId); },
    /* Mots en direct seuls (tests) : BT.fauxPont.parler('texte', { pas: 250, annule: 'bruit' }). */
    parler: function (texte, opts) { parler(texte, opts); }
  };

  function demarrer() {
    Promise.all([charger(NOM), charger(NOM + '.entree'), P.get('historique') ? charger(P.get('historique')) : Promise.resolve(null)]).then(function (r) {
      sortie = r[0] || [];
      entree = r[1] || [];
      utilisateurs = entree.filter(function (o) { return o.type === 'user'; });
      interruptions = entree.filter(function (o) { return o.type === 'control_request' && o.request && o.request.subtype === 'interrupt'; })
        .map(function (o) { return o.request_id; });
      var init = sortie.filter(function (o) { return o.type === 'system' && o.subtype === 'init'; })[0];
      window.bt.info({
        cwd: (init && init.cwd) || '/Users/eliotgourdoux/Desktop/Projets/Demo',
        projet: P.get('projet') || 'Better Terminal For Claude', emoji: P.get('emoji') || '🖥️',
        sessionId: (init && init.session_id) || 'demo', modele: P.get('modele') || 'sonnet',
        // effort=defaut : aucun effort choisi, le menu montre « Par défaut (…) » (effortDefaut, Moyen si absent).
        effort: P.get('effort') === 'defaut' ? '' : (P.get('effort') || 'high'), effortDefaut: P.get('effortDefaut') || 'medium'
      });
      if (VOCAL) etatVocal(FIGE || 'pret', P.get('enLigne') === '1');
      if (r[2]) window.bt.historique(r[2]);
      if (!r[0]) log('enregistrement introuvable : fixtures/' + NOM + '.jsonl');
      if (AUTO && utilisateurs.length) envoyerSuivant();
      else if (!utilisateurs.length && sortie.length) { enPause = false; jouer(); }
      else apresLecture();
    });
  }

  function envoyerSuivant() {
    var u = utilisateurs[envoyes];
    if (!u) return false;
    var c = u.message && u.message.content;
    var t = typeof c === 'string' ? c : (c || []).map(function (b) { return b.text || ''; }).join('\n');
    if (DICTE) window.bt.transcription({ texte: t });
    else BT.app.interface.simulerSaisie(t);
    return true;
  }

  function delai(d) {
    if (d.type === 'stream_event') return d.event && d.event.type === 'content_block_delta' ? 24 : 8;
    if (d.type === 'user') return 420;
    if (d.type === 'system') return d.subtype === 'status' ? 260 : 40;
    if (d.type === 'assistant') return 30;
    return 40;
  }

  function jouer() {
    if (VITESSE === 0) {
      var garde = 0;
      while (!enPause && p < sortie.length && garde++ < 100000) etape();
      if (p >= sortie.length) finEnregistrement();
      return;
    }
    if (enPause) return;
    if (p >= sortie.length) { finEnregistrement(); return; }
    var ms = delai(sortie[p]);
    etape();
    if (!enPause) setTimeout(jouer, ms / VITESSE);
  }

  function etape() {
    var d = sortie[p++];
    // Interruption enregistrée : on rejoue le geste d'Eliot (bouton Arrêter).
    if (d.type === 'control_response' && d.response && interruptions.indexOf(d.response.request_id) >= 0) {
      if (AUTO) { interruptionRejouee = true; BT.app.session.interrompre(); }
      return;
    }
    versPage(d);
    if (d.type === 'control_request' && d.request && d.request.subtype === 'can_use_tool') {
      enPause = true;
      attenteReq = d.request_id;
      apresLecture();
      return;
    }
    if (d.type === 'result') {
      enPause = true;
      finDeTour();
    }
  }

  function finDeTour() {
    var reste = p < sortie.length;
    var attente = VITESSE === 0 ? 0 : 900 / VITESSE;
    if (AUTO && reste) {
      setTimeout(function () {
        if (envoyes < utilisateurs.length) envoyerSuivant();
        else { enPause = false; jouer(); } // tour lancé sans message (tâche de fond)
      }, attente);
    } else if (!reste) {
      finEnregistrement();
    }
  }

  function finEnregistrement() {
    if (finie) return;
    finie = true;
    if (P.get('fin') === '1') window.bt.fin({ code: 0 });
    apresLecture();
    if (P.get('dicter')) setTimeout(function () { dicter(P.get('dicter'), null); }, VITESSE === 0 ? 0 : 1200 / VITESSE);
  }

  function apresLecture() {
    if (apres) return;
    apres = true;
    setTimeout(function () {
      BT.app.vue.vider();
      if (P.get('ouvrir') === '1') BT.app.vue.toutDeplier(true);
      if (P.get('haut') === '1') { BT.app.defilement.colle = false; document.getElementById('defile').scrollTop = 0; }
      if (P.get('eliot')) { // aller au n-ième message d'Eliot (captures)
        var n = BT.app.vue.eliots[parseInt(P.get('eliot'), 10) - 1];
        if (n) BT.app.defilement.allerA(n, { instantane: true, marquer: false });
      }
      if (P.get('recherche')) BT.app.recherche.ouvrir(P.get('recherche'));
      document.documentElement.classList.add('lecture-finie');
    }, VITESSE === 0 ? 30 : 300);
  }

  /* ---------- Ce que la page écrit sur « stdin » ---------- */

  function depuisPage(o) {
    if (o.type === 'user') {
      envoyes++;
      if (enPause && !attenteReq && !finie && p < sortie.length) { enPause = false; jouer(); }
      else if (p >= sortie.length) tourFactice(o);
      return;
    }
    if (o.type === 'control_response') {
      var r = o.response || {};
      if (attenteReq && r.request_id === attenteReq) {
        attenteReq = null;
        enPause = false;
        apres = false;
        setTimeout(jouer, VITESSE === 0 ? 0 : 200);
      }
      return;
    }
    if (o.type === 'control_request') {
      var req = o.request || {}, rep = {};
      if (req.subtype === 'initialize') rep = { models: MODELES, account: { subscriptionType: 'Claude Team' }, commands: [] };
      else if (req.subtype === 'set_model') rep = { model: req.model ? (MODELES.filter(function (m) { return m.value === req.model; })[0] || { resolvedModel: req.model }).resolvedModel : 'claude-fable-5-1' };
      else if (req.subtype === 'rewind_conversation') {
        // Maquette : accepte toujours, sauf ?reprise=refus (pour voir le message d'erreur).
        rep = /[?&]reprise=refus/.test(location.search)
          ? { rewound: false, prefillText: null, precedingAssistantUuid: null, error: 'target not found', reason: 'target_not_found' }
          : { rewound: true, targetMessageUuid: req.target_message_uuid, prefillText: '', precedingAssistantUuid: null };
      }
      else if (req.subtype === 'interrupt') {
        rep = { still_queued: [] };
        // Interruption déjà contenue dans l'enregistrement : on la laisse jouer telle quelle.
        if (interruptionRejouee) interruptionRejouee = false; else setTimeout(interrompre, 60);
      }
      setTimeout(function () { versPage({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: rep } }); }, 30);
    }
  }

  function interrompre() {
    // Sauter la fin du tour enregistré et terminer comme le vrai claude.
    var i = p;
    while (i < sortie.length && sortie[i].type !== 'result') i++;
    var dejaMarque = false;
    for (var k = p; k < i; k++) {
      var d = sortie[k];
      if (d.type === 'user' && JSON.stringify(d.message || {}).indexOf('[Request interrupted') >= 0) dejaMarque = true;
    }
    if (dejaMarque) return; // l'enregistrement contient déjà l'interruption : on le laisse jouer
    p = i + 1;
    versPage({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null });
    versPage({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', duration_ms: 0 });
    enPause = true;
    finDeTour();
  }

  /* Après la fin de l'enregistrement : une réponse factice, pour tester l'envoi. */
  function tourFactice(o) {
    var c = o.message && o.message.content;
    var t = typeof c === 'string' ? c : (c || []).map(function (b) { return b.text || ''; }).join('\n');
    var id = 'msg_faux_' + Date.now();
    var texte = 'Faux pont : l’enregistrement « ' + NOM + ' » est fini. Message reçu :\n\n> ' + BT.tronquer(t, 300).replace(/\n/g, '\n> ');
    versPage({ type: 'system', subtype: 'status', status: 'requesting' });
    versPage({ type: 'stream_event', event: { type: 'message_start', message: { id: id } } });
    versPage({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    var morceaux = texte.match(/.{1,12}/g) || [];
    var i = 0;
    (function suite() {
      if (i < morceaux.length) {
        versPage({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: morceaux[i++] } } });
        setTimeout(suite, VITESSE === 0 ? 0 : 30);
        return;
      }
      versPage({ type: 'assistant', message: { id: id, model: 'faux', content: [{ type: 'text', text: texte }] }, parent_tool_use_id: null });
      versPage({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
      versPage({ type: 'result', subtype: 'success', is_error: false, duration_ms: 900 });
    })();
  }

  /* ---------- Mode vocal : ce que ferait la coque ---------- */

  var fileVocale = [], parleVocal = null, minuteurVocal = 0, vocalActif = VOCAL, derniereQuestion = null;
  var reponsesVocales = P.get('reponseVocale') ? P.get('reponseVocale').split('|') : [];

  function attente(ms) { return VITESSE === 0 ? 0 : ms / VITESSE; }

  function etatVocal(etat, enLigne, questionId) {
    window.bt.vocalEtat({ actif: vocalActif, etat: vocalActif ? etat : 'inactif', enLigne: !!enLigne, questionId: questionId || null, raccourci: P.get('raccourci') || undefined });
  }

  function vocalRecu(m) {
    if (m.type === 'modeVocal') {
      vocalActif = !!m.actif;
      if (!vocalActif) { fileVocale = []; parleVocal = null; clearTimeout(minuteurVocal); }
      setTimeout(function () { etatVocal(vocalActif ? 'pret' : 'inactif', false); }, 120);
      return;
    }
    if (FIGE) return; // état figé pour une capture : on note, on ne joue rien
    if (m.type === 'vocalAnnule') {
      fileVocale = fileVocale.filter(function (x) { return x.questionId !== m.questionId; });
      if (parleVocal && parleVocal.questionId === m.questionId) { clearTimeout(minuteurVocal); parleVocal = null; etatVocal('pret', false); suiteVocale(); }
      return;
    }
    if (!vocalActif) return;
    if (m.questionId && fileVocale.some(function (x) { return x.questionId === m.questionId && x.texte === m.texte; })) return;
    fileVocale.push(m);
    // les questions passent avant les fins de tâche, dans l'ordre d'arrivée
    fileVocale = fileVocale.filter(function (x) { return x.priorite === 'question'; }).concat(fileVocale.filter(function (x) { return x.priorite !== 'question'; }));
    suiteVocale();
  }

  function suiteVocale() {
    if (parleVocal || !fileVocale.length) return;
    parleVocal = fileVocale.shift();
    etatVocal('parle', true, parleVocal.questionId);
    log('Jarvis dit :', (P.get('projet') || 'Better Terminal For Claude') + ' ' + parleVocal.texte);
    minuteurVocal = setTimeout(finParole, attente(Math.min(4000, 500 + parleVocal.texte.length * 22)));
  }

  function finParole() {
    var it = parleVocal;
    parleVocal = null;
    if (it && it.priorite === 'question' && it.questionId) {
      derniereQuestion = it.questionId;
      if (reponsesVocales.length) { dicter(reponsesVocales.shift(), it.questionId, suiteVocale); return; }
      etatVocal('pret', true, it.questionId); // attend la réponse : BT.fauxPont.dicter('deux')
      suiteVocale();
      return;
    }
    etatVocal('pret', false);
    suiteVocale();
  }

  /* Eliot dicte, comme la coque le joue : mots en direct (bt.vocalDirect, partiels whisper qui grandissent,
   * avec un premier mot mal compris puis corrigé), transcription, puis « fini » juste avant bt.transcription.
   * opts : questionId, ensuite, annule (raison : énoncé abandonné), pas (ms entre deux partiels). */
  var numDirect = 0;
  function direct(o) { if (window.bt.vocalDirect) window.bt.vocalDirect(o); }
  function partiels(texte) {
    var mots = texte.split(/\s+/).filter(Boolean), l = [], n = Math.min(2, mots.length);
    while (n <= mots.length) {
      var m = mots.slice(0, n);
      if (l.length < 2 && m[0].length > 3) m[0] = m[0].slice(0, -2) + 'e'; // whisper se trompe au début
      l.push(m.join(' '));
      if (n === mots.length) break;
      n = Math.min(mots.length, n + 1 + (l.length % 2));
    }
    return l;
  }
  function parler(texte, opts) {
    opts = opts || {};
    var id = ++numDirect, pas = opts.pas != null ? opts.pas : attente(260), l = partiels(texte), i = 0;
    etatVocal('ecoute', true, opts.questionId);
    direct({ id: id, etat: 'debut', source: 'mainsLibres' });
    (function suivant() {
      if (i < l.length) { direct({ id: id, etat: 'partiel', texte: l[i++] }); setTimeout(suivant, pas); return; }
      if (opts.annule) {
        etatVocal('pret', false);
        direct({ id: id, etat: 'annule', raison: opts.annule });
        if (opts.ensuite) opts.ensuite();
        return;
      }
      etatVocal('transcription', true, opts.questionId);
      direct({ id: id, etat: 'transcription' });
      setTimeout(function () {
        etatVocal('pret', false);
        log('transcription', opts.questionId || '(message)', texte);
        direct(opts.questionId ? { id: id, etat: 'fini', texte: texte, questionId: opts.questionId } : { id: id, etat: 'fini', texte: texte });
        window.bt.transcription(opts.questionId ? { texte: texte, questionId: opts.questionId } : { texte: texte });
        if (opts.ensuite) opts.ensuite();
      }, opts.pas != null ? opts.pas * 2 : attente(450));
    })();
  }
  function dicter(texte, questionId, ensuite) { parler(texte, { questionId: questionId, ensuite: ensuite }); }

  /* Réponse « depuis Telegram » : celle de l'enregistrement si elle existe. */
  function simulerTelegram(msg) {
    var rep = entree.filter(function (o) { return o.type === 'control_response' && o.response && o.response.request_id === attenteReq; })[0];
    var r = rep && rep.response.response;
    var valeur;
    if (msg.typeQuestion === 'permission') {
      valeur = r && r.behavior === 'deny' ? (r.message || 'Refusé depuis Telegram') : [msg.options[0].label];
    } else {
      var a = r && r.updatedInput && r.updatedInput.answers && r.updatedInput.answers[msg.texte];
      valeur = a ? String(a).split(', ') : [msg.options[0].label];
    }
    log('réponse Telegram simulée', msg.id, valeur);
    window.bt.reponseExterne({ id: msg.id, reponse: valeur, source: 'telegram' });
  }
})();
