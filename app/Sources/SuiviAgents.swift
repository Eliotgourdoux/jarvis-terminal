import Foundation

/// Suivi en direct des sous-agents (08/11/2026, Eliot : « pourquoi je vois pas tes agents qui travaillent ? »).
/// claude écrit le transcript de chaque sous-agent dans
/// ~/.claude/projects/<projet>/<sessionId>/subagents/agent-<id>.jsonl, avec un agent-<id>.meta.json
/// qui donne le `toolUseId` de l'appel Agent qui l'a lancé et `finished`.
/// La page envoie la liste des appels Agent en cours (`agents {ids}`) ; tant qu'elle n'est pas vide,
/// on relit chaque seconde la fin de leurs transcripts et on pousse les nouvelles étapes :
/// bt.agents([{id, etapes:[{n, e, t}], nb, texte?, fini}]).
/// Lecture seule, hors du fil principal ; rien n'est lu quand aucun agent ne tourne.
final class SuiviAgents {
    private static var suivis: [String: SuiviAgents] = [:]   // clé : sessionId (fil principal)
    private static let file = DispatchQueue(label: "local.eliot.betterterminal.agents")

    /// Appelé par Session sur le fil principal.
    static func suivre(_ ids: [String], session: Session, cwd: String, sessionId: String,
                       pousser: @escaping ([[String: Any]]) -> Void) {
        let s = suivis[sessionId] ?? SuiviAgents(session: session, cwd: cwd, sessionId: sessionId, pousser: pousser)
        suivis[sessionId] = s
        s.pousser = pousser
        s.definir(Set(ids))
        if ids.isEmpty { suivis[sessionId] = nil }
    }

    private weak var session: Session?
    private let dossier: String
    private var pousser: ([[String: Any]]) -> Void
    // état propre à `file`
    private var ids = Set<String>()
    private var fichiers: [String: String] = [:]      // toolUseId → chemin du jsonl
    private var positions: [String: UInt64] = [:]     // toolUseId → octets déjà lus
    private var restes: [String: Data] = [:]          // ligne incomplète en fin de lecture
    private var compteurs: [String: Int] = [:]
    private var finis = Set<String>()
    private var signales = Set<String>()        // fin déjà annoncée à la page
    private var minuteur: DispatchSourceTimer?

    private init(session: Session, cwd: String, sessionId: String, pousser: @escaping ([[String: Any]]) -> Void) {
        self.session = session
        self.pousser = pousser
        var racine = HOME + "/.claude/projects/" + Transcript.dossierProjet(cwd)
        if let t = Transcript.chemin(cwd: cwd, sessionId: sessionId) { racine = (t as NSString).deletingLastPathComponent }
        dossier = racine + "/" + sessionId + "/subagents"
    }

    private func definir(_ nouveaux: Set<String>) {
        Self.file.async {
            self.ids = nouveaux
            if nouveaux.isEmpty {
                self.minuteur?.cancel(); self.minuteur = nil
                return
            }
            if self.minuteur == nil {
                let t = DispatchSource.makeTimerSource(queue: Self.file)
                t.schedule(deadline: .now(), repeating: 1.0, leeway: .milliseconds(200))
                t.setEventHandler { [weak self] in self?.tic() }
                self.minuteur = t
                t.resume()
            } else {
                self.tic()
            }
        }
    }

    private func tic() {
        if session == nil { minuteur?.cancel(); minuteur = nil; return }
        if ids.contains(where: { fichiers[$0] == nil }) { relireMeta() }
        var lot: [[String: Any]] = []
        for id in ids {
            guard let chemin = fichiers[id], !signales.contains(id) else { continue }
            if !finis.contains(id) { relireFini(id, chemin) }
            // Déjà fini quand on le découvre (historique rechargé) : on le dit sans relire son transcript.
            if finis.contains(id) && positions[id] == nil {
                signales.insert(id)
                lot.append(["id": id, "etapes": [], "nb": 0, "fini": true, "deja": true])
                continue
            }
            let (etapes, texte) = lire(id, chemin)
            let fini = finis.contains(id)
            if fini { signales.insert(id) }
            if etapes.isEmpty && texte == nil && !fini { continue }
            var r: [String: Any] = ["id": id, "etapes": etapes, "nb": compteurs[id] ?? 0, "fini": fini]
            if let texte { r["texte"] = texte }
            lot.append(r)
        }
        guard !lot.isEmpty else { return }
        DispatchQueue.main.async { [pousser] in pousser(lot) }
    }

