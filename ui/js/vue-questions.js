/* Better Terminal For Claude — bloc de question dans le fil.
 * Construit une fois (le texte tapé dans « préciser » ne se perd pas), puis mis à jour.
 * Les réponses passent toutes par la Session (session.repondre / session.brouillon). */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};
  var el = BT.el;

  var TITRES = { questions: 'Claude te pose une question', permission: 'Autorisation demandée', plan: 'Claude propose un plan' };

  BT.rendreQuestion = function (q, n, session) {
    if (!n._construit) construire(q, n, session);
    mettreAJour(q, n, session);
  };

  /* Valeur actuelle (sélection ou texte libre) d'une sous-question. */
  function valeur(n, i) {
    var etat = n._sel[i];
    if (etat.libre && etat.libre.trim()) return etat.libre.trim();
    return etat.labels.join(', ');
  }

  function construire(q, n, session) {
    n._construit = true;
    n._sel = [];
    n.className = 'question type-' + q.type;
    var tete = el('div', 'question-tete', [el('span', 'question-marque', TITRES[q.type] || 'Question'),
      q.type === 'questions' && q.questions.length > 1 ? el('span', 'question-compte', q.questions.length + ' questions') : null]);
    n.appendChild(tete);
    // Mode vocal : « Tu peux aussi répondre à la voix », ou ce que fait Jarvis en ce moment.
    var qv = el('div', 'q-vocal', [el('span', 'q-vocal-icone'), el('span', 'q-vocal-texte'), el('span', 'q-vocal-entendu')]);
    qv.hidden = true;
    n.appendChild(qv);

    if (q.type === 'questions') construireQuestions(q, n, session);
    else construirePermission(q, n, session);

    n.appendChild(el('div', 'question-repondue'));
  }

  function construireQuestions(q, n, session) {
    var unique = q.questions.length === 1 && !q.questions[0].multi;
    q.questions.forEach(function (x, i) {
      var etat = { labels: [], libre: '' };
      n._sel.push(etat);
      var bloc = el('div', 'q-bloc');
      if (x.entete) bloc.appendChild(el('span', 'puce q-entete', x.entete));
      bloc.appendChild(el('div', 'q-texte', x.texte));
      if (x.multi) bloc.appendChild(el('div', 'q-aide', 'Plusieurs choix possibles.'));
      var opts = el('div', 'q-options');
      opts.setAttribute('role', x.multi ? 'group' : 'radiogroup');
      x.options.forEach(function (o, k) {
        var b = BT.bouton('q-option', null, function () {
          if (n._fige) return;
          etat.libre = '';
          champ.value = '';
          if (x.multi) {
            var j = etat.labels.indexOf(o.label);
            if (j >= 0) etat.labels.splice(j, 1); else etat.labels.push(o.label);
            // garder l'ordre des options
            etat.labels.sort(function (a, c) { return indexLabel(x, a) - indexLabel(x, c); });
          } else {
            etat.labels = [o.label];
          }
          if (unique) { session.repondre(q.id, { reponses: [o.label] }, 'mac'); return; }
          session.brouillon(q.id, i, valeur(n, i), 'mac');
        });
        b.dataset.label = o.label;
        b.setAttribute('role', x.multi ? 'checkbox' : 'radio');
        b.appendChild(el('span', 'q-coche' + (x.multi ? ' carre' : '')));
        var txt = el('span', 'q-option-texte', [el('span', 'q-label', o.label)]);
        if (o.description && o.description.trim() && o.description.trim() !== o.label.trim()) txt.appendChild(el('span', 'q-desc', o.description));
        b.appendChild(txt);
        b.appendChild(el('span', 'q-raccourci', String(k + 1)));
        opts.appendChild(b);
      });
      bloc.appendChild(opts);
      // « Autre » : réponse libre (Claude Code l'ajoute toujours)
      var champ = el('input', 'q-libre');
      champ.type = 'text';
      champ.placeholder = 'Autre réponse, ou préciser…';
      champ.setAttribute('aria-label', 'Réponse libre');
      champ.addEventListener('input', function () {
        if (n._fige) return;
        etat.libre = champ.value;
        if (champ.value.trim()) etat.labels = [];
        session.brouillon(q.id, i, valeur(n, i), 'mac');
      });
      champ.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && !ev.isComposing && champ.value.trim()) {
          ev.preventDefault();
          if (unique) session.repondre(q.id, { reponses: [champ.value.trim()] }, 'mac');
          else envoyerSiComplet();
        }
      });
      bloc.appendChild(el('div', 'q-autre', [champ]));
      n.appendChild(bloc);
    });

    function envoyerSiComplet() {
      var reps = q.questions.map(function (x, i) { return valeur(n, i); });
      if (reps.every(function (v) { return v; })) session.repondre(q.id, { reponses: reps }, 'mac');
    }

    var actions = el('div', 'q-actions');
    if (!unique) {
      var envoyer = BT.bouton('bouton-principal q-envoyer', 'Envoyer les réponses', envoyerSiComplet);
      actions.appendChild(envoyer);
      n._envoyer = envoyer;
    }
    actions.appendChild(BT.bouton('bouton-discret', 'Fermer sans répondre', function () { session.ignorerQuestion(q.id); }));
    n.appendChild(actions);
  }

  function indexLabel(x, l) {
    for (var i = 0; i < x.options.length; i++) if (x.options[i].label === l) return i;
    return 99;
  }

  function construirePermission(q, n, session) {
    var corps = el('div', 'q-bloc');
    if (q.type === 'plan') {
      var md = el('div', 'md plan');
      md.appendChild(BT.rendreMarkdown(BT.nettoyerTexteClaude(q.plan || '')));
      corps.appendChild(md);
    } else {
      var r = BT.resumeOutil(q.outil, q.entree);
      corps.appendChild(el('div', 'q-texte', ['Claude veut utiliser ', el('strong', null, r.nom), r.cible ? ' : ' + r.cible : '']));
      if (q.titre && q.titre !== q.outil) corps.appendChild(el('div', 'q-aide', q.titre));
      if (q.raison) corps.appendChild(el('div', 'q-aide', q.raison));
      var ap = BT.apercuEntree(q.outil, q.entree);
      if (ap) corps.appendChild(el('div', 'q-apercu', [ap]));
    }
    n.appendChild(corps);

    var libelles = session.optionsPermission(q);
    var actions = el('div', 'q-actions');
    actions.appendChild(BT.bouton('bouton-principal', libelles[0].label, function () { session.repondre(q.id, { decision: 'autoriser' }, 'mac'); }));
    if (q.type === 'permission' && q.suggestions) {
      actions.appendChild(BT.bouton('bouton-secondaire', 'Toujours autoriser', function () { session.repondre(q.id, { decision: 'toujours' }, 'mac'); }));
    }
    actions.appendChild(BT.bouton('bouton-refus', libelles[libelles.length - 1].label, function () {
      session.repondre(q.id, { decision: 'refuser', message: champ.value }, 'mac');
    }));
    n.appendChild(actions);

    var champ = el('input', 'q-libre');
    champ.type = 'text';
    champ.placeholder = q.type === 'plan' ? 'Ce qu’il faut changer dans le plan…' : 'Refuser en expliquant à Claude quoi faire à la place…';
    champ.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.isComposing && champ.value.trim()) {
        ev.preventDefault();
        session.repondre(q.id, { decision: 'refuser', message: champ.value.trim() }, 'mac');
      }
    });
    n.appendChild(el('div', 'q-autre', [champ]));
  }

  function mettreAJour(q, n, session) {
    var fige = q.statut !== 'attente';
    n._fige = fige;
    n.classList.toggle('en-attente', !fige);
    n.classList.toggle('repondue', q.statut === 'repondue');
    n.classList.toggle('annulee', q.statut === 'annulee');

    if (q.type === 'questions') {
      var blocs = n.querySelectorAll('.q-bloc');
      q.questions.forEach(function (x, i) {
        var etat = n._sel[i];
        // Brouillon arrivé d'ailleurs (Telegram) ou réponse finale : on l'affiche.
        var source = fige ? x.reponse : x.brouillon;
        if (source != null && source !== valeur(n, i)) {
          var labels = splitLabels(x, source);
          if (labels) { etat.labels = labels; etat.libre = ''; } else { etat.labels = []; etat.libre = source; }
          var ch = blocs[i] && blocs[i].querySelector('.q-libre');
          if (ch && document.activeElement !== ch) ch.value = etat.libre;
        }
        var boutons = blocs[i] ? blocs[i].querySelectorAll('.q-option') : [];
        for (var k = 0; k < boutons.length; k++) {
          var choisi = etat.labels.indexOf(boutons[k].dataset.label) >= 0;
          boutons[k].classList.toggle('choisie', choisi);
          boutons[k].setAttribute('aria-checked', choisi ? 'true' : 'false');
          boutons[k].disabled = fige;
        }
        var champ = blocs[i] && blocs[i].querySelector('.q-libre');
        if (champ) champ.disabled = fige;
      });
      if (n._envoyer) {
        var complet = q.questions.every(function (x, i) { return valeur(n, i); });
        n._envoyer.disabled = fige || !complet;
      }
    }

    var bt = n.querySelectorAll('.q-actions button, .q-autre input');
    for (var b = 0; b < bt.length; b++) if (fige) bt[b].disabled = true;
    n.querySelector('.q-actions').hidden = fige;
    var autre = n.querySelectorAll('.q-autre');
    if (q.type !== 'questions') for (var a = 0; a < autre.length; a++) autre[a].hidden = fige;

    majVocal(q, n, session, fige);

    var rep = n.querySelector('.question-repondue');
    if (fige) {
      var src = q.source === 'telegram' ? ' · depuis Telegram' : q.source === 'vocal' ? ' · à la voix' : '';
      rep.textContent = q.statut === 'annulee' ? (q.reponseTexte || 'Question close') : 'Répondu : ' + (q.reponseTexte || '') + src;
      rep.hidden = false;
    } else {
      rep.hidden = true;
    }
  }

  /* Ligne vocale du bloc : visible seulement en mode Jarvis, tant que la question attend. */
  function majVocal(q, n, session, fige) {
    var qv = n.querySelector('.q-vocal');
    if (!qv) return;
    var v = session.vocal || {};
    qv.hidden = fige || !v.actif;
    if (qv.hidden) return;
    // La question que Jarvis lit : celle que la coque désigne, sinon la première en attente.
    var visee = v.questionId ? (q.pontIds || []).indexOf(v.questionId) >= 0 : session.questionsEnAttente()[0] === q;
    var ici = v.enLigne && visee;
    var etat = ici ? v.etat : 'pret';
    var t;
    if (etat === 'parle') t = 'Jarvis lit cette question.';
    else if (etat === 'ecoute') t = 'Jarvis t’écoute : dis un numéro' + (q.type === 'questions' ? ' ou le nom d’une option.' : ', oui ou non.');
    else if (etat === 'transcription') t = 'Transcription de ta réponse…';
    else t = 'Tu peux aussi répondre à la voix : ' + (q.type === 'questions' ? 'un numéro ou le nom d’une option.' : 'oui, non, ou un numéro.');
    qv.className = 'q-vocal etat-' + etat + (ici ? ' en-ligne' : '');
    var icone = qv.querySelector('.q-vocal-icone');
    var nom = etat === 'parle' ? 'voix' : 'micro';
    if (icone.dataset.nom !== nom && BT.icone) { icone.replaceChildren(BT.icone(nom)); icone.dataset.nom = nom; }
    qv.querySelector('.q-vocal-texte').textContent = t;
    var ent = qv.querySelector('.q-vocal-entendu');
    var rate = q.vocalEntendu && q.vocalCompris === false;
    ent.hidden = !rate;
    ent.textContent = rate ? 'Entendu : « ' + BT.tronquer(q.vocalEntendu, 80) + ' », pas compris.' : '';
  }

  /* « Rouge, Vert » → ['Rouge', 'Vert'] si ce sont bien des options ; sinon null (texte libre). */
  function splitLabels(x, v) {
    if (v == null || v === '') return [];
    var labels = x.options.map(function (o) { return o.label; });
    if (labels.indexOf(v) >= 0) return [v];
    if (!x.multi) return null;
    var parts = String(v).split(', ');
    return parts.every(function (p) { return labels.indexOf(p) >= 0; }) ? parts : null;
  }

  /* Premier élément cliquable d'une question (pour la bannière et le clavier). */
  BT.focusQuestion = function (n) {
    if (!n) return;
    var b = n.querySelector('.q-option:not([disabled]), .q-actions .bouton-principal:not([disabled])');
    if (b) b.focus({ preventScroll: true });
  };

  /* Raccourci 1-9 : choisir une option de la première sous-question sans réponse. */
  BT.choisirOptionClavier = function (n, chiffre) {
    if (!n || n._fige) return false;
    var blocs = n.querySelectorAll('.q-bloc');
    for (var i = 0; i < blocs.length; i++) {
      var opts = blocs[i].querySelectorAll('.q-option');
      if (!opts.length) continue;
      var deja = blocs[i].querySelector('.q-option.choisie');
      if (deja && i < blocs.length - 1) continue;
      var b = opts[chiffre - 1];
      if (b) { b.click(); return true; }
      return false;
    }
    return false;
  };
})();
