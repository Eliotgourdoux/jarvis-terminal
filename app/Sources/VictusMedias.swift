import Foundation

/// Médias cités par une session du Victus (`/home/eliotgrx/…`) : le même schéma `btmedia://` que le Mac
/// (Medias.swift), mais le fichier est d'abord copié par `ssh victus cat -- <chemin>` dans
/// ~/Library/Caches/JarvisTerminal/victus/, puis servi depuis cette copie (requêtes Range comprises).
/// Mêmes règles que le Mac, appliquées au home du Victus : chemin absolu sous le home, extension image / vidéo / audio
/// connue sur le chemin demandé ET sur le chemin réel (readlink -f), fichier ordinaire seulement.
enum VictusMedias {
    static let gestionnaire = Medias(maison: { VictusLien.shared.home }, resoudre: resoudre)

    /// Au-delà, on ne copie pas (une vidéo de plusieurs Go ne passe pas par ssh pour un aperçu).
    static let tailleMax: UInt64 = 1_500_000_000
    static let cacheMax: UInt64 = 2_000_000_000

    static var dossierCache: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("JarvisTerminal/victus", isDirectory: true)
    }

    private struct Meta { let reel: String; let taille: UInt64; let date: Int; let vu: Date }
    private static var metas: [String: Meta] = [:]
    private static var verrous: [String: NSLock] = [:]
    private static let verrou = NSLock()

    /// Chemin normalisé (sans `.`, `..` ni `//`), sous le home du Victus, avec une extension média connue. Sinon nil.
    static func cheminValide(_ demande: String, home: String) -> String? {
        guard demande.hasPrefix("/"), demande.utf8.count <= 4096, !demande.contains("\0"), !demande.contains("\n") else { return nil }
        let morceaux = demande.split(separator: "/", omittingEmptySubsequences: true)
        guard !morceaux.contains(where: { $0 == "." || $0 == ".." }) else { return nil }
        let p = "/" + morceaux.joined(separator: "/")
        guard p.hasPrefix(home + "/"), Medias.types[(p as NSString).pathExtension.lowercased()] != nil else { return nil }
        return p
    }

    /// Résolveur pour Medias : appelé hors du fil principal (file de lecture des médias). Bloque le temps de la copie.
    static func resoudre(_ demande: String) -> Medias.Fichier? {
        let home = VictusLien.shared.home
        guard let p = cheminValide(demande, home: home) else { return nil }
        guard let m = meta(p, home: home) else { return nil }
        guard m.taille <= tailleMax else { journal("victus médias : \(m.taille) o, trop gros pour être copié"); return nil }
        let ext = (m.reel as NSString).pathExtension.lowercased()
        guard let type = Medias.types[ext] else { return nil }
        var h: UInt64 = 1469598103934665603
        for o in "\(m.reel)|\(m.taille)|\(m.date)".utf8 { h = (h ^ UInt64(o)) &* 1099511628211 }
        let fm = FileManager.default
        let dossier = dossierCache
        let cible = dossier.appendingPathComponent(String(h, radix: 16) + "." + ext)

        let v = verrouPour(cible.path)
        v.lock(); defer { v.unlock() }   // plusieurs requêtes Range de la même vidéo : une seule copie
        if let n = taille(cible.path), n == m.taille {
            try? fm.setAttributes([.modificationDate: Date()], ofItemAtPath: cible.path)   // récent : gardé par l'élagage
            return (cible.path, type, n)
        }
        try? fm.createDirectory(at: dossier, withIntermediateDirectories: true)
        let tmp = dossier.appendingPathComponent(".tmp-" + UUID().uuidString)
        guard fm.createFile(atPath: tmp.path, contents: nil), let sortie = FileHandle(forWritingAtPath: tmp.path) else { return nil }
        let debut = Date()
        let r = VictusSsh.executer("cat -- \(shq(m.reel))", sortie: sortie, delai: 600)
        try? sortie.close()
        guard r.code == 0, taille(tmp.path) == m.taille, (try? fm.moveItem(at: tmp, to: cible)) != nil else {
            try? fm.removeItem(at: tmp)
            journal("victus médias : copie en échec (code \(r.code)) — \((m.reel as NSString).lastPathComponent)")
            return nil
        }
        journal(String(format: "victus médias : %@ copié en %.2f s (%llu o)", (m.reel as NSString).lastPathComponent, Date().timeIntervalSince(debut), m.taille))
        DispatchQueue.global(qos: .utility).async { elaguer() }
        return (cible.path, type, m.taille)
    }

    /// Chemin réel, taille et date du fichier sur le Victus (un seul aller-retour ssh), gardés 30 s.
    private static func meta(_ p: String, home: String) -> Meta? {
        verrou.lock()
        if let m = metas[p], Date().timeIntervalSince(m.vu) < 30 { verrou.unlock(); return m }
        verrou.unlock()
        let cmd = "f=\(shq(p)); r=$(readlink -f -- \"$f\") && [ -f \"$r\" ] && printf '%s\\n' \"$r\" && stat -c '%s %Y' -- \"$r\""
        let res = VictusSsh.executer(cmd, delai: 15)
        let lignes = res.texte.split(separator: "\n").map(String.init)
        guard res.code == 0, lignes.count >= 2 else { journal("victus médias : introuvable — \((p as NSString).lastPathComponent)"); return nil }
        let reel = lignes[0]
        let nombres = lignes[1].split(separator: " ")
        // le chemin réel doit lui aussi rester sous le home, avec une extension média (lien symbolique vers ailleurs : refusé)
        guard nombres.count == 2, let t = UInt64(nombres[0]), let d = Int(nombres[1]),
              cheminValide(reel, home: home) == reel else { journal("victus médias : chemin réel refusé"); return nil }
        let m = Meta(reel: reel, taille: t, date: d, vu: Date())
        verrou.lock(); metas[p] = m; verrou.unlock()
        return m
    }

    private static func verrouPour(_ cle: String) -> NSLock {
        verrou.lock(); defer { verrou.unlock() }
        if let v = verrous[cle] { return v }
        let v = NSLock(); verrous[cle] = v
        return v
    }

    private static func taille(_ chemin: String) -> UInt64? {
        ((try? FileManager.default.attributesOfItem(atPath: chemin))?[.size] as? NSNumber)?.uint64Value
    }

    /// Cache plafonné à 2 Go : on retire les copies les moins récemment servies, une par une, par leur nom exact.
    private static func elaguer() {
        let fm = FileManager.default
        guard let urls = try? fm.contentsOfDirectory(at: dossierCache, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey]) else { return }
        var fichiers = urls.compactMap { u -> (URL, UInt64, Date)? in
            guard !u.lastPathComponent.hasPrefix("."), let v = try? u.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]) else { return nil }
            return (u, UInt64(v.fileSize ?? 0), v.contentModificationDate ?? .distantPast)
        }
        var total = fichiers.reduce(0) { $0 + $1.1 }
        guard total > cacheMax else { return }
        fichiers.sort { $0.2 < $1.2 }
        for (u, n, _) in fichiers where total > cacheMax {
            if (try? fm.removeItem(at: u)) != nil { total -= n }
        }
    }
}
