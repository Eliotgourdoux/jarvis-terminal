import Foundation

// Lien avec le Victus (« Ultron Terminal », victus/CONTRAT-VICTUS.md, 12/11/2026).
// Un seul processus `ssh -T victus ~/.local/bin/ultron-terminal relais`, partagé par toutes les sessions du Victus
// affichées dans l'app. Protocole : une ligne JSON par message (section « Protocole du démon »).
// Ce fichier ne dépend que de Foundation et d'Outils.swift : il se teste hors de l'app (petit binaire en ligne de commande).

/// Une page de session du Victus attachée à un canal du lien.
protocol VictusCanal: AnyObject {
    /// `ev page` : appels `bt.<fonction>(argument)` à exécuter dans l'ordre.
    func lienAppels(_ appels: [[Any]])
    /// La connexion est tombée : le canal n'existe plus.
    func lienCoupe()
    /// La connexion est revenue : il faut se rattacher.
    func lienRetabli()
    /// `ev recharger` : la session a repris ici après un terminal, la page repart de zéro.
    func lienRecharger()
}

private final class Faible { weak var c: VictusCanal?; init(_ c: VictusCanal) { self.c = c } }

/// Appels ssh ponctuels vers le Victus (médias, pièces jointes, terminal) : même hôte que le lien.
/// Connexion partagée (ControlMaster) : un média ou une pièce jointe ne repaie pas la poignée de main ssh.
enum VictusSsh {
    /// Hôte ssh : `BT_VICTUS_HOTE`, réglage `BTVictusHote`, sinon « victus ».
    static var hote: String {
        if let h = ProcessInfo.processInfo.environment["BT_VICTUS_HOTE"], !h.isEmpty { return h }
        if let h = UserDefaults.standard.string(forKey: "BTVictusHote"), !h.isEmpty { return h }
        return "victus"
    }

    static let options = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15",
                          "-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/btv-\(getuid())-%C", "-o", "ControlPersist=120"]

    /// `ssh -T <hôte> <commande>` : la commande est interprétée par le shell du Victus, chaque morceau variable passe par shq.
    /// Lancé hors du fil principal. stdout va dans `sortie` (ou est rendu), stdin vient de `entree`.
    @discardableResult
    static func executer(_ commande: String, entree: FileHandle? = nil, sortie: FileHandle? = nil, delai: TimeInterval = 20) -> (code: Int32, texte: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        p.arguments = ["-T"] + options + [hote, commande]
        p.standardInput = entree ?? FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        var donnees = Data()
        let lu = DispatchGroup()
        if let sortie { p.standardOutput = sortie } else {
            let tuyau = Pipe(); p.standardOutput = tuyau
            lu.enter()
            DispatchQueue.global().async { donnees = tuyau.fileHandleForReading.readDataToEndOfFile(); lu.leave() }
        }
        do { try p.run() } catch { journal("victus : ssh impossible — \(error.localizedDescription)"); return (-1, "") }
        let garde = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + delai, execute: garde)
        p.waitUntilExit()
        garde.cancel()
        _ = lu.wait(timeout: .now() + 2)
        return (p.terminationStatus, String(decoding: donnees, as: UTF8.self))
    }

    /// Vrai si `ssh victus` est configuré (Host victus dans ~/.ssh/config) ou si la commande du relais est surchargée.
    static var configure: Bool {
        if VictusLien.commandeSurchargee != nil { return true }
        guard let c = try? String(contentsOfFile: HOME + "/.ssh/config", encoding: .utf8) else { return false }
        let h = hote.lowercased()
        for ligne in c.split(whereSeparator: \.isNewline) {
            let mots = ligne.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "=" }).map { $0.lowercased() }
            if mots.first == "host", mots.dropFirst().contains(h) { return true }
        }
        return false
    }
}

/// Le lien lui-même. Tout son état vit sur le fil principal ; la lecture et l'écriture du tuyau se font à côté.
final class VictusLien {
    static let shared = VictusLien()
    /// État ou liste des sessions changés (userInfo vide) : la barre se redessine.
    static let changement = Notification.Name("bt.victus.changement")

