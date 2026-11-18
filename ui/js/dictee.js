/* Jarvis Terminal — dictée dans la saisie : maintenir Espace pour parler, comme dans Claude Code.
 * Refonte du 18/11/2026 (« je veux un truc aussi smooth que dans le terminal ») : calquée sur Claude Code 2.1.325.
 *  - Appui : l'espace s'écrit tout de suite, comme une frappe normale (le terminal aussi laisse passer les
 *    premiers espaces). Tenu 250 ms, ou dès la première répétition de la touche, il devient une dictée :
 *    l'espace tapé est retiré et le micro s'ouvre.
 *  - Écoute : le curseur devient une barre de niveau qui suit la voix (lissage 0,7 par pas de 50 ms et hauteur
 *    mini d'un huitième, comme le « ▁▂▃▄▅▆▇█ » du terminal ; grise dans le silence, or quand tu parles).
 *    Le texte provisoire s'écrit au curseur, estompé, mot par mot. La ligne du bas dit « Je t’écoute… »
 *    (le « listening… » du terminal), sans rien pousser dans la mise en page.
 *  - Relâchement : « Transcription… » pulse doucement (le « Voice: processing… » du terminal), puis le texte
 *    final remplace le provisoire sur place : les mots communs restent, les autres se fondent, le curseur se
 *    pose juste après. Rien n'est envoyé : tu relis puis Entrée.
 *  - Échap annule, pendant l'écoute comme pendant la transcription, et remet la saisie d'avant.
 * Rendu : pendant la dictée, le texte du textarea devient transparent et un calque identique (même police,
 * même largeur, même défilement) le dessine, ce qui permet d'estomper le seul texte provisoire et de dessiner
 * la barre à la place du curseur. Le textarea garde toujours la vraie valeur.
 * Page → Swift : dictee {action: debut|fin|annuler}. Swift → page : bt.dictee({etat, niveau?, texte?, erreur?}). */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};
  var el = BT.el;

  var SEUIL = 250;        // ms d'appui avant la dictée (ou la première répétition de la touche, si elle vient avant)
  var LISSAGE = 0.7;      // part de l'ancien niveau gardée à chaque pas de 50 ms (Claude Code : 0,7)
  var SILENCE = 0.22;     // niveau Swift (-55 dB → 0, -10 dB → 1) sous lequel la barre reste grise
  var MIN = 0.125;        // hauteur mini de la barre : « ▁ », un huitième de la case, comme le terminal
  var ENTREE = 220;       // ms, fondu d'un mot qui arrive
  var TRAINE = 360;       // ms, le texte final finit d'apparaître avant de rendre la main à la saisie

  var GRIS = [140, 132, 118], OR = [201, 164, 92], OR_CLAIR = [227, 200, 135];

  function reduit() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function mots(t) { return String(t || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean); }
  /* Clé de comparaison d'un mot : la casse et la ponctuation ne comptent pas (« photos, » = « Photos »). */
  function cle(m) { return String(m).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }
  function melange(a, b, k) {
    return [0, 1, 2].map(function (i) { return a[i] + (b[i] - a[i]) * k; });
  }
  function rgb(c) { return 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')'; }
  /* Niveau du micro → hauteur de la barre : le bruit de fond reste en bas, une voix normale monte aux deux tiers. */
  function voix(n) { return Math.max(0, Math.min(1, (n - 0.1) / 0.7)); }

  BT.Interface.prototype._initDictee = function () {
    var self = this, ta = this.ta;
    var saisie = ta.closest('.saisie');
    var bas = saisie.querySelector('.saisie-bas');
    var etat = 'repos';        // repos | appui | ecoute | transcription
    var appui = null;          // {debut, fin, espace} : l'appui en cours, avant de savoir si c'est une dictée
    var base = null;           // {valeur, debut, fin} : saisie d'avant la dictée, remise avant l'insertion finale
    var minuteur = null, masquage = null, traine = null;
    var aIgnorer = 0;          // réponses de fin (fini | erreur | annule) d'une transcription annulée par Échap

    /* ---- Ligne d'état, dans le pied de la saisie (là où le terminal écrit « listening… ») ---- */
    var ligne = el('div', 'dictee-etat');
    var ligneTexte = el('span', 'dictee-etat-texte'), ligneAide = el('span', 'dictee-etat-aide');
    ligne.appendChild(ligneTexte);
    ligne.appendChild(ligneAide);
    ligne.setAttribute('role', 'status');
    ligne.setAttribute('aria-live', 'polite');
    ligne.hidden = true;
    var statut = bas && bas.querySelector('.saisie-statut');
    if (bas) bas.insertBefore(ligne, statut ? statut.nextSibling : bas.firstChild);
    else saisie.appendChild(ligne);

    function montrer(genre, texte, aide) {
      clearTimeout(masquage);
      ligne.className = 'dictee-etat ' + genre;
      ligneTexte.textContent = texte;
      ligneAide.textContent = aide || '';
      ligne.hidden = false;
      saisie.classList.add('en-dictee');
    }
    function cacher(apres) {
      clearTimeout(masquage);
      var f = function () { ligne.hidden = true; saisie.classList.remove('en-dictee'); };
      if (apres) masquage = setTimeout(f, apres); else f();
    }

    /* ---- Calque : dessine le texte du textarea pendant la dictée ---- */
    var calque = el('div', 'dictee-calque');
    calque.setAttribute('aria-hidden', 'true');
    calque.hidden = true;
    var page = el('div', 'dictee-calque-page');
    var tAvant = document.createTextNode('');
    var tSel = el('span', 'dictee-remplace');          // sélection d'origine, remplacée par le premier partiel
    var interim = el('span', 'dictee-interim');
    var repere = el('span', 'dictee-repere', '⁠'); // position du curseur (word joiner : aucune largeur, aucune coupure)
    var tApres = document.createTextNode('');
    [tAvant, tSel, interim, repere, tApres].forEach(function (n) { page.appendChild(n); });
    var curseur = el('span', 'dictee-curseur'), barre = el('i', 'dictee-curseur-barre');
    curseur.appendChild(barre);
    calque.appendChild(page);
    calque.appendChild(curseur);
    ta.parentNode.insertBefore(calque, ta.nextSibling);

    var PROPRIETES = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'lineHeight', 'letterSpacing',
      'wordSpacing', 'textTransform', 'textIndent', 'tabSize', 'fontFeatureSettings', 'fontVariantLigatures', 'fontKerning',
      'textRendering', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'direction'];
    var hauteurBarre = 18;
    function copierStyle() {
      var cs = getComputedStyle(ta);
      PROPRIETES.forEach(function (p) { if (cs[p] != null) page.style[p] = cs[p]; });
      var taille = parseFloat(cs.fontSize) || 15.5;
      hauteurBarre = Math.round(taille * 1.15);
      curseur.style.width = Math.max(3, Math.round(taille * 0.42)) + 'px';
      curseur.style.height = hauteurBarre + 'px';
    }
    /* Le calque suit la boîte et le défilement du textarea. */
    function caler() {
      var w = ta.clientWidth;
      calque.style.left = ta.offsetLeft + 'px';
      calque.style.top = ta.offsetTop + 'px';
      calque.style.width = w + 'px';
      calque.style.height = ta.clientHeight + 'px';
      page.style.width = w + 'px';
      page.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
    }
    /* Saisie plus haute que sa zone : la ligne du curseur reste visible. */
    function suivreCurseur() {
      if (ta.scrollHeight <= ta.clientHeight + 1) return;
      var y = repere.offsetTop, h = repere.offsetHeight || hauteurBarre;
      var pb = parseFloat(page.style.paddingBottom) || 0;
      if (y + h + pb > ta.scrollTop + ta.clientHeight) ta.scrollTop = y + h + pb - ta.clientHeight;
      else if (y < ta.scrollTop) ta.scrollTop = y;
    }
    function placerCurseur() {
      if (curseur.hidden) return;
      var r = repere.getBoundingClientRect(), c = calque.getBoundingClientRect();
      var x = r.left - c.left + 1, y = (r.top + r.bottom) / 2 - c.top - hauteurBarre / 2;
      curseur.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
    }

    /* ---- Niveau de la voix : lissé à chaque image, comme le levelSmoother du terminal ---- */
    var niv = { brut: 0, cible: 0, val: 0, or: 0, t: 0, raf: 0 };
    function dessiner() {
      suivreCurseur();
      caler();
      placerCurseur();
      if (curseur.hidden) return;
      var v = reduit() ? (niv.brut < SILENCE ? MIN : 0.6) : Math.max(MIN, Math.min(1, niv.val));
      barre.style.transform = 'scaleY(' + v.toFixed(3) + ')';
      barre.style.backgroundColor = rgb(melange(GRIS, melange(OR, OR_CLAIR, Math.min(1, niv.val)), niv.or));
    }
    function boucle(t) {
      niv.raf = 0;
      if (etat !== 'ecoute' || calque.hidden) return;
      var dt = niv.t ? Math.min(120, t - niv.t) : 16;
      niv.t = t;
      var k = Math.pow(LISSAGE, dt / 50);
      niv.val = niv.cible + (niv.val - niv.cible) * k;
      niv.or = (niv.brut < SILENCE ? 0 : 1) + (niv.or - (niv.brut < SILENCE ? 0 : 1)) * k;
      if (reduit()) niv.or = niv.brut < SILENCE ? 0 : 1;
      dessiner();
      niv.raf = requestAnimationFrame(boucle);
    }
    function lancerBoucle() { if (!niv.raf) { niv.t = 0; niv.raf = requestAnimationFrame(boucle); } }
    function arreterBoucle() { if (niv.raf) cancelAnimationFrame(niv.raf); niv.raf = 0; }

    /* ---- Mots du texte provisoire : ceux déjà là ne bougent pas, les nouveaux arrivent un par un ---- */
    var affiches = [], file = [], tic = 0;
    function apparaitre(n, retard) {
      if (reduit() || document.hidden || !n.animate) return;
      n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ENTREE, delay: retard || 0, easing: 'ease-out', fill: 'backwards' });
    }
    function fondre(n) {
      if (reduit() || document.hidden || !n.animate) return;
      n.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' });
    }
    function poser(retard) {
      var w = file.shift();
      if (!w) return false;
      w.el = el('span', 'dictee-mot', (affiches.length ? ' ' : '') + w.texte);
      interim.appendChild(w.el);
      affiches.push(w);
      apparaitre(w.el, retard);
      return true;
    }
    /* Whisper retranscrit tout depuis le début à chaque passe : un mot du début peut changer (ponctuation,
     * accord). Les mots déjà affichés sont donc corrigés sur place, à leur position, sans jamais être retirés
     * puis réécrits (18/11/2026, Eliot : « voir les caractères se mettre à jour mais pas réécrire la même ligne »).
     * Seuls les mots en plus, à la fin, arrivent un par un. */
    function afficherMots(t, final) {
      var B = mots(t), i;
      clearInterval(tic); tic = 0;
      var n = Math.min(affiches.length, B.length);
      for (i = 0; i < n; i++) {
        if (affiches[i].texte === B[i]) continue;
        affiches[i].texte = B[i];
        affiches[i].cle = cle(B[i]);
        affiches[i].el.textContent = (i ? ' ' : '') + B[i];
        if (final) fondre(affiches[i].el);
      }
      // texte plus court que ce qui est affiché : la fin en trop part d'un coup
      for (i = n; i < affiches.length; i++) affiches[i].el.remove();
      affiches.length = n;
      file = B.slice(n).map(function (m) { return { texte: m, cle: cle(m) }; });
      if (final || reduit() || document.hidden) {
        // texte final : la suite d'un coup, avec un léger décalage de mot en mot plutôt qu'un bloc
        var r = 0, decale = final && !reduit();
        while (poser(decale ? Math.min(r++, 12) * 28 : 0)) { /* tous les mots */ }
        return;
      }
      if (!file.length) return;
      // whisper rend un texte toutes les 0,5 s environ : les mots nouveaux s'étalent sur ce temps
      var pas = Math.max(45, Math.min(130, Math.round(420 / file.length)));
      poser(0);
      if (file.length) tic = setInterval(function () { if (!poser(0) || !file.length) { clearInterval(tic); tic = 0; } }, pas);
    }
    function viderMots() {
      clearInterval(tic); tic = 0;
      file = []; affiches = [];
      interim.textContent = '';
      interim.className = 'dictee-interim';
    }

    function ouvrirCalque(b) {
      clearTimeout(traine); traine = null;
      copierStyle();
      viderMots();
      tAvant.data = b.valeur.slice(0, b.debut);
      tSel.textContent = b.valeur.slice(b.debut, b.fin);
      tApres.data = b.valeur.slice(b.fin);
      niv.brut = niv.cible = niv.val = niv.or = 0;
      curseur.hidden = false;
      calque.hidden = false;
      ta.classList.add('dictee-active');
      dessiner();
    }
    function fermerCalque() {
      clearTimeout(traine); traine = null;
      arreterBoucle();
      calque.hidden = true;
      ta.classList.remove('dictee-active');
      viderMots();
      tSel.textContent = '';
    }

    /* ---- Déroulé ---- */
    function activer() {
      clearTimeout(minuteur); minuteur = null;
      if (etat !== 'appui') return;
      var a = appui; appui = null;
      var debut = a.debut, fin = a.fin;
      if (a.espace) {
        // l'espace tapé à l'appui n'était pas un espace : on le retire (le terminal fait de même)
        if (ta.selectionStart === debut + 1 && ta.selectionEnd === debut + 1 && ta.value.charAt(debut) === ' ') {
          ta.setSelectionRange(debut, debut + 1);
          if (!document.execCommand('delete')) {
            ta.value = ta.value.slice(0, debut) + ta.value.slice(debut + 1);
            ta.setSelectionRange(debut, debut);
            ta.dispatchEvent(new Event('input'));
          }
        }
        debut = ta.selectionStart; fin = ta.selectionEnd;
      }
      etat = 'ecoute';
      base = { valeur: ta.value, debut: debut, fin: fin };
      ouvrirCalque(base);
      montrer('ecoute', 'Je t’écoute…', 'Échap annule');
      lancerBoucle();
      BT.pont.envoyer('dictee', { action: 'debut' });
    }

    function annulerAppui(taper) {
      clearTimeout(minuteur); minuteur = null;
      var a = appui; appui = null;
      if (etat === 'appui') etat = 'repos';
      // appui bref sur une sélection : l'espace la remplace, comme d'habitude
      if (taper && a && !a.espace) document.execCommand('insertText', false, ' ');
    }

    function finir() {
      if (etat !== 'ecoute') return;
      etat = 'transcription';
      arreterBoucle();
      curseur.hidden = true;
      montrer('transcription', 'Transcription…');
      BT.pont.envoyer('dictee', { action: 'fin' });
    }

    function annuler() {
      var avant = etat;
      etat = 'repos';
      if (avant === 'ecoute') BT.pont.envoyer('dictee', { action: 'annuler' });
      else if (avant === 'transcription') aIgnorer++;   // whisper finit quand même : sa réponse sera ignorée
      restaurer();
      fermerCalque();
      cacher();
    }

    function separateurs(avant, apres, t) {
      return {
        a: avant && t && !/\s$/.test(avant) ? ' ' : '',
        b: apres && t && !/^\s/.test(apres) ? ' ' : ''
      };
    }

    // Texte partiel affiché en direct à la place de la sélection d'origine (sans historique d'annulation).
    function partiel(t) {
      if (!base || !t) return;
      var avant = base.valeur.slice(0, base.debut), apres = base.valeur.slice(base.fin);
      var s = separateurs(avant, apres, t);
      ta.value = avant + s.a + t + s.b + apres;
      var c = avant.length + s.a.length + t.length;
      ta.setSelectionRange(c, c);
      self.ajusterSaisie();
      tAvant.data = avant + s.a;
      tSel.textContent = '';
      tApres.data = s.b + apres;
      afficherMots(t, false);
      dessiner();
    }

    function restaurer() {
      if (!base) return;
      if (ta.value !== base.valeur) { ta.value = base.valeur; self.ajusterSaisie(); }
      ta.setSelectionRange(base.debut, base.fin);
      base = null;
    }

    // Texte final : remplace le provisoire sur place, en une seule étape d'annulation (⌘Z).
    function finale(t) {
      var b = base;
      if (!b) b = { valeur: ta.value, debut: ta.value.length, fin: ta.value.length };
      base = null;
      if (ta.value !== b.valeur) ta.value = b.valeur;
      if (!t) { ta.setSelectionRange(b.debut, b.fin); self.ajusterSaisie(); fermerCalque(); return; }
      var avant = b.valeur.slice(0, b.debut), apres = b.valeur.slice(b.fin);
      var s = separateurs(avant, apres, t);
      var c = b.debut + s.a.length + t.length;
      ta.focus();
      ta.setSelectionRange(b.debut, b.fin);
      if (!document.execCommand('insertText', false, s.a + t + s.b)) {   // repli : sans historique d'annulation
        ta.value = avant + s.a + t + s.b + apres;
        ta.dispatchEvent(new Event('input'));
      }
      ta.setSelectionRange(c, c);   // curseur juste après le texte dicté, comme dans le terminal
      self.ajusterSaisie();
      if (calque.hidden || reduit()) { fermerCalque(); return; }
      curseur.hidden = true;
      tAvant.data = avant + s.a;
      tSel.textContent = '';
      tApres.data = s.b + apres;
      interim.classList.add('final');
      afficherMots(t, true);
      dessiner();
      traine = setTimeout(fermerCalque, TRAINE + Math.min(mots(t).length, 12) * 28);
    }

    /* ---- Clavier ---- */
    function modifie(e) {
      if (e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter' || e.key === 'Tab') return true;
      return e.key.length === 1 && !(e.metaKey && /^[ac]$/i.test(e.key));
    }

    ta.addEventListener('keydown', function (e) {
      var espace = e.key === ' ' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.isComposing;
      if (traine) fermerCalque();   // on reprend la main pendant la fin du fondu : la saisie redevient normale
      if (etat === 'appui' && !espace) annulerAppui(true);   // autre touche : c'était un espace tapé
      if (etat === 'ecoute' || etat === 'transcription') {
        if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); annuler(); return; }
        if (e.key === ' ' || modifie(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
        return;
      }
      if (!espace || !BT.pont.natif || ta.disabled) return;
      if (etat === 'appui') {   // répétition de la touche : c'est un appui maintenu, inutile d'attendre
        e.preventDefault();
        if (e.repeat) activer();
        return;
      }
      if (e.repeat) { e.preventDefault(); return; }   // touche encore tenue après une dictée ou une erreur
      appui = { debut: ta.selectionStart, fin: ta.selectionEnd };
      appui.espace = appui.debut === appui.fin;
      // sans sélection, l'espace s'écrit tout de suite ; avec, on attend de savoir (il la remplacerait)
      if (!appui.espace) e.preventDefault();
      etat = 'appui';
      minuteur = setTimeout(activer, SEUIL);
    }, true);

    ta.addEventListener('keyup', function (e) {
      if (e.key !== ' ') return;
      if (etat === 'appui') annulerAppui(true);   // appui bref : un espace normal
      else if (etat === 'ecoute') finir();
    });

    // keyup perdu (fenêtre quittée, focus ailleurs) : on termine proprement.
    function perte() {
      if (etat === 'appui') annulerAppui(false);
      else if (etat === 'ecoute') finir();
    }
    ta.addEventListener('blur', perte);
    window.addEventListener('blur', perte);
    ta.addEventListener('input', function () { if (traine) fermerCalque(); });
    ta.addEventListener('mousedown', function () { if (traine) fermerCalque(); });
    ta.addEventListener('scroll', function () { if (!calque.hidden) caler(); });
    window.addEventListener('resize', function () { if (!calque.hidden) dessiner(); });

    /* ---- Swift → page ---- */
    this.recevoirDictee = function (d) {
      d = d || {};
      var e = d.etat;
      if ((e === 'fini' || e === 'erreur' || e === 'annule') && aIgnorer > 0) { aIgnorer--; return; }
      if (e === 'ecoute') {
        if (etat !== 'ecoute') return;
        niv.brut = Math.max(0, Math.min(1, +d.niveau || 0));
        niv.cible = voix(niv.brut);
      } else if (e === 'partiel') {
        if (etat === 'ecoute' || etat === 'transcription') partiel(String(d.texte || '').trim());
      } else if (e === 'transcription') {
        // relâchement côté Swift (durée maximale atteinte) : même affichage qu'au relâchement d'Espace
        if (etat === 'ecoute') {
          etat = 'transcription';
          arreterBoucle();
          curseur.hidden = true;
          montrer('transcription', 'Transcription…');
        }
      } else if (e === 'fini') {
        if (etat !== 'ecoute' && etat !== 'transcription') return;
        etat = 'repos';
        cacher();
        finale(String(d.texte || '').trim());
      } else if (e === 'erreur') {
        if (etat === 'ecoute' || etat === 'transcription') { etat = 'repos'; restaurer(); fermerCalque(); }
        montrer('erreur', d.erreur || 'La dictée a échoué.');
        cacher(4000);
      } else if (e === 'annule') {
        if (etat !== 'ecoute' && etat !== 'transcription') return;
        etat = 'repos';
        restaurer();
        fermerCalque();
        cacher();
      }
    };
  };
})();
