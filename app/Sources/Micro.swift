import AppKit
import AVFoundation
import CoreAudio
import CoreMedia

/// Choix du micro (09/11/2026). Deux modes, réglage `microPrefere` :
/// - `.mac` (valeur "integre") : le micro intégré du Mac quand il existe. Le micro d'un casque Bluetooth fait
///   passer le casque en mode « appel » (HFP) : son dégradé dans les oreilles, entrée 16 à 24 kHz (AirPods Pro d'Eliot :
///   24 kHz), et un Sony WH-1000XM4 en HFP a déjà renvoyé un silence complet au mode Jarvis.
/// - `.branche` (défaut depuis le 09/11/2026, choix d'Eliot : parler via ses AirPods ; valeur "defaut") : le micro d'entrée choisi dans macOS
///   (AirPods compris, donc HFP assumé). Filet : si ce micro ne renvoie que des zéros exacts pendant 8 s, repli sur le
///   micro intégré jusqu'au prochain changement de périphérique.
/// Le micro choisi est surveillé (branchement, débranchement, micro par défaut de macOS, mode) : `changement` est
/// posté sur le fil principal, et une `CaptureMicro` en cours bascule à chaud sur le nouveau micro.
enum ChoixMicro {
    enum Mode: String { case mac = "integre", branche = "defaut" }

    /// Posté sur le fil principal quand le mode ou le micro effectivement choisi change.
    static let changement = Notification.Name("bt.micro.changement")

    private static let cle = "microPrefere"
    private static let integreTransport = Int32(bitPattern: 0x626c_746e)   // 'bltn'

    static var mode: Mode {
        get { Reglages.texte(cle) == Mode.mac.rawValue ? .mac : .branche }
        set {
            let avant = mode
            Reglages.mettre(newValue.rawValue, cle)
            guard newValue != avant else { return }
            journal("micro : mode « \(newValue == .mac ? "micro du Mac" : "micro choisi dans macOS") »")
            repli = nil
            SurveillanceMicro.partage.signaler(forcer: true)
        }
    }

    static func choisi() -> AVCaptureDevice? {
        _ = SurveillanceMicro.partage
        let liste = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone], mediaType: .audio, position: .unspecified).devices
        let defaut = CoreAudioOutil.uidEntreeDefaut().flatMap { AVCaptureDevice(uniqueID: $0) } ?? AVCaptureDevice.default(for: .audio)
        let integre = liste.first(where: estIntegre)
        if mode == .branche {
            if let d = defaut, let r = repli, d.uniqueID == r, let integre { return integre }
            return defaut ?? liste.first
        }
        return integre ?? defaut ?? liste.first
    }

    /// Nom du micro qui serait pris maintenant (menu).
    static func nomChoisi() -> String? { choisi()?.localizedName }

    static func estIntegre(_ d: AVCaptureDevice) -> Bool { d.transportType == integreTransport }

    // MARK: Repli sur le micro intégré (micro muet en mode `.branche`)

    private static let verrouRepli = NSLock()
    private static var _repli: String?
    /// uniqueID du micro écarté (que des zéros) ; remis à nil au prochain changement de périphérique ou de mode.
    fileprivate static var repli: String? {
        get { verrouRepli.lock(); defer { verrouRepli.unlock() }; return _repli }
        set { verrouRepli.lock(); _repli = newValue; verrouRepli.unlock() }
    }

    /// Appelé par une capture (n'importe quel fil) quand le micro `id` ne renvoie que des zéros.
    fileprivate static func replier(id: String, nom: String) {
        guard mode == .branche, repli != id else { return }
        repli = id
        journal("micro : « \(nom) » ne renvoie que des zéros depuis 8 s, repli sur le micro du Mac")
        SurveillanceMicro.partage.signaler(forcer: true)
    }
}