    enum Etat: String { case inactif, connexion, connecte, injoignable }
    private(set) var etat: Etat = .inactif
    /// Dernière liste reçue (`ev liste`), gardée quand le Victus devient injoignable (sessions grisées).
    private(set) var sessions: [[String: Any]] = []
    /// Home du Victus (reçu dans `bonjour`). Lisible de n'importe quelle file (médias servis à côté).
    var home: String { verrouHome.lock(); defer { verrouHome.unlock() }; return _home }
    private var _home = "/home/eliotgrx"
    private let verrouHome = NSLock()
    private(set) var derniereErreur: String?

    /// Commande du relais surchargée (tests) : `BT_VICTUS_RELAIS` ou réglage `BTVictusRelais`, lancée par /bin/sh -c.
    static var commandeSurchargee: String? {
        if let c = ProcessInfo.processInfo.environment["BT_VICTUS_RELAIS"], !c.isEmpty { return c }
        if let c = UserDefaults.standard.string(forKey: "BTVictusRelais"), !c.isEmpty { return c }
        return nil
    }

    private var processus: Process?
    private var entree: FileHandle?
    private let ecriture = DispatchQueue(label: "bt.victus.ecriture")
    private let lecture = DispatchQueue(label: "bt.victus.lecture")
    private var tampon = Data()          // file `lecture` seulement
    private var generation = 0
    private var delai: TimeInterval = 2
    private var reconnexion: DispatchWorkItem?
    private var garde: DispatchWorkItem?
    private var minuteur: Timer?
    private var dernierSigne = Date()
    private var canaux: [String: Faible] = [:]
    private var requetes: [String: (rappel: ([String: Any]) -> Void, garde: DispatchWorkItem)] = [:]
    private var compteur = 0
    private var demarre = false

    private init() {}

    var connecte: Bool { etat == .connecte }

    func session(_ id: String) -> [String: Any]? {
        let i = id.lowercased()
        return sessions.first { ($0["id"] as? String)?.lowercased() == i }
    }

    // MARK: - Connexion

    /// Au lancement de l'app : rien si `ssh victus` n'est pas configuré.
    func demarrer() {
        guard !demarre else { return }
        guard VictusSsh.configure else { journal("victus : ssh victus non configuré, lien désactivé"); return }
        demarre = true
        connecter()
        let t = Timer(timeInterval: 15, repeats: true) { [weak self] _ in self?.veiller() }
        RunLoop.main.add(t, forMode: .common)
        minuteur = t
    }

    /// Réveil du Mac, réseau revenu : on retente tout de suite, sans attendre le délai croissant.
    func reveil() {
        guard demarre, etat != .connecte, etat != .connexion else { return }
        delai = 2
        reconnexion?.cancel(); reconnexion = nil
        connecter()
    }

