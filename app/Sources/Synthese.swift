import AVFoundation

/// Synthèse vocale avec la voix de Jarvis : edge-tts `fr-FR-RemyMultilingualNeural` (débit réglable, -8 % par défaut),
/// appelé comme dans `~/.claude/bin/tg-say.sh`, après nettoyage par `tts-clean.py`.
/// Une seule voix par message (09/11/2026) : le moteur est choisi sur le PREMIER morceau, et tous les morceaux
/// suivants le gardent. edge-tts répond en 1 à 10 s selon les moments (mesuré : même texte 4 s puis 10 s, quatre
/// morceaux en parallèle en 1,5 s : c'est la latence du service Microsoft, pas la taille du morceau) ; chaque appel
/// est donc doublé par une seconde tentative en parallèle s'il traîne, et un morceau suivant n'est JAMAIS lu par `say` :
/// il est retenté (jusqu'à 25 s), et sauté en dernier recours. `say` ne sert que si edge-tts échoue dès le premier
/// morceau (pas de réseau), avec la meilleure voix française installée ; edge-tts n'est alors plus essayé pendant 60 s.
/// La préparation (nettoyage + fichier audio) tourne hors du fil principal ; la lecture, sur le fil principal.
final class Synthese: NSObject, AVAudioPlayerDelegate {
    static let shared = Synthese()

    /// `etape` : repère `[[n]]` du bloc vocal qui commence avec ce morceau (scène animée, voir MoteurVocal).
    struct Audio { let url: URL; let moteur: String; let duree: TimeInterval; let texte: String; var suite: Suite? = nil; var etape: Int? = nil }

    /// Morceaux 2..n d'un long texte : synthétisés en arrière-plan (en parallèle) pendant que le premier joue.
    /// Accès sur le fil principal uniquement.
    final class Suite {
        var urls: [URL?]
        var echecs: Set<Int> = []
        var etapes: [Int?]
        var attente: (() -> Void)?
        init(_ n: Int) { urls = Array(repeating: nil, count: n); etapes = Array(repeating: nil, count: n) }
        func pret(_ i: Int) -> Bool { urls[i] != nil || echecs.contains(i) }
    }

    static let voixEdge = "fr-FR-RemyMultilingualNeural"
    /// Débit edge-tts : réglage `BTDebitVoix` (ex. "-10%"), sinon -8 % (09/11/2026 : Eliot trouvait +8 % trop rapide).
    static var debitEdge: String { Reglages.texte("BTDebitVoix") ?? "-8%" }
    /// Voix de secours : réglage `BTVoixSay`, sinon la meilleure voix française installée.
    static var voixSay: String { Reglages.texte("BTVoixSay") ?? meilleureVoixSay }
    /// Premium, puis Enhanced (« Thomas (Enhanced) », « Audrey (Premium) »…), puis Thomas. Lu une fois (`say -v ?`).
    static let meilleureVoixSay: String = {
        let (_, out) = executer("/usr/bin/say", ["-v", "?"], delai: 5)
        var voix: [String] = []
        for l in out.split(separator: "\n") {
            guard let r = l.range(of: "^(.+?)\\s+(fr_FR|fr_CA|fr_BE|fr_CH)\\s+#", options: .regularExpression) else { continue }
            let ligne = String(l[r])
            let nom = ligne.replacingOccurrences(of: "\\s+fr_[A-Z]{2}\\s+#$", with: "", options: .regularExpression)
            if ligne.contains("fr_FR") { voix.insert(nom, at: 0) } else { voix.append(nom) }
        }
        let choix = voix.first { $0.contains("(Premium)") } ?? voix.first { $0.contains("(Enhanced)") }
            ?? voix.first { $0.hasPrefix("Thomas") } ?? voix.first ?? "Thomas"
        journal("voix : voix de secours say → \(choix)")
        return choix
    }()

