import AppKit
import IOKit.ps

/// File « limite » (18/11/2026, Eliot : « quand on tape la limite on va ajouter une stack de messages »).
/// Quand Claude refuse un tour parce que la limite d'usage de l'abonnement est atteinte :
///  - la session refusée est « coupée » : à la minute de la reprise, elle reçoit « Reprends » toute seule ;
///  - les messages qu'Eliot écrit en attendant ne partent pas chez Claude (il les refuserait) : ils sont gardés
///    ici, dans l'ordre, et tous écrits d'un coup à la reprise ;
///  - tant que quelque chose attend et que le Mac est sur secteur, la mise en veille automatique est bloquée.
/// Deux sortes de limites : celle de tout l'abonnement (5 h, semaine), où toutes les sessions retiennent, et celle
/// d'un seul modèle (seven_day_opus…), où seules les sessions refusées retiennent.
/// Le refus est confirmé par Session (message d'erreur `usage_limit_reached` de Claude, ou relevé « rejected »
/// suivi d'un tour en erreur) ; une vraie réponse de Claude après un refus prouve que la limite est levée.
/// Un message refusé reste dans la conversation de Claude : il n'est jamais réécrit, c'est « Reprends » qui
/// demande d'y répondre (pas de doublon).
/// L'état est écrit dans ~/.config/better-terminal/limite.json : il survit à une relance de l'app.
/// Tout se passe sur le fil principal.
final class LimiteUsage {
    static let shared = LimiteUsage()

    struct Retenu {
        let uuid: String
        let sessionId: String
        let cwd: String
        let ligne: String      // ligne stdin complète (texte, images)
        let texte: String      // pour la bulle et pour une session rouverte
    }

    struct Coupure {
        var cwd: String
        var reprise: Date
        var globale: Bool      // refusée par la limite de tout l'abonnement
        var auto: Bool         // « Reprends » envoyé tout seul (faux après trop de refus d'affilée)
    }

    /// Fin de la limite de tout l'abonnement. Tant qu'elle est là, aucune session n'envoie.
    private(set) var globale: Date?
    private var coupees: [String: Coupure] = [:]     // sessionId → coupure
    private var retenus: [Retenu] = []
    /// Fin de chaque fenêtre vue dans un relevé normal : repli quand le refus ne donne pas d'heure.
    private var resets: [String: Date] = [:]
    private var dernierRefus = Date.distantPast
    /// Refus d'affilée juste après une reprise, par session : on espace, puis on ne relance plus seul.
    private var tentatives: [String: Int] = [:]
    private var relachees: [String: Date] = [:]
    /// Messages qu'on n'a pas pu écrire à la reprise (claude arrêté) : dits une fois à la page.
    private var perdus: [String: [String]] = [:]
    private var minuteur: Timer?
    private var activite: NSObjectProtocol?
    private var activiteSecteur = false
    private let chemin = DOSSIER_BT + "/limite.json"
    /// Claude rouvre la fenêtre à la seconde près ; petite marge pour ne pas être refusé de nouveau.
    static let marge: TimeInterval = 20
    static let delais: [TimeInterval] = [300, 900, 3600]
    /// Horloge (remplaçable dans les essais).
    static var maintenant: () -> Date = { Date() }
    /// Rien ne part dans les secondes qui suivent le lancement : les sessions du dernier lancement ne sont pas
    /// encore toutes rouvertes, on les prendrait pour des sessions fermées.
    static var pasAvant = Date().addingTimeInterval(12)
    static let messageReprise = "Reprends : la limite d'usage vient d'être levée. Continue exactement où tu t'es arrêté, sans refaire ce qui est déjà fait, et réponds aux messages que je t'ai envoyés pendant la limite s'ils sont restés sans réponse."