/// Surveillance des micros (singleton, installé une fois) : AVCaptureDevice connecté / déconnecté et micro d'entrée par
/// défaut de macOS (Core Audio, sur sa propre file). Tout converge sur le fil principal, avec un délai de 0,3 s
/// (macOS envoie plusieurs notifications d'affilée), puis `ChoixMicro.changement` si le choix a changé.
private final class SurveillanceMicro {
    static let partage = SurveillanceMicro()

    private let file = DispatchQueue(label: "bt.micro.surveillance")
    private var jetons: [NSObjectProtocol] = []
    // Fil principal uniquement :
    private var attente: DispatchWorkItem?
    private var forcer = false
    private var dernierChoix: String?
    private var dernierMateriel = ""

    private init() {
        let nc = NotificationCenter.default
        for n in [AVCaptureDevice.wasConnectedNotification, AVCaptureDevice.wasDisconnectedNotification] {
            jetons.append(nc.addObserver(forName: n, object: nil, queue: nil) { [weak self] _ in self?.signaler(forcer: false) })
        }
        var adr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice,
                                             mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        let st = AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &adr, file) { [weak self] _, _ in
            self?.signaler(forcer: false)
        }
        if st != noErr { journal("micro : surveillance du micro par défaut impossible (\(st))") }
        // État de départ, hors de l'initialisation (choisi() passe par `partage`).
        DispatchQueue.main.async { [self] in
            dernierMateriel = empreinte()
            dernierChoix = ChoixMicro.choisi()?.uniqueID
        }
    }

    /// N'importe quel fil. `forcer` : poster `changement` même si le micro choisi est le même (changement de mode).
    func signaler(forcer f: Bool) {
        DispatchQueue.main.async { [self] in
            if f { forcer = true }
            attente?.cancel()
            let w = DispatchWorkItem { [weak self] in self?.evaluer() }
            attente = w
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: w)
        }
    }

    private func evaluer() {
        attente = nil
        let materiel = empreinte()
        if materiel != dernierMateriel {
            if ChoixMicro.repli != nil { ChoixMicro.repli = nil; journal("micro : périphériques changés, fin du repli") }
            dernierMateriel = materiel
        }
        let choix = ChoixMicro.choisi()
        guard forcer || choix?.uniqueID != dernierChoix else { return }
        forcer = false
        dernierChoix = choix?.uniqueID
        journal("micro : choisi → \(choix?.localizedName ?? "aucun")")
        NotificationCenter.default.post(name: ChoixMicro.changement, object: nil)
    }

    /// Liste des micros + micro par défaut de macOS : sert à savoir si le matériel a vraiment changé.
    private func empreinte() -> String {
        let ids = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone], mediaType: .audio, position: .unspecified)
            .devices.map(\.uniqueID).sorted()
        return ids.joined(separator: ",") + "|" + (CoreAudioOutil.uidEntreeDefaut() ?? "")
    }
}

/// Sortie audio de macOS, pour l'anti-écho : `hautParleursIntegres()` est vrai seulement si la sortie par défaut est le
/// haut-parleur intégré du Mac (transport intégré, et source 'ispk' quand la source existe ; prise casque 'hdpn' → faux).
/// Faux pour Bluetooth (AirPods), USB, AirPlay… Valeur en cache, rafraîchie par Core Audio, lisible de tout fil.
/// `casque()` (09/11/2026) : sortie Bluetooth ou prise casque, que le micro n'entend pas. Une enceinte USB, HDMI ou
/// AirPlay n'est pas un casque : l'anti-écho reste actif (le micro l'entend sans doute).
enum SortieAudio {
    static func hautParleursIntegres() -> Bool { SurveillanceSortie.partage.etat().integre }
    static func casque() -> Bool { SurveillanceSortie.partage.etat().casque }
    /// Nom de la sortie par défaut (journal).
    static func nom() -> String { SurveillanceSortie.partage.etat().nom }
}

private final class SurveillanceSortie {
    static let partage = SurveillanceSortie()

