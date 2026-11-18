import Foundation

/// Un processus claude qui peut survivre à l'app (18/11/2026, Eliot : « quitter l'app et laisser tourner en fond »).
/// stdin est un tube nommé que claude ouvre lui-même en lecture-écriture (jamais de fin de fichier quand l'app
/// s'en va), stdout et stderr sont des fichiers que l'app lit à la suite. Tout est dans `dossier`
/// (~/.config/better-terminal/vivants/<session>/). L'app peut donc se détacher (`detacher`), quitter, puis se
/// rebrancher (`init(attache:)`) à l'endroit exact où elle s'était arrêtée de lire : rien n'est perdu.
/// Lancé avec posix_spawn dans sa propre session : l'arrêt atteint aussi ses enfants (serveurs MCP, commandes Bash).
/// Essai du principe sur un vrai claude : /tmp, 18/11/2026 (survie, rebranchement, SIGTERM propre en 0,7 s).
final class ProcessusClaude {
    let pid: pid_t
    let dossier: String
    /// Nom du fichier de sortie (dans `dossier`), à redonner pour se rebrancher.
    let nomSortie: String
    /// Lancé par cette app (on peut attendre sa fin avec waitpid) ; sinon rebranché sur un processus déjà là.
    private let enfant: Bool
    private let entree: Int32
    private let sortie: Int32
    private let erreurs: Int32
    private let fileEcriture = DispatchQueue(label: "bt.stdin")
    private let verrou = NSLock()
    private var _fini = false
    private var _code: Int32 = 0
    private var arretDemande = false
    private var _detache = false
    private var _mort = false
    private var _consomme: UInt64        // octets de stdout déjà rendus en lignes complètes
    private var entreeOuverte = true     // lu et écrit uniquement sur fileEcriture
    private let limiteRattrapage: UInt64
    private var ecoute = false
    private let lectures = DispatchGroup()

    /// Rappels appelés sur des fils d'arrière-plan, dans l'ordre (toutes les lignes avant surFin).
    /// `rattrapage` : ligne écrite pendant que l'app n'était pas là (déjà dans le transcript).
    var surLigne: ((_ ligne: String, _ rattrapage: Bool) -> Void)?
    var surStderr: ((String) -> Void)?
    var surFin: ((Int32) -> Void)?
    /// Après un rebranchement : toutes les lignes écrites en l'absence de l'app ont été rendues.
    var surRattrape: (() -> Void)?
    private var apresFin: [() -> Void] = []

    var fini: Bool { verrou.lock(); defer { verrou.unlock() }; return _fini }
    private var detache: Bool { verrou.lock(); defer { verrou.unlock() }; return _detache }
    private var mort: Bool { verrou.lock(); defer { verrou.unlock() }; return _mort }
    /// Octets de stdout déjà rendus : l'endroit où reprendre après un rebranchement.
    var consomme: UInt64 { verrou.lock(); defer { verrou.unlock() }; return _consomme }

    enum Erreur: Error, CustomStringConvertible {
        case dossier(String), tube(Int32), spawn(Int32), absent
        var description: String {
            switch self {
            case .dossier(let d): return "dossier \(d) impossible à préparer"
            case .tube(let e): return "tube nommé : \(String(cString: strerror(e)))"
            case .spawn(let e): return "posix_spawn : \(String(cString: strerror(e)))"
            case .absent: return "le processus n'est plus là"
            }
        }
    }

    private static let tube = "entree.fifo"

