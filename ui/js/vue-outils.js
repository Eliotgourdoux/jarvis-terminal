/* Better Terminal For Claude — aides DOM et détail des appels d'outils.
 * Tout texte venant de Claude passe par textContent, ou par BT.rendreMarkdown (assaini). */
(function () {
  'use strict';
  var BT = window.BT = window.BT || {};

  /* ---------- Aides DOM ---------- */

  function ajouter(n, e) {
    if (e == null || e === false) return;
    if (Array.isArray(e)) { for (var i = 0; i < e.length; i++) ajouter(n, e[i]); return; }
    if (typeof e === 'string' || typeof e === 'number') n.appendChild(document.createTextNode(String(e)));
    else n.appendChild(e);
  }
  BT.el = function (tag, classe, enfants) {
    var n = document.createElement(tag);
    if (classe) n.className = classe;
    ajouter(n, enfants);
    return n;
  };
  BT.bouton = function (classe, texte, action) {
    var b = BT.el('button', classe, texte);
    b.type = 'button';
    if (action) b.addEventListener('click', action);
    return b;
  };
  var el = BT.el;

  /* Texte brut limité, avec « Afficher tout ». */
  BT.preLimite = function (texte, classe, maxLignes) {
    texte = String(texte == null ? '' : texte);
    maxLignes = maxLignes || 40;
    var lignes = texte.split('\n');
    var trop = lignes.length > maxLignes + 4 || texte.length > 9000;
    var pre = el('pre', 'sortie' + (classe ? ' ' + classe : ''));
    pre.textContent = trop ? BT.tronquer(lignes.slice(0, maxLignes).join('\n'), 9000) : texte;
    if (!trop) return pre;
    var b = BT.bouton('bt-plus', 'Afficher tout (' + lignes.length + ' lignes)', function () { pre.textContent = texte; b.remove(); });
    return el('div', 'sortie-limitee', [pre, b]);
  };

  /* Bloc de code limité, avec « Afficher tout » ; Copier copie toujours le texte complet. */
  BT.codeLimite = function (code, lang, titre, maxLignes) {
    code = String(code == null ? '' : code).replace(/\n$/, '');
    maxLignes = maxLignes || 60;
    var lignes = code.split('\n');
    var trop = lignes.length > maxLignes + 4;
    var bloc = BT.blocCode(trop ? lignes.slice(0, maxLignes).join('\n') : code, lang, { titre: titre });
    bloc.codeComplet = code;
    if (!trop) return bloc;
    var b = BT.bouton('bt-plus', 'Afficher les ' + lignes.length + ' lignes', function () {
      var c = bloc.querySelector('code');
      c.textContent = code;
      if (lang) BT.colorerCode(c, lang);
      b.remove();
    });
    return el('div', 'sortie-limitee', [bloc, b]);
  };

  function section(titre, contenu) {
    return el('div', 'od-section', [titre ? el('div', 'od-titre', titre) : null, contenu]);
  }
  function chemin(p) { return el('div', 'od-chemin', p); }
  function note(t, classe) { return el('div', 'od-note' + (classe ? ' ' + classe : ''), t); }

  /* ---------- Diff (Edit / Write) ---------- */

  function diffDepuisPatch(patch) {
    var d = el('div', 'diff');
    var n = 0;
    patch.forEach(function (h) {
      d.appendChild(el('div', 'd-entete', 'Ligne ' + (h.newStart || h.oldStart || 1)));
      (h.lines || []).forEach(function (l) {
        if (n++ > 400) return;
        var s = l.charAt(0);
        var cls = s === '+' ? 'd-add' : s === '-' ? 'd-del' : 'd-ctx';
        d.appendChild(el('div', 'd-ligne ' + cls, [el('span', 'd-signe', s === ' ' ? '' : s), el('span', 'd-texte', l.slice(1) || ' ')]));
      });
    });
    return d;
  }
  function diffDepuisTextes(avant, apres) {
    var d = el('div', 'diff');
    String(avant || '').split('\n').forEach(function (l) {
      d.appendChild(el('div', 'd-ligne d-del', [el('span', 'd-signe', '-'), el('span', 'd-texte', l || ' ')]));
    });
    String(apres || '').split('\n').forEach(function (l) {
      d.appendChild(el('div', 'd-ligne d-add', [el('span', 'd-signe', '+'), el('span', 'd-texte', l || ' ')]));
    });
    return d;
  }
  BT.diff = function (entree, structure) {
    if (structure && Array.isArray(structure.structuredPatch) && structure.structuredPatch.length) return diffDepuisPatch(structure.structuredPatch);
    return diffDepuisTextes(entree.old_string, entree.new_string);
  };

  function images(r) {
    if (!r || !r.images || !r.images.length) return null;
    return el('div', 'od-images', r.images.map(function (im) {
      var i = document.createElement('img');
      if (/^image\/(png|jpe?g|gif|webp)$/.test(im.type || '')) i.src = 'data:' + im.type + ';base64,' + im.data;
      i.alt = 'Image renvoyée par l’outil';
      return i;
    }));
  }

  function json(o) {
    try { return JSON.stringify(o, null, 2); } catch (e) { return String(o); }
  }

  /* ---------- Aperçu de l'entrée (aussi utilisé par les permissions) ---------- */

  BT.apercuEntree = function (nom, e, structure) {
    e = e || {};
    switch (nom) {
      case 'Bash': case 'PowerShell':
        return el('div', null, [BT.codeLimite(e.command || '', 'bash', 'commande', 30), e.description ? note(e.description) : null,
          e.run_in_background ? note('Lancée en arrière-plan.') : null]);
      case 'Write':
        return el('div', null, [chemin(e.file_path || ''), BT.codeLimite(e.content || '', BT.langageFichier(e.file_path), BT.basename(e.file_path) || 'contenu', 40)]);
      case 'Edit':
        return el('div', null, [chemin(e.file_path || ''), BT.diff(e, structure), e.replace_all ? note('Toutes les occurrences.') : null]);
      case 'MultiEdit':
        return el('div', null, [chemin(e.file_path || '')].concat((e.edits || []).map(function (x) { return BT.diff(x, null); })));
      case 'Read':
        return chemin(e.file_path || '');
      default:
        if (!Object.keys(e).length) return null;
        return BT.codeLimite(json(e), 'json', 'paramètres', 30);
    }
  };

  /* ---------- Détail complet d'un appel d'outil ---------- */

  BT.detailOutil = function (o, session) {
    var e = o.entree || o.entreeApercu || {};
    var r = o.resultat;
    var s = r && r.structure;
    var f = document.createDocumentFragment();
    var erreur = o.statut === 'erreur' && r;
    if (erreur) f.appendChild(section('Erreur', BT.preLimite(r.texte || 'Erreur sans message.', 'erreur', 20)));

    switch (o.nom) {
      case 'Bash': case 'PowerShell':
        f.appendChild(section(null, BT.apercuEntree(o.nom, e)));
        if (r && !erreur) {
          if (s && typeof s === 'object' && s.stdout != null) {
            if (s.stdout) f.appendChild(section('Sortie', BT.preLimite(BT.sansAnsi(s.stdout), '', 40)));
            if (s.stderr) f.appendChild(section('Erreurs', BT.preLimite(BT.sansAnsi(s.stderr), 'erreur', 20)));
            if (!s.stdout && !s.stderr) f.appendChild(note('Aucune sortie.'));
            if (s.interrupted) f.appendChild(note('Commande interrompue.', 'avert'));
          } else {
            f.appendChild(section('Sortie', r.texte ? BT.preLimite(r.texte, '', 40) : note('Aucune sortie.')));
          }
        }
        break;

      case 'Read':
        f.appendChild(chemin(e.file_path || ''));
        if (r && !erreur) {
          var fichier = s && s.file;
          if (fichier && typeof fichier.content === 'string') {
            var debut = fichier.startLine || 1;
            var titre = fichier.totalLines ? 'lignes ' + debut + '–' + (debut + (fichier.numLines || 1) - 1) + ' sur ' + fichier.totalLines : BT.basename(e.file_path);
            f.appendChild(BT.codeLimite(fichier.content, BT.langageFichier(e.file_path), titre, 50));
          } else if (r.texte) {
            f.appendChild(BT.codeLimite(r.texte.replace(/^ *\d+\t/gm, ''), BT.langageFichier(e.file_path), BT.basename(e.file_path), 50));
          }
          var im = images(r); if (im) f.appendChild(im);
        }
        break;

      case 'Write': case 'Edit': case 'MultiEdit':
        f.appendChild(BT.apercuEntree(o.nom, e, s));
        break;

      case 'Grep': case 'Glob':
        var p = [];
        if (e.pattern) p.push('motif « ' + e.pattern + ' »');
        if (e.path) p.push('dans ' + e.path);
        if (e.glob) p.push('fichiers ' + e.glob);
        if (e.output_mode) p.push('mode ' + e.output_mode);
        f.appendChild(note(p.join(' · ')));
        if (r && !erreur) f.appendChild(section('Résultat', r.texte ? BT.preLimite(r.texte, '', 40) : note('Aucun résultat.')));
        break;

      case 'TodoWrite':
        var liste = el('ul', 'todos');
        (e.todos || []).forEach(function (t) {
          var st = t.status || 'pending';
          liste.appendChild(el('li', 'todo todo-' + st, [el('span', 'todo-marque', st === 'completed' ? '✓' : st === 'in_progress' ? '●' : '○'),
            el('span', 'todo-texte', st === 'in_progress' && t.activeForm ? t.activeForm : (t.content || ''))]));
        });
        f.appendChild(liste);
        break;

      case 'Agent': case 'Task':
        var puces = [e.subagent_type, e.model].filter(Boolean);
        if (puces.length) f.appendChild(el('div', 'od-puces', puces.map(function (x) { return el('span', 'puce', x); })));
        if (e.prompt) f.appendChild(section('Consigne', BT.preLimite(e.prompt, 'consigne', 8)));
        var lesEtapes = session && o.enfants && o.enfants.length ? etapes(o, session) : null;
        if (lesEtapes && lesEtapes.childNodes.length) f.appendChild(section('Étapes du sous-agent', lesEtapes));
        if (o.tache && o.tache.fond) {
          if (o.tache.statut === 'completed' && o.tache.resume) f.appendChild(section('Résultat', markdown(o.tache.resume)));
          else if (o.tache.statut !== 'completed') f.appendChild(note('Le sous-agent travaille en arrière-plan' + (o.tache.progres ? ' : ' + o.tache.progres : '') + '.'));
        } else if (r && !erreur && r.texte) {
          f.appendChild(section('Résultat', markdown(r.texte)));
        }
        break;

      case 'WebFetch':
        f.appendChild(lienUrl(e.url));
        if (e.prompt) f.appendChild(note(e.prompt));
        if (r && !erreur && r.texte) f.appendChild(section('Résultat', markdown(r.texte)));
        break;

      case 'WebSearch':
        f.appendChild(note('Recherche : ' + (e.query || '')));
        if (r && !erreur && r.texte) f.appendChild(section('Résultat', BT.preLimite(r.texte, '', 30)));
        break;

      case 'AskUserQuestion':
        var rep = (s && s.answers) || {};
        var ql = el('div', 'od-questions');
        (e.questions || []).forEach(function (q) {
          ql.appendChild(el('div', 'od-q', [el('div', 'od-q-texte', q.question || ''), el('div', 'od-q-rep', rep[q.question] ? '→ ' + rep[q.question] : '')]));
        });
        f.appendChild(ql);
        break;

      case 'ExitPlanMode':
        if (e.plan) f.appendChild(markdown(e.plan));
        break;

      default:
        var ap = BT.apercuEntree(o.nom, e);
        if (ap) f.appendChild(section('Paramètres', ap));
        if (r && !erreur) {
          if (r.texte) f.appendChild(section('Résultat', BT.preLimite(r.texte, '', 40)));
          var im2 = images(r); if (im2) f.appendChild(im2);
          if (!r.texte && !im2) f.appendChild(note('Aucun résultat.'));
        }
    }
    if (!r && o.statut !== 'interrompu' && !(o.tache && o.tache.fond)) f.appendChild(note(o.statut === 'prepare' ? 'Claude prépare l’appel…' : 'En cours…'));
    if (o.statut === 'interrompu') f.appendChild(note('Interrompu avant la fin.', 'avert'));
    return f;
  };

  function markdown(t) {
    var d = el('div', 'md md-petit');
    d.appendChild(BT.rendreMarkdown(BT.nettoyerTexteClaude(t)));
    return d;
  }

  function lienUrl(url) {
    var a = el('a', 'lien od-chemin', url || '');
    if (/^https?:/i.test(url || '')) a.setAttribute('href', url);
    return a;
  }

  /* Étapes d'un sous-agent : lignes compactes, sans détail (pas d'imbrication sans fin). */
  function etapes(o, session) {
    var l = el('div', 'etapes');
    o.enfants.forEach(function (id) {
      var it = session.item(id);
      if (!it) return;
      if (it.genre === 'outil') {
        var r = BT.resumeOutil(it.nom, it.entree || it.entreeApercu);
        l.appendChild(el('div', 'etape statut-' + it.statut, [el('span', 'pastille'), el('span', 'ligne-nom', r.nom),
          el('span', 'ligne-cible' + (r.mono ? ' mono' : ''), r.cible)]));
      }
      // Les textes du sous-agent ne sont pas répétés ici : son dernier mot est le « Résultat ».
    });
    return l;
  }
})();
