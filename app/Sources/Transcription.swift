import AppKit

/// Transcription locale avec whisper.cpp (`whisper-cli`), comme `~/.claude/bin/voice.sh`.
///
/// Réglages retenus après mesure (07/11/2026, Mac M4, voir app/LISEZMOI.md) :
/// - modèle large-v3-turbo (le seul qui écrit « Cockpit » correctement ; small donne « Lorsque pique ») ;
/// - `-l fr` (la détection automatique se trompe sur les phrases courtes et coûte du temps) ;
/// - `-ac 768` (fenêtre de 15 s au lieu de 30 s) pour les dictées de moins de 14 s : l'encodage passe
///   d'environ 1,1 s à 0,5 s, sans perte mesurée ; 512 provoque des répétitions (« Le deuxième. Le deuxième. ») ;
/// - pas de `--prompt` : avec les noms des projets en invite, whisper avale le nom dit en tête de phrase
///   (« Cockpit, réponds… » devient « Réponds… ») et ralentit (3,5 s au lieu de 1,4 s). La correspondance
///   souple du routage rattrape les noms mal écrits (« King Pong » → Ping Pong Edit).
enum Transcription {
    struct Resultat { let texte: String; let brut: String; let duree: TimeInterval; let modele: String }

    static let modeles = HOME + "/.claude/models"

    /// Réglage `BTModeleWhisper` (nom de fichier dans ~/.claude/models ou chemin absolu), sinon turbo, sinon small.
    static func cheminModele() -> String? {
        let fm = FileManager.default
        if let r = Reglages.texte("BTModeleWhisper"), !r.isEmpty {
            let p = r.hasPrefix("/") ? r : modeles + "/" + r
            if fm.fileExists(atPath: p) { return p }
            journal("whisper : modèle réglé introuvable (\(p)), repli")
        }
        return [modeles + "/ggml-large-v3-turbo.bin", modeles + "/ggml-small.bin"].first { fm.fileExists(atPath: $0) }
    }

    static func cheminWhisper(_ env: [String: String]) -> String? {
        Environnement.trouver("whisper-cli", env, connus: ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"])
    }

    /// À appeler sur le fil principal ; le travail se fait ailleurs et `fini` est appelé sur le fil principal.
    /// Passe d'abord par `ServeurFinal` (même modèle, déjà chargé : ~0,7 s au lieu de ~1,5 à 2,9 s) s'il est prêt,
    /// sinon, ou s'il échoue, par `whisper-cli` comme avant.
    static func transcrire(_ wav: URL, dureeAudio: Double, vocabulaire: [String], env: [String: String],
                           fini: @escaping (Result<Resultat, Erreur>) -> Void) {
        guard let exe = cheminWhisper(env) else { fini(.failure(.outil("whisper-cli introuvable (brew install whisper-cpp)"))); return }
        guard let modele = cheminModele() else { fini(.failure(.outil("aucun modèle whisper dans ~/.claude/models"))); return }
        // Réglage BTInviteWhisper=1 : invite avec les noms des projets ouverts (déconseillé, voir plus haut).
        let prompt = Reglages.bool("BTInviteWhisper") ? invite(vocabulaire) : ""
        let cli = { transcrireCLI(exe: exe, modele: modele, wav, dureeAudio: dureeAudio, prompt: prompt, env: env, fini: fini) }
        guard Thread.isMainThread, ServeurFinal.shared.estPret(pour: modele) else { cli(); return }
        let debut = Date()
        ServeurFinal.shared.transcrire(wav, dureeAudio: dureeAudio, prompt: prompt) { reponse in
            guard let reponse else { cli(); return }
            let brut = reponse.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let texte = nettoyer(brut, invite: prompt)
            let duree = Date().timeIntervalSince(debut)
            let nom = (modele as NSString).lastPathComponent
            journal("whisper : \(String(format: "%.2f", duree)) s pour \(String(format: "%.1f", dureeAudio)) s d'audio (serveur, \(nom)) → « \(extrait(texte, 160)) »")
            fini(.success(Resultat(texte: texte, brut: brut, duree: duree, modele: nom)))
        }
    }

    private static func transcrireCLI(exe: String, modele: String, _ wav: URL, dureeAudio: Double, prompt: String,
                                      env: [String: String], fini: @escaping (Result<Resultat, Erreur>) -> Void) {
        var args = ["-m", modele, "-f", wav.path, "-l", "fr", "-nt", "-np"]
        if dureeAudio < 14 { args += ["-ac", "768"] }
        if !prompt.isEmpty { args += ["--prompt", prompt] }
        DispatchQueue.global(qos: .userInitiated).async {
            let debut = Date()
            let (code, out, err) = executerAvecErreurs(exe, args, env: env, delai: 40)
            let duree = Date().timeIntervalSince(debut)
            // temps internes de whisper (chargement, encodage, reprises) : utiles quand une dictée traîne
            let temps = err.split(separator: "\n").compactMap { l -> String? in
                guard let r = l.range(of: "whisper_print_timings:") else { return nil }
                let t = l[r.upperBound...].trimmingCharacters(in: .whitespaces)
                return ["load time", "encode time", "fallbacks", "total time"].contains { t.hasPrefix($0) }
                    ? t.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression) : nil
            }
            if duree > 3 || code != 0 { journal("whisper : détail — \(temps.joined(separator: " ; "))\(code != 0 ? " ; " + extrait(err, 300) : "")") }
            let brut = out.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let texte = nettoyer(brut, invite: prompt)
            DispatchQueue.main.async {
                journal("whisper : \(String(format: "%.2f", duree)) s pour \(String(format: "%.1f", dureeAudio)) s d'audio (code \(code), \((modele as NSString).lastPathComponent)) → « \(extrait(texte, 160)) »")
                if code != 0 { fini(.failure(.outil("whisper-cli code \(code)"))); return }
                fini(.success(Resultat(texte: texte, brut: brut, duree: duree, modele: (modele as NSString).lastPathComponent)))
            }
        }
    }