    /// Lance claude. `dossier` est vidé de ses anciens fichiers (ceux d'un processus précédent, mort).
    init(exe: String, args: [String], env: [String: String], cwd: String, dossier: String) throws {
        let fm = FileManager.default
        do {
            try fm.createDirectory(atPath: dossier, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        } catch { throw Erreur.dossier(dossier) }
        for f in (try? fm.contentsOfDirectory(atPath: dossier)) ?? [] where f.hasPrefix("sortie-") || f.hasPrefix("erreurs-") || f == Self.tube {
            try? fm.removeItem(atPath: dossier + "/" + f)
        }
        let marque = String(Int(Date().timeIntervalSince1970 * 1000))
        let nom = "sortie-\(marque).jsonl"
        let cheminTube = dossier + "/" + Self.tube
        let cheminSortie = dossier + "/" + nom
        let cheminErreurs = dossier + "/erreurs-\(marque).log"
        guard mkfifo(cheminTube, 0o600) == 0 else { throw Erreur.tube(errno) }
        // un lecteur provisoire, pour pouvoir ouvrir le tube en écriture sans attendre que claude l'ait ouvert
        let provisoire = open(cheminTube, O_RDWR | O_CLOEXEC)
        guard provisoire >= 0 else { throw Erreur.tube(errno) }
        defer { close(provisoire) }

        var actions: posix_spawn_file_actions_t? = nil
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        // lecture-écriture : claude tient lui-même un écrivain, donc jamais de fin de fichier sur stdin
        posix_spawn_file_actions_addopen(&actions, 0, cheminTube, O_RDWR, 0)
        posix_spawn_file_actions_addopen(&actions, 1, cheminSortie, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        posix_spawn_file_actions_addopen(&actions, 2, cheminErreurs, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        posix_spawn_file_actions_addchdir_np(&actions, cwd)

        var attr: posix_spawnattr_t? = nil
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        // propre session (donc propre groupe) : il ne dépend plus de l'app ; seuls 0/1/2 sont hérités ;
        // signaux remis par défaut (l'app ignore SIGPIPE)
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT
                                              | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))
        var tous = sigset_t(); sigfillset(&tous)
        posix_spawnattr_setsigdefault(&attr, &tous)
        var aucun = sigset_t(); sigemptyset(&aucun)
        posix_spawnattr_setsigmask(&attr, &aucun)

        let argv: [UnsafeMutablePointer<CChar>?] = ([exe] + args).map { strdup($0) } + [nil]
        let envp: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { argv.forEach { free($0) }; envp.forEach { free($0) } }

        var p: pid_t = 0
        let r = posix_spawn(&p, exe, &actions, &attr, argv, envp)
        guard r == 0 else { throw Erreur.spawn(r) }
        let e = open(cheminTube, O_WRONLY | O_CLOEXEC)
        let s = open(cheminSortie, O_RDWR | O_CLOEXEC)
        let er = open(cheminErreurs, O_RDONLY | O_CLOEXEC)
        guard e >= 0, s >= 0, er >= 0 else {
            let code = errno
            [e, s, er].forEach { if $0 >= 0 { close($0) } }
            _ = kill(p, SIGKILL)
            throw Erreur.tube(code)
        }
        pid = p; enfant = true; self.dossier = dossier; nomSortie = nom
        entree = e; sortie = s; erreurs = er
        _consomme = 0; limiteRattrapage = 0
    }

    /// Se rebranche sur un claude laissé en fond par un lancement précédent de l'app.
    /// `depuis` : octets de stdout déjà lus avant de partir. Échoue si le processus n'est plus là.
    init(attache pid: pid_t, dossier: String, nomSortie: String, depuis: UInt64) throws {
        guard pid > 1, kill(pid, 0) == 0 else { throw Erreur.absent }
        let cheminSortie = dossier + "/" + nomSortie
        let cheminErreurs = dossier + "/" + nomSortie.replacingOccurrences(of: "sortie-", with: "erreurs-").replacingOccurrences(of: ".jsonl", with: ".log")
        // sans lecteur (claude mort), l'ouverture non bloquante échoue : c'est le test
        let e = open(dossier + "/" + Self.tube, O_WRONLY | O_NONBLOCK | O_CLOEXEC)
        guard e >= 0 else { throw Erreur.absent }
        _ = fcntl(e, F_SETFL, fcntl(e, F_GETFL) & ~O_NONBLOCK)
        let s = open(cheminSortie, O_RDWR | O_CLOEXEC)
        guard s >= 0 else { close(e); throw Erreur.absent }
        let er = open(cheminErreurs, O_RDONLY | O_CLOEXEC)
        var st = stat()
        let taille = fstat(s, &st) == 0 ? UInt64(max(0, st.st_size)) : 0
        self.pid = pid; enfant = false; self.dossier = dossier; self.nomSortie = nomSortie
        entree = e; sortie = s; erreurs = er
        _consomme = min(depuis, taille); limiteRattrapage = taille
        if er >= 0 { lseek(er, 0, SEEK_END) }   // les anciennes erreurs ont déjà été dites
    }

    /// Début du processus (secondes Unix) : sert à vérifier, au rebranchement, que le pid n'a pas été repris.
    static func debut(_ pid: pid_t) -> Double? {
        var info = kinfo_proc()
        var taille = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &info, &taille, nil, 0) == 0, taille > 0 else { return nil }
        let t = info.kp_proc.p_starttime
        return Double(t.tv_sec) + Double(t.tv_usec) / 1_000_000
    }