    let dossier: URL = {
        let d = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("better-terminal-vocal", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return d
    }()

    private let file = DispatchQueue(label: "bt.synthese", qos: .userInitiated, attributes: .concurrent)
    /// Morceaux suivants : au plus 3 appels edge-tts en même temps par message.
    private let parallele = DispatchSemaphore(value: 3)
    private var edgeEnPanneJusqua = Date.distantPast
    private var cheminEdgeCache: String??
    private let verrou = NSLock()

    /// Tests (pilote) : `--proxy` passé à edge-tts pour simuler l'absence de réseau.
    var proxyEdge: String?

    private var lecteur: AVAudioPlayer?
    private var finLecture: (() -> Void)?
    /// Rappel quand un morceau marqué d'une étape commence à jouer (repères `[[n]]`).
    private var surEtape: ((Int) -> Void)?

    /// Puissance moyenne (dBFS) du morceau en train de jouer, nil si rien ne joue (comparaison écho côté écoute).
    func niveauSortie() -> Float? {
        guard let l = lecteur, l.isPlaying else { return nil }
        l.updateMeters()
        return l.averagePower(forChannel: 0)
    }

    var parle: Bool { lecteur?.isPlaying ?? false }

    // MARK: - Préparation

    /// Nettoie le texte, fabrique l'audio du PREMIER morceau, puis `fini` sur le fil principal (nil si échec).
    /// Les morceaux suivants se fabriquent ensuite en arrière-plan, avec le même moteur.
    /// `segments` : le texte découpé aux repères `[[n]]` (n, texte) ; chaque segment commence un nouveau morceau,
    /// marqué de son étape. Sans segments, `texte` est lu d'un bloc.
    func preparer(_ texte: String, segments: [(Int, String)]? = nil, env: [String: String], fini: @escaping (Audio?) -> Void) {
        file.async { [self] in
            let debut = Date()
            var morceaux: [(String, Int?)] = []
            if let segments {
                var enAttente: Int?
                for (n, t) in segments {
                    enAttente = max(enAttente ?? n, n)
                    let p = nettoyer(t, env: env)
                    guard !p.isEmpty else { continue }
                    for (i, m) in Self.decouper(p).enumerated() { morceaux.append((m, i == 0 ? enAttente : nil)) }
                    enAttente = nil
                }
            } else {
                let p = nettoyer(texte, env: env)
                if !p.isEmpty { morceaux = Self.decouper(p).map { ($0, nil) } }
            }
            guard !morceaux.isEmpty else { DispatchQueue.main.async { fini(nil) }; return }
            guard var premier = fabriquer(morceaux[0].0, env: env, moteur: nil) else { DispatchQueue.main.async { fini(nil) }; return }
            premier.etape = morceaux[0].1
            let total = Date().timeIntervalSince(debut)
            journal("voix : \(premier.moteur) prêt en \(String(format: "%.2f", total)) s, morceau 1/\(morceaux.count) (« \(extrait(morceaux[0].0, 80)) »)")
            if morceaux.count > 1 {
                let suite = Suite(morceaux.count - 1)
                for (i, m) in morceaux.dropFirst().enumerated() { suite.etapes[i] = m.1 }
                premier.suite = suite
                let moteur = premier.moteur
                for (i, m) in morceaux.dropFirst().enumerated() {
                    file.async { [self] in
                        parallele.wait()
                        let a = fabriquer(m.0, env: env, moteur: moteur)
                        parallele.signal()
                        DispatchQueue.main.async {
                            if let a { suite.urls[i] = a.url } else { suite.echecs.insert(i) }
                            let f = suite.attente; suite.attente = nil; f?()
                        }
                    }
                }
            }
            let resultat = Audio(url: premier.url, moteur: premier.moteur, duree: total, texte: morceaux.map { $0.0 }.joined(separator: " "),
                                 suite: premier.suite, etape: premier.etape)
            DispatchQueue.main.async { fini(resultat) }
        }
    }

    /// Repères d'étape dans un texte à dire : `[[1]]`, `[[ 2 ]]`. Renvoie nil sans repère, sinon les segments
    /// (étape 0 = le texte avant le premier repère, éventuellement vide).
    static func segments(_ t: String) -> [(Int, String)]? {
        guard let re = try? NSRegularExpression(pattern: "\\[\\[\\s*(\\d{1,3})\\s*\\]\\]") else { return nil }
        let ns = t as NSString
        let l = re.matches(in: t, range: NSRange(location: 0, length: ns.length))
        guard !l.isEmpty else { return nil }
        var r: [(Int, String)] = []
        var n = 0, pos = 0
        for m in l {
            r.append((n, ns.substring(with: NSRange(location: pos, length: m.range.location - pos))))
            n = Int(ns.substring(with: m.range(at: 1))) ?? n + 1
            pos = m.range.location + m.range.length
        }
        r.append((n, ns.substring(from: pos)))
        return r
    }

    static func sansReperes(_ t: String) -> String {
        t.replacingOccurrences(of: "\\s*\\[\\[\\s*\\d{1,3}\\s*\\]\\]\\s*", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
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

    /// Un fichier audio pour un morceau. `moteur` nil (premier morceau) : edge-tts, sinon say. "edge" (morceaux
    /// suivants d'un message commencé en edge) : edge-tts uniquement, retenté, jamais say. Autre : say.
    private func fabriquer(_ propre: String, env: [String: String], moteur: String?) -> Audio? {
        let edge = cheminEdge(env)
        if moteur == "edge" || (moteur == nil && edge != nil && Date() >= enPanneJusqua()) {
            let t0 = Date()
            // Premier morceau : seconde tentative à 3,5 s, abandon vers 14 s (alors say pour tout le message).
            // Morceau suivant : secondes tentatives à 5 s et 13 s, jusqu'à 25 s chacune.
            let essais: [(TimeInterval, TimeInterval)] = moteur == nil ? [(0, 10), (3.5, 10.5)] : [(0, 12), (5, 25), (13, 25)]
            if let edge, let mp3 = edgeCourse(propre, exe: edge, env: env, essais: essais) {
                return Audio(url: mp3, moteur: "edge", duree: Date().timeIntervalSince(t0), texte: propre)
            }
            if moteur == "edge" {
                journal("voix : edge-tts en échec sur un morceau suivant après \(essais.count) tentatives (\(String(format: "%.1f", Date().timeIntervalSince(t0))) s) : morceau sauté (pas de changement de voix)")
                mettreEnPanne()
                return nil
            }
            mettreEnPanne()
            journal("voix : edge-tts indisponible (\(String(format: "%.2f", Date().timeIntervalSince(t0))) s) : say pour ce message, edge-tts réessayé dans 60 s")
        }
        let base = dossier.appendingPathComponent(UUID().uuidString.lowercased())
        let txt = base.appendingPathExtension("txt")
        guard (try? propre.write(to: txt, atomically: true, encoding: .utf8)) != nil else { return nil }
        defer { try? FileManager.default.removeItem(at: txt) }
        let aiff = base.appendingPathExtension("aiff")
        let t0 = Date()
        let voix = Self.voixSay
        let (code, _) = executer("/usr/bin/say", ["-v", voix, "-f", txt.path, "-o", aiff.path], delai: 20)
        let taille = (try? FileManager.default.attributesOfItem(atPath: aiff.path)[.size] as? Int) ?? 0
        if code == 0, taille > 0 { return Audio(url: aiff, moteur: "say/" + voix, duree: Date().timeIntervalSince(t0), texte: propre) }
        journal("voix : say en échec (code \(code))")
        return nil
    }

    /// Plusieurs appels edge-tts décalés (départ, délai max) ; le premier fichier valide l'emporte.
    /// Une tentative pas encore partie quand une autre a réussi ne part pas ; une tentative en échec rapide
    /// (pas de réseau) avance le départ de la suivante.
    private func edgeCourse(_ propre: String, exe: String, env: [String: String], essais: [(TimeInterval, TimeInterval)]) -> URL? {
        let base = dossier.appendingPathComponent(UUID().uuidString.lowercased())
        let txt = base.appendingPathExtension("txt")
        guard (try? propre.write(to: txt, atomically: true, encoding: .utf8)) != nil else { return nil }
        defer { try? FileManager.default.removeItem(at: txt) }
        let v = NSLock()
        var gagnant: URL?
        var restants = essais.count
        var partis = Set<Int>()
        let signal = DispatchSemaphore(value: 0)
        let t0 = Date()
        func lancer(_ i: Int) {
            v.lock()
            if partis.contains(i) || gagnant != nil {
                let deja = partis.contains(i)
                if !deja { partis.insert(i); restants -= 1 }
                let fin = !deja && restants == 0
                v.unlock()
                if fin { signal.signal() }
                return
            }
            partis.insert(i)
            v.unlock()
            DispatchQueue.global(qos: .userInitiated).async { [self] in
                let mp3 = base.appendingPathExtension("\(i).mp3")
                var args = ["--voice", Self.voixEdge, "--rate=" + Self.debitEdge, "-f", txt.path, "--write-media", mp3.path]
                if let p = proxyEdge { args += ["--proxy", p] }
                let t = Date()
                let (code, _) = executer(exe, args, env: env, delai: essais[i].1)
                let taille = (try? FileManager.default.attributesOfItem(atPath: mp3.path)[.size] as? Int) ?? 0
                let ok = code == 0 && taille > 0
                v.lock()
                var garde = false
                if ok && gagnant == nil { gagnant = mp3; garde = true }
                restants -= 1
                let fin = garde || restants == 0
                v.unlock()
                if !garde { try? FileManager.default.removeItem(at: mp3) }
                if !ok { journal("voix : edge-tts tentative \(i + 1)/\(essais.count) en échec (code \(code), \(String(format: "%.2f", Date().timeIntervalSince(t))) s)") }
                else if i > 0, garde { journal("voix : edge-tts gagné par la tentative \(i + 1) (\(String(format: "%.2f", Date().timeIntervalSince(t0))) s)") }
                if !ok, i + 1 < essais.count { lancer(i + 1) }
                if fin { signal.signal() }
            }
        }
        for i in essais.indices {
            if essais[i].0 <= 0 { lancer(i) }
            else { DispatchQueue.global().asyncAfter(deadline: .now() + essais[i].0) { lancer(i) } }
        }
        signal.wait()
        v.lock(); let g = gagnant; v.unlock()
        return g
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
    func jouer(_ a: Audio, volume: Float, surEtape: ((Int) -> Void)? = nil, fini: @escaping () -> Void) -> Bool {
        arreter()
        guard jouerURL(a.url, volume: volume, moteur: a.moteur) else { return false }
        finLecture = fini
        suiteCourante = a.suite
        indexSuite = 0
        volumeCourant = volume
        self.surEtape = surEtape
        if let n = a.etape { surEtape?(n) }
        return true
    }

    private func jouerURL(_ url: URL, volume: Float, moteur: String) -> Bool {
        do {
            let l = try AVAudioPlayer(contentsOf: url)
            l.delegate = self
            l.volume = volume
            l.isMeteringEnabled = true
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
        while indexSuite < s.urls.count, s.echecs.contains(indexSuite) {   // morceau sauté : son étape part quand même
            if let n = s.etapes[indexSuite] { surEtape?(n) }
            indexSuite += 1
        }
        guard indexSuite < s.urls.count else { terminerLecture(); return }
        guard let u = s.urls[indexSuite] else {
            s.attente = { [weak self, weak s] in
                guard let self, let s, self.suiteCourante === s else { return }
                self.continuerSuite()
            }
            return
        }
        let etape = s.etapes[indexSuite]
        indexSuite += 1
        let ok = jouerURL(u, volume: volumeCourant, moteur: "suite")
        if let n = etape { surEtape?(n) }
        if !ok { continuerSuite() }
    }

    private func terminerLecture() {
        let f = finLecture
        finLecture = nil
        surEtape = nil
        lecteur = nil
        suiteCourante = nil
        f?()
    }

    func arreter() {
        finLecture = nil
        surEtape = nil
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
