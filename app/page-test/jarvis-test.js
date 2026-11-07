// Panneau Jarvis de test (agent V1), en attendant ui/jarvis.html (agent V2). Aucun innerHTML.
(function () {
  'use strict';
  const pont = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bt;
  const poster = (o) => { if (pont) pont.postMessage(o); };
  const $ = (id) => document.getElementById(id);
  const noms = { inactif: 'Mode vocal coupé', pret: 'Prêt', ecoute: 'J’écoute…', transcription: 'Transcription…', parle: 'Parle' };
  let actif = false, recus = 0;

  window.jarvis = {
    maj(e) {
      recus++;
      actif = !!e.actif;
      document.body.dataset.etat = e.etat;
      $('etat').textContent = (noms[e.etat] || e.etat) + (e.enPause ? ' · en pause' : '');
      $('raccourci').textContent = e.actif ? 'maintenir ' + (e.raccourci || '') + (e.raccourciPris ? ' (pris !)' : '') : '';
      $('barre').style.width = Math.round((e.etat === 'ecoute' ? e.niveau : 0) * 100) + '%';
      const l = e.enLigne;
      $('enligne').textContent = l ? (l.emoji || '') + ' ' + l.projet + (l.texte ? ' : ' + l.texte : '') : '';
      const ol = $('file');
      ol.replaceChildren();
      for (const x of e.file || []) {
        const li = document.createElement('li');
        li.textContent = (x.priorite === 'question' ? '❓ ' : '✅ ') + (x.emoji || '') + ' ' + x.projet + ' : ' + x.texte;
        ol.appendChild(li);
      }
      const d = e.derniere;
      $('note').textContent = e.erreur ? '⚠️ ' + e.erreur : (d ? '🎙 ' + (d.projet || '') + ' ← « ' + d.texte + ' »' : '') +
        ' · micro ' + e.micro + ' · voix ' + e.voix;
      $('b-mode').textContent = actif ? 'Couper le mode' : 'Mode vocal';
      document.body.dataset.recus = String(recus);
    },
  };
  $('b-mode').addEventListener('click', () => poster({ type: 'modeVocal', actif: !actif }));
  $('b-passer').addEventListener('click', () => poster({ type: 'passer' }));
  $('b-rejouer').addEventListener('click', () => poster({ type: 'rejouer' }));
  $('b-couper').addEventListener('click', () => poster({ type: 'couper' }));
  poster({ type: 'pret' });
})();
