import Foundation

/// Écoute mains libres du mode Jarvis (08/11/2026, demande d'Eliot : « je le lance et à partir de là, je parle
/// et il me répond »). Un `CaptureMicro` en mode continu, à part de celui de la dictée, dont l'audio passe dans
/// un `DecoupeurEnonces`. Elle-même ne décide de rien : `MoteurVocal` la démarre, l'arrête (le micro est libéré
/// pour la dictée de la saisie et pour ⌥Espace) et l'ouvre ou la ferme (fermée : l'audio reçu est jeté, le micro
/// reste ouvert, ce qui évite de le rallumer à chaque fois).
///
/// 09/11/2026 : elle reste ouverte pendant la voix de Jarvis (pour qu'Eliot puisse lui couper la parole) ;
/// `niveauEcho` donne alors le niveau joué sur les haut-parleurs, relevé ici toutes les 20 ms sur le fil principal
/// et passé au découpeur (anti-écho). Pauses et reprises d'un énoncé remontent aussi (fin d'énoncé intelligente).
///
/// Les rappels arrivent sur le fil principal ; un énoncé commencé avant une fermeture n'est jamais livré.
final class EcouteContinue {
    /// Un énoncé commence (parole d'Eliot détectée).
    var surDebut: (() -> Void)?
    /// Silence dans l'énoncé (`silencePause`) : `MoteurVocal` doit rendre un `verdict`.
    var surPause: ((DecoupeurEnonces.Pause) -> Void)?
    /// Eliot reparle après une pause : même énoncé.
    var surReprise: (() -> Void)?
    /// L'énoncé est fini.
    var surFin: ((DecoupeurEnonces.Enonce) -> Void)?
    /// Niveau (dBFS) de ce que Jarvis joue sur des haut-parleurs que le micro entend, nil sinon. Fil principal.
    var niveauEcho: (() -> Float?)?

    private let micro = CaptureMicro()
    private let verrou = NSLock()
    private var decoupeur = DecoupeurEnonces()
    private var ouverte = false
    private var generation = 0
    private var echo: Float?
    private var releve: DispatchSourceTimer?
    private(set) var enMarche = false

    /// Démarre le micro (AVCaptureSession) ; `source` remplace le micro par un fichier (tests).
    func demarrer(source: URL?) throws {
        guard !enMarche else { return }
        verrou.lock()
        decoupeur = DecoupeurEnonces(ParametresEcoute.depuis(Reglages.d))   // réglages relus à chaque démarrage
        generation += 1
        verrou.unlock()
        try micro.demarrerContinu(source: source) { [weak self] t in self?.recevoir(t) }
        enMarche = true
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now(), repeating: .milliseconds(20))
        t.setEventHandler { [weak self] in
            guard let self else { return }
            let n = self.niveauEcho?()
            self.verrou.lock(); self.echo = n; self.verrou.unlock()
        }
        releve = t
        t.resume()
        journal("écoute : micro ouvert en continu\(source != nil ? " (simulé)" : "")")
    }

    func arreter() {
        guard enMarche else { return }
        micro.arreterSansResultat()   // synchrone : plus aucune tranche ensuite
        releve?.cancel(); releve = nil
        enMarche = false
        verrou.lock(); ouverte = false; echo = nil; decoupeur.reinitialiser(); generation += 1; verrou.unlock()
        journal("écoute : micro fermé")
    }

    /// Fermée : l'audio est jeté (et l'énoncé en cours oublié). Rouverte : on repart de zéro.
    func ouvrir(_ o: Bool) {
        verrou.lock()
        if o != ouverte {
            ouverte = o
            decoupeur.reinitialiser()
            generation += 1
        }
        verrou.unlock()
    }

    /// Verdict sur une pause (fil principal) : faux si Eliot a repris entre-temps.
    @discardableResult
    func verdict(pause: Int, inacheve: Bool) -> Bool {
        verrou.lock(); defer { verrou.unlock() }
        return ouverte && decoupeur.verdict(pause: pause, inacheve: inacheve)
    }

    /// Copie de l'audio de l'énoncé en cours (vide hors énoncé), pour la transcription en direct. Tout fil.
    func echantillonsEnonce() -> [Int16] {
        verrou.lock(); defer { verrou.unlock() }
        return ouverte ? decoupeur.enonceEnCours : []
    }

    var ouvertePourDiagnostic: Bool { verrou.lock(); defer { verrou.unlock() }; return ouverte }
    var couplageEchoPourDiagnostic: Float? { verrou.lock(); defer { verrou.unlock() }; return decoupeur.couplageDb }

    /// File de capture.
    private func recevoir(_ t: [Int16]) {
        verrou.lock()
        guard ouverte else { verrou.unlock(); return }
        let ev = decoupeur.pousser(t, sortieDb: echo)
        let g = generation
        verrou.unlock()
        guard !ev.isEmpty else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            for e in ev {
                self.verrou.lock()
                let valide = g == self.generation && self.ouverte
                self.verrou.unlock()
                guard valide else { return }
                switch e {
                case .debut: self.surDebut?()
                case .pause(let p): self.surPause?(p)
                case .reprise: self.surReprise?()
                case .fin(let en): self.surFin?(en)
                }
            }
        }
    }
}