    // MARK: lecture

    /// À appeler une fois les rappels posés : rien n'est perdu entre-temps (les fichiers gardent tout).
    func ecouter() {
        guard !ecoute else { return }
        ecoute = true
        lectures.enter()
        Thread.detachNewThread { [self] in
            suivre(sortie, depuis: consomme, principal: true)
            lectures.leave()
        }
        if erreurs >= 0 {
            lectures.enter()
            Thread.detachNewThread { [self] in
                suivre(erreurs, depuis: nil, principal: false)
                lectures.leave()
            }
        }
        Thread.detachNewThread { [self] in
            let code = attendreFin()
            verrou.lock(); _mort = true; verrou.unlock()
            // les lecteurs voient `mort`, lisent ce qui reste et s'arrêtent
            _ = lectures.wait(timeout: .now() + 3)
            verrou.lock()
            let parti = _detache
            _fini = true; _code = code
            let demande = arretDemande; let suite = apresFin; apresFin = []
            verrou.unlock()
            fileEcriture.async { self.fermerEntree() }
            if demande { _ = kill(-pid, SIGTERM) }   // ménage : enfants restés dans le groupe
            if !parti { surFin?(code) }
            suite.forEach { $0() }
        }
    }

    /// Attend la mort du processus. Enfant : waitpid (code exact). Rebranché : kqueue (code inconnu, 0).
    private func attendreFin() -> Int32 {
        if enfant {
            var statut: Int32 = 0
            while waitpid(pid, &statut, 0) == -1 && errno == EINTR {}
            let sig = statut & 0x7f
            return sig == 0 ? (statut >> 8) & 0xff : 128 + sig
        }
        let kq = kqueue()
        defer { if kq >= 0 { close(kq) } }
        var ev = kevent(ident: UInt(pid), filter: Int16(EVFILT_PROC), flags: UInt16(EV_ADD | EV_ONESHOT), fflags: UInt32(NOTE_EXIT), data: 0, udata: nil)
        if kq >= 0, kevent(kq, &ev, 1, nil, 0, nil) == 0 {
            var recu = kevent()
            while true {
                if detache { return 0 }
                var delai = timespec(tv_sec: 1, tv_nsec: 0)
                let n = kevent(kq, nil, 0, &recu, 1, &delai)
                if n > 0 { return 0 }
                if n < 0 && errno != EINTR { break }
            }
        }
        // repli (processus déjà mort à l'inscription, ou kqueue en échec) : on regarde toutes les demi-secondes
        while kill(pid, 0) == 0 || errno == EPERM { if detache { return 0 }; usleep(500_000) }
        return 0
    }

    /// Lit un fichier à la suite et découpe sur « \n » (octet) : un caractère UTF-8 n'est jamais coupé.
    /// S'arrête au détachement, ou quand le processus est mort et que tout est lu.
    private func suivre(_ fd: Int32, depuis: UInt64?, principal: Bool) {
        if let d = depuis { lseek(fd, off_t(d), SEEK_SET) }
        var position = depuis ?? 0
        var rattrape = !principal || position >= limiteRattrapage
        if principal, rattrape { surRattrape?() }
        let kq = kqueue()
        defer { if kq >= 0 { close(kq) } }
        if kq >= 0 {
            var ev = kevent(ident: UInt(fd), filter: Int16(EVFILT_VNODE), flags: UInt16(EV_ADD | EV_CLEAR),
                            fflags: UInt32(NOTE_WRITE | NOTE_EXTEND), data: 0, udata: nil)
            _ = kevent(kq, &ev, 1, nil, 0, nil)
        }
        var tampon = Data()
        var bloc = [UInt8](repeating: 0, count: 65536)
        var dernierTour = false
        while true {
            if detache { break }
            if principal {   // fichier vidé par allegerSortie : on repart du début
                verrou.lock()
                if aRemisAZero { aRemisAZero = false; position = 0; tampon.removeAll() }
                verrou.unlock()
            }
            let n = read(fd, &bloc, bloc.count)
            if n < 0 { if errno == EINTR { continue }; break }
            if n > 0 {
                tampon.append(contentsOf: bloc[0..<n])
                while let i = tampon.firstIndex(of: 0x0A) {
                    let ligne = tampon[tampon.startIndex..<i]
                    position += UInt64(ligne.count + 1)
                    tampon.removeSubrange(tampon.startIndex...i)
                    var s = String(decoding: ligne, as: UTF8.self)
                    if s.hasSuffix("\r") { s.removeLast() }
                    if principal {
                        if !s.isEmpty { surLigne?(s, position <= limiteRattrapage) }
                        verrou.lock(); _consomme = position; verrou.unlock()
                        if !rattrape, position >= limiteRattrapage { rattrape = true; surRattrape?() }
                    } else if !s.isEmpty { surStderr?(s) }
                }
                continue
            }
            // rien de neuf
            if principal, !rattrape { rattrape = true; surRattrape?() }
            if detache { break }
            if mort { if dernierTour { break }; dernierTour = true; continue }
            var recu = kevent()
            var delai = timespec(tv_sec: 0, tv_nsec: 200_000_000)
            if kq >= 0 { _ = kevent(kq, nil, 0, &recu, 1, &delai) } else { usleep(30_000) }
        }
        if principal, !detache, !tampon.isEmpty { surLigne?(String(decoding: tampon, as: UTF8.self), false) }
        close(fd)
    }

