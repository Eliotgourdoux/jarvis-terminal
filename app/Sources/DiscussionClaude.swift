import Foundation

/// Discussions libres (~/Claude-Discussions) lisibles dans l'app Claude, sur le Mac et sur le téléphone
/// (16/11/2026, Eliot : « je veux que ce soit lisible dans l'app bureau et téléphone quand j'utilise Jarvis Terminal
/// pour une conv normale »).
///
/// - Remote Control : dès que claude est lancé, la coque écrit `control_request remote_control` (enabled, name,
///   keep_session_on_exit). La session apparaît dans l'app Claude (section Code) et sur claude.ai/code, en direct.
///   Le `bridge_session_id` est gardé par session (BTPontsClaude) : après une relance de l'app, `reattach_session_id`
///   reprend la même conversation côté Claude au lieu d'en créer une nouvelle.
/// - Titre : à la fin du premier tour, `generate_session_title` (persist) puis `rename_session`. Le titre remplace
///   « Discussion » dans la barre des sessions, la barre du haut et l'app Claude. Un renommage fait depuis l'app
///   Claude revient par `system session_title_changed`.
/// Les requêtes de la coque ont un request_id préfixé « bt- » : la page les ignore (aucun rappel enregistré).
extension Session {
    static let clePonts = "BTPontsClaude"

    var estDiscussion: Bool { cwd == cheminReel(Entrees.dossierDiscussions) }

    private static func ligne(_ id: String, _ requete: [String: Any]) -> String? {
        // Une seule ligne : json() indente (.prettyPrinted), et claude lit stdin ligne par ligne. Le « { » seul
        // sur la première ligne le faisait planter au lancement (code 1, bug du 17/11/2026).
        guard let d = try? JSONSerialization.data(withJSONObject: ["type": "control_request", "request_id": id, "request": requete],
                                                  options: [.withoutEscapingSlashes]) else { return nil }
        return String(data: d, encoding: .utf8)
    }

    private var pontGarde: String? {
        get { (Reglages.d.dictionary(forKey: Self.clePonts) as? [String: String])?[sessionId] }
        set {
            var t = (Reglages.d.dictionary(forKey: Self.clePonts) as? [String: String]) ?? [:]
            t[sessionId] = newValue
            if t.count > 300 { t = Dictionary(uniqueKeysWithValues: t.suffix(300).map { ($0.key, $0.value) }) }
            Reglages.mettre(t, Self.clePonts)
        }
    }

    /// Appelé juste après le lancement du processus (nouveau ou relancé).
    func publierDansClaude(_ p: ProcessusClaude, rattacher: Bool = true) {
        guard estDiscussion, !PiloteDev.actif, Reglages.bool("BTDiscussionsDansClaude", defaut: true) else { return }
        var r: [String: Any] = ["subtype": "remote_control", "enabled": true, "name": nomAffiche, "keep_session_on_exit": true]
        let rattache = rattacher ? pontGarde : nil
        if let b = rattache { r["reattach_session_id"] = b }
        let id = (rattache != nil ? "bt-rc-r-" : "bt-rc-") + UUID().uuidString.prefix(8).lowercased()
        guard let l = Self.ligne(id, r) else { return }
        p.ecrire(l)
        journal("session \(sessionId) : publication dans l'app Claude\(rattache.map { " (rattachement \($0))" } ?? "")")
    }

