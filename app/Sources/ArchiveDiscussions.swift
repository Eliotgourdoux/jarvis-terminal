import Foundation

/// Les discussions passées (17/11/2026, Eliot : « que je puisse les retrouver si jamais je les perds »).
/// Source : les transcripts de claude pour ~/Claude-Discussions. Le titre vient du transcript (custom-title, sinon
/// ai-title) ; à défaut, le début du premier message. Le texte des messages d'Eliot sert à la recherche du panneau.
enum ArchiveDiscussions {
    struct Entree {
        let id: String
        let titre: String
        let titreAuto: Bool       // vrai titre (généré ou choisi), pas le début du premier message
        let premier: String
        let texte: String
        let maj: Date
        let messages: Int
    }

    private static let file = DispatchQueue(label: "bt.archive-discussions", qos: .userInitiated)
    private static var cache: [String: (date: Date, taille: Int, entree: Entree?)] = [:]

    static var dossier: String { HOME + "/.claude/projects/" + Transcript.dossierProjet(cheminReel(Entrees.dossierDiscussions)) }

    /// Liste triée de la plus récente à la plus ancienne. `fini` sur la file principale.
    static func lister(_ fini: @escaping ([Entree]) -> Void) {
        file.async {
            let fm = FileManager.default
            let d = dossier
            var vues = Set<String>()
            var l: [Entree] = []
            for nom in (try? fm.contentsOfDirectory(atPath: d)) ?? [] where nom.hasSuffix(".jsonl") {
                let id = String(nom.dropLast(6)).lowercased()
                guard Validation.sessionId(id) else { continue }
                let chemin = d + "/" + nom
                guard let a = try? fm.attributesOfItem(atPath: chemin), let date = a[.modificationDate] as? Date else { continue }
                let taille = (a[.size] as? NSNumber)?.intValue ?? 0
                vues.insert(chemin)
                if let c = cache[chemin], c.date == date, c.taille == taille {
                    if let e = c.entree { l.append(e) }
                    continue
                }
                let e = lire(chemin, id: id, maj: date)
                cache[chemin] = (date, taille, e)
                if let e { l.append(e) }
            }
            cache = cache.filter { vues.contains($0.key) }
            l.sort { $0.maj > $1.maj }
            DispatchQueue.main.async { fini(l) }
        }
    }

    /// Les messages tapés par Eliot dans un transcript, dans l'ordre (sans résultats d'outils, commandes ni pièces jointes).
    static func messagesEliot(_ chemin: String) -> (messages: [String], titrePerso: String?, titreAuto: String?) {
        guard let data = FileManager.default.contents(atPath: chemin) else { return ([], nil, nil) }
        var msgs: [String] = []
        var perso: String?, auto: String?
        for l in data.split(separator: 0x0A) {
            // repère rapide avant d'analyser : la plupart des lignes sont des réponses ou des outils
            guard l.count < 400_000, let s = String(data: Data(l), encoding: .utf8) else { continue }
            if s.contains("-title\"") {
                if let o = (try? JSONSerialization.jsonObject(with: Data(l))) as? [String: Any] {
                    if o["type"] as? String == "custom-title", let t = o["customTitle"] as? String { perso = t }
                    if o["type"] as? String == "ai-title", let t = o["aiTitle"] as? String { auto = t }
                }
                continue
            }
            guard s.hasPrefix("{\"") , s.contains("\"type\":\"user\""), !s.contains("\"tool_result\""), !s.contains("\"isMeta\":true"),
                  let o = (try? JSONSerialization.jsonObject(with: Data(l))) as? [String: Any],
                  o["type"] as? String == "user", let m = o["message"] as? [String: Any] else { continue }
            var t = ""
            if let c = m["content"] as? String { t = c }
            else if let c = m["content"] as? [[String: Any]] {
                t = c.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined(separator: "\n")
            }
            t = nettoyer(t)
            if !t.isEmpty { msgs.append(t) }
        }
        return (msgs, perso, auto)
    }

    private static func nettoyer(_ brut: String) -> String {
        var t = brut
        for balise in ["fichiers-joints", "system-reminder", "local-command-stdout", "local-command-caveat"] {
            while let a = t.range(of: "<\(balise)>"), let b = t.range(of: "</\(balise)>", range: a.upperBound..<t.endIndex) {
                t.removeSubrange(a.lowerBound..<b.upperBound)
            }
        }
        let debut = t.trimmingCharacters(in: .whitespacesAndNewlines)
        // fins d'agents de fond, commandes, interruptions : pas tapés par Eliot
        for p in ["<task-notification", "<command-", "<local-command", "<bash-", "Caveat:", "[Request interrupted"] where debut.hasPrefix(p) { return "" }
        return t.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    }

    private static func lire(_ chemin: String, id: String, maj: Date) -> Entree? {
        let r = messagesEliot(chemin)
        guard let premier = r.messages.first else { return nil }
        let vrai = (r.titrePerso ?? r.titreAuto)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let titre = (vrai?.isEmpty == false) ? vrai! : extrait(premier, 60)
        var texte = ""
        for m in r.messages where texte.count < 6_000 { texte += (texte.isEmpty ? "" : " ¶ ") + String(m.prefix(600)) }
        return Entree(id: id, titre: titre, titreAuto: vrai?.isEmpty == false, premier: extrait(premier, 140),
                      texte: texte, maj: maj, messages: r.messages.count)
    }

    /// Ce qu'on donne à generate_session_title : les premiers et les derniers messages d'Eliot.
    static func description(_ chemin: String) -> String? {
        let m = messagesEliot(chemin).messages
        guard !m.isEmpty else { return nil }
        let choisis = m.count <= 10 ? m : Array(m.prefix(2)) + ["…"] + Array(m.suffix(8))
        var d = "Messages d'Eliot dans cette conversation, dans l'ordre. Le titre doit dire de quoi elle parle surtout, maintenant :\n"
        for x in choisis { d += "- " + String(x.prefix(220)) + "\n" }
        return String(d.prefix(2000))
    }
}
