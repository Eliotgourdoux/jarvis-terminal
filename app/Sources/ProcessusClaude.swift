import Foundation

/// Un processus claude : stdin/stdout/stderr en tubes, lecture ligne par ligne, arrêt progressif.
/// Lancé avec posix_spawn dans son propre groupe de processus : l'arrêt atteint aussi ses enfants
/// (serveurs MCP, commandes Bash), comme la fermeture d'un onglet Terminal.
final class ProcessusClaude {
    let pid: pid_t
    private let entree: Int32
    private let fileEcriture = DispatchQueue(label: "bt.stdin")
    private let verrou = NSLock()
    private var _fini = false
    private var _code: Int32 = 0
    private var arretDemande = false
    private var entreeOuverte = true   // lu et écrit uniquement sur fileEcriture

    /// Rappels appelés sur des fils d'arrière-plan, dans l'ordre (toutes les lignes avant surFin).
    var surLigne: ((String) -> Void)?
    var surStderr: ((String) -> Void)?
    var surFin: ((Int32) -> Void)?
    private var apresFin: [() -> Void] = []

    var fini: Bool { verrou.lock(); defer { verrou.unlock() }; return _fini }

    enum Erreur: Error, CustomStringConvertible {
        case tube(Int32), spawn(Int32)
        var description: String {
            switch self {
            case .tube(let e): return "pipe() : \(String(cString: strerror(e)))"
            case .spawn(let e): return "posix_spawn : \(String(cString: strerror(e)))"
            }
        }
    }