    /// Comme `executer`, en gardant aussi stderr (64 Ko au plus).
    private static func executerAvecErreurs(_ exe: String, _ args: [String], env: [String: String], delai: TimeInterval) -> (Int32, String, String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        p.environment = env
        p.standardInput = FileHandle.nullDevice
        let o = Pipe(), e = Pipe()
        p.standardOutput = o
        p.standardError = e
        var dOut = Data(), dErr = Data()
        let g = DispatchGroup()
        g.enter(); DispatchQueue.global().async { dOut = o.fileHandleForReading.readDataToEndOfFile(); g.leave() }
        g.enter(); DispatchQueue.global().async { dErr = e.fileHandleForReading.readDataToEndOfFile(); g.leave() }
        do { try p.run() } catch { return (-1, "", "lancement impossible : \(error.localizedDescription)") }
        let garde = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + delai, execute: garde)
        p.waitUntilExit()
        garde.cancel()
        _ = g.wait(timeout: .now() + 2)
        return (p.terminationStatus, String(decoding: dOut, as: UTF8.self), String(decoding: dErr.suffix(65_536), as: UTF8.self))
    }

    enum Erreur: Error, CustomStringConvertible {
        case outil(String)
        var description: String { if case .outil(let s) = self { return s }; return "" }
    }

    /// Liste courte de noms propres (projets ouverts) passée à whisper comme contexte.
    static func invite(_ noms: [String]) -> String {
        var vus = Set<String>(), l: [String] = []
        for n in noms + ["Jarvis"] where !n.isEmpty && vus.insert(n.lowercased()).inserted { l.append(n) }
        return l.prefix(12).joined(separator: ", ") + "."
    }

    /// Retire ce que whisper invente sur du silence, les phrases répétées et l'écho de l'invite.
    static func nettoyer(_ brut: String, invite: String) -> String {
        var t = brut.replacingOccurrences(of: "\\[[^\\]]*\\]|\\([^)]*(musique|rires|applaudissements|silence)[^)]*\\)",
                                          with: " ", options: [.regularExpression, .caseInsensitive])
        let bas = t.lowercased()
        let inventions = ["sous-titres réalisés", "sous-titrage", "amara.org", "merci d'avoir regardé", "abonnez-vous",
                          "sous-titres par", "♪"]
        if inventions.contains(where: { bas.contains($0) }) { return "" }
        // phrases identiques à la suite (« Le deuxième. Le deuxième. »)
        let phrases = decouperPhrases(t)
        var gardees: [String] = []
        for p in phrases {
            let q = p.trimmingCharacters(in: .whitespaces)
            if q.isEmpty { continue }
            if let d = gardees.last, Routage.normaliser(d) == Routage.normaliser(q) { continue }
            gardees.append(q)
        }
        t = gardees.joined(separator: " ")
        let inv = Routage.normaliser(invite)
        if !inv.isEmpty && Routage.normaliser(t) == inv { return "" }
        return t.replacingOccurrences(of: "\\s{2,}", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func decouperPhrases(_ t: String) -> [String] {
        var l: [String] = [], cur = ""
        for c in t {
            cur.append(c)
            if ".!?".contains(c) { l.append(cur); cur = "" }
        }
        if !cur.trimmingCharacters(in: .whitespaces).isEmpty { l.append(cur) }
        return l
    }
}


/// Serveur whisper « final » (18/11/2026, demande d'Eliot : la dictée aussi fluide que dans le terminal).
/// Le même modèle que `whisper-cli` (large-v3-turbo par défaut), gardé en mémoire par `whisper-server` sur le port
/// 18742 : au relâchement d'Espace, plus de chargement du modèle ni de démarrage de Metal. Mesuré sur ce Mac (M4),
/// 7,8 s d'audio : 0,72 s au lieu de 1,3 à 1,8 s, texte identique ; le journal montrait 2,15 s pour 9 s et 2,9 s
/// pour 22 s avec whisper-cli. Préchauffé au début de chaque dictée et de chaque énoncé vocal
/// (`DicteeDirecte.commencer`), prêt en moins d'une seconde ; arrêté après 5 min sans usage et à la sortie de l'app.
/// S'il n'est pas prêt ou s'il échoue, `Transcription` repasse par `whisper-cli`. Fil principal, sauf la requête HTTP.
final class ServeurFinal {
    static let shared = ServeurFinal()
    static let port = 18742
    static let inactiviteMax: TimeInterval = 300
    /// Garde-fou : le serveur meurt avec l'app, même si elle plante (sinon ~1,6 Go resteraient chargés).
    /// `sh -c veille sh <whisper-server> <arguments…>` ; `$PPID` est l'app.
    private static let veille = "\"$@\" & s=$!; trap 'kill $s 2>/dev/null; exit 0' TERM INT HUP; "
        + "while kill -0 $PPID 2>/dev/null && kill -0 $s 2>/dev/null; do sleep 1; done; kill $s 2>/dev/null"

    private var serveur: Process?
    private var modele: String?
    private var pret = false
    private var demarrage = false
    private var arretDiffere: DispatchWorkItem?

    private init() {
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: nil) { _ in
            ServeurFinal.shared.arreter()
        }
    }

    func estPret(pour m: String) -> Bool { pret && modele == m }

    /// Charge le serveur s'il ne l'est pas, et repousse son arrêt de 5 min.
    func prechauffer() {
        planifierArret()
        guard let m = Transcription.cheminModele() else { return }
        if modele != m && (serveur != nil || pret) { arreter(); planifierArret() }   // modèle changé dans les réglages
        if pret || demarrage { return }
        demarrage = true
        modele = m
        Environnement.charger { env in
            let f = ServeurFinal.shared
            guard f.demarrage, f.modele == m else { return }
            guard let exe = Environnement.trouver("whisper-server", env, connus: ["/opt/homebrew/bin/whisper-server", "/usr/local/bin/whisper-server"]) else {
                journal("whisper final : whisper-server introuvable, whisper-cli à chaque dictée")
                f.demarrage = false
                return
            }
            // Un serveur resté d'un lancement précédent répond déjà : on le reprend.
            f.attendre(essais: 1) { dejaLa in
                guard f.demarrage, f.modele == m else { return }
                if dejaLa { f.pret = true; f.demarrage = false; journal("whisper final : serveur déjà en place"); return }
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/bin/sh")
                p.arguments = ["-c", Self.veille, "sh", exe, "-m", m, "-l", "fr", "--host", "127.0.0.1", "--port", String(Self.port), "-nt", "-t", "4"]
                p.environment = env
                p.standardInput = FileHandle.nullDevice
                p.standardOutput = FileHandle.nullDevice
                p.standardError = FileHandle.nullDevice
                p.terminationHandler = { _ in DispatchQueue.main.async {
                    let f = ServeurFinal.shared
                    if f.serveur === p { f.serveur = nil; f.pret = false; f.demarrage = false }
                } }
                do { try p.run() } catch {
                    journal("whisper final : lancement impossible — \(error.localizedDescription)")
                    f.demarrage = false; return
                }
                f.serveur = p
                let debut = Date()
                f.attendre(essais: 75) { ok in
                    guard f.serveur === p else { return }
                    f.demarrage = false
                    f.pret = ok
                    journal(ok ? "whisper final : serveur prêt en \(String(format: "%.2f", Date().timeIntervalSince(debut))) s (\((m as NSString).lastPathComponent))"
                               : "whisper final : le serveur ne répond pas")
                    if !ok { f.arreter() }
                }
            }
        }
    }

    /// Texte brut de whisper pour `wav`, ou nil (pas prêt, erreur, délai dépassé) : l'appelant repasse par whisper-cli.
    /// Mêmes réglages que whisper-cli : `-l fr`, `-nt`, fenêtre de 15 s (`audio_ctx` 768) sous 14 s d'audio.
    func transcrire(_ wav: URL, dureeAudio: Double, prompt: String, fini: @escaping (String?) -> Void) {
        guard pret, let son = try? Data(contentsOf: wav) else { fini(nil); return }
        planifierArret()
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(Self.port)/inference")!, timeoutInterval: max(6, 3 + dureeAudio * 0.4))
        req.httpMethod = "POST"
        let frontiere = "bt" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        req.setValue("multipart/form-data; boundary=\(frontiere)", forHTTPHeaderField: "Content-Type")
        var d = Data()
        func champ(_ nom: String, _ valeur: String) {
            d.append("--\(frontiere)\r\nContent-Disposition: form-data; name=\"\(nom)\"\r\n\r\n\(valeur)\r\n".data(using: .utf8)!)
        }
        champ("response_format", "json")
        champ("language", "fr")
        champ("audio_ctx", dureeAudio < 14 ? "768" : "0")
        if !prompt.isEmpty { champ("prompt", prompt) }
        d.append("--\(frontiere)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"dictee.wav\"\r\nContent-Type: audio/wav\r\n\r\n".data(using: .utf8)!)
        d.append(son)
        d.append("\r\n--\(frontiere)--\r\n".data(using: .utf8)!)
        req.httpBody = d
        URLSession.shared.dataTask(with: req) { data, rep, err in
            let code = (rep as? HTTPURLResponse)?.statusCode ?? 0
            let texte = code == 200 ? data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["text"] as? String : nil
            DispatchQueue.main.async {
                if texte == nil { journal("whisper final : échec (code \(code)\(err.map { ", " + $0.localizedDescription } ?? "")), repli sur whisper-cli") }
                fini(texte)
            }
        }.resume()
    }

    private func planifierArret() {
        arretDiffere?.cancel()
        let w = DispatchWorkItem { ServeurFinal.shared.arreter() }
        arretDiffere = w
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.inactiviteMax, execute: w)
    }

    /// Interroge le serveur toutes les 0,2 s, `essais` fois au plus.
    private func attendre(essais: Int, _ fini: @escaping (Bool) -> Void) {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(Self.port)/")!, timeoutInterval: 0.5)
        req.httpMethod = "GET"
        URLSession.shared.dataTask(with: req) { _, rep, _ in
            let ok = (rep as? HTTPURLResponse).map { $0.statusCode < 500 } ?? false
            DispatchQueue.main.async {
                if ok || essais <= 1 { fini(ok); return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { ServeurFinal.shared.attendre(essais: essais - 1, fini) }
            }
        }.resume()
    }

    func arreter() {
        arretDiffere?.cancel(); arretDiffere = nil
        if let p = serveur, p.isRunning { p.terminate(); journal("whisper final : serveur arrêté") }
        serveur = nil
        pret = false
        demarrage = false
    }
}
