import AVFoundation

/// Synthèse vocale avec la voix de Jarvis : edge-tts `fr-FR-RemyMultilingualNeural` (débit +8 %), appelé
/// comme dans `~/.claude/bin/tg-say.sh`, après nettoyage par `tts-clean.py`. Sans réseau (ou si edge-tts
/// échoue), repli sur `say` avec une voix française ; après un échec, edge-tts n'est plus essayé pendant 60 s
/// pour ne pas ajouter son délai d'attente à chaque phrase.
/// La préparation (nettoyage + fichier audio) tourne hors du fil principal ; la lecture, sur le fil principal.
final class Synthese: NSObject, AVAudioPlayerDelegate {
    static let shared = Synthese()

    struct Audio { let url: URL; let moteur: String; let duree: TimeInterval; let texte: String; var suite: Suite? = nil }

    /// Morceaux 2..n d'un long texte : synthétisés en arrière-plan pendant que le premier joue (07/11/2026).
    /// Accès sur le fil principal uniquement.
    final class Suite {
        var urls: [URL?]
        var echecs: Set<Int> = []
        var attente: (() -> Void)?
        init(_ n: Int) { urls = Array(repeating: nil, count: n) }
        func pret(_ i: Int) -> Bool { urls[i] != nil || echecs.contains(i) }
    }

    static let voixEdge = "fr-FR-RemyMultilingualNeural"
    /// Débit edge-tts : réglage `BTDebitVoix` (ex. "-10%"), sinon -8 % (09/11/2026 : Eliot trouvait +8 % trop rapide).
    static var debitEdge: String { Reglages.texte("BTDebitVoix") ?? "-8%" }
    static var voixSay: String { Reglages.texte("BTVoixSay") ?? "Thomas" }