    private func connecter() {
        reconnexion = nil
        generation += 1
        let gen = generation
        changerEtat(.connexion)
        let p = Process()
        if let c = Self.commandeSurchargee {
            p.executableURL = URL(fileURLWithPath: "/bin/sh")
            p.arguments = ["-c", c]
        } else {
            p.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
            p.arguments = ["-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
                           "-o", "ConnectTimeout=10", VictusSsh.hote, "~/.local/bin/ultron-terminal relais"]
        }
        let vers = Pipe(), depuis = Pipe()
        p.standardInput = vers
        p.standardOutput = depuis
        p.standardError = FileHandle.nullDevice
        lecture.async { self.tampon = Data() }
        depuis.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            guard let self else { return }
            if d.isEmpty { h.readabilityHandler = nil; return }
            self.lecture.async { self.recu(d, gen: gen) }
        }
        p.terminationHandler = { [weak self] pr in
            let code = pr.terminationStatus
            DispatchQueue.main.async { self?.coupe(gen: gen, raison: "relais terminé (code \(code))") }
        }
        do { try p.run() } catch {
            journal("victus : lancement du relais impossible — \(error.localizedDescription)")
            coupe(gen: gen, raison: "lancement impossible"); return
        }
        processus = p
        entree = vers.fileHandleForWriting
        dernierSigne = Date()
        journal("victus : connexion (\(Self.commandeSurchargee ?? "ssh " + VictusSsh.hote))")
        ecrire(["op": "bonjour", "client": "mac", "version": 1])
        // pas de bonjour en 25 s (ssh bloqué, relais muet) : on coupe et on retentera
        let g = DispatchWorkItem { [weak self] in
            guard let self, gen == self.generation, self.etat == .connexion else { return }
            self.arreterProcessus(raison: "pas de réponse au bonjour")
        }
        garde = g
        DispatchQueue.main.asyncAfter(deadline: .now() + 25, execute: g)
    }

    /// Toutes les 15 s : ping ; plus aucun signe depuis 50 s → on coupe (la reconnexion suit).
    private func veiller() {
        guard etat == .connecte else { return }
        if Date().timeIntervalSince(dernierSigne) > 50 { arreterProcessus(raison: "plus de signe depuis 50 s"); return }
        ecrire(["op": "ping"])
    }

    private func arreterProcessus(raison: String) {
        journal("victus : coupure — \(raison)")
        derniereErreur = raison
        if let p = processus, p.isRunning { p.terminate() }
        coupe(gen: generation, raison: raison)
    }

    private func coupe(gen: Int, raison: String) {
        guard gen == generation else { return }
        generation += 1   // les rappels de l'ancien processus sont ignorés
        garde?.cancel(); garde = nil
        if let p = processus, p.isRunning { p.terminate() }
        processus = nil
        let e = entree; entree = nil
        ecriture.async { try? e?.close() }
        let etaitConnecte = etat == .connecte
        if derniereErreur == nil || etaitConnecte { derniereErreur = raison }
        journal("victus : injoignable (\(raison)), nouvel essai dans \(Int(delai)) s")
        let anciens = canaux.values.compactMap(\.c)
        canaux.removeAll()
        let attentes = requetes; requetes.removeAll()
        attentes.values.forEach { $0.garde.cancel(); $0.rappel(["ev": "erreur", "message": "Victus injoignable"]) }
        changerEtat(.injoignable)
        anciens.forEach { $0.lienCoupe() }
        let r = DispatchWorkItem { [weak self] in self?.connecter() }
        reconnexion = r
        DispatchQueue.main.asyncAfter(deadline: .now() + delai, execute: r)
        delai = min(60, delai * 2)
    }

    private func changerEtat(_ e: Etat) {
        guard e != etat else { return }
        etat = e
        NotificationCenter.default.post(name: Self.changement, object: self)
    }

    // MARK: - Lecture (file `lecture`)

    private func recu(_ d: Data, gen: Int) {
        tampon.append(d)
        if tampon.count > 64_000_000 {   // une ligne de plus de 20 Mo n'est pas dans le contrat : on coupe
            tampon = Data()
            DispatchQueue.main.async { [weak self] in
                guard let self, gen == self.generation else { return }
                self.arreterProcessus(raison: "ligne trop longue")
            }
            return
        }
        var debut = tampon.startIndex
        var lignes: [Data] = []
        while let fin = tampon[debut...].firstIndex(of: 0x0A) {
            if fin > debut { lignes.append(tampon[debut..<fin]) }
            debut = tampon.index(after: fin)
        }
        if debut > tampon.startIndex { tampon = Data(tampon[debut...]) }
        guard !lignes.isEmpty else { return }
        let objets = lignes.compactMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
        DispatchQueue.main.async { [weak self] in
            guard let self, gen == self.generation else { return }
            self.dernierSigne = Date()
            objets.forEach(self.traiter)
        }
    }

    private func traiter(_ o: [String: Any]) {
        guard let ev = o["ev"] as? String else { return }
        switch ev {
        case "bonjour":
            garde?.cancel(); garde = nil
            if let h = o["home"] as? String, h.hasPrefix("/"), h.count > 1, !h.contains("\0") {
                verrouHome.lock(); _home = h; verrouHome.unlock()
            }
            delai = 2
            derniereErreur = nil
            journal("victus : connecté (machine \(o["machine"] as? String ?? "?"), version \(o["version"] ?? "?"), home \(home))")
            ecrire(["op": "abonner"])
            changerEtat(.connecte)
            // Fenêtres déjà ouvertes : elles se rattachent (la reconnexion repart de leur page).
            Array(enAttenteDeLien).forEach { $0.c?.lienRetabli() }
            enAttenteDeLien.removeAll()
        case "liste":
            sessions = (o["sessions"] as? [[String: Any]] ?? []).filter { s in
                guard let id = s["id"] as? String else { return false }
                return VictusLien.idValide(id)
            }
            NotificationCenter.default.post(name: Self.changement, object: self)
        case "page":
            guard let c = o["canal"] as? String, let appels = o["appels"] as? [[Any]] else { return }
            canaux[c]?.c?.lienAppels(appels)
        case "recharger":
            guard let c = o["canal"] as? String else { return }
            canaux[c]?.c?.lienRecharger()
        case "fermee" where (o["req"] as? String).flatMap({ requetes[$0] }) == nil:
            // session fermée sur le Victus (ou par une autre page) : sa vue part, sans renvoyer d'op fermer
            if let id = o["sessionId"] as? String { VictusSession.existante(id)?.liberer() }
        case "pong", "attache":
            break
        default:
            // réponses aux requêtes (ouverte, dossiers, erreur…)
            if let req = o["req"] as? String, let r = requetes.removeValue(forKey: req) {
                r.garde.cancel(); r.rappel(o)
            } else if ev == "erreur" {
                journal("victus : erreur du démon — \(extrait(o["message"] as? String ?? "?", 200))")
            }
        }
    }

    /// Canaux à rattacher à la prochaine connexion (fenêtres ouvertes pendant une coupure).
    private var enAttenteDeLien: [Faible] = []

    // MARK: - Écriture

    /// Une ligne JSON vers le démon. Faux si le lien n'est pas établi (rien n'est mis en file ici).
    @discardableResult
    func envoyer(_ o: [String: Any]) -> Bool {
        guard etat == .connecte else { return false }
        return ecrire(o)
    }

    @discardableResult
    private func ecrire(_ o: [String: Any]) -> Bool {
        guard let h = entree, JSONSerialization.isValidJSONObject(o),
              var d = try? JSONSerialization.data(withJSONObject: o, options: [.withoutEscapingSlashes]) else { return false }
        guard d.count <= 20_000_000 else { journal("victus : message de \(d.count) o refusé (20 Mo au plus)"); return false }
        d.append(0x0A)
        ecriture.async { try? h.write(contentsOf: d) }
        return true
    }

    /// Requête avec réponse (`req`) : `ouvrir`, `dossiers`. Le rappel reçoit l'objet de réponse, ou
    /// `{ev:"erreur", message}` (délai dépassé, lien coupé). Toujours sur le fil principal.
    func requete(_ o: [String: Any], delai d: TimeInterval = 30, _ rappel: @escaping ([String: Any]) -> Void) {
        guard etat == .connecte else { rappel(["ev": "erreur", "message": "Victus injoignable"]); return }
        compteur += 1
        let req = "m\(compteur)"
        var m = o; m["req"] = req
        let g = DispatchWorkItem { [weak self] in
            guard let self, let r = self.requetes.removeValue(forKey: req) else { return }
            r.rappel(["ev": "erreur", "message": "Le Victus ne répond pas."])
        }
        requetes[req] = (rappel, g)
        DispatchQueue.main.asyncAfter(deadline: .now() + d, execute: g)
        if !ecrire(m) { requetes.removeValue(forKey: req); g.cancel(); rappel(["ev": "erreur", "message": "Envoi impossible"]) }
    }

    // MARK: - Canaux

    /// Attache une page à une session : renvoie le canal, ou nil si le lien n'est pas établi
    /// (le canal est alors rattaché automatiquement par `lienRetabli` à la reconnexion).
    func attacher(_ c: VictusCanal, sessionId: String) -> String? {
        guard etat == .connecte else {
            if !enAttenteDeLien.contains(where: { $0.c === c }) { enAttenteDeLien.append(Faible(c)) }
            return nil
        }
        compteur += 1
        let canal = "c\(compteur)"
        canaux[canal] = Faible(c)
        ecrire(["op": "attacher", "sessionId": sessionId, "canal": canal])
        return canal
    }

    func detacher(_ canal: String) {
        guard canaux.removeValue(forKey: canal) != nil else { return }
        envoyer(["op": "detacher", "canal": canal])
    }

    func oublier(_ c: VictusCanal) { enAttenteDeLien.removeAll { $0.c == nil || $0.c === c } }

    static func idValide(_ id: String) -> Bool {
        id.count == 36 && id.allSatisfy { $0.isHexDigit || $0 == "-" }
    }
}
