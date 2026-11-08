/* Banc du mur de vidéos. ?d=<dossier>&m=h1;h1,h2,v1 : un message par groupe (séparés par « ; »), une vidéo
 * <nom>.mp4 par nom. window.bilanMur() renvoie la disposition de chaque mur (rangées, tailles en px). */
(function () {
  'use strict';
  var BT = window.BT;
  var q = new URLSearchParams(location.search);
  var d = q.get('d') || '/tmp/bt-mur';
  var fil = document.getElementById('fil');
  (q.get('m') || 'h1').split(';').forEach(function (g) {
    var texte = 'Vidéos : ' + g.split(',').map(function (n) { return n.charAt(0) === '/' ? n : d + '/' + n + '.mp4'; }).join(' ');
    var carte = document.createElement('section'); carte.className = 'tour-claude';
    var corps = document.createElement('div'); corps.className = 'tour-corps';
    var bloc = document.createElement('div'); bloc.className = 'bloc-texte md';
    var frag = BT.rendreMarkdown(texte);
    var lec = BT.medias.pour(frag);
    bloc.appendChild(frag);
    if (lec) bloc.appendChild(lec);
    corps.appendChild(bloc); carte.appendChild(corps); fil.appendChild(carte);
  });
  window.bilanMur = function () {
    return Array.prototype.map.call(document.querySelectorAll('.media-mur'), function (m) {
      return {
        largeur: m.offsetWidth, colonne: m.parentNode.clientWidth, deborde: m.classList.contains('media-deborde'),
        rangs: Array.prototype.map.call(m.querySelectorAll('.mur-rang'), function (r) {
          return Array.prototype.map.call(r.querySelectorAll('video'), function (v) {
            return v.offsetWidth + 'x' + v.offsetHeight + (v.readyState ? '' : '!') + (v.paused ? '' : '▶') + (v.muted ? 'm' : '');
          }).join(' ');
        })
      };
    });
  };
})();
