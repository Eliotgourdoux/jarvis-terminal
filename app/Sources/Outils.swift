import Foundation
import Security

// Utilitaires partagés : chemins, journal, échappement shell, écriture atomique, lancement de
// petits outils, environnement du shell de connexion, binaire claude, registre des projets, transcripts.

let HOME = FileManager.default.homeDirectoryForCurrentUser.path
/// Lu dans le bundle : une copie de test (autre identifiant) tourne à côté de l'app d'Eliot sans lui passer la main.
let BUNDLE_ID = Bundle.main.bundleIdentifier ?? "local.eliot.betterterminal"
let DOSSIER_BT = HOME + "/.config/better-terminal"
let DOSSIER_SESSIONS = DOSSIER_BT + "/sessions"
let DOSSIER_QUESTIONS = DOSSIER_BT + "/questions"
let FICHIER_JETON = DOSSIER_BT + "/jeton"
let TG_QUESTION = HOME + "/Desktop/Projets/Jarvis-Ultron-Telegram/tg-question.sh"

// MARK: - Journal (~/Library/Logs/Better Terminal/app.log)

private let fileJournal = DispatchQueue(label: "bt.journal")
private let cheminJournal = HOME + "/Library/Logs/Better Terminal/app.log"
private let formatHeure: DateFormatter = {
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"; return f
}()

