/* Better Terminal For Claude — pont page ↔ Swift (voir CONTRAT.md).
 * Page → Swift : window.webkit.messageHandlers.bt.postMessage({type, ...}).
 * Swift → page : window.bt.info / depuisClaude / stderr / fin / reponseExterne / historique / envoyerTexte
 *                / vocalEtat / transcription / vocalDirect.
 * Les appels reçus avant que l'application soit prête sont mis en file. */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};

  function natif() {
    return window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bt;
  }

  BT.pont = {
    natif: !!natif(),
    envoyer: function (type, donnees) {
      var msg = BT.etendre({ type: type }, donnees || {});
      var h = natif();
      if (h) { try { h.postMessage(msg); } catch (e) { console.error('[BT] pont', e); } return; }
      if (BT.fauxPont) { setTimeout(function () { BT.fauxPont.recevoir(msg); }, 0); return; }
      console.log('[BT] → Swift', msg);
    },
    copier: function (texte) {
      if (natif()) { BT.pont.envoyer('copier', { texte: texte }); return Promise.resolve(); }
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(texte).catch(function () {});
      return Promise.resolve();
    },
    ouvrirLien: function (url) {
      if (!/^https?:\/\//i.test(String(url || ''))) return;
      BT.pont.envoyer('ouvrirLien', { url: url });
    }
  };

  var file = [];
  var cibles = null;
  function appel(nom) {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      if (cibles) {
        try { return cibles[nom].apply(null, args); } catch (e) { console.error('[BT] bt.' + nom, e); }
        return undefined;
      }
      file.push([nom, args]);
      return undefined;
    };
  }

  window.bt = {
    info: appel('info'),
    depuisClaude: appel('depuisClaude'),
    stderr: appel('stderr'),
    fin: appel('fin'),
    reponseExterne: appel('reponseExterne'),
    historique: appel('historique'),
    // Ajout de la coque : prompt de lancement, messages du registre.
    envoyerTexte: appel('envoyerTexte'),
    // Mode vocal « Jarvis » (CONTRAT.md) : état commun du micro et de la voix, texte dicté pour cette session.
    vocalEtat: appel('vocalEtat'),
    transcription: appel('transcription'),
    // Mots d'Eliot en direct pendant un énoncé du mode vocal (js/vocal-direct.js).
    vocalDirect: appel('vocalDirect'),
    // Étape d'animation atteinte par la voix (repères [[n]] du bloc <vocal>) : relayée à l'aperçu du tour.
    vocalEtape: appel('vocalEtape'),
    // Fichiers joints (bouton, Finder, collage) : chemins réels lus par la coque.
    fichiers: appel('fichiers'),
    dictee: appel('dictee'),
    // Panneau To-do (js/todo.js ↔ app/Sources/Todo.swift).
    todo: appel('todo'),
    // Sous-agents en cours (js/agents.js ↔ app/Sources/SuiviAgents.swift).
    agents: appel('agents'),
    // Sessions du Victus (victus/CONTRAT-VICTUS.md) : texte confié par le démon, message tapé sur une autre page.
    texteAEnvoyer: appel('texteAEnvoyer'),
    utilisateurAilleurs: appel('utilisateurAilleurs')
  };

  /* Branche les fonctions réelles et vide la file. */
  BT.brancherPont = function (c) {
    cibles = c;
    var f = file; file = [];
    f.forEach(function (x) { try { c[x[0]].apply(null, x[1]); } catch (e) { console.error('[BT] bt.' + x[0], e); } });
  };
})();