    /// Lignes de claude d'une discussion : réponses aux requêtes de la coque, titre, fin de tour.
    func discussionLigne(_ a: Analyse, de p: ProcessusClaude) {
        if let id = a.reponseId, id.hasPrefix("bt-") {
            if id.hasPrefix("bt-rc-") {
                if a.reponseSucces, let b = a.reponseContenu?["bridge_session_id"] as? String, !b.isEmpty {
                    pontGarde = b
                    journal("session \(sessionId) : visible dans l'app Claude — \(a.reponseContenu?["session_url"] as? String ?? b)")
                } else if id.hasPrefix("bt-rc-r-") {
                    // Rattachement refusé (session supprimée côté Claude, trop ancienne) : nouvelle publication.
                    journal("session \(sessionId) : rattachement refusé, nouvelle publication")
                    pontGarde = nil
                    publierDansClaude(p, rattacher: false)
                } else {
                    journal("session \(sessionId) : publication dans l'app Claude refusée")
                }
            } else if id.hasPrefix("bt-titre-") {
                titreDemande = false
                if a.reponseSucces, let t = a.reponseContenu?["title"] as? String { appliquerTitre(t, renommer: true, p) }
                else { journal("session \(sessionId) : titre non généré") }
            }
            return
        }
        if let t = a.titre {
            // Un titre qui n'est pas le nôtre (renommage depuis l'app Claude) : Eliot l'a choisi, on n'y touche plus.
            if !titreDemande, t.trimmingCharacters(in: .whitespacesAndNewlines) != titre, titre != nil { titreManuel = true }
            appliquerTitre(t, renommer: false, p)
        }
        if a.finTour {
            toursDiscussion += 1
            // Titre au premier échange, puis remis à jour au fil de la conversation (17/11/2026, Eliot : « qu'elles
            // changent automatiquement leur nom en fonction de ce que j'ai fait dedans »).
            if !titreDemande, !titreManuel, titre == nil || Self.toursRetitrage.contains(toursDiscussion) { demanderTitre(p) }
        }
    }

    private static let toursRetitrage: Set<Int> = [3, 6, 10, 15, 22, 30, 45, 60]
    private static let cleTitresManuels = "BTTitresManuels"

    private var titreManuel: Bool {
        get { (Reglages.d.stringArray(forKey: Self.cleTitresManuels) ?? []).contains(sessionId) }
        set {
            var l = (Reglages.d.stringArray(forKey: Self.cleTitresManuels) ?? []).filter { $0 != sessionId }
            if newValue { l.append(sessionId); journal("session \(sessionId) : titre choisi par Eliot, plus de renommage automatique") }
            Reglages.mettre(Array(l.suffix(300)), Self.cleTitresManuels)
        }
    }

    private func demanderTitre(_ p: ProcessusClaude) {
        titreDemande = true
        let repli = ((premierMessage ?? "").isEmpty ? (dernierMessage ?? "") : premierMessage!).trimmingCharacters(in: .whitespacesAndNewlines)
        let chemin = Transcript.chemin(cwd: cwd, sessionId: sessionId)
        DispatchQueue.global(qos: .utility).async { [weak self] in
            // toute la conversation (messages d'Eliot), pas seulement le premier message
            let desc = chemin.flatMap { ArchiveDiscussions.description($0) } ?? repli
            DispatchQueue.main.async {
                guard let self else { return }
                guard !desc.isEmpty, let l = Self.ligne("bt-titre-" + UUID().uuidString.prefix(8).lowercased(),
                                                        ["subtype": "generate_session_title", "description": String(desc.prefix(2000)), "persist": true])
                else { self.titreDemande = false; return }
                p.ecrire(l)
            }
        }
    }

    private func appliquerTitre(_ brut: String, renommer: Bool, _ p: ProcessusClaude?) {
        let t = brut.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, t.count <= 200, t != titre else { return }
        titre = t
        journal("session \(sessionId) : titre « \(t) »")
        if renommer, let p, let l = Self.ligne("bt-nom-" + UUID().uuidString.prefix(8).lowercased(), ["subtype": "rename_session", "title": t]) {
            p.ecrire(l)
        }
        pousser("titre", t)
        ecrireEtat()
        RegistreSessions.shared.signaler(self)
    }

    /// Discussion reprise : son titre est déjà dans le transcript (custom-title, sinon ai-title).
    func lireTitreExistant() {
        guard let chemin = Transcript.chemin(cwd: cwd, sessionId: sessionId) else { return }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let data = FileManager.default.contents(atPath: chemin) else { return }
            var perso: String?, auto: String?
            for l in data.split(separator: 0x0A) where l.count < 4000 {
                guard let s = String(data: Data(l), encoding: .utf8), s.contains("-title\"") ,
                      let o = (try? JSONSerialization.jsonObject(with: Data(l))) as? [String: Any] else { continue }
                if o["type"] as? String == "custom-title", let t = o["customTitle"] as? String { perso = t }
                if o["type"] as? String == "ai-title", let t = o["aiTitle"] as? String { auto = t }
            }
            guard let t = perso ?? auto else { return }
            DispatchQueue.main.async { self?.appliquerTitre(t, renommer: false, nil) }
        }
    }
}
