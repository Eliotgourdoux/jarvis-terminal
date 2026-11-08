import AppKit
import WebKit

/// Lecteur intégré : sert à la page les images, vidéos et sons locaux cités dans un message.
///
/// Les pages sont chargées par `loadFileURL(allowingReadAccessTo: ui/)` : un fichier du Bureau n'y est pas lisible.
/// Le schéma `btmedia://` comble ce manque, de façon étroite :
///   - `btmedia://fichier/<chemin absolu encodé>` ou `btmedia://maison/<chemin sous ~>` ;
///   - seulement des fichiers ordinaires, aux extensions image, vidéo ou audio connues (pas de SVG : il peut contenir du script),
///     vérifiées sur le chemin demandé ET sur le chemin réel (liens symboliques résolus) ;
///   - requêtes Range (206 + Content-Range) : sans elles, WebKit ne lit pas une vidéo ;
///   - lecture par morceaux sur une file à part : une longue vidéo n'est jamais chargée entière en mémoire.
/// Le gestionnaire de messages `medias` reçoit `{type: "ouvrir", chemin}` : il ouvre le fichier dans l'app par défaut
/// (Aperçu, QuickTime…), avec les mêmes vérifications. Rien n'est jamais exécuté.
final class Medias: NSObject, WKURLSchemeHandler {
    static let schema = "btmedia"
    private static let partage = Medias()

    /// À appeler sur chaque WKWebViewConfiguration qui affiche des messages, avant de créer la vue.
    static func installer(dans cfg: WKWebViewConfiguration) {
        cfg.setURLSchemeHandler(partage, forURLScheme: schema)
        cfg.userContentController.add(RelaisOuvrir(), name: "medias")
        // Aucune lecture automatique, même si une page l'oubliait : il faut un clic d'Eliot.
        cfg.mediaTypesRequiringUserActionForPlayback = .all
    }

    static let types: [String: String] = [
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
        "heic": "image/heic",
        "mp4": "video/mp4", "m4v": "video/x-m4v", "mov": "video/quicktime", "webm": "video/webm",
        "mp3": "audio/mpeg", "m4a": "audio/mp4", "aac": "audio/aac", "wav": "audio/wav", "flac": "audio/flac",
        "ogg": "audio/ogg", "oga": "audio/ogg", "opus": "audio/ogg",
    ]

    /// Chemin réel d'un fichier média autorisé, ou nil (extension inconnue, dossier, absent, tube, lien vers autre chose).
    static func cheminAutorise(_ demande: String) -> (chemin: String, type: String, taille: UInt64)? {
        guard demande.hasPrefix("/"), demande.utf8.count <= 4096, !demande.contains("\0") else { return nil }
        let u = URL(fileURLWithPath: demande).standardizedFileURL
        let reel = u.resolvingSymlinksInPath()
        guard let type = types[u.pathExtension.lowercased()], types[reel.pathExtension.lowercased()] != nil,
              let a = try? FileManager.default.attributesOfItem(atPath: reel.path),
              (a[.type] as? FileAttributeType) == .typeRegular,
              let taille = (a[.size] as? NSNumber)?.uint64Value else { return nil }
        return (reel.path, type, taille)
    }

    // MARK: - Schéma btmedia://

    private var actives = Set<ObjectIdentifier>()   // file principale seulement
    private let lecture = DispatchQueue(label: "local.eliot.betterterminal.medias", qos: .userInitiated, attributes: .concurrent)
    private static let morceau = 512 * 1024

    func webView(_ w: WKWebView, start t: WKURLSchemeTask) {
        let id = ObjectIdentifier(t)
        actives.insert(id)
        let requete = t.request
        lecture.async { [weak self] in self?.servir(requete, t, id) }
    }

    func webView(_ w: WKWebView, stop t: WKURLSchemeTask) { actives.remove(ObjectIdentifier(t)) }

    /// Exécute `bloc` sur la file principale si la tâche est encore vivante (WebKit interdit tout appel après `stop`).
    @discardableResult
    private func surTache(_ id: ObjectIdentifier, _ t: WKURLSchemeTask, fin: Bool = false, _ bloc: @escaping (WKURLSchemeTask) -> Void) -> Bool {
        DispatchQueue.main.sync {
            guard actives.contains(id) else { return false }
            bloc(t)
            if fin { actives.remove(id) }
            return true
        }
    }

    private func echouer(_ id: ObjectIdentifier, _ t: WKURLSchemeTask, _ raison: String, code: Int = NSURLErrorFileDoesNotExist) {
        journal("medias : refusé (\(raison))")
        surTache(id, t, fin: true) { $0.didFailWithError(NSError(domain: NSURLErrorDomain, code: code)) }
    }