func journal(_ s: String) {
    let ligne = formatHeure.string(from: Date()) + " " + s + "\n"
    fileJournal.async {
        let fm = FileManager.default
        try? fm.createDirectory(atPath: (cheminJournal as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        if let attr = try? fm.attributesOfItem(atPath: cheminJournal), let t = attr[.size] as? Int, t > 5_000_000 {
            try? fm.removeItem(atPath: cheminJournal)
        }
        if !fm.fileExists(atPath: cheminJournal) { fm.createFile(atPath: cheminJournal, contents: nil) }
        if let h = FileHandle(forWritingAtPath: cheminJournal) {
            h.seekToEndOfFile(); h.write(Data(ligne.utf8)); try? h.close()
        }
    }
}

/// Extrait court et sur une ligne, pour le journal.
func extrait(_ s: String, _ n: Int = 120) -> String {
    let u = s.replacingOccurrences(of: "\n", with: "⏎")
    return u.count <= n ? u : String(u.prefix(n)) + "…"
}

// MARK: - Shell, chemins, fichiers

/// Échappement shell POSIX : entre apostrophes, chaque ' devient '\''.
func shq(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

/// Chemin canonique (liens résolus, /tmp → /private/tmp), comme process.cwd() côté claude.
func cheminReel(_ p: String) -> String {
    guard let r = realpath(p, nil) else { return (p as NSString).standardizingPath }
    defer { free(r) }
    return String(cString: r)
}

func creerDossier(_ p: String) {
    try? FileManager.default.createDirectory(atPath: p, withIntermediateDirectories: true,
                                             attributes: [.posixPermissions: 0o700])
}

/// Écriture atomique (fichier temporaire + rename).
@discardableResult
func ecrireAtomique(_ data: Data, _ chemin: String) -> Bool {
    creerDossier((chemin as NSString).deletingLastPathComponent)
    do { try data.write(to: URL(fileURLWithPath: chemin), options: .atomic); return true }
    catch { journal("écriture \(chemin) : \(error.localizedDescription)"); return false }
}

/// Création exclusive et atomique : échoue si le fichier existe déjà (« la première réponse l'emporte »).
func creerExclusif(_ data: Data, _ chemin: String) -> Bool {
    let tmp = chemin + ".tmp-\(getpid())-\(UInt32.random(in: 0...UInt32.max))"
    guard FileManager.default.createFile(atPath: tmp, contents: data) else { return false }
    defer { unlink(tmp) }
    return link(tmp, chemin) == 0
}

func json(_ o: Any) -> Data? {
    try? JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
}

let iso8601: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f
}()

// MARK: - Petits outils externes (jamais de shell avec une chaîne venue de la page)

/// Lance un exécutable avec des arguments séparés, attend la fin (délai max), renvoie (code, stdout).
@discardableResult
func executer(_ exe: String, _ args: [String], env: [String: String]? = nil, delai: TimeInterval = 10) -> (Int32, String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    if let e = env { p.environment = e }
    p.standardInput = FileHandle.nullDevice
    let sortie = Pipe(); p.standardOutput = sortie
    p.standardError = FileHandle.nullDevice
    var donnees = Data()
    let lu = DispatchGroup(); lu.enter()
    DispatchQueue.global().async { donnees = sortie.fileHandleForReading.readDataToEndOfFile(); lu.leave() }
    do { try p.run() } catch { journal("lancement \(exe) impossible : \(error.localizedDescription)"); return (-1, "") }
    let garde = DispatchWorkItem { if p.isRunning { p.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + delai, execute: garde)
    p.waitUntilExit()
    garde.cancel()
    _ = lu.wait(timeout: .now() + 2)
    return (p.terminationStatus, String(decoding: donnees, as: UTF8.self))
}

// MARK: - Environnement du shell de connexion

/// Une app graphique n'a pas le PATH d'Eliot (défini dans ~/.zshrc) : on le demande une fois à un zsh
/// de connexion interactif, puis on retire les variables d'une éventuelle session Claude parente.
enum Environnement {
    private static var cache: [String: String]?
    private static var enAttente: [([String: String]) -> Void] = []
    private static var enCours = false

    /// Variables à ne jamais transmettre (sinon le fils se croit sous-processus d'une autre session).
    static func aRetirer(_ k: String) -> Bool {
        if k == "CLAUDE_CONFIG_DIR" { return false }
        return k.hasPrefix("CLAUDE") || k == "AI_AGENT" || k == "TG_BOT_NAME" || k == "BT_TEST" || k == "BT_APP"
            || k == "PWD" || k == "OLDPWD" || k == "SHLVL" || k == "_" || k.hasPrefix("__CF")
    }

    static func propre(_ e: [String: String]) -> [String: String] { e.filter { !aRetirer($0.key) } }

    /// Appelé sur le fil principal ; le rappel aussi.
    static func charger(_ fini: @escaping ([String: String]) -> Void) {
        if let c = cache { fini(c); return }
        enAttente.append(fini)
        if enCours { return }
        enCours = true
        DispatchQueue.global(qos: .userInitiated).async {
            let e = lire()
            DispatchQueue.main.async {
                cache = e; enCours = false
                let a = enAttente; enAttente = []
                a.forEach { $0(e) }
            }
        }
    }

    private static func lire() -> [String: String] {
        let base = propre(ProcessInfo.processInfo.environment)
        let marque = "__BT_ENV__"
        for opts in ["-lic", "-lc"] {
            let (code, out) = executer("/bin/zsh", [opts, "printf '\(marque)\\0'; /usr/bin/env -0"], env: base, delai: 8)
            guard code == 0, let r = out.range(of: marque + "\0") else {
                journal("environnement : zsh \(opts) code \(code), essai suivant"); continue
            }
            var e: [String: String] = [:]
            for morceau in out[r.upperBound...].split(separator: "\0") {
                guard let eg = morceau.firstIndex(of: "=") else { continue }
                e[String(morceau[..<eg])] = String(morceau[morceau.index(after: eg)...])
            }
            if (e["PATH"] ?? "").isEmpty { continue }
            journal("environnement : zsh \(opts), \(e.count) variables, PATH=\(extrait(e["PATH"] ?? "", 200))")
            return propre(e)
        }
        var e = base
        e["PATH"] = [HOME + "/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":")
        journal("environnement : repli sur l'environnement de l'app + PATH standard")
        return e
    }

    /// Cherche un exécutable dans le PATH donné, puis dans des emplacements connus.
    static func trouver(_ nom: String, _ env: [String: String], connus: [String] = []) -> String? {
        let fm = FileManager.default
        for d in (env["PATH"] ?? "").split(separator: ":") {
            let p = String(d) + "/" + nom
            if fm.isExecutableFile(atPath: p) { return p }
        }
        return connus.first { fm.isExecutableFile(atPath: $0) }
    }

    /// terminal-notifier à l'icône marbre de l'app (~/.claude/bin/notifier → ~/Applications/Jarvis Notifier.app, 16/11/2026).
    static func notifier(_ env: [String: String]) -> String? {
        let p = (env["HOME"] ?? NSHomeDirectory()) + "/.claude/bin/notifier"
        return FileManager.default.isExecutableFile(atPath: p) ? p : nil
    }
}

/// Le vrai binaire claude (dans le shell, `claude` est un alias) : ~/.local/bin/claude, sinon `whence -p claude`.
enum BinaireClaude {
    private static var cache: String?
    static func chemin(_ env: [String: String]) -> String? {
        if let c = cache { return c }
        let local = HOME + "/.local/bin/claude"
        if FileManager.default.isExecutableFile(atPath: local) { cache = local; return local }
        let (code, out) = executer("/bin/zsh", ["-lc", "whence -p claude"], env: env, delai: 8)
        let p = out.split(separator: "\n").last.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        if code == 0, p.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: p) { cache = p; return p }
        return nil
    }
}

// MARK: - Registre des projets (~/.config/projets/registry.json)

/// `parent` : pour un sous-projet (champ `parent` du registre), l'identifiant et le nom du projet qui le contient.
struct InfoProjet { let nom: String; let emoji: String; var id: String? = nil; var chemin: String? = nil; var parentId: String? = nil; var parentNom: String? = nil }

enum RegistreProjets {
    /// Tests seulement : `BT_DEV_REGISTRE` (pilote actif) remplace le registre, pour donner des noms de
    /// projet distincts à des sessions de bac-a-sable/ (routage vocal par nom).
    static var chemin: String { PiloteDev.registre ?? HOME + "/.config/projets/registry.json" }

    static func info(cwd: String) -> InfoProjet {
        let defaut = InfoProjet(nom: (cwd as NSString).lastPathComponent, emoji: "📁")
        if cwd == cheminReel(Entrees.dossierDiscussions) { return InfoProjet(nom: "Discussion", emoji: "") }   // pas d'emoji (Eliot, 17/11/2026)
        guard let d = FileManager.default.contents(atPath: chemin),
              let liste = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]] else { return defaut }
        typealias P = (chemin: String, nom: String, emoji: String, id: String?, parent: String?)
        let projets: [P] = liste.compactMap {
            guard let c = $0["chemin"] as? String, !c.isEmpty else { return nil }
            return (cheminReel((c as NSString).expandingTildeInPath), $0["nom"] as? String ?? "", $0["emoji"] as? String ?? "", $0["id"] as? String, $0["parent"] as? String)
        }
        func vers(_ p: P) -> InfoProjet {
            let pere = p.parent.flatMap { id in projets.first { $0.id == id } }
            return InfoProjet(nom: p.nom.isEmpty ? defaut.nom : p.nom, emoji: p.emoji.isEmpty ? defaut.emoji : p.emoji, id: p.id,
                              chemin: p.chemin, parentId: pere?.id, parentNom: pere.map { $0.nom })
        }
        if let p = projets.first(where: { $0.chemin == cwd }) { return vers(p) }
        // Sous-dossier d'un projet. Les dossiers « parents » d'autres projets (home, ~/Desktop/Projets)
        // ne captent que leur propre chemin, comme dans Cockpit.
        // Un projet dont tous les projets imbriqués sont des sous-projets déclarés (champ `parent`) n'est pas un
        // simple dossier parent : il garde ses autres sous-dossiers (18/11/2026).
        let parents = Set(projets.map(\.chemin).filter { c in projets.contains { $0.chemin.hasPrefix(c + "/") && $0.parent == nil } })
        if let p = projets.filter({ !parents.contains($0.chemin) && cwd.hasPrefix($0.chemin + "/") })
            .max(by: { $0.chemin.count < $1.chemin.count }) { return vers(p) }
        return defaut
    }

    /// Dossier du sous-projet `nom` du projet `parent`, une fois créé par `todo nouveau --parent`.
    static func cheminSousProjet(nom: String, parent: String) -> String? {
        guard let d = FileManager.default.contents(atPath: chemin),
              let liste = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]] else { return nil }
        let c = liste.first { ($0["parent"] as? String) == parent && ($0["nom"] as? String) == nom }?["chemin"] as? String
        return (c?.isEmpty ?? true) ? nil : c
    }
}

