import Foundation

/// Écoute mains libres du mode Jarvis (08/11/2026, demande d'Eliot : « je le lance et à partir de là, je parle
/// et il me répond »). Un `CaptureMicro` en mode continu, à part de celui de la dictée, dont l'audio passe dans
/// un `DecoupeurEnonces`. Elle-même ne décide de rien : `MoteurVocal` la démarre, l'arrête (le micro est libéré
/// pour la dictée de la saisie et pour ⌥Espace) et l'ouvre ou la ferme (fermée pendant que Jarvis parle, pendant
/// une transcription : l'audio reçu est jeté, le micro reste ouvert, ce qui évite de le rallumer à chaque fois).
///
/// Les rappels arrivent sur le fil principal ; un énoncé commencé avant une fermeture n'est jamais livré.
final class EcouteContinue {
    /// Un énoncé commence (parole d'Eliot détectée).
    var surDebut: (() -> Void)?
    /// L'énoncé est fini.
    var surFin: ((DecoupeurEnonces.Enonce) -> Void)?

    private let micro = CaptureMicro()
    private let verrou = NSLock()
    private var decoupeur = DecoupeurEnonces()
    private var ouverte = false
    private var generation = 0
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
        journal("écoute : micro ouvert en continu\(source != nil ? " (simulé)" : "")")
    }

    func arreter() {
        guard enMarche else { return }
        micro.arreterSansResultat()   // synchrone : plus aucune tranche ensuite
        enMarche = false
        verrou.lock(); ouverte = false; decoupeur.reinitialiser(); generation += 1; verrou.unlock()
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

    /// Copie de l'audio de l'énoncé en cours (vide hors énoncé), pour la transcription en direct. Tout fil.
    func echantillonsEnonce() -> [Int16] {
        verrou.lock(); defer { verrou.unlock() }
        return ouverte ? decoupeur.enonceEnCours : []
    }

    var ouvertePourDiagnostic: Bool { verrou.lock(); defer { verrou.unlock() }; return ouverte }

    /// File de capture.
    private func recevoir(_ t: [Int16]) {
        verrou.lock()
        guard ouverte else { verrou.unlock(); return }
        let ev = decoupeur.pousser(t)
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
                case .fin(let en): self.surFin?(en)
                }
            }
        }
    }
}