    private let file = DispatchQueue(label: "bt.audio.sortie")
    private let verrou = NSLock()
    private var cache: (integre: Bool, nom: String, casque: Bool) = (false, "inconnue", false)
    private var appareilSuivi = AudioObjectID(kAudioObjectUnknown)   // file
    private static var adrSource = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDataSource,
                                                              mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
    private lazy var surChangement: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.rafraichir() }

    private init() {
        file.sync { rafraichir() }
        var adr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                                             mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        let st = AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &adr, file, surChangement)
        if st != noErr { journal("audio : surveillance de la sortie impossible (\(st))") }
    }

    func etat() -> (integre: Bool, nom: String, casque: Bool) { verrou.lock(); defer { verrou.unlock() }; return cache }

    /// Sur `file` : relit la sortie par défaut et suit sa source de données (haut-parleur / prise casque).
    private func rafraichir() {
        let id = CoreAudioOutil.appareilDefaut(entree: false) ?? AudioObjectID(kAudioObjectUnknown)
        if id != appareilSuivi {
            if appareilSuivi != kAudioObjectUnknown {
                AudioObjectRemovePropertyListenerBlock(appareilSuivi, &Self.adrSource, file, surChangement)
            }
            if id != kAudioObjectUnknown, AudioObjectHasProperty(id, &Self.adrSource) {
                AudioObjectAddPropertyListenerBlock(id, &Self.adrSource, file, surChangement)
            }
            appareilSuivi = id
        }
        var integre = false
        var casque = false
        var nom = "aucune"
        if id != kAudioObjectUnknown {
            nom = CoreAudioOutil.texte(id, kAudioObjectPropertyName) ?? "sans nom"
            let transport = CoreAudioOutil.entier(id, kAudioDevicePropertyTransportType)
            if transport == kAudioDeviceTransportTypeBuiltIn {
                if let src = CoreAudioOutil.entier(id, kAudioDevicePropertyDataSource, scope: kAudioDevicePropertyScopeOutput) {
                    integre = src == 0x6973_706b   // 'ispk' ('hdpn' = prise casque)
                    casque = src == 0x6864_706e
                } else {
                    integre = true
                }
            } else if transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE {
                casque = true
            }
        }
        verrou.lock(); let avant = cache; cache = (integre, nom, casque); verrou.unlock()
        if avant.integre != integre || avant.nom != nom || avant.casque != casque {
            journal("audio : sortie « \(nom) »\(integre ? " (haut-parleur du Mac)" : casque ? " (casque)" : "")")
        }
    }
}

/// Lectures Core Audio (aucune ne demande l'autorisation micro).
private enum CoreAudioOutil {
    static func entier(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector,
                       scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> UInt32? {
        var adr = AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectHasProperty(id, &adr) else { return nil }
        var v: UInt32 = 0
        var taille = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(id, &adr, 0, nil, &taille, &v) == noErr ? v : nil
    }

    static func texte(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
        var adr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var v: Unmanaged<CFString>?
        var taille = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let st = withUnsafeMutablePointer(to: &v) { AudioObjectGetPropertyData(id, &adr, 0, nil, &taille, $0) }
        guard st == noErr, let v else { return nil }
        return v.takeRetainedValue() as String
    }

    static func appareilDefaut(entree: Bool) -> AudioObjectID? {
        let sel = entree ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice
        guard let id = entier(AudioObjectID(kAudioObjectSystemObject), sel), id != kAudioObjectUnknown else { return nil }
        return id
    }

    /// UID Core Audio du micro par défaut de macOS (= `AVCaptureDevice.uniqueID`).
    static func uidEntreeDefaut() -> String? { appareilDefaut(entree: true).flatMap { texte($0, kAudioDevicePropertyDeviceUID) } }
}

/// Autorisation micro de macOS (TCC). `etat` ne déclenche jamais la demande ; seul `demander` le fait.
enum AutorisationMicro {
    static var etat: AVAuthorizationStatus { AVCaptureDevice.authorizationStatus(for: .audio) }

    static var texte: String {
        switch etat {
        case .authorized: return "autorise"
        case .notDetermined: return "a-demander"
        case .denied: return "refuse"
        case .restricted: return "restreint"
        @unknown default: return "inconnu"
        }
    }

