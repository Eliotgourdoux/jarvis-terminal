import AppKit
import WebKit

/// Relais faible pour la page de la conversation Telegram.
private final class RelaisTelegram: NSObject, WKScriptMessageHandler {
    weak var cible: ConversationJarvis?
    init(_ c: ConversationJarvis) { cible = c }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { cible?.messageDeLaPage(m) }
}

/// La conversation Telegram d'Eliot avec Jarvis (son bot Telegram), épinglée en haut de la barre
/// (demande d'Eliot, 08/11/2026 : « ma conv Telegram, mais dans cette UI »).
/// Lecture : ~/.claude/channels/telegram/jarvis/transcript.md, écrit par tg-router.sh dans les deux sens.
/// Envoi : par l'API locale de Beeper Desktop, depuis le compte Telegram d'Eliot (08/11/2026). Le message
/// apparaît à droite dans Telegram, comme tapé sur le téléphone, et tg-router.sh le reçoit comme n'importe
/// quel message : un seul chemin, rien à synchroniser. Si Beeper est fermé ou répond une erreur, l'échec
/// s'affiche dans la page : jamais de repli silencieux par le bot.
final class ConversationJarvis: NSObject, WKNavigationDelegate {
    static let shared = ConversationJarvis()
    static let dossier = URL(fileURLWithPath: NSHomeDirectory() + "/.claude/channels/telegram/jarvis", isDirectory: true)
    private var transcript: URL { Self.dossier.appendingPathComponent("transcript.md") }
    /// Le chat Telegram avec le bot Jarvis, vu par Beeper : identifiant lu dans ~/.config/better-terminal/jarvis-chat
    /// (ou la variable BT_BEEPER_CHAT), jamais écrit dans le code.
    private static let chatBeeper: String = {
        if let e = ProcessInfo.processInfo.environment["BT_BEEPER_CHAT"], !e.isEmpty { return e }
        let f = NSHomeDirectory() + "/.config/better-terminal/jarvis-chat"
        return ((try? String(contentsOfFile: f, encoding: .utf8)) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }()
    private static let apiBeeper = "http://localhost:23373/v1"
    private var envoisEnCours = 0
    /// Vocal enregistré dans la fenêtre Jarvis (08/11/2026) : part comme un vrai vocal Telegram, par Beeper.
    private let micro = CaptureMicro()
    /// Vocaux dont l'envoi a échoué, gardés pour « Réessayer » (id de la page → fichier ogg).
    private var vocauxEnEchec: [String: (url: URL, duree: Double)] = [:]

    let vue = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 780))
    private(set) var web: WKWebView?
    private var pageUrl: URL?
    private var pagePrete = false

    // Suivi du fichier
    private var inode: UInt64 = 0
    private var lu: UInt64 = 0          // octets déjà transmis (toujours sur une fin de ligne)
    private var minuterie: Timer?
    private var tic = 0

    // Aperçu pour la barre latérale
    private(set) var apercu = ""
    private(set) var dateDernier: Date?
    private(set) var nonLu = false
    private(set) var occupe = false
    private var signatureDernier = ""

    var disponible: Bool { FileManager.default.fileExists(atPath: transcript.path) }

    private override init() {
        super.init()
        vue.wantsLayer = true
        vue.layer?.backgroundColor = NSColor(srgbRed: 0x11/255.0, green: 0x12/255.0, blue: 0x16/255.0, alpha: 1).cgColor
    }

    /// Au lancement : suit le transcript (aperçu, non-lu), sans créer la vue web.
    func demarrer() {
        guard minuterie == nil else { return }
        lireApercu(premiere: true)
        let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.battement() }
        RunLoop.main.add(t, forMode: .common)
        minuterie = t
    }

    /// Vue web créée à la première ouverture seulement.
    func preparerVue() {
        guard web == nil else { return }
        let (_, lecture) = Page.choisir()
        let p = lecture.appendingPathComponent("telegram.html")
        pageUrl = p
        let cfg = WKWebViewConfiguration()
        Medias.installer(dans: cfg)   // images, vidéos et sons locaux cités dans le fil (btmedia://, Medias.swift)
        cfg.userContentController.add(RelaisTelegram(self), name: "tg")
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
        let w = WKWebView(frame: vue.bounds, configuration: cfg)
        w.autoresizingMask = [.width, .height]
        w.navigationDelegate = self
        w.allowsBackForwardNavigationGestures = false
        w.allowsLinkPreview = false
        if #available(macOS 13.3, *) { w.isInspectable = true }
        if PiloteDev.actif, w.responds(to: Selector(("_setWindowOcclusionDetectionEnabled:"))) {
            w.setValue(false, forKey: "windowOcclusionDetectionEnabled")
        }
        vue.addSubview(w)
        web = w
        w.loadFileURL(p, allowingReadAccessTo: lecture)
    }

    /// Eliot regarde la conversation : plus rien de non lu.
    func marquerAffichee() {
        if nonLu { nonLu = false; FenetrePrincipale.shared.planifierMaj() }
        if pagePrete { appeler("window.fil && window.fil.focus()", [:]) }
        marquerLuBeeper()
    }

    /// Un « vu » ici = un « vu » dans Telegram et Beeper (demande d'Eliot, 09/11/2026) : POST /chats/{id}/read.
    /// Une fois par message (signature du dernier), jamais en boucle. Beeper fermé : on ne le lance pas pour ça.
    private var signatureLueBeeper = ""
    private func marquerLuBeeper() {
        guard !signatureDernier.isEmpty, signatureDernier != signatureLueBeeper, BeeperDiscret.tourne() else { return }
        let jeton = (try? String(contentsOfFile: NSHomeDirectory() + "/.config/beeper/token", encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let permis = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        guard !jeton.isEmpty, let chat = Self.chatBeeper.addingPercentEncoding(withAllowedCharacters: permis),
              let url = URL(string: "\(Self.apiBeeper)/chats/\(chat)/read") else { return }
        let sig = signatureDernier
        signatureLueBeeper = sig
        var req = URLRequest(url: url, timeoutInterval: 8)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer " + jeton, forHTTPHeaderField: "Authorization")
        req.httpBody = Data("{}".utf8)
        URLSession.shared.dataTask(with: req) { [weak self] _, rep, err in
            let code = (rep as? HTTPURLResponse)?.statusCode ?? 0
            DispatchQueue.main.async {
                if err != nil || !(200..<300).contains(code) {
                    journal("jarvis : « vu » Beeper en échec (code \(code))")
                    if self?.signatureLueBeeper == sig { self?.signatureLueBeeper = "" }   // on retentera au prochain affichage
                }
            }
        }.resume()
    }

    // MARK: - Suivi du fichier

    private func battement() {
        tic += 1
        let attrs = try? FileManager.default.attributesOfItem(atPath: transcript.path)
        let taille = (attrs?[.size] as? NSNumber)?.uint64Value ?? 0
        let ino = (attrs?[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0
        var change = false
        if ino != inode || taille < lu {
            // rotation (tail + mv) ou premier passage : on renvoie tout
            inode = ino; lu = 0
            if pagePrete { envoyerTout() }
            change = true
        } else if taille > lu {
            if pagePrete { envoyerSuite() }
            change = true
        }
        if change { lireApercu(premiere: false) }
        if tic % 2 == 0 { verifierOccupe() }
    }

    private func lireOctets(depuis debut: UInt64) -> (String, UInt64)? {
        guard let h = try? FileHandle(forReadingFrom: transcript) else { return nil }
        defer { try? h.close() }
        try? h.seek(toOffset: debut)
        guard let d = try? h.readToEnd(), !d.isEmpty else { return nil }
        // On s'arrête à la dernière fin de ligne : jamais de caractère UTF-8 coupé ni de ligne à moitié écrite.
        guard let n = d.lastIndex(of: 0x0A) else { return nil }
        let morceau = d.prefix(through: n)
        return (String(decoding: morceau, as: UTF8.self), debut + UInt64(morceau.count))
    }

    private func envoyerTout() {
        lu = 0
        let (texte, fin) = lireOctets(depuis: 0) ?? ("", 0)
        lu = fin
        appeler("window.fil && window.fil.tout(texte)", ["texte": texte])
    }

    private func envoyerSuite() {
        guard let (texte, fin) = lireOctets(depuis: lu) else { return }
        lu = fin
        appeler("window.fil && window.fil.ajout(texte)", ["texte": texte])
    }

    /// Dernière entrée du transcript : aperçu de la barre et pastille « non lu ».
    private func lireApercu(premiere: Bool) {
        guard let h = try? FileHandle(forReadingFrom: transcript) else { return }
        defer { try? h.close() }
        let fin = (try? h.seekToEnd()) ?? 0
        try? h.seek(toOffset: fin > 24_000 ? fin - 24_000 : 0)
        guard let d = try? h.readToEnd() else { return }
        let t = String(decoding: d, as: UTF8.self)
        let re = try! NSRegularExpression(pattern: "^## (\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}) — (.+)$", options: [.anchorsMatchLines])
        let ns = t as NSString
        guard let m = re.matches(in: t, range: NSRange(location: 0, length: ns.length)).last else { return }
        let date = ns.substring(with: m.range(at: 1)), qui = ns.substring(with: m.range(at: 2))
        let corps = ns.substring(from: m.range.location + m.range.length)
            .replacingOccurrences(of: "\\[\\[[^\\]]*\\]\\]", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let f = DateFormatter(); f.locale = Locale(identifier: "fr_FR"); f.dateFormat = "yyyy-MM-dd HH:mm"
        dateDernier = f.date(from: date)
        let deJarvis = qui.hasPrefix("moi")
        apercu = (deJarvis ? "" : "Toi : ") + String(corps.prefix(220))
        let sig = date + qui + String(corps.prefix(80))
        if !premiere, sig != signatureDernier, deJarvis, !FenetrePrincipale.shared.jarvisDevant { nonLu = true }
        signatureDernier = sig
        // Message arrivé pendant qu'Eliot a la conversation sous les yeux : vu aussi côté Telegram.
        let f0 = FenetrePrincipale.shared
        if !premiere, f0.jarvisDevant, f0.window.isVisible, f0.window.isKeyWindow, NSApp.isActive { marquerLuBeeper() }
        FenetrePrincipale.shared.planifierMaj()
    }

    /// Jarvis travaille-t-il ? = un `claude --resume <session Jarvis>` tourne, ou un envoi par Beeper est en cours.
    private func verifierOccupe() {
        let sid = (try? String(contentsOf: Self.dossier.appendingPathComponent("session_id.txt"), encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let enAttente = envoisEnCours > 0
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var tourne = false
            if Validation.sessionId(sid) { tourne = Self.pgrep("--resume \(sid)") }
            let routeur = Self.pgrep("tg-router.sh jarvis")
            DispatchQueue.main.async {
                guard let self else { return }
                let o = tourne || enAttente
                if o != self.occupe { self.occupe = o; FenetrePrincipale.shared.planifierMaj() }
                self.appeler("window.fil && window.fil.etat(e)",
                             ["e": ["reflechit": tourne, "enAttente": enAttente, "routeur": routeur]])
            }
        }
    }

    private static func pgrep(_ motif: String) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        p.arguments = ["-f", "--", motif]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }

    // MARK: - Envoi

    /// Envoie le texte dans le chat Jarvis depuis le compte Telegram d'Eliot, via Beeper Desktop.
    /// Beeper injoignable : on le lance en arrière-plan et on réessaie une fois. Le jeton n'est jamais journalisé.
    private func envoyerParBeeper(_ texte: String, essai: Int = 1, fini: @escaping (String?) -> Void) {
        let t = texte.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { fini("message vide"); return }
        guard t.utf8.count <= 4_000 else { fini("message trop long pour Telegram (4 000 caractères au plus)"); return }
        let jeton = (try? String(contentsOfFile: NSHomeDirectory() + "/.config/beeper/token", encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !jeton.isEmpty else { fini("jeton Beeper introuvable (~/.config/beeper/token)"); return }
        let permis = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        guard let chat = Self.chatBeeper.addingPercentEncoding(withAllowedCharacters: permis),
              let url = URL(string: "\(Self.apiBeeper)/chats/\(chat)/messages"),
              let corps = try? JSONSerialization.data(withJSONObject: ["text": t]) else { fini("requête impossible"); return }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer " + jeton, forHTTPHeaderField: "Authorization")
        req.httpBody = corps
        URLSession.shared.dataTask(with: req) { [weak self] data, rep, err in
            DispatchQueue.main.async {
                guard let self else { return }
                if let err = err as? URLError, [.cannotConnectToHost, .cannotFindHost, .networkConnectionLost, .timedOut].contains(err.code) {
                    if essai == 1 {
                        journal("jarvis : Beeper injoignable, lancement caché en arrière-plan puis nouvel essai")
                        BeeperDiscret.lancer { pret in
                            if pret { self.envoyerParBeeper(t, essai: 2, fini: fini) }
                            else { fini("Beeper Desktop ne démarre pas. Ouvre-le, puis renvoie.") }
                        }
                    } else {
                        journal("jarvis : Beeper toujours injoignable — \(err.code.rawValue)")
                        fini("Beeper Desktop ne répond pas. Ouvre-le, puis renvoie.")
                    }
                    return
                }
                if let err { journal("jarvis : envoi Beeper en échec — \(err.localizedDescription)"); fini("erreur réseau : \(err.localizedDescription)"); return }
                let code = (rep as? HTTPURLResponse)?.statusCode ?? 0
                guard (200..<300).contains(code) else {
                    var detail = ""
                    if let data, let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        detail = (o["message"] as? String) ?? (o["error"] as? String) ?? ""
                    }
                    journal("jarvis : Beeper a répondu \(code) \(extrait(detail, 200))")
                    fini(code == 401 || code == 403 ? "Beeper refuse le jeton (code \(code))"
                         : "Beeper a répondu une erreur (code \(code))" + (detail.isEmpty ? "" : " : " + String(detail.prefix(140))))
                    return
                }
                journal("jarvis : message envoyé par Beeper (\(t.count) car.)")
                fini(nil)
            }
        }.resume()
    }

    // MARK: - Vocal

    private func vocalEtat(_ etat: String, _ raison: String = "") {
        appeler("window.fil && window.fil.vocal && window.fil.vocal(e)", ["e": ["etat": etat, "raison": raison]])
    }

    /// Bouton micro : autorisation macOS si besoin, puis enregistrement (WAV 16 kHz mono, comme la dictée).
    private func demarrerVocal() {
        switch AutorisationMicro.etat {
        case .authorized: lancerEnregistrement()
        case .notDetermined:
            AutorisationMicro.demander { [weak self] ok in
                if ok { self?.lancerEnregistrement() }
                else { self?.vocalEtat("erreur", "Micro refusé par macOS.") }
            }
        default:
            vocalEtat("erreur", "Micro refusé : System Settings → Privacy & Security → Microphone.")
            AutorisationMicro.ouvrirReglages()
        }
    }

    private func lancerEnregistrement() {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("jarvis-vocal-\(UUID().uuidString).wav")
        micro.surNiveau = { [weak self] n in
            self?.appeler("window.fil && window.fil.niveau && window.fil.niveau(n)", ["n": Double(n)])
        }
        do {
            try micro.demarrer(vers: u)
            journal("jarvis : enregistrement d'un vocal")
            vocalEtat("enregistre")
        } catch {
            journal("jarvis : micro indisponible — \(error)")
            vocalEtat("erreur", "Micro indisponible : \(error)")
        }
    }

    /// Fin de l'enregistrement : WAV → ogg/opus (format des vocaux Telegram), puis envoi.
    private func terminerVocal(id: String) {
        guard let r = micro.arreter() else { finVocal(id, "rien n'a été enregistré"); return }
        journal("jarvis : vocal de \(String(format: "%.1f", r.duree)) s, niveau max \(String(format: "%.2f", r.niveauMax))")
        if r.duree < 0.6 { try? FileManager.default.removeItem(at: r.url); finVocal(id, "vocal trop court"); return }
        if r.niveauMax < 0.12 { try? FileManager.default.removeItem(at: r.url); finVocal(id, "le micro n'a rien capté (silence)"); return }
        envoisEnCours += 1
        verifierOccupe()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let ogg = r.url.deletingPathExtension().appendingPathExtension("ogg")
            let ok = Self.convertirOpus(r.url, ogg)
            try? FileManager.default.removeItem(at: r.url)
            DispatchQueue.main.async {
                guard let self else { return }
                guard ok else { self.envoisEnCours = max(0, self.envoisEnCours - 1); self.finVocal(id, "conversion en opus impossible (ffmpeg)"); return }
                self.envoyerVocalParBeeper(ogg, duree: r.duree) { erreur in
                    self.envoisEnCours = max(0, self.envoisEnCours - 1)
                    if erreur == nil { try? FileManager.default.removeItem(at: ogg) }
                    else { self.vocauxEnEchec[id] = (ogg, r.duree) }
                    self.finVocal(id, erreur)
                }
            }
        }
    }

    private func reessayerVocal(id: String) {
        guard let v = vocauxEnEchec.removeValue(forKey: id) else { finVocal(id, "le fichier du vocal n'existe plus"); return }
        envoisEnCours += 1
        verifierOccupe()
        envoyerVocalParBeeper(v.url, duree: v.duree) { [weak self] erreur in
            guard let self else { return }
            self.envoisEnCours = max(0, self.envoisEnCours - 1)
            if erreur == nil { try? FileManager.default.removeItem(at: v.url) } else { self.vocauxEnEchec[id] = v }
            self.finVocal(id, erreur)
        }
    }

    private func finVocal(_ id: String, _ erreur: String?) {
        appeler("window.fil && window.fil.envoye(id, ok, raison)", ["id": id, "ok": erreur == nil, "raison": erreur ?? ""])
        verifierOccupe()
    }

    private static func convertirOpus(_ wav: URL, _ ogg: URL) -> Bool {
        guard let ff = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else { return false }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: ff)
        p.arguments = ["-loglevel", "error", "-y", "-i", wav.path, "-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1", ogg.path]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0 && ((try? ogg.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) > 0
    }

    /// Même chemin que beeper-say.sh : dépôt du fichier (/assets/upload), puis message de type « voice-note ».
    private func envoyerVocalParBeeper(_ ogg: URL, duree: Double, essai: Int = 1, fini: @escaping (String?) -> Void) {
        let jeton = (try? String(contentsOfFile: NSHomeDirectory() + "/.config/beeper/token", encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !jeton.isEmpty else { fini("jeton Beeper introuvable (~/.config/beeper/token)"); return }
        guard let donnees = try? Data(contentsOf: ogg) else { fini("fichier du vocal illisible"); return }
        let frontiere = "bt-" + UUID().uuidString
        var corps = Data()
        func champ(_ nom: String, _ valeur: String) {
            corps.append("--\(frontiere)\r\nContent-Disposition: form-data; name=\"\(nom)\"\r\n\r\n\(valeur)\r\n".data(using: .utf8)!)
        }
        corps.append("--\(frontiere)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"vocal.ogg\"\r\nContent-Type: audio/ogg\r\n\r\n".data(using: .utf8)!)
        corps.append(donnees)
        corps.append("\r\n".data(using: .utf8)!)
        champ("fileName", "vocal.ogg")
        champ("mimeType", "audio/ogg")
        corps.append("--\(frontiere)--\r\n".data(using: .utf8)!)
        guard let urlDepot = URL(string: "\(Self.apiBeeper)/assets/upload") else { fini("requête impossible"); return }
        var req = URLRequest(url: urlDepot, timeoutInterval: 30)
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(frontiere)", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer " + jeton, forHTTPHeaderField: "Authorization")
        req.httpBody = corps
        URLSession.shared.dataTask(with: req) { [weak self] data, rep, err in
            DispatchQueue.main.async {
                guard let self else { return }
                if let err = err as? URLError, [.cannotConnectToHost, .cannotFindHost, .networkConnectionLost, .timedOut].contains(err.code) {
                    if essai == 1 {
                        journal("jarvis : Beeper injoignable pour le vocal, lancement caché puis nouvel essai")
                        BeeperDiscret.lancer { pret in
                            if pret { self.envoyerVocalParBeeper(ogg, duree: duree, essai: 2, fini: fini) }
                            else { fini("Beeper Desktop ne démarre pas. Ouvre-le, puis réessaie.") }
                        }
                    } else { fini("Beeper Desktop ne répond pas. Ouvre-le, puis réessaie.") }
                    return
                }
                if let err { fini("erreur réseau : \(err.localizedDescription)"); return }
                let code = (rep as? HTTPURLResponse)?.statusCode ?? 0
                let o = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
                guard (200..<300).contains(code), let idDepot = o["uploadID"] as? String, !idDepot.isEmpty else {
                    journal("jarvis : dépôt du vocal refusé (\(code))")
                    fini(code == 401 || code == 403 ? "Beeper refuse le jeton (code \(code))" : "Beeper refuse le fichier du vocal (code \(code))")
                    return
                }
                var piece: [String: Any] = ["uploadID": idDepot, "type": "voice-note", "fileName": "vocal.ogg", "mimeType": "audio/ogg"]
                piece["duration"] = (o["duration"] as? Double) ?? duree
                self.posterMessageBeeper(["attachment": piece], jeton: jeton) { erreur in
                    if erreur == nil { journal("jarvis : vocal envoyé par Beeper (\(String(format: "%.1f", duree)) s)") }
                    fini(erreur)
                }
            }
        }.resume()
    }

    private func posterMessageBeeper(_ objet: [String: Any], jeton: String, fini: @escaping (String?) -> Void) {
        let permis = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        guard let chat = Self.chatBeeper.addingPercentEncoding(withAllowedCharacters: permis),
              let url = URL(string: "\(Self.apiBeeper)/chats/\(chat)/messages"),
              let corps = try? JSONSerialization.data(withJSONObject: objet) else { fini("requête impossible"); return }
        var req = URLRequest(url: url, timeoutInterval: 30)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer " + jeton, forHTTPHeaderField: "Authorization")
        req.httpBody = corps
        URLSession.shared.dataTask(with: req) { data, rep, err in
            DispatchQueue.main.async {
                if let err { fini("erreur réseau : \(err.localizedDescription)"); return }
                let code = (rep as? HTTPURLResponse)?.statusCode ?? 0
                guard (200..<300).contains(code) else {
                    var detail = ""
                    if let data, let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        detail = (o["message"] as? String) ?? (o["error"] as? String) ?? ""
                    }
                    journal("jarvis : Beeper a répondu \(code) \(extrait(detail, 200))")
                    fini("Beeper a répondu une erreur (code \(code))" + (detail.isEmpty ? "" : " : " + String(detail.prefix(140))))
                    return
                }
                fini(nil)
            }
        }.resume()
    }

    // MARK: - Page

    private func appeler(_ code: String, _ args: [String: Any]) {
        guard pagePrete, let web else { return }
        web.callAsyncJavaScript(code, arguments: args, in: nil, in: .page) { r in
            if case .failure(let e) = r { journal("jarvis : page — \(e.localizedDescription)") }
        }
    }

    func messageDeLaPage(_ m: WKScriptMessage) {
        guard m.frameInfo.isMainFrame, let u = m.frameInfo.request.url, u.isFileURL, let p = pageUrl,
              u.standardizedFileURL.path == p.standardizedFileURL.path,
              let o = m.body as? [String: Any], let type = o["type"] as? String else {
            journal("jarvis : message de page refusé"); return
        }
        switch type {
        case "pret":
            pagePrete = true
            inode = (try? FileManager.default.attributesOfItem(atPath: transcript.path)[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0
            envoyerTout()
            verifierOccupe()
            if FenetrePrincipale.shared.jarvisDevant { appeler("window.fil && window.fil.focus()", [:]) }
        case "envoyer":
            let t = o["texte"] as? String ?? "", id = o["id"] as? String ?? ""
            envoisEnCours += 1
            verifierOccupe()
            envoyerParBeeper(t) { [weak self] erreur in
                guard let self else { return }
                self.envoisEnCours = max(0, self.envoisEnCours - 1)
                self.appeler("window.fil && window.fil.envoye(id, ok, raison)", ["id": id, "ok": erreur == nil, "raison": erreur ?? ""])
                self.verifierOccupe()
            }
        case "vocalDebut":
            demarrerVocal()
        case "vocalAnnuler":
            micro.arreterSansResultat()
            journal("jarvis : vocal annulé")
        case "vocalEnvoyer":
            terminerVocal(id: o["id"] as? String ?? "")
        case "vocalReessayer":
            reessayerVocal(id: o["id"] as? String ?? "")
        case "vocalOublier":
            if let v = vocauxEnEchec.removeValue(forKey: o["id"] as? String ?? "") { try? FileManager.default.removeItem(at: v.url) }
        case "copier":
            if let t = o["texte"] as? String {
                NSPasteboard.general.clearContents(); NSPasteboard.general.setString(t, forType: .string)
            }
        case "lien":
            if let s = o["url"] as? String, let url = URL(string: s), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                NSWorkspace.shared.open(url)
            }
        case "fichier":
            // chemins de photos/fichiers envoyés par Jarvis : montrés dans le Finder, jamais exécutés
            if let s = o["chemin"] as? String, s.hasPrefix("/"), FileManager.default.fileExists(atPath: s) {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: s)])
            }
        default:
            journal("jarvis : type inconnu « \(type.prefix(30)) »")
        }
    }

    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = action.request.url, u.isFileURL, let p = pageUrl, u.standardizedFileURL.path == p.standardizedFileURL.path {
            decisionHandler(.allow); return
        }
        decisionHandler(.cancel)
    }

    func webView(_ w: WKWebView, didStartProvisionalNavigation n: WKNavigation!) { pagePrete = false }
    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { pagePrete = false; w.reload() }

    /// Pilote de développement uniquement (BT_DEV_PILOTE).
    func evaluerDev(_ code: String, _ fini: @escaping (Bool, Any) -> Void) {
        guard PiloteDev.actif, let web else { fini(false, "pilote inactif ou vue absente"); return }
        web.callAsyncJavaScript(code, arguments: [:], in: nil, in: .page) { r in
            switch r {
            case .success(let v): fini(true, JSONSerialization.isValidJSONObject([v]) ? v : String(describing: v))
            case .failure(let e): fini(false, e.localizedDescription)
            }
        }
    }
}