    init(exe: String, args: [String], env: [String: String], cwd: String) throws {
        var tin: [Int32] = [0, 0], tout: [Int32] = [0, 0], terr: [Int32] = [0, 0]
        guard pipe(&tin) == 0, pipe(&tout) == 0, pipe(&terr) == 0 else { throw Erreur.tube(errno) }
        // côté app : jamais hérités par d'autres enfants (osascript, terminal-notifier…)
        for fd in [tin[1], tout[0], terr[0]] { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }

        var actions: posix_spawn_file_actions_t? = nil
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_adddup2(&actions, tin[0], 0)
        posix_spawn_file_actions_adddup2(&actions, tout[1], 1)
        posix_spawn_file_actions_adddup2(&actions, terr[1], 2)
        posix_spawn_file_actions_addchdir_np(&actions, cwd)

        var attr: posix_spawnattr_t? = nil
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        // propre groupe ; seuls 0/1/2 sont hérités ; signaux remis par défaut (l'app ignore SIGPIPE)
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT
                                              | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))
        posix_spawnattr_setpgroup(&attr, 0)
        var tous = sigset_t(); sigfillset(&tous)
        posix_spawnattr_setsigdefault(&attr, &tous)
        var aucun = sigset_t(); sigemptyset(&aucun)
        posix_spawnattr_setsigmask(&attr, &aucun)

        let argv: [UnsafeMutablePointer<CChar>?] = ([exe] + args).map { strdup($0) } + [nil]
        let envp: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { argv.forEach { free($0) }; envp.forEach { free($0) } }

        var p: pid_t = 0
        let r = posix_spawn(&p, exe, &actions, &attr, argv, envp)
        close(tin[0]); close(tout[1]); close(terr[1])
        guard r == 0 else { close(tin[1]); close(tout[0]); close(terr[0]); throw Erreur.spawn(r) }
        pid = p
        entree = tin[1]
        sortie = tout[0]
        erreurs = terr[0]
    }

    private let sortie: Int32
    private let erreurs: Int32
    private var ecoute = false

    // MARK: lecture

    /// À appeler une fois les rappels posés : rien n'est perdu entre-temps (les tubes gardent tout,
    /// et un processus déjà mort reste en zombie jusqu'au waitpid).
    func ecouter() {
        guard !ecoute else { return }
        ecoute = true
        let lectures = DispatchGroup()
        lectures.enter()
        Thread.detachNewThread { [self] in
            lireLignes(sortie) { self.surLigne?($0) }
            lectures.leave()
        }
        lectures.enter()
        Thread.detachNewThread { [self] in
            lireLignes(erreurs) { self.surStderr?($0) }
            lectures.leave()
        }
        Thread.detachNewThread { [self] in
            var statut: Int32 = 0
            while waitpid(pid, &statut, 0) == -1 && errno == EINTR {}
            // un petit-enfant peut garder stdout ouvert : on n'attend pas plus d'1 s la fin des lectures
            _ = lectures.wait(timeout: .now() + 1)
            let sig = statut & 0x7f
            let code: Int32 = sig == 0 ? (statut >> 8) & 0xff : 128 + sig
            verrou.lock(); _fini = true; _code = code; let demande = arretDemande; let suite = apresFin; apresFin = []; verrou.unlock()
            fileEcriture.async { self.fermerEntree() }
            if demande { _ = kill(-pid, SIGTERM) }   // ménage : enfants restés dans le groupe
            surFin?(code)
            suite.forEach { $0() }
        }
    }

    /// Lit jusqu'à EOF et découpe sur « \n » (octet) : un caractère UTF-8 n'est jamais coupé.
    private func lireLignes(_ fd: Int32, _ rappel: (String) -> Void) {
        var tampon = Data()
        var bloc = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = read(fd, &bloc, bloc.count)
            if n < 0 { if errno == EINTR { continue }; break }
            if n == 0 { break }
            tampon.append(contentsOf: bloc[0..<n])
            while let i = tampon.firstIndex(of: 0x0A) {
                let ligne = tampon[tampon.startIndex..<i]
                tampon.removeSubrange(tampon.startIndex...i)
                var s = String(decoding: ligne, as: UTF8.self)
                if s.hasSuffix("\r") { s.removeLast() }
                if !s.isEmpty { rappel(s) }
            }
        }
        if !tampon.isEmpty { rappel(String(decoding: tampon, as: UTF8.self)) }
        close(fd)
    }

    // MARK: écriture

    /// Écrit une ligne + "\n" sur stdin (hors du fil principal : un tube plein ne bloque pas l'interface).
    func ecrire(_ ligne: String, fini rappel: ((Bool) -> Void)? = nil) {
        let donnees = Array((ligne + "\n").utf8)
        fileEcriture.async { [self] in
            var ok = entreeOuverte
            var deb = 0
            while ok && deb < donnees.count {
                let n = donnees[deb...].withUnsafeBufferPointer { write(entree, $0.baseAddress, $0.count) }
                if n < 0 { if errno == EINTR { continue }; ok = false; journal("stdin pid \(pid) : \(String(cString: strerror(errno)))") }
                else { deb += n }
            }
            rappel?(ok)
        }
    }

    /// Ferme stdin une seule fois (sur fileEcriture) : jamais de double close ni d'écriture sur un fd réutilisé.
    private func fermerEntree() {
        if entreeOuverte { entreeOuverte = false; close(entree) }
    }

    // MARK: arrêt

    /// Arrêt propre : fin de stdin (claude termine de lui-même), SIGTERM au groupe après 2 s, SIGKILL après 5 s.
    /// `termine` est appelé une fois le processus mort (tout de suite s'il l'est déjà).
    func arreter(_ termine: (() -> Void)? = nil) {
        verrou.lock()
        if _fini { verrou.unlock(); termine?(); return }
        if let t = termine { apresFin.append(t) }
        let deja = arretDemande
        arretDemande = true
        verrou.unlock()
        if deja { return }
        journal("arrêt pid \(pid) : fin de stdin")
        fileEcriture.async { [self] in fermerEntree() }
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [self] in
            guard !fini else { return }
            journal("arrêt pid \(pid) : SIGTERM"); _ = kill(-pid, SIGTERM); _ = kill(pid, SIGTERM)
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 5) { [self] in
            guard !fini else { return }
            journal("arrêt pid \(pid) : SIGKILL"); _ = kill(-pid, SIGKILL); _ = kill(pid, SIGKILL)
        }
    }
}