    /// Affiche la demande de macOS (une seule fois : ensuite macOS répond seul). Rappel sur le fil principal.
    static func demander(_ fini: @escaping (Bool) -> Void) {
        journal("micro : demande d'autorisation à macOS")
        AVCaptureDevice.requestAccess(for: .audio) { ok in
            DispatchQueue.main.async { journal("micro : autorisation \(ok ? "accordée" : "refusée")"); fini(ok) }
        }
    }

    static func ouvrirReglages() {
        if let u = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") { NSWorkspace.shared.open(u) }
    }
}

/// Capture du micro pendant l'appui : AVCaptureSession → WAV 16 kHz mono 16 bits (ce qu'attend whisper.cpp),
/// avec le niveau sonore (0 à 1) envoyé environ 15 fois par seconde.
///
/// Mode continu (écoute mains libres du mode Jarvis) : `demarrerContinu` ne fabrique aucun fichier ; chaque
/// tranche convertie (16 kHz mono Int16) est remise à `surTranche`, sur la file de capture.
///
/// Bascule à chaud (09/11/2026) : quand `ChoixMicro.changement` désigne un autre micro, la session AVCaptureSession est
/// reconstruite sur le nouveau micro sans rien perdre (fichier, `surTranche`, pcm, trames) ; seul le convertisseur
/// repart de zéro. En cas d'échec, journal et on garde l'ancien micro. Démarrer, arrêter et basculer : fil principal.
///
/// Mode simulé (tests uniquement, pilote actif) : `source` remplace le micro par un fichier audio lu en
/// temps réel, par tranches de 50 ms, puis du silence jusqu'au relâchement. Même conversion, même niveau,
/// aucune demande d'autorisation.
final class CaptureMicro {
    struct Resultat { let url: URL; let duree: Double; let niveauMax: Float }
    enum Erreur: Error, CustomStringConvertible {
        case pasDEntree, format, fichier(String)
        var description: String {
            switch self {
            case .pasDEntree: return "aucun micro disponible"
            case .format: return "format audio non pris en charge"
            case .fichier(let s): return "fichier : \(s)"
            }
        }
    }

    /// Appelé sur le fil principal.
    var surNiveau: ((Float) -> Void)?

    private let formatSortie = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
    /// Session réelle (sous `verrouSession`).
    private var capture: AVCaptureSession?
    private var delegue: AnyObject?
    private var appareil: (id: String, nom: String)?
    private let verrouSession = NSLock()
    private let fileCapture = DispatchQueue(label: "bt.micro.capture")
    private var convertisseur: AVAudioConverter?
    private var fichier: AVAudioFile?
    private var url: URL?
    private let verrou = NSLock()
    private var trames: AVAudioFramePosition = 0
    private var niveauMax: Float = 0
    /// Copie en mémoire de l'audio 16 kHz déjà écrit (dictée en direct : transcriptions partielles).
    private var pcm: [Int16] = []
    private var dernierEnvoi: CFAbsoluteTime = 0
    private var simulation: DispatchSourceTimer?
    /// Mode continu : reçoit l'audio converti (file de capture), au lieu du fichier.
    private var surTranche: (([Int16]) -> Void)?
    private let fileSimulation = DispatchQueue(label: "bt.micro.simulation")
    /// Génération de la session en service (sous `verrou`) : les tranches d'une ancienne session sont ignorées.
    private var generation = 0
    private var compteurGenerations = 0
    /// Filet « que des zéros » (sous `verrou`) : actif en mode `.branche` sur un micro qui n'est pas l'intégré.
    private var zeros: (surveiller: Bool, secondes: Double) = (false, 0)
    /// Copie de `appareil` sous `verrou` (la file de capture ne prend jamais `verrouSession` : stopRunning l'attend).
    private var appareilCapte: (id: String, nom: String)?
    private var jeton: NSObjectProtocol?

    init() {
        jeton = NotificationCenter.default.addObserver(forName: ChoixMicro.changement, object: nil, queue: .main) { [weak self] _ in
            self?.basculerSiBesoin()
        }
    }

