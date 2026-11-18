import AppKit

/// Registre central : le seul objet qui connaît toutes les sessions ouvertes (fenêtre, état, dernier
/// message) et qui peut parler à n'importe laquelle. Point d'entrée prévu pour les étapes suivantes
/// (Cockpit, Jarvis, mode vocal avec file d'attente commune) : elles s'abonnent aux notifications
/// ci-dessous et appellent `envoyer`, sans toucher aux fenêtres.
/// Tout se passe sur le fil principal.
final class RegistreSessions {
    static let shared = RegistreSessions()
    private init() {}

    /// Une session a changé (état, résumé, dernier message, pid, ouverture, fermeture). userInfo["sessionId"].
    static let changement = Notification.Name("bt.registre.changement")
    /// Claude a fini un tour de parole. userInfo["sessionId"], userInfo["texte"] (réponse finale).
    static let tourTermine = Notification.Name("bt.registre.tourTermine")

    private(set) var sessions: [Session] = []

    struct Apercu {
        let sessionId, cwd, projet, emoji, etat: String
        let resume, dernierMessage, modele, effort: String?
        let pid: Int32?
        let dansTerminal: Bool
        let maj: Date
        let agents: Int
        var parent: String? = nil   // nom du projet parent, pour un sous-projet
    }

    func ajouter(_ s: Session) { sessions.append(s); signaler(s); memoriser() }

    func retirer(_ s: Session) {
        sessions.removeAll { $0 === s }
        memoriser()
        NotificationCenter.default.post(name: Self.changement, object: self, userInfo: ["sessionId": s.sessionId, "ferme": true])
    }

    /// Fermetures avec bilan en cours (08/11/2026, demande d'Eliot) : la fenêtre est partie, Claude fait sa fin de
    /// session en arrière-plan. La barre les montre en bas de la liste avec un spinner rouge jusqu'à l'arrêt du processus.
    struct Fermeture { let sessionId, projet, emoji, cwd: String; let debut: Date }
    private(set) var enFermeture: [Fermeture] = []

    func debutFermeture(_ s: Session) {
        enFermeture.removeAll { $0.sessionId == s.sessionId }
        enFermeture.append(Fermeture(sessionId: s.sessionId, projet: s.projet.nom, emoji: s.projet.emoji, cwd: s.cwd, debut: Date()))
        NotificationCenter.default.post(name: Self.changement, object: self, userInfo: ["sessionId": s.sessionId, "fermeture": true])
    }

    func finFermeture(_ sessionId: String) {
        guard enFermeture.contains(where: { $0.sessionId == sessionId }) else { return }
        enFermeture.removeAll { $0.sessionId == sessionId }
        NotificationCenter.default.post(name: Self.changement, object: self, userInfo: ["sessionId": sessionId, "fermetureFinie": true])
    }

    /// Session ouverte (pas en cours de fermeture) portant cet id.
    func session(_ sessionId: String) -> Session? {
        sessions.first { !$0.estFermee && $0.sessionId.lowercased() == sessionId.lowercased() }
    }

    // MARK: - Mémoire entre deux lancements (demande d'Eliot, 07/11/2026)

    /// Vrai pendant « Quitter » : les fermetures en série ne doivent pas effacer la liste à rouvrir.
    var quitte = false

    /// Sessions ouvertes (dossier + id), relues au prochain lancement ; et dernier dossier utilisé.
    func memoriser() {
        guard !quitte, !PiloteDev.actif else { return }
        let liste = sessions.filter { !$0.estFermee }.map { ["cwd": $0.cwd, "id": $0.sessionId] }
        Reglages.mettre(liste, "BTSessionsOuvertes")
        if let d = sessions.last?.cwd { Reglages.mettre(d, "BTDernierDossier") }
        // état affiché dans la barre (Travaille…, résumé, dernier message), relu après une relance
        var etats: [String: [String: Any]] = [:]
        for s in sessions where !s.estFermee {
            var e: [String: Any] = ["etat": s.etat, "maj": s.maj.timeIntervalSince1970, "agents": s.agentsEnCours]
            if let r = s.resume { e["resume"] = r }
            if let d = s.dernierMessage { e["dernier"] = String(d.prefix(2000)) }
            etats[s.sessionId] = e
        }
        Reglages.mettre(etats, "BTEtatsSessions")
    }

    /// États mémorisés au dernier « Quitter », consommés une fois par chaque session reprise.
    private static var etatsRestaures: [String: [String: Any]] = [:]
    static func etatRestaure(_ id: String) -> [String: Any]? { etatsRestaures.removeValue(forKey: id.lowercased()) }

