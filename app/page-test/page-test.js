// Page de test du pont Swift ↔ page (agent D). Pas l'interface : elle exerce chaque fonction du contrat.
// Aucun innerHTML : tout le texte passe par textContent.
(function () {
  'use strict';
  const pont = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bt;
  const poster = (o) => { if (pont) pont.postMessage(o); else ecrire('sys', '(pas de pont : ' + JSON.stringify(o) + ')'); };
  const journalEl = document.getElementById('journal');
  const compteur = document.getElementById('compteur');
  let info = null, nLignes = 0, enCours = null, dernierResultat = '';
  let vocal = { actif: false, etat: 'inactif', enLigne: false }, questionVocale = null;

  // Ce que la page dit à voix haute en fin de tour (règle du contrat) : la ligne « ✅ … » sans l'emoji,
  // sinon les deux premières phrases, environ 200 caractères.
  function resumeVocal(t) {
    const l = t.split('\n').map((x) => x.trim()).find((x) => x.startsWith('✅'));
    if (l) return l.replace(/^✅\s*/, '').slice(0, 220);
    const phrases = t.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]*/g) || [t];
    return phrases.slice(0, 2).join(' ').slice(0, 200).trim();
  }

  function ecrire(classe, texte) {
    const p = document.createElement('p');
    p.className = 'l ' + classe;
    p.textContent = texte;
    journalEl.appendChild(p);
    journalEl.scrollTop = journalEl.scrollHeight;
    return p;
  }
  const propre = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');

  function envoyer(texte, source) {
    const ligne = JSON.stringify({ type: 'user', session_id: '', message: { role: 'user', content: [{ type: 'text', text: texte }] }, parent_tool_use_id: null });
    poster({ type: 'versClaude', ligne });
    poster({ type: 'etat', etat: 'travaille', resume: 'page-test : message envoyé' });
    ecrire('vous', '→ vous' + (source ? ' (' + source + ')' : '') + ' : ' + texte);
  }

  window.bt = {
    info(i) {
      info = i;
      document.getElementById('titre').textContent = (i.emoji || '') + ' ' + (i.projet || '');
      document.getElementById('details').textContent =
        i.cwd + ' · session ' + i.sessionId + ' · modèle ' + (i.modele || 'défaut') + ' · effort ' + (i.effort || 'défaut') +
        (i.reprise ? ' · reprise' : '') + (i.dansTerminal ? ' · dans le Terminal' : '');
      ecrire('sys', 'bt.info reçu');
    },
    historique(lignes) {
      ecrire('sys', 'bt.historique : ' + lignes.length + ' lignes de transcript');
      for (const l of lignes) {
        try {
          const o = JSON.parse(l);
          if (o.type === 'user' && !o.isMeta && o.message) {
            const c = o.message.content;
            const t = typeof c === 'string' ? c : (c || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
            if (t) ecrire('vous', '↺ vous : ' + t);
          } else if (o.type === 'assistant' && o.message) {
            const t = (o.message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
            if (t) ecrire('claude', '↺ claude : ' + propre(t));
          }
        } catch (e) { /* ligne illisible */ }
      }
    },
    depuisClaude(ligne) {
      nLignes++;
      compteur.textContent = nLignes + (nLignes > 1 ? ' lignes' : ' ligne');
      let o;
      try { o = JSON.parse(ligne); } catch (e) { ecrire('err', 'ligne non JSON : ' + ligne.slice(0, 200)); return; }
      if (o.type === 'system' && o.subtype === 'init') {
        ecrire('sys', 'init · ' + o.model + ' · ' + o.permissionMode + ' · id ' + o.session_id);
      } else if (o.type === 'stream_event' && o.event && o.event.type === 'content_block_delta' && o.event.delta && o.event.delta.type === 'text_delta') {
        if (!enCours) enCours = ecrire('claude', 'claude : ');
        enCours.textContent += o.event.delta.text;
      } else if (o.type === 'result') {
        enCours = null;
        dernierResultat = propre(o.result || '').replace(/━+[^\n]*\n?/g, '').trim();
        ecrire(o.is_error ? 'err' : 'ok', 'result · ' + o.subtype + ' · ' + o.duration_ms + ' ms · ' + nLignes + ' lignes reçues');
        // aller-retour complet : la page renvoie à Swift ce qu'elle a reçu (fichier d'état)
        poster({ type: 'etat', etat: 'pret', resume: 'page-test : ' + nLignes + ' lignes reçues ; réponse : ' + dernierResultat.slice(0, 160) });
        if (vocal.actif && !o.is_error && dernierResultat) poster({ type: 'vocal', texte: resumeVocal(dernierResultat), priorite: 'fin' });
      } else if (o.type === 'control_request') {
        ecrire('sys', 'control_request · ' + (o.request && o.request.subtype) + ' · ' + (o.request && o.request.tool_name || ''));
      }
    },
    stderr(t) { ecrire('err', 'stderr : ' + t); },
    fin(f) { enCours = null; ecrire('sys', 'bt.fin · code ' + f.code + (f.raison ? ' · ' + f.raison : '')); },
    reponseExterne(r) { ecrire('ok', 'réponse externe ' + r.id + ' (' + r.source + ') : ' + JSON.stringify(r.reponse)); },
    envoyerTexte(texte, opts) { envoyer(texte, opts && opts.source); return true; },
    vocalEtat(e) {
      vocal = e;
      document.getElementById('vocal-etat').textContent = '🎙 ' + (e.actif ? e.etat : 'coupé') + (e.enLigne ? ' · en ligne' : '');
      document.body.dataset.vocal = e.etat + (e.enLigne ? ' enligne' : '');
    },
    transcription(t) {
      if (t.questionId && questionVocale && t.questionId === questionVocale.id) {
        // la vraie page convertit « deux », « Poire », « le deuxième »… ; ici on cherche juste le numéro ou le libellé
        const bas = t.texte.toLowerCase();
        const nombres = ['un', 'deux', 'trois'], ordinaux = ['premier', 'deuxième', 'troisième'];
        const i = questionVocale.options.findIndex((o, k) => bas.includes(o.toLowerCase()) || bas.includes(nombres[k]) || bas.includes(ordinaux[k]));
        if (i >= 0) {
          ecrire('ok', '🎙 réponse vocale à ' + t.questionId + ' : ' + questionVocale.options[i] + ' (« ' + t.texte + ' »)');
          questionVocale = null;
        } else {
          ecrire('err', '🎙 réponse vocale ambiguë : « ' + t.texte + ' »');
          poster({ type: 'vocal', texte: 'Je n’ai pas compris, réponds par un numéro.', priorite: 'question', questionId: t.questionId });
        }
        return;
      }
      ecrire('vous', '🎙 dicté : ' + t.texte);
      envoyer(t.texte, 'vocal');
    },
  };

  document.getElementById('saisie').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) { envoyer(e.target.value.trim()); e.target.value = ''; }
  });
  const sur = (id, f) => document.getElementById(id).addEventListener('click', f);
  sur('b-attend', () => poster({ type: 'etat', etat: 'attend', resume: 'page-test : attente simulée' }));
  sur('b-relancer', () => poster({ type: 'relancer', modele: 'haiku' }));
  sur('b-terminal', () => poster({ type: 'ouvrirTerminal' }));
  sur('b-copier', () => { if (info) poster({ type: 'copier', texte: info.sessionId }); });
  sur('b-lien', () => poster({ type: 'ouvrirLien', url: 'https://code.claude.com/docs' }));
  sur('b-question', () => poster({ type: 'question', id: 'bt' + Math.random().toString(36).slice(2, 8), typeQuestion: 'choix',
    texte: 'Question de test de la page du pont', options: [{ label: 'Oui' }, { label: 'Non' }] }));
  sur('b-fermer', () => poster({ type: 'fermer' }));
  sur('b-vocal', () => poster({ type: 'modeVocal', actif: !vocal.actif }));
  sur('b-qvocale', () => {
    questionVocale = { id: 'qv' + Math.random().toString(36).slice(2, 8), options: ['Pomme', 'Poire', 'Kiwi'] };
    const p = (info && info.projet) || 'La session';
    poster({ type: 'vocal', priorite: 'question', questionId: questionVocale.id,
      texte: p + ' te demande : quel fruit ? Un : Pomme. Deux : Poire. Trois : Kiwi.' });
  });

  ecrire('sys', 'page chargée, envoi de « pret »');
  poster({ type: 'pret' });
})();