    deinit { if let jeton { NotificationCenter.default.removeObserver(jeton) } }

    var enCours: Bool { verrou.lock(); defer { verrou.unlock() }; return fichier != nil || surTranche != nil }

    /// `source` : fichier audio à la place du micro (tests). Sinon le micro de `ChoixMicro`.
    func demarrer(vers u: URL, source: URL? = nil) throws {
        arreterSansResultat()
        let f: AVAudioFile
        do {
            f = try AVAudioFile(forWriting: u, settings: formatSortie.settings, commonFormat: .pcmFormatInt16, interleaved: true)
        } catch { throw Erreur.fichier(error.localizedDescription) }
        verrou.lock()
        fichier = f; url = u; trames = 0; niveauMax = 0; pcm.removeAll(keepingCapacity: true); dernierEnvoi = 0; convertisseur = nil
        verrou.unlock()
        try ouvrirSource(source)
    }

    /// Écoute continue : pas de fichier, l'audio 16 kHz part vers `tranche` (sur la file de capture) jusqu'à `arreter`.
    func demarrerContinu(source: URL? = nil, tranche: @escaping ([Int16]) -> Void) throws {
        arreterSansResultat()
        verrou.lock()
        surTranche = tranche; trames = 0; niveauMax = 0; pcm.removeAll(); dernierEnvoi = 0; convertisseur = nil
        verrou.unlock()
        try ouvrirSource(source)
    }

    private func ouvrirSource(_ source: URL?) throws {
        if let source { try demarrerSimulation(source); return }

        // AVCaptureSession plutôt qu'AVAudioEngine : AVAudioEngine lie le micro à la sortie audio et ne reçoit
        // rien (ou plante) quand les deux n'ont pas la même fréquence (casque Bluetooth en sortie, micro du Mac en entrée).
        guard let a = ChoixMicro.choisi() else { arreterSansResultat(); throw Erreur.pasDEntree }
        verrouSession.lock()
        do { try brancher(a); verrouSession.unlock() } catch { verrouSession.unlock(); arreterSansResultat(); throw error }
    }

    /// Démarre une session sur `a`, la met en service, puis arrête l'ancienne (s'il y en a une). Si la nouvelle
    /// échoue, l'ancienne n'est pas touchée. Appelé sous `verrouSession`.
    private func brancher(_ a: AVCaptureDevice) throws {
        verrou.lock(); compteurGenerations += 1; let g = compteurGenerations; verrou.unlock()
        let sess = AVCaptureSession()
        do {
            let entree = try AVCaptureDeviceInput(device: a)
            guard sess.canAddInput(entree) else { throw Erreur.pasDEntree }
            sess.addInput(entree)
        } catch { throw Erreur.fichier("micro « \(a.localizedName) » : \(error)") }
        let sortie = AVCaptureAudioDataOutput()
        sortie.audioSettings = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1,
                                AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false]
        let d = Delegue(); d.micro = self; d.generation = g
        sortie.setSampleBufferDelegate(d, queue: fileCapture)
        guard sess.canAddOutput(sortie) else { throw Erreur.format }
        sess.addOutput(sortie)
        sess.startRunning()
        guard sess.isRunning else { throw Erreur.fichier("le micro « \(a.localizedName) » n'a pas démarré") }
        verrou.lock()
        generation = g; convertisseur = nil   // le format peut changer : recréé à la première tranche
        zeros = (ChoixMicro.mode == .branche && !ChoixMicro.estIntegre(a), 0)
        appareilCapte = (a.uniqueID, a.localizedName)
        verrou.unlock()
        capture?.stopRunning()
        capture = sess; delegue = d; appareil = (a.uniqueID, a.localizedName)
        journal("micro : \(a.localizedName), capture → 16 kHz mono")
    }

