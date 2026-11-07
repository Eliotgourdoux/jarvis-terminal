/* Better Terminal For Claude — faux pont du panneau Jarvis, pour développer dans un navigateur.
 * Actif SEULEMENT si window.webkit est absent (jamais dans l'app). Il joue le rôle de la coque :
 * il envoie jarvis.maj et répond aux boutons Passer, Rejouer, Couper et Mode.
 *
 *   http://127.0.0.1:8765/ui/jarvis.html?scene=demo
 *   scene=demo (défaut)   une séquence complète, jouée une fois : fin de tâche lue, question, écoute, transcription
 *         coupe | pret | ecoute | transcription | parle | file   un état figé (captures)
 *   niveau=0.6            niveau du micro pour scene=ecoute
 *   raccourci=⌥Espace     raccourci affiché
 *   fond=clair            faux bureau clair */
(function () {
  'use strict';
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bt) return;
  var BT = window.BT = window.BT || {};
  var P = new URLSearchParams(location.search);
  document.documentElement.classList.add('dev');
  document.documentElement.dataset.fond = P.get('fond') || 'sombre';

  var S = {
    bt: { sessionId: 's-bt', projet: 'Better Terminal For Claude', emoji: '🖥️' },
    cockpit: { sessionId: 's-cockpit', projet: 'Cockpit', emoji: '🧭' },
    reels: { sessionId: 's-reels', projet: 'Stories Reels FR', emoji: '🎬' },
    ping: { sessionId: 's-ping', projet: 'Ping Pong Edit', emoji: '🏓' }
  };
  function item(s, priorite, texte) { return { sessionId: s.sessionId, projet: s.projet, emoji: s.emoji, priorite: priorite, texte: texte }; }
  var Q1 = item(S.bt, 'question', 'te demande : Quel fruit préférez-vous ? Un : Pomme. Deux : Poire. Trois : Kiwi.');
  var Q2 = item(S.ping, 'question', 'te demande l’autorisation de lancer la commande npm run build. Un : Autoriser. Deux : Refuser.');
  var F1 = item(S.cockpit, 'fin', 'Tableau de bord mis à jour : trois sessions en attente, aucune erreur.');
  var F2 = item(S.reels, 'fin', 'Épisode 4 rendu en 1080 × 1920, sous-titres mot par mot calés sur la voix.');
  var F3 = item(S.bt, 'fin', 'Fichier autorise.txt créé avec le contenu « ok » dans le dossier courant.');

  var raccourci = P.get('raccourci') || '⌥Espace';
  var e = { actif: true, etat: 'pret', niveau: 0, enLigne: null, file: [], raccourci: raccourci };
  var dernier = null, minuteurs = [];

  function pousser() { window.jarvis.maj(JSON.parse(JSON.stringify(e))); }
  function plus(ms, fn) { minuteurs.push(setTimeout(fn, ms)); }
  function stop() { minuteurs.forEach(clearTimeout); minuteurs = []; }
  function log() { console.info.apply(console, ['[faux Jarvis]'].concat([].slice.call(arguments))); }

  var SCENES = {
    coupe: { actif: false, etat: 'inactif', enLigne: null, file: [] },
    pret: { etat: 'pret', enLigne: null, file: [F2] },
    ecoute: { etat: 'ecoute', niveau: P.has('niveau') ? parseFloat(P.get('niveau')) : 0.62, enLigne: Q1, file: [F1, F2] },
    transcription: { etat: 'transcription', enLigne: Q1, file: [F1, F2] },
    parle: { etat: 'parle', enLigne: F1, file: [Q2, F2] },
    file: { etat: 'parle', enLigne: F3, file: [F1, Q2, F2, item(S.reels, 'question', 'te demande : Quelle musique de fond ? Un : Calme. Deux : Tendue.'), item(S.ping, 'fin', 'Montage exporté : 3 min 12, sans coupure.'), item(S.cockpit, 'fin', 'Rappels synchronisés avec la to-do du projet.')] }
  };

  /* Démo : une seule fois, puis le panneau reste au repos (aucune boucle). */
  function demo() {
    e.file = [Q1, F2];
    e.etat = 'parle'; e.enLigne = F1; dernier = F1; pousser();
    plus(3200, function () { e.enLigne = e.file.shift(); dernier = e.enLigne; pousser(); });
    plus(7000, function () {
      e.etat = 'ecoute'; pousser();
      // fausse voix : enveloppe de niveaux pendant 2,4 s
      var t = 0;
      (function voix() {
        t += 60;
        var n = Math.max(0, Math.min(1, 0.45 + 0.35 * Math.sin(t / 130) * Math.sin(t / 47) + (Math.random() - 0.5) * 0.2));
        window.jarvis.maj({ niveau: t > 2300 ? 0 : n });
        if (t < 2400) plus(60, voix);
      })();
    });
    plus(9600, function () { e.etat = 'transcription'; e.niveau = 0; pousser(); });
    plus(10400, function () { e.etat = 'parle'; e.enLigne = e.file.shift() || null; dernier = e.enLigne; pousser(); });
    plus(13800, function () { e.etat = 'pret'; e.enLigne = null; pousser(); });
  }

  BT.fauxJarvis = {
    recevoir: function (m) {
      log('←', m.type, m.actif !== undefined ? m.actif : '');
      switch (m.type) {
        case 'pret':
          var sc = SCENES[P.get('scene')];
          if (sc) { for (var k in sc) e[k] = sc[k]; if (e.enLigne) dernier = e.enLigne; pousser(); }
          else demo();
          break;
        case 'passer':
          stop();
          e.enLigne = e.file.shift() || null; dernier = e.enLigne || dernier;
          e.etat = e.enLigne ? 'parle' : 'pret'; pousser();
          break;
        case 'rejouer':
          stop();
          if (dernier) { e.enLigne = dernier; e.etat = 'parle'; pousser(); }
          break;
        case 'couper':
          stop();
          e.etat = 'pret'; e.enLigne = null; pousser();
          break;
        case 'modeVocal':
          stop();
          e.actif = !!m.actif; e.etat = e.actif ? 'pret' : 'inactif';
          if (!e.actif) { e.file = []; e.enLigne = null; }
          plus(120, pousser);
          break;
      }
    }
  };
})();