    let dossier: URL = {
        let d = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("better-terminal-vocal", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return d
    }()

    private let file = DispatchQueue(label: "bt.synthese", qos: .userInitiated, attributes: .concurrent)
    private var edgeEnPanneJusqua = Date.distantPast
    private var cheminEdgeCache: String??
    private let verrou = NSLock()

    /// Tests (pilote) : `--proxy` passé à edge-tts pour simuler l'absence de réseau.
    var proxyEdge: String?

    private var lecteur: AVAudioPlayer?
    private var finLecture: (() -> Void)?

    var parle: Bool { lecteur?.isPlaying ?? false }

    // MARK: - Préparation

    /// Nettoie le texte, fabrique l'audio du PREMIER morceau, puis `fini` sur le fil principal (nil si échec).
    /// Les morceaux suivants se fabriquent ensuite en arrière-plan : la voix démarre en ~1 s au lieu d'attendre
    /// la synthèse de tout le texte (5 s et plus sur un long compte rendu).
    func preparer(_ texte: String, env: [String: String], fini: @escaping (Audio?) -> Void) {
        file.async { [self] in
            let debut = Date()
            let propre = nettoyer(texte, env: env)
            guard !propre.isEmpty else { DispatchQueue.main.async { fini(nil) }; return }
            let morceaux = Self.decouper(propre)
            guard var premier = fabriquer(morceaux[0], env: env) else { DispatchQueue.main.async { fini(nil) }; return }
            let total = Date().timeIntervalSince(debut)
            journal("voix : \(premier.moteur) prêt en \(String(format: "%.2f", total)) s, morceau 1/\(morceaux.count) (« \(extrait(morceaux[0], 80)) »)")
            if morceaux.count > 1 {
                let suite = Suite(morceaux.count - 1)
                premier.suite = suite
                file.async { [self] in
                    for (i, m) in morceaux.dropFirst().enumerated() {
                        let a = fabriquer(m, env: env)
                        DispatchQueue.main.async {
                            if let a { suite.urls[i] = a.url } else { suite.echecs.insert(i) }
                            let f = suite.attente; suite.attente = nil; f?()
                        }
                    }
                }
            }
            let resultat = Audio(url: premier.url, moteur: premier.moteur, duree: total, texte: propre, suite: premier.suite)
            DispatchQueue.main.async { fini(resultat) }
        }
    }

    /// Phrases regroupées : un premier morceau court (démarrage rapide), puis des morceaux d'environ 260 caractères.
    static func decouper(_ t: String) -> [String] {
        var phrases: [String] = []
        var courant = ""
        for c in t {
            courant.append(c)
            if ".!?…;:".contains(c) { phrases.append(courant.trimmingCharacters(in: .whitespaces)); courant = "" }
        }
        let reste = courant.trimmingCharacters(in: .whitespaces)
        if !reste.isEmpty { phrases.append(reste) }
        phrases = phrases.filter { !$0.isEmpty }
        guard !phrases.isEmpty else { return [t] }
        var morceaux: [String] = []
        var m = ""
        for p in phrases {
            let limite = morceaux.isEmpty ? 110 : 260
            if m.isEmpty { m = p } else if m.count + 1 + p.count <= limite { m += " " + p } else { morceaux.append(m); m = p }
        }
        if !m.isEmpty { morceaux.append(m) }
        return morceaux
    }

    /// Un fichier audio pour un morceau : edge-tts, sinon say.
    private func fabriquer(_ propre: String, env: [String: String]) -> Audio? {
        let base = dossier.appendingPathComponent(UUID().uuidString.lowercased())
        let txt = base.appendingPathExtension("txt")
        guard (try? propre.write(to: txt, atomically: true, encoding: .utf8)) != nil else { return nil }
        defer { try? FileManager.default.removeItem(at: txt) }
        if let edge = cheminEdge(env), Date() >= enPanneJusqua() {
            let mp3 = base.appendingPathExtension("mp3")
            var args = ["--voice", Self.voixEdge, "--rate=" + Self.debitEdge, "-f", txt.path, "--write-media", mp3.path]
            if let p = proxyEdge { args += ["--proxy", p] }
            let t0 = Date()
            let (code, _) = executer(edge, args, env: env, delai: 12)
            let taille = (try? FileManager.default.attributesOfItem(atPath: mp3.path)[.size] as? Int) ?? 0
            if code == 0, taille > 0 { return Audio(url: mp3, moteur: "edge", duree: Date().timeIntervalSince(t0), texte: propre) }
            try? FileManager.default.removeItem(at: mp3)
            mettreEnPanne()
            journal("voix : edge-tts en échec (code \(code), \(String(format: "%.2f", Date().timeIntervalSince(t0))) s) : repli sur say pendant 60 s")
        }
        let aiff = base.appendingPathExtension("aiff")
        let t0 = Date()
        let (code, _) = executer("/usr/bin/say", ["-v", Self.voixSay, "-r", "165", "-f", txt.path, "-o", aiff.path], delai: 20)
        let taille = (try? FileManager.default.attributesOfItem(atPath: aiff.path)[.size] as? Int) ?? 0
        if code == 0, taille > 0 { return Audio(url: aiff, moteur: "say/" + Self.voixSay, duree: Date().timeIntervalSince(t0), texte: propre) }
        journal("voix : say en échec (code \(code))")
        return nil
    }

    private func enPanneJusqua() -> Date { verrou.lock(); defer { verrou.unlock() }; return edgeEnPanneJusqua }
    private func mettreEnPanne() { verrou.lock(); edgeEnPanneJusqua = Date().addingTimeInterval(60); verrou.unlock() }
    func reparerEdge() { verrou.lock(); edgeEnPanneJusqua = .distantPast; verrou.unlock() }

    var moteurPrevu: String {
        Date() < enPanneJusqua() ? "say" : "edge"
    }

    /// Texte prêt à dire : `tts-clean.py` (projet Jarvis, sinon ~/.claude/bin), repli Swift minimal.
    func nettoyer(_ texte: String, env: [String: String]) -> String {
        let scripts = [HOME + "/Desktop/Projets/Jarvis-Ultron-Telegram/tts-clean.py", HOME + "/.claude/bin/tts-clean.py"]
        if let s = scripts.first(where: { FileManager.default.fileExists(atPath: $0) }),
           let py = Environnement.trouver("python3", env, connus: ["/usr/bin/python3"]) {
            let (code, out) = executerAvecEntree(py, [s], entree: texte, env: env, delai: 5)
            let t = out.trimmingCharacters(in: .whitespacesAndNewlines)
            if code == 0, !t.isEmpty { return t }
            journal("voix : tts-clean.py en échec (code \(code)), nettoyage minimal")
        }
        return Self.nettoyageMinimal(texte)
    }

    static func nettoyageMinimal(_ t: String) -> String {
        var s = t.replacingOccurrences(of: "\u{1b}\\[[0-9;]*[a-zA-Z]", with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: "```[\\s\\S]*?```", with: " (extrait de code) ", options: .regularExpression)
        s = s.replacingOccurrences(of: "https?://\\S+", with: "un lien", options: .regularExpression)
        s = s.replacingOccurrences(of: "[`*_#>|]", with: "", options: .regularExpression)
        s = String(s.unicodeScalars.filter { !($0.properties.isEmojiPresentation || $0.properties.generalCategory == .otherSymbol) })
        return s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// edge-tts : le shim pyenv ajoute ~0,2 s par appel, on vise le vrai script quand c'est possible.
    private func cheminEdge(_ env: [String: String]) -> String? {
        verrou.lock()
        if let c = cheminEdgeCache { verrou.unlock(); return c }
        verrou.unlock()
        var r = Environnement.trouver("edge-tts", env, connus: [HOME + "/.pyenv/shims/edge-tts", "/opt/homebrew/bin/edge-tts", HOME + "/.local/bin/edge-tts"])
        if let p = r, p.contains("/.pyenv/shims/"),
           let pyenv = Environnement.trouver("pyenv", env, connus: ["/opt/homebrew/bin/pyenv", HOME + "/.pyenv/bin/pyenv"]) {
            let (code, out) = executer(pyenv, ["which", "edge-tts"], env: env, delai: 5)
            let vrai = out.trimmingCharacters(in: .whitespacesAndNewlines)
            if code == 0, vrai.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: vrai) { r = vrai }
        }
        journal("voix : edge-tts → \(r ?? "introuvable (repli say)")")
        verrou.lock(); cheminEdgeCache = .some(r); verrou.unlock()
        return r
    }

    // MARK: - Lecture

    private var suiteCourante: Suite?
    private var indexSuite = 0
    private var volumeCourant: Float = 1

    /// Joue l'audio puis les morceaux de sa suite ; `fini` à la fin naturelle uniquement (pas après `arreter`).
    @discardableResult
    func jouer(_ a: Audio, volume: Float, fini: @escaping () -> Void) -> Bool {
        arreter()
        guard jouerURL(a.url, volume: volume, moteur: a.moteur) else { return false }
        finLecture = fini
        suiteCourante = a.suite
        indexSuite = 0
        volumeCourant = volume
        return true
    }

    private func jouerURL(_ url: URL, volume: Float, moteur: String) -> Bool {
        do {
            let l = try AVAudioPlayer(contentsOf: url)
            l.delegate = self
            l.volume = volume
            l.prepareToPlay()
            guard l.play() else { journal("voix : lecture refusée"); return false }
            lecteur = l
            journal("voix : lecture \(String(format: "%.1f", l.duration)) s (\(moteur))\(volume == 0 ? " [muet]" : "")")
            return true
        } catch {
            journal("voix : lecture impossible — \(error.localizedDescription)")
            return false
        }
    }

    /// Morceau suivant de la suite : joué s'il est prêt, sinon on l'attend (rappel quand il arrive).
    private func continuerSuite() {
        guard let s = suiteCourante, finLecture != nil else { return }
        while indexSuite < s.urls.count, s.echecs.contains(indexSuite) { indexSuite += 1 }
        guard indexSuite < s.urls.count else { terminerLecture(); return }
        guard let u = s.urls[indexSuite] else {
            s.attente = { [weak self, weak s] in
                guard let self, let s, self.suiteCourante === s else { return }
                self.continuerSuite()
            }
            return
        }
        indexSuite += 1
        if !jouerURL(u, volume: volumeCourant, moteur: "suite") { continuerSuite() }
    }

    private func terminerLecture() {
        let f = finLecture
        finLecture = nil
        lecteur = nil
        suiteCourante = nil
        f?()
    }

    func arreter() {
        finLecture = nil
        suiteCourante?.attente = nil
        suiteCourante = nil
        if let l = lecteur { l.delegate = nil; l.stop() }
        lecteur = nil
    }

    func audioPlayerDidFinishPlaying(_ p: AVAudioPlayer, successfully ok: Bool) {
        guard p === lecteur else { return }
        lecteur = nil
        if suiteCourante != nil { continuerSuite() } else { terminerLecture() }
    }

    func audioPlayerDecodeErrorDidOccur(_ p: AVAudioPlayer, error: Error?) {
        journal("voix : erreur de décodage — \(error?.localizedDescription ?? "?")")
        audioPlayerDidFinishPlaying(p, successfully: false)
    }

    func supprimer(_ a: Audio?) {
        guard let a else { return }
        try? FileManager.default.removeItem(at: a.url)
        for u in a.suite?.urls ?? [] { if let u { try? FileManager.default.removeItem(at: u) } }
    }

    func toutNettoyer() { try? FileManager.default.removeItem(at: dossier) }
}

/// Comme `executer`, avec un texte écrit sur stdin (jamais de shell).
func executerAvecEntree(_ exe: String, _ args: [String], entree: String, env: [String: String]? = nil, delai: TimeInterval = 10) -> (Int32, String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    if let e = env { p.environment = e }
    let in_ = Pipe(), out = Pipe()
    p.standardInput = in_
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    var donnees = Data()
    let lu = DispatchGroup(); lu.enter()
    DispatchQueue.global().async { donnees = out.fileHandleForReading.readDataToEndOfFile(); lu.leave() }
    do { try p.run() } catch { journal("lancement \(exe) impossible : \(error.localizedDescription)"); return (-1, "") }
    DispatchQueue.global().async {
        try? in_.fileHandleForWriting.write(contentsOf: Data(entree.utf8))
        try? in_.fileHandleForWriting.close()
    }
    let garde = DispatchWorkItem { if p.isRunning { p.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + delai, execute: garde)
    p.waitUntilExit()
    garde.cancel()
    _ = lu.wait(timeout: .now() + 2)
    return (p.terminationStatus, String(decoding: donnees, as: UTF8.self))
}