    private func servir(_ requete: URLRequest, _ t: WKURLSchemeTask, _ id: ObjectIdentifier) {
        guard let url = requete.url, url.scheme?.lowercased() == Self.schema else { echouer(id, t, "url"); return }
        let demande: String
        switch url.host?.lowercased() {
        case "fichier": demande = url.path
        case "maison": demande = NSHomeDirectory() + url.path
        default: echouer(id, t, "hôte"); return
        }
        guard let f = Self.cheminAutorise(demande) else { echouer(id, t, "fichier non autorisé ou absent"); return }

        // Plage demandée (une seule ; « bytes=a-b », « bytes=a- », « bytes=-n »)
        let taille = f.taille
        var debut: UInt64 = 0, fin: UInt64 = taille == 0 ? 0 : taille - 1, partiel = false
        if let r = requete.value(forHTTPHeaderField: "Range"), let plage = Self.plage(r, taille: taille) {
            guard let p = plage.valeur else {
                let rep = HTTPURLResponse(url: url, statusCode: 416, httpVersion: "HTTP/1.1",
                                          headerFields: ["Content-Range": "bytes */\(taille)", "Content-Length": "0"])!
                surTache(id, t, fin: true) { $0.didReceive(rep); $0.didFinish() }
                return
            }
            (debut, fin, partiel) = (p.0, p.1, true)
        }
        let longueur = taille == 0 ? 0 : fin - debut + 1
        var entetes = ["Content-Type": f.type, "Content-Length": String(longueur), "Accept-Ranges": "bytes",
                       "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff"]
        if partiel { entetes["Content-Range"] = "bytes \(debut)-\(fin)/\(taille)" }
        let rep = HTTPURLResponse(url: url, statusCode: partiel ? 206 : 200, httpVersion: "HTTP/1.1", headerFields: entetes)!

        guard let h = FileHandle(forReadingAtPath: f.chemin) else { echouer(id, t, "lecture impossible"); return }
        defer { try? h.close() }
        guard surTache(id, t, { $0.didReceive(rep) }) else { return }
        if requete.httpMethod?.uppercased() == "HEAD" || longueur == 0 { surTache(id, t, fin: true) { $0.didFinish() }; return }
        do {
            try h.seek(toOffset: debut)
            var reste = longueur
            while reste > 0 {
                let n = Int(min(UInt64(Self.morceau), reste))
                guard let d = try h.read(upToCount: n), !d.isEmpty else { break }
                reste -= UInt64(d.count)
                guard surTache(id, t, { $0.didReceive(d) }) else { return }   // la page n'en veut plus (vidéo en pause, vue fermée)
            }
            surTache(id, t, fin: true) { $0.didFinish() }
        } catch {
            echouer(id, t, "erreur de lecture", code: NSURLErrorCannotOpenFile)
        }
    }

    /// nil : en-tête illisible (on sert tout le fichier) ; `.valeur == nil` : plage hors du fichier (416).
    private struct Plage { let valeur: (UInt64, UInt64)? }
    private static func plage(_ entete: String, taille: UInt64) -> Plage? {
        let e = entete.trimmingCharacters(in: .whitespaces).lowercased()
        guard e.hasPrefix("bytes=") else { return nil }
        let premiere = e.dropFirst(6).split(separator: ",").first.map(String.init) ?? ""
        let morceaux = premiere.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        guard morceaux.count == 2 else { return nil }
        if morceaux[0].isEmpty {                       // les n derniers octets
            guard let n = UInt64(morceaux[1]), n > 0 else { return nil }
            return taille == 0 ? Plage(valeur: nil) : Plage(valeur: (taille - min(n, taille), taille - 1))
        }
        guard let a = UInt64(morceaux[0]) else { return nil }
        guard a < taille else { return Plage(valeur: nil) }
        var b = taille - 1
        if !morceaux[1].isEmpty { guard let x = UInt64(morceaux[1]), x >= a else { return nil }; b = min(x, taille - 1) }
        return Plage(valeur: (a, b))
    }
}

/// « Ouvrir » d'un média que WebKit ne sait pas lire (ogg, opus…) : app par défaut, mêmes règles que le schéma.
private final class RelaisOuvrir: NSObject, WKScriptMessageHandler {
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard m.frameInfo.isMainFrame, m.frameInfo.request.url?.isFileURL == true,
              let o = m.body as? [String: Any], o["type"] as? String == "ouvrir",
              var chemin = o["chemin"] as? String else { journal("medias : message refusé"); return }
        if chemin.hasPrefix("~/") { chemin = NSHomeDirectory() + chemin.dropFirst(1) }
        guard let f = Medias.cheminAutorise(chemin) else { journal("medias : ouverture refusée"); return }
        NSWorkspace.shared.open(URL(fileURLWithPath: f.chemin))
    }
}
