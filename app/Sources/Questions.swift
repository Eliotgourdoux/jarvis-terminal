import Foundation

/// Boîte aux lettres des questions Telegram (CONTRAT.md, étape 6) :
/// `<id>.json` écrit ici → `tg-question.sh envoyer <fichier>` ; le routeur Jarvis écrit `<id>.reponse.json`.
enum Questions {
    static func chemin(_ id: String) -> String { DOSSIER_QUESTIONS + "/" + id + ".json" }
    static func cheminReponse(_ id: String) -> String { DOSSIER_QUESTIONS + "/" + id + ".reponse.json" }

    static var scriptDisponible: Bool { FileManager.default.isExecutableFile(atPath: TG_QUESTION) }

    static func envoyer(_ q: [String: Any], session: Session) {
        guard let id = q["id"] as? String, Validation.idQuestion(id), let d = json(q) else { return }
        guard ecrireAtomique(d, chemin(id)) else { return }
        BoiteQuestions.shared.surveiller(id, session)
        journal("question \(id) écrite (\(q["type"] ?? "?"))")
        lancerScript(["envoyer", chemin(id)])
    }

    /// Eliot a répondu sur le Mac : la réponse est posée en premier (création exclusive, la première l'emporte),
    /// puis le message Telegram est mis à jour.
    static func fermerDepuisMac(_ id: String, reponse: Any) {
        BoiteQuestions.shared.oublier(id)
        let o: [String: Any] = ["id": id, "reponse": reponse, "source": "mac", "date": iso8601.string(from: Date())]
        var dejaTelegram = false
        if let d = json(o), !creerExclusif(d, cheminReponse(id)) {
            // déjà répondu : si c'est Telegram, son message est déjà à jour
            if let x = FileManager.default.contents(atPath: cheminReponse(id)),
               let r = try? JSONSerialization.jsonObject(with: x) as? [String: Any] { dejaTelegram = (r["source"] as? String) != "mac" }
        }
        if dejaTelegram { journal("question \(id) : déjà répondue depuis Telegram"); return }
        let texte = (reponse as? [String])?.joined(separator: ", ") ?? (reponse as? String) ?? ""
        clore(id, texte: texte)
    }

    static func clore(_ id: String, texte: String) {
        guard Validation.idQuestion(id) else { return }
        lancerScript(["clore", id, String(texte.prefix(1000))])
    }

    /// Arguments séparés, jamais de shell ; rien si le script de l'agent E n'existe pas encore.
    private static func lancerScript(_ args: [String]) {
        guard scriptDisponible else { journal("tg-question.sh absent : \(args.first ?? "") ignoré"); return }
        Environnement.charger { env in
            DispatchQueue.global().async {
                let (code, out) = executer(TG_QUESTION, args, env: env, delai: 30)
                journal("tg-question.sh \(args.first ?? "") → code \(code) \(extrait(out, 200))")
            }
        }
    }
}

/// Surveille `questions/` (événements du dossier + relevé toutes les 2 s tant qu'une question est ouverte).
final class BoiteQuestions {
    static let shared = BoiteQuestions()
    private final class Faible { weak var s: Session?; init(_ s: Session) { self.s = s } }
    private var suivies: [String: Faible] = [:]
    private var source: DispatchSourceFileSystemObject?
    private var minuteur: Timer?

    func surveiller(_ id: String, _ s: Session) {
        suivies[id] = Faible(s)
        demarrer()
        verifier()
    }

    func oublier(_ id: String) { suivies[id] = nil }

    private func demarrer() {
        creerDossier(DOSSIER_QUESTIONS)
        if source == nil {
            let fd = open(DOSSIER_QUESTIONS, O_EVTONLY)
            if fd >= 0 {
                let s = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .link], queue: .main)
                s.setEventHandler { [weak self] in self?.verifier() }
                s.setCancelHandler { close(fd) }
                s.resume()
                source = s
            }
        }
        if minuteur == nil {
            minuteur = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.verifier() }
        }
    }

    private func verifier() {
        for (id, f) in suivies {
            let p = Questions.cheminReponse(id)
            guard let d = FileManager.default.contents(atPath: p),
                  let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
            suivies[id] = nil
            let source = o["source"] as? String ?? "telegram"
            if source == "mac" { continue }   // notre propre réponse
            guard let reponse = o["reponse"], reponse is String || reponse is [Any] else { continue }
            f.s?.reponseExterne(id: id, reponse: reponse, source: source)
        }
        if suivies.isEmpty { minuteur?.invalidate(); minuteur = nil }
    }
}