    private func relireMeta() {
        let fm = FileManager.default
        for nom in (try? fm.contentsOfDirectory(atPath: dossier)) ?? [] where nom.hasSuffix(".meta.json") {
            let p = dossier + "/" + nom
            guard let d = fm.contents(atPath: p),
                  let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let id = o["toolUseId"] as? String, ids.contains(id) else { continue }
            if (o["finished"] as? Bool) == true { finis.insert(id) }
            if fichiers[id] == nil {
                fichiers[id] = dossier + "/" + nom.replacingOccurrences(of: ".meta.json", with: ".jsonl")
            }
        }
    }

    /// Lit ce qui a été ajouté au transcript depuis la dernière fois. Au premier passage, seules
    /// les 40 dernières étapes partent (un agent repris peut avoir des milliers de lignes).
    private func lire(_ id: String, _ chemin: String) -> ([[String: Any]], String?) {
        guard let h = FileHandle(forReadingAtPath: chemin) else { return ([], nil) }
        defer { try? h.close() }
        let debut = positions[id] ?? 0
        let fin = (try? h.seekToEnd()) ?? 0
        guard fin > debut else { return ([], nil) }
        try? h.seek(toOffset: debut)
        var data = restes[id] ?? Data()
        data.append((try? h.read(upToCount: Int(fin - debut))) ?? Data())
        positions[id] = fin
        var lignes = data.split(separator: 0x0A, omittingEmptySubsequences: false)
        restes[id] = Data(lignes.removeLast())
        var etapes: [[String: Any]] = []
        var texte: String?
        for l in lignes where l.count > 2 && l.count < 4_000_000 {
            guard let o = try? JSONSerialization.jsonObject(with: Data(l)) as? [String: Any],
                  (o["type"] as? String) == "assistant",
                  let m = o["message"] as? [String: Any], let c = m["content"] as? [[String: Any]] else { continue }
            let t = o["timestamp"] as? String ?? ""
            for b in c {
                switch b["type"] as? String {
                case "tool_use":
                    etapes.append(["n": b["name"] as? String ?? "", "e": Self.abreger(b["input"]), "t": t])
                    compteurs[id, default: 0] += 1
                case "text":
                    let s = (b["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    if !s.isEmpty { texte = String(s.prefix(600)) }
                default: break
                }
            }
        }
        if debut == 0 && etapes.count > 40 { etapes = Array(etapes.suffix(40)) }
        return (etapes, texte)
    }

    private func relireFini(_ id: String, _ chemin: String) {
        let p = chemin.replacingOccurrences(of: ".jsonl", with: ".meta.json")
        if let d = FileManager.default.contents(atPath: p),
           let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
           (o["finished"] as? Bool) == true { finis.insert(id) }
    }

    /// Entrée d'outil allégée : chaînes coupées à 240 caractères, pas d'imbrication profonde.
    private static func abreger(_ v: Any?, profondeur: Int = 0) -> Any {
        switch v {
        case let s as String: return s.count > 240 ? String(s.prefix(240)) + "…" : s
        case let d as [String: Any]:
            if profondeur > 1 { return [String: Any]() }
            var r: [String: Any] = [:]
            for (k, x) in d { r[k] = abreger(x, profondeur: profondeur + 1) }
            return r
        case let a as [Any]:
            if profondeur > 1 { return [Any]() }
            return a.prefix(12).map { abreger($0, profondeur: profondeur + 1) }
        case let n as NSNumber: return n
        default: return NSNull()
        }
    }
}