    /// `ChoixMicro.changement` (fil principal) : bascule une capture réelle en cours sur le nouveau micro choisi.
    private func basculerSiBesoin() {
        verrouSession.lock(); defer { verrouSession.unlock() }
        guard let ancienne = capture, enCours else { return }
        guard let a = ChoixMicro.choisi() else { journal("micro : plus aucun micro visible, on garde la session actuelle"); return }
        guard a.uniqueID != appareil?.id else { return }
        let avant = appareil?.nom ?? "?"
        do {
            try brancher(a)
            journal("micro : bascule à chaud « \(avant) » → « \(a.localizedName) »")
        } catch {
            journal("micro : bascule vers « \(a.localizedName) » impossible (\(error)), on garde « \(avant) »")
            if !ancienne.isRunning { ancienne.startRunning() }
        }
    }

    /// Reçoit les tranches d'AVCaptureSession (fil `fileCapture`) et les passe à `traiter`.
    private final class Delegue: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
        weak var micro: CaptureMicro?
        var generation = 0
        func captureOutput(_ o: AVCaptureOutput, didOutput sb: CMSampleBuffer, from c: AVCaptureConnection) {
            guard let m = micro, let fd = CMSampleBufferGetFormatDescription(sb) else { return }
            let n = CMSampleBufferGetNumSamples(sb)
            let format = AVAudioFormat(cmAudioFormatDescription: fd)
            guard n > 0, let b = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(n)) else { return }
            b.frameLength = AVAudioFrameCount(n)
            guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sb, at: 0, frameCount: Int32(n), into: b.mutableAudioBufferList) == noErr else { return }
            m.traiterCapture(b, generation: generation)
        }
    }

    /// Le format exact n'est connu qu'à la première tranche : le convertisseur se crée là. Surveille aussi les zéros.
    fileprivate func traiterCapture(_ b: AVAudioPCMBuffer, generation g: Int) {
        verrou.lock()
        guard g == generation else { verrou.unlock(); return }   // tranche d'une session remplacée
        if convertisseur == nil, fichier != nil || surTranche != nil, let c = AVAudioConverter(from: b.format, to: formatSortie) {
            c.downmix = true
            convertisseur = c
        }
        var muet: (id: String, nom: String)?
        if zeros.surveiller {
            var nul = true
            if let canaux = b.floatChannelData {
                let n = Int(b.frameLength)
                for c in 0..<Int(b.format.channelCount) where nul { let p = canaux[c]; for i in 0..<n where p[i] != 0 { nul = false; break } }
            } else { nul = false }
            if nul {
                zeros.secondes += Double(b.frameLength) / b.format.sampleRate
                if zeros.secondes >= 8 { zeros.surveiller = false; muet = appareilCapte }   // 8 s : les AirPods rendent des zéros 3 à 5 s le temps de passer en mode micro (19:37, 09/11)
            } else { zeros.surveiller = false }   // du vrai son : ce micro marche
        }
        verrou.unlock()
        if let a = muet { ChoixMicro.replier(id: a.id, nom: a.nom) }
        traiter(b, generation: g)
    }

    /// L'audio capté jusqu'ici (16 kHz mono), pour une transcription partielle.
    func echantillons() -> [Int16] { verrou.lock(); defer { verrou.unlock() }; return pcm }

    /// Fin de l'appui : ferme le WAV et renvoie sa durée.
    func arreter() -> Resultat? {
        couperSources()
        verrou.lock()
        let u = url, n = trames, mx = niveauMax
        fichier = nil   // libère l'AVAudioFile : l'en-tête WAV est finalisé
        url = nil; convertisseur = nil; surTranche = nil; zeros = (false, 0); appareilCapte = nil
        verrou.unlock()
        guard let u else { return nil }
        return Resultat(url: u, duree: Double(n) / 16_000, niveauMax: mx)
    }

    func arreterSansResultat() {
        if let r = arreter() { try? FileManager.default.removeItem(at: r.url) }
    }

    private func couperSources() {
        verrouSession.lock()
        if let c = capture {
            c.stopRunning()   // synchrone : plus aucune tranche après
            capture = nil; delegue = nil; appareil = nil
        }
        verrouSession.unlock()
        simulation?.cancel()
        simulation = nil
    }

    /// Une tranche d'audio (fil du micro ou de la simulation) : niveau, conversion, écriture.
    /// `generation` : celle de la session réelle d'origine (nil pour la simulation).
    private func traiter(_ b: AVAudioPCMBuffer, generation g: Int? = nil) {
        let n = Int(b.frameLength)
        guard n > 0 else { return }
        var somme: Float = 0
        if let canaux = b.floatChannelData {
            let nc = Int(b.format.channelCount)
            for c in 0..<nc { let p = canaux[c]; for i in 0..<n { somme += p[i] * p[i] } }
            somme /= Float(max(1, nc))
        }
        let rms = (somme / Float(n)).squareRoot()
        let db = 20 * log10(max(rms, 1e-7))
        let niveau = min(1, max(0, (db + 55) / 45))   // -55 dB → 0, -10 dB → 1

        verrou.lock()
        let f = fichier, rappel = surTranche
        guard f != nil || rappel != nil, g == nil || g == generation, let c = convertisseur else { verrou.unlock(); return }
        if niveau > niveauMax { niveauMax = niveau }
        var pourRappel: [Int16] = []
        let capacite = AVAudioFrameCount(Double(n) * 16_000 / b.format.sampleRate) + 64
        if let sortie = AVAudioPCMBuffer(pcmFormat: formatSortie, frameCapacity: capacite) {
            var fourni = false
            var err: NSError?
            let st = c.convert(to: sortie, error: &err) { _, statut in
                if fourni { statut.pointee = .noDataNow; return nil }
                fourni = true; statut.pointee = .haveData; return b
            }
            if st != .error, sortie.frameLength > 0 {
                let d = sortie.int16ChannelData.map { UnsafeBufferPointer(start: $0[0], count: Int(sortie.frameLength)) }
                if let f {
                    if let d { pcm.append(contentsOf: d) }
                    do { try f.write(from: sortie); trames += AVAudioFramePosition(sortie.frameLength) }
                    catch { journal("micro : écriture impossible — \(error.localizedDescription)") }
                } else if let d { pourRappel = Array(d) }
            }
        }
        let maintenant = CFAbsoluteTimeGetCurrent()
        let envoyer = maintenant - dernierEnvoi > 1.0 / 15
        if envoyer { dernierEnvoi = maintenant }
        verrou.unlock()
        if let rappel, !pourRappel.isEmpty { rappel(pourRappel) }
        if envoyer { DispatchQueue.main.async { [weak self] in self?.surNiveau?(niveau) } }
    }

    // MARK: - Simulation (tests)

    private func demarrerSimulation(_ source: URL) throws {
        let lecture: AVAudioFile
        do { lecture = try AVAudioFile(forReading: source) } catch { arreterSansResultat(); throw Erreur.fichier(error.localizedDescription) }
        let format = lecture.processingFormat
        guard let c = AVAudioConverter(from: format, to: formatSortie) else { arreterSansResultat(); throw Erreur.format }
        c.downmix = true
        verrou.lock(); convertisseur = c; verrou.unlock()
        let tranche = AVAudioFrameCount(format.sampleRate * 0.05)
        let t = DispatchSource.makeTimerSource(queue: fileSimulation)
        t.schedule(deadline: .now(), repeating: .milliseconds(50))
        t.setEventHandler { [weak self] in
            guard let self, let b = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: tranche) else { return }
            if lecture.framePosition < lecture.length { try? lecture.read(into: b, frameCount: tranche) }
            if b.frameLength == 0 {   // fin du fichier : silence jusqu'au relâchement
                b.frameLength = tranche
                if let canaux = b.floatChannelData { for i in 0..<Int(format.channelCount) { canaux[i].update(repeating: 0, count: Int(tranche)) } }
            }
            self.traiter(b)
        }
        simulation = t
        t.resume()
        journal("micro : SIMULÉ depuis \(source.lastPathComponent) (\(Int(format.sampleRate)) Hz)")
    }
}