// MARK: - Transcripts (~/.claude/projects/<dossier>/<sessionId>.jsonl)

enum Transcript {
    /// Règle de nommage de claude : chaque unité UTF-16 non alphanumérique ASCII du cwd réel devient « - »
    /// (équivalent de `cwd.replace(/[^a-zA-Z0-9]/g, "-")`). Repli : recherche dans tous les dossiers.
    static func dossierProjet(_ cwd: String) -> String {
        String(decoding: cwd.utf16.map { u -> UInt16 in
            (u >= 48 && u <= 57) || (u >= 65 && u <= 90) || (u >= 97 && u <= 122) ? u : 45
        }, as: UTF16.self)
    }

    static func chemin(cwd: String, sessionId: String) -> String? {
        let racine = HOME + "/.claude/projects/"
        let direct = racine + dossierProjet(cwd) + "/" + sessionId + ".jsonl"
        let fm = FileManager.default
        if fm.fileExists(atPath: direct) { return direct }
        for d in (try? fm.contentsOfDirectory(atPath: racine)) ?? [] {
            let p = racine + d + "/" + sessionId + ".jsonl"
            if fm.fileExists(atPath: p) { return p }
        }
        return nil
    }

    static func lignes(cwd: String, sessionId: String) -> [String] {
        guard let p = chemin(cwd: cwd, sessionId: sessionId), let d = FileManager.default.contents(atPath: p) else { return [] }
        return String(decoding: d, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    }
}

// MARK: - Jeton local (protège le schéma d'URL)

/// Un lien betterterminal:// peut venir de n'importe quelle page web. Les appelants locaux (Cockpit, la
/// ligne de commande) lisent ce jeton (fichier 0600) et l'ajoutent à l'URL : ils ne sont pas interrogés.
enum Jeton {
    static let valeur: String = {
        if let s = try? String(contentsOfFile: FICHIER_JETON, encoding: .utf8) {
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.count >= 32 { return t }
        }
        var octets = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, octets.count, &octets)
        let t = octets.map { String(format: "%02x", $0) }.joined()
        creerDossier(DOSSIER_BT)
        FileManager.default.createFile(atPath: FICHIER_JETON, contents: Data((t + "\n").utf8), attributes: [.posixPermissions: 0o600])
        return t
    }()

    static func valide(_ t: String?) -> Bool {
        guard let t = t, t.count == valeur.count else { return false }
        // comparaison à temps constant
        return zip(t.utf8, valeur.utf8).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
}