    /// Rouvre les sessions du dernier lancement : reprise si la conversation existe, sinon session neuve
    /// dans le même dossier. Renvoie faux s'il n'y avait rien à rouvrir.
    @discardableResult
    static func rouvrirDernieres() -> Bool {
        var liste = (Reglages.d.array(forKey: "BTSessionsOuvertes") as? [[String: String]]) ?? []
        if liste.isEmpty, let d = Reglages.texte("BTDernierDossier") { liste = [["cwd": d]] }
        FenetrePrincipale.shared.debuterRestauration()   // la page affichée au dernier lancement reprend sa place
        etatsRestaures = (Reglages.d.dictionary(forKey: "BTEtatsSessions") as? [String: [String: Any]]) ?? [:]
        // la session qui a demandé la relance (app/relancer.sh) avait fini son tour : pas de reprise automatique
        if let d = Reglages.texte("BTRelanceDemandeur")?.lowercased() {
            etatsRestaures[d]?["etat"] = "pret"
            Reglages.mettre(nil, "BTRelanceDemandeur")
        }
        var n = 0
        for e in liste {
            guard let c = e["cwd"], FileManager.default.fileExists(atPath: c) else { continue }
            var dem = DemandeSession(cwd: c)
            if let id = e["id"], Transcript.chemin(cwd: c, sessionId: id) != nil { dem.resume = id }
            Entrees.ouvrir(dem); n += 1
        }
        journal("lancement : \(n) session(s) rouverte(s) depuis la mémoire")
        return n > 0
    }

    func apercus() -> [Apercu] { sessions.map(\.apercu) }

    /// Envoie un message utilisateur à une session (par la page si elle sait le faire, sinon directement).
    @discardableResult
    func envoyer(_ texte: String, a sessionId: String, source: String) -> Bool {
        guard let s = session(sessionId) else { journal("registre : session \(sessionId) inconnue"); return false }
        return s.envoyerTexte(texte, source: source)
    }

    func signaler(_ s: Session) {
        NotificationCenter.default.post(name: Self.changement, object: self, userInfo: ["sessionId": s.sessionId])
    }

    func signalerTour(_ s: Session, texte: String) {
        NotificationCenter.default.post(name: Self.tourTermine, object: self, userInfo: ["sessionId": s.sessionId, "texte": texte])
    }

    /// Ferme toutes les sessions (quitter l'app) ; `fini` quand tous les processus sont arrêtés.
    func toutArreter(_ fini: @escaping () -> Void) {
        // « Laisser tourner en fond » (réglage BTGarderEnFond, ou une seule fois pour une relance par
        // app/relancer.sh) : les claude continuent sans l'app, qui se rebranchera dessus au prochain lancement.
        let unefois = Reglages.d.bool(forKey: "BTGarderUneFois")
        if unefois { Reglages.mettre(nil, "BTGarderUneFois") }
        let garder = !PiloteDev.actif && (unefois || Reglages.d.bool(forKey: "BTGarderEnFond"))
        journal("quitter : \(garder ? "les claude restent en fond" : "les claude sont arrêtés")")
        let groupe = DispatchGroup()
        for s in sessions {
            groupe.enter()
            if garder, s.detacherPourQuitter({ groupe.leave() }) { continue }
            s.arreterPourQuitter { groupe.leave() }
        }
        groupe.notify(queue: .main, execute: fini)
    }

    /// Fichiers d'état laissés par une app tuée : on retire ceux dont le processus n'existe plus.
    /// claude laissés en fond (ProcessusClaude.swift) : on supprime les dossiers des processus morts, et on arrête
    /// ceux qui tournent encore sans qu'aucune session ouverte ne les tienne (ils resteraient invisibles).
    /// Appelé un moment après le lancement, quand les sessions du dernier lancement sont rouvertes.
    static func nettoyerVivants() {
        let racine = DOSSIER_BT + "/vivants"
        let fm = FileManager.default
        for id in (try? fm.contentsOfDirectory(atPath: racine)) ?? [] where Validation.sessionId(id) {
            let d = racine + "/" + id
            let o = (fm.contents(atPath: d + "/vivant.json")).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let pid = pid_t((o?["pid"] as? Int) ?? 0)
            let debut = (o?["debut"] as? Double) ?? 0
            let vivant = pid > 1 && kill(pid, 0) == 0 && ProcessusClaude.debut(pid).map { abs($0 - debut) < 0.01 } == true
            if RegistreSessions.shared.session(id) != nil { continue }
            if vivant {
                journal("vivants : claude pid \(pid) de la session \(id) tourne sans session ouverte, arrêté")
                _ = kill(-pid, SIGTERM); _ = kill(pid, SIGTERM)
                DispatchQueue.global().asyncAfter(deadline: .now() + 5) { if ProcessusClaude.debut(pid) == debut { _ = kill(-pid, SIGKILL) } }
            }
            try? fm.removeItem(atPath: d)
        }
    }

    static func nettoyerEtatsOrphelins() {
        let fm = FileManager.default
        for f in (try? fm.contentsOfDirectory(atPath: DOSSIER_SESSIONS)) ?? [] where f.hasSuffix(".json") {
            let p = DOSSIER_SESSIONS + "/" + f
            guard let d = fm.contents(atPath: p), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
            let pid = (o["pid"] as? NSNumber)?.int32Value ?? 0
            if pid <= 0 || (kill(pid, 0) != 0 && errno == ESRCH) { try? fm.removeItem(atPath: p); journal("état orphelin retiré : \(f)") }
        }
    }
}