    /// Le fichier de sortie grossit sans fin (flux de jetons compris). Quand claude ne travaille pas et que tout
    /// est lu, on le vide : claude écrit en mode ajout, il reprend donc au début. À appeler en fin de tour.
    func allegerSortie(seuil: UInt64 = 32 << 20) {
        verrou.lock(); defer { verrou.unlock() }
        guard !_fini, !_detache, _consomme >= seuil else { return }
        var st = stat()
        guard fstat(sortie, &st) == 0, UInt64(max(0, st.st_size)) == _consomme else { return }
        // le lecteur est à la fin : après la troncature, sa position dépasse la taille, on la remet à zéro
        guard ftruncate(sortie, 0) == 0 else { return }
        lseek(sortie, 0, SEEK_SET)
        _consomme = 0
        aRemisAZero = true
    }
    private var aRemisAZero = false

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

    /// Ferme notre bout de stdin une seule fois (sur fileEcriture). claude garde le sien : il ne s'arrête pas.
    private func fermerEntree() {
        if entreeOuverte { entreeOuverte = false; close(entree) }
    }

    // MARK: détachement et arrêt

    /// L'app s'en va et laisse claude tourner. `fini` reçoit l'endroit où reprendre la lecture ; il est appelé
    /// sur un fil d'arrière-plan, après le dernier `surLigne`.
    func detacher(_ fini: @escaping (UInt64) -> Void) {
        verrou.lock()
        if _fini || _detache { let c = _consomme; verrou.unlock(); fini(c); return }
        _detache = true
        verrou.unlock()
        journal("pid \(pid) : laissé en fond")
        fileEcriture.async { [self] in
            fermerEntree()
            DispatchQueue.global().async { [self] in
                _ = lectures.wait(timeout: .now() + 2)
                fini(consomme)
            }
        }
    }

    /// Arrêt : SIGTERM (claude s'arrête proprement de lui-même, il n'y a pas de fin de stdin possible),
    /// SIGTERM au groupe après 2 s, SIGKILL après 5 s.
    /// `termine` est appelé une fois le processus mort (tout de suite s'il l'est déjà).
    func arreter(_ termine: (() -> Void)? = nil) {
        verrou.lock()
        if _fini { verrou.unlock(); termine?(); return }
        if let t = termine { apresFin.append(t) }
        let deja = arretDemande
        arretDemande = true
        verrou.unlock()
        if deja { return }
        journal("arrêt pid \(pid) : SIGTERM")
        fileEcriture.async { [self] in
            // après la dernière ligne déjà en file (interruption du tour), puis le signal
            fermerEntree()
            _ = kill(pid, SIGTERM)
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [self] in
            guard !fini else { return }
            journal("arrêt pid \(pid) : SIGTERM au groupe"); _ = kill(-pid, SIGTERM); _ = kill(pid, SIGTERM)
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 5) { [self] in
            guard !fini else { return }
            journal("arrêt pid \(pid) : SIGKILL"); _ = kill(-pid, SIGKILL); _ = kill(pid, SIGKILL)
        }
    }
}