    private init() {
        lire()
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            // au réveil du Mac, le réseau n'est pas encore là : on laisse quelques secondes
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) { self?.verifier() }
        }
        armer()
    }

    private var rienEnAttente: Bool { retenus.isEmpty && coupees.isEmpty }
    /// Une limite est notée, ou quelque chose attend encore.
    var active: Bool { globale != nil || !rienEnAttente }

    // MARK: - Ce que voient les sessions

    /// Cette session doit-elle garder ses messages au lieu de les envoyer ?
    /// (Aussi tant qu'elle a des messages gardés pas encore partis : l'ordre est respecté.)
    func retient(_ s: Session) -> Bool {
        guard active else { return false }
        verifier()
        let id = s.sessionId
        return globale != nil || coupees[id] != nil || retenus.contains { $0.sessionId == id }
    }

    /// Heure à laquelle cette session pourra envoyer (nil si aucune limite ne la retient).
    private func repriseDe(_ id: String) -> Date? {
        switch (globale, coupees[id]?.reprise) {
        case let (g?, c?): return max(g, c)
        case let (g?, nil): return g
        case let (nil, c?): return c
        default: return nil
        }
    }

    /// Pour la barre des sessions : heure de reprise et nombre de messages gardés (nil si rien ne l'attend).
    func attente(_ sessionId: String) -> (reprise: Date, messages: Int)? {
        let n = retenus.filter { $0.sessionId == sessionId }.count
        guard n > 0 || coupees[sessionId] != nil, let r = repriseDe(sessionId) else { return nil }
        return (r, n)
    }

    /// État pour la page : bt.limite({reprise, retient, coupee, auto, attente:[{uuid, texte}], perdus:[uuid], total}).
    func etatPage(_ s: Session) -> [String: Any] {
        let id = s.sessionId
        let r = repriseDe(id)
        let siens = retenus.filter { $0.sessionId == id }
        var e: [String: Any] = [
            "reprise": r.map { $0.timeIntervalSince1970 * 1000 as Any } ?? NSNull(),
            "retient": r != nil || !siens.isEmpty,
            "coupee": coupees[id] != nil,
            "auto": coupees[id]?.auto ?? false,
            "attente": siens.map { ["uuid": $0.uuid, "texte": String($0.texte.prefix(4000))] },
            "total": retenus.count + coupees.count
        ]
        if let p = perdus[id] { e["perdus"] = p }
        return e
    }

    // MARK: - Ce que Session rapporte

    /// Relevé normal (allowed, allowed_warning) : on retient seulement la fin de la fenêtre.
    func releve(type: String?, resetsAt: Double?) {
        if let t = resetsAt, t > 0 { resets[type ?? ""] = Date(timeIntervalSince1970: t) }
    }

    /// Limite de tout l'abonnement ? Tout sauf la limite d'un seul modèle (seven_day_opus, seven_day_sonnet…).
    static func estGlobale(_ type: String?) -> Bool {
        guard let t = type else { return true }
        return !(t.hasPrefix("seven_day_") && t != "seven_day_overage_included")
    }

    /// Claude vient de refuser un tour de cette session : limite atteinte (refus confirmé par Session).
    func refus(_ s: Session, resetsAt: Double?, type: String?) {
        guard !s.estFermee else { return }
        let id = s.sessionId, now = Self.maintenant()
        dernierRefus = now
        // refusée juste après qu'on l'a relancée : l'heure annoncée était fausse, on espace
        if let r = relachees[id], now.timeIntervalSince(r) < 600 { tentatives[id, default: 0] += 1 }
        relachees[id] = nil
        let n = tentatives[id] ?? 0
        let annoncee = resetsAt.flatMap { $0 > 0 ? Date(timeIntervalSince1970: $0) : nil } ?? resets[type ?? ""]
        var d = annoncee ?? now.addingTimeInterval(1800)
        // heure passée ou imminente : nouvel essai dans 5, 15 puis 60 min
        if d.timeIntervalSince(now) < 60 { d = now.addingTimeInterval(Self.delais[min(n, Self.delais.count - 1)]) }
        let glob = Self.estGlobale(type)
        let auto = n < Self.delais.count
        let dejaLa = coupees[id]?.reprise == d
        coupees[id] = Coupure(cwd: s.cwd, reprise: d, globale: glob, auto: auto)
        if glob { globale = d }
        if !dejaLa {
            journal("limite : atteinte dans \(id) (\(type ?? "type inconnu")\(glob ? ", tout l'abonnement" : ", ce modèle seulement")), reprise prévue à \(iso8601.string(from: d))\(auto ? "" : " — trop de refus d'affilée, plus de reprise automatique")")
        }
        changement()
    }

    /// Claude a vraiment répondu dans cette session (message du fil principal, pas une erreur).
    /// `debutRequete` : début du tour ou de la dernière requête à l'API de cette session.
    func reponseReelle(_ s: Session, debutRequete: Date?) {
        let id = s.sessionId
        tentatives[id] = nil; relachees[id] = nil
        guard active else { return }
        var change = false
        if coupees[id] != nil {
            // la session travaille : le refus venait d'un sous-agent, ou Claude a continué autrement
            journal("limite : \(id) répond de nouveau, sa coupure est annulée")
            coupees[id] = nil
            change = true
        }
        // une requête partie après le dernier refus a abouti : la limite de l'abonnement est levée avant l'heure
        if globale != nil, let d = debutRequete, d > dernierRefus {
            journal("limite : une réponse est arrivée, la limite de l'abonnement est levée avant l'heure prévue")
            globale = nil
            for k in coupees.keys where coupees[k]!.globale { coupees[k]!.reprise = .distantPast }
            change = true
        }
        if change, !verifier() { changement() }
    }

    /// La session est fermée par Eliot (pas par « Quitter ») : sa reprise automatique n'a plus lieu.
    /// Les messages qu'il avait préparés restent : ils rouvriront la session à la reprise.
    func sessionFermee(_ s: Session) {
        guard coupees[s.sessionId] != nil else { return }
        coupees[s.sessionId] = nil
        journal("limite : \(s.sessionId) fermée, sa reprise automatique est abandonnée")
        changement()
    }

    /// Eliot change de modèle : une coupure due à la limite d'un seul modèle ne vaut plus.
    func modeleChange(_ s: Session) {
        guard let c = coupees[s.sessionId], !c.globale else { return }
        journal("limite : \(s.sessionId) change de modèle, sa coupure est levée")
        coupees[s.sessionId] = nil
        if !verifier() { changement() }
    }

    // MARK: - Messages retenus

    /// Garde un message d'Eliot au lieu de l'écrire sur stdin. Faux s'il doit partir normalement.
    func garder(_ s: Session, ligne: String, objet: [String: Any]) -> Bool {
        guard retient(s) else { return false }
        let uuid = (objet["uuid"] as? String) ?? UUID().uuidString.lowercased()
        var texte = ""
        if let m = objet["message"] as? [String: Any] {
            if let t = m["content"] as? String { texte = t }
            else if let c = m["content"] as? [[String: Any]] {
                texte = c.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined(separator: "\n")
            }
        }
        retenus.append(Retenu(uuid: uuid, sessionId: s.sessionId, cwd: s.cwd, ligne: ligne, texte: String(texte.prefix(20_000))))
        journal("limite : message gardé pour \(s.sessionId) (\(retenus.count) en attente) \(extrait(texte, 60))")
        changement()
        return true
    }

    /// Eliot vide la pile de cette session : ses messages et sa reprise automatique.
    func vider(_ s: Session) {
        retenus.removeAll { $0.sessionId == s.sessionId }
        coupees[s.sessionId] = nil
        journal("limite : pile vidée pour \(s.sessionId)")
        changement()
    }

    /// Eliot n'attend pas : ce qui attend dans cette session part tout de suite. Si la limite vaut encore,
    /// Claude refuse et la session est coupée de nouveau ; s'il répond, `reponseReelle` libère tout le monde.
    func envoyerMaintenant(_ s: Session) {
        guard s.peutRecevoir else { journal("limite : envoi immédiat impossible, claude est arrêté dans \(s.sessionId)"); return }
        journal("limite : envoi immédiat demandé pour \(s.sessionId)")
        relacher(s.sessionId, forcee: true)
        changement()
    }

    // MARK: - Reprise

    /// Appelé toutes les 15 s tant qu'une limite est notée, au réveil du Mac et avant chaque envoi.
    /// Vrai si quelque chose a changé (les pages ont alors été prévenues).
    @discardableResult
    func verifier() -> Bool {
        guard active, Date() >= Self.pasAvant else { return false }
        let now = Self.maintenant()
        var change = false
        if let g = globale, now.timeIntervalSince(g) >= Self.marge {
            journal("limite : fin de la limite de l'abonnement")
            globale = nil; change = true
        }
        if globale == nil {
            var ordre: [String] = []
            for id in coupees.keys.sorted() + retenus.map(\.sessionId) where !ordre.contains(id) { ordre.append(id) }
            for id in ordre {
                if let c = coupees[id], now.timeIntervalSince(c.reprise) < Self.marge { continue }   // sa propre limite tient encore
                if relacher(id, forcee: false) { change = true }
            }
        }
        if change { changement() } else { tenirEveille() }
        return change
    }

    /// Écrit ce qui attend dans une session : « Reprends » si elle était coupée, puis ses messages, dans l'ordre.
    /// Faux si rien n'a bougé (page pas encore prête : au prochain passage).
    @discardableResult
    private func relacher(_ id: String, forcee: Bool) -> Bool {
        let siens = retenus.filter { $0.sessionId == id }
        let coupure = coupees[id]
        guard let s = RegistreSessions.shared.session(id) else {
            // session fermée entre-temps : rouverte seulement pour des messages qu'Eliot avait préparés
            coupees[id] = nil
            retenus.removeAll { $0.sessionId == id }
            let textes = siens.map(\.texte).filter { !$0.isEmpty }
            if let cwd = siens.first?.cwd, !textes.isEmpty, FileManager.default.fileExists(atPath: cwd) {
                var d = DemandeSession(cwd: cwd)
                if Transcript.chemin(cwd: cwd, sessionId: id) != nil { d.resume = id }
                d.prompt = textes.joined(separator: "\n\n")
                journal("limite : session \(id) fermée entre-temps, rouverte avec \(textes.count) message(s)")
                Entrees.ouvrir(d)
            }
            return true
        }
        // après une relance de l'app, la page doit d'abord avoir reçu son historique (sinon pas de bulle)
        if !forcee, !s.pretePourLimite { return false }
        coupees[id] = nil
        retenus.removeAll { $0.sessionId == id }
        guard s.peutRecevoir else {
            // claude est arrêté dans cette session (Terminal, session terminée) : rien ne peut partir
            if !siens.isEmpty {
                perdus[id] = siens.map(\.uuid)
                journal("limite : \(siens.count) message(s) non envoyé(s), claude est arrêté dans \(id)")
                s.pousserLimite(etatPage(s))
                s.pousser("stderr", "Limite d'usage levée, mais Claude est arrêté dans cette session : \(siens.count) message(s) gardé(s) n'ont pas été envoyés.\n")
                perdus[id] = nil
            }
            return true
        }
        let reprendre = coupure.map { $0.auto || forcee } ?? false
        journal("limite : reprise de \(id)\(reprendre ? " (« Reprends »)" : "") avec \(siens.count) message(s) gardé(s)")
        relachees[id] = Self.maintenant()
        s.pousserLimite(etatPage(s))   // la page apprend d'abord que ses messages partent
        if reprendre { s.ecrireDepuisLimite(Self.ligneReprise(), montrer: true) }
        siens.forEach { s.ecrireDepuisLimite($0.ligne, montrer: false) }
        return true
    }

    /// Ligne stdin du message de reprise, avec un uuid (la page ne l'affiche pas deux fois après un rechargement).
    static func ligneReprise() -> String? {
        let o: [String: Any] = [
            "type": "user", "uuid": UUID().uuidString.lowercased(), "session_id": "",
            "message": ["role": "user", "content": [["type": "text", "text": messageReprise]]],
            "parent_tool_use_id": NSNull()
        ]
        guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.withoutEscapingSlashes]) else { return nil }
        return String(data: d, encoding: .utf8)
    }

    // MARK: - Mémoire, minuteur, veille

    private func changement() {
        sauver()
        armer()
        for s in RegistreSessions.shared.sessions where !s.estFermee {
            s.pousserLimite(etatPage(s))
            RegistreSessions.shared.signaler(s)
        }
    }

    private func armer() {
        tenirEveille()
        if !active {
            minuteur?.invalidate(); minuteur = nil
            return
        }
        guard minuteur == nil else { return }
        let t = Timer(timeInterval: 15, repeats: true) { [weak self] _ in self?.verifier() }
        RunLoop.main.add(t, forMode: .common)
        minuteur = t
    }

    /// Tant que quelque chose attend la reprise : l'app n'est pas mise en sommeil (App Nap retarderait le minuteur)
    /// et, sur secteur, le Mac ne s'endort pas tout seul (l'écran peut s'éteindre). Sur batterie ou capot fermé,
    /// macOS décide ; la reprise part alors au réveil.
    private func tenirEveille() {
        let utile = !rienEnAttente
        let secteur = Self.surSecteur()
        if let a = activite, !utile || secteur != activiteSecteur {
            ProcessInfo.processInfo.endActivity(a); activite = nil
            if !utile { journal("limite : plus rien n'attend, veille automatique rendue") }
        }
        guard utile, activite == nil else { return }
        activiteSecteur = secteur
        activite = ProcessInfo.processInfo.beginActivity(
            options: secteur ? [.userInitiated] : [.userInitiatedAllowingIdleSystemSleep],
            reason: "Jarvis Terminal attend la fin de la limite d'usage")
        journal("limite : attente de la reprise\(secteur ? ", veille automatique bloquée (secteur)" : " (batterie : le Mac peut s'endormir)")")
    }

    private static func surSecteur() -> Bool {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let type = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() as String? else { return true }
        return type == kIOPMACPowerKey
    }

    private func sauver() {
        if !active { try? FileManager.default.removeItem(atPath: chemin); return }
        var o: [String: Any] = [
            "dernierRefus": dernierRefus.timeIntervalSince1970,
            "tentatives": tentatives,
            "coupees": coupees.mapValues { ["cwd": $0.cwd, "reprise": $0.reprise.timeIntervalSince1970, "globale": $0.globale, "auto": $0.auto] as [String: Any] },
            "retenus": retenus.map { ["uuid": $0.uuid, "sessionId": $0.sessionId, "cwd": $0.cwd, "ligne": $0.ligne, "texte": $0.texte] }
        ]
        if let g = globale { o["globale"] = g.timeIntervalSince1970 }
        if let d = json(o) { _ = ecrireAtomique(d, chemin) }
    }

    private func lire() {
        guard !PiloteDev.actif, let d = FileManager.default.contents(atPath: chemin),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return }
        globale = (o["globale"] as? Double).map { Date(timeIntervalSince1970: $0) }
        dernierRefus = (o["dernierRefus"] as? Double).map { Date(timeIntervalSince1970: $0) } ?? .distantPast
        tentatives = (o["tentatives"] as? [String: Int]) ?? [:]
        for (id, v) in (o["coupees"] as? [String: [String: Any]]) ?? [:] {
            guard let cwd = v["cwd"] as? String, let r = v["reprise"] as? Double else { continue }
            coupees[id] = Coupure(cwd: cwd, reprise: Date(timeIntervalSince1970: max(r, 0)), globale: (v["globale"] as? Bool) ?? true, auto: (v["auto"] as? Bool) ?? true)
        }
        retenus = ((o["retenus"] as? [[String: String]]) ?? []).compactMap {
            guard let u = $0["uuid"], let s = $0["sessionId"], let c = $0["cwd"], let l = $0["ligne"] else { return nil }
            return Retenu(uuid: u, sessionId: s, cwd: c, ligne: l, texte: $0["texte"] ?? "")
        }
        journal("limite : état relu — \(globale.map { "abonnement jusqu'à " + iso8601.string(from: $0) } ?? "pas de limite d'abonnement"), \(coupees.count) session(s) coupée(s), \(retenus.count) message(s) gardé(s)")
    }
}
