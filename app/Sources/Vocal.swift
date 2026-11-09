import AppKit

/// Réglages de l'app (UserDefaults). En mode pilote (tests), un domaine à part : les tests ne
/// modifient jamais les réglages d'Eliot.
enum Reglages {
    static let d: UserDefaults = PiloteDev.actif ? (UserDefaults(suiteName: BUNDLE_ID + ".dev") ?? .standard) : .standard
    static func texte(_ k: String) -> String? { d.string(forKey: k) }
    static func bool(_ k: String, defaut: Bool = false) -> Bool { d.object(forKey: k) == nil ? defaut : d.bool(forKey: k) }
    static func mettre(_ v: Any?, _ k: String) { d.set(v, forKey: k) }
}

/// Mode vocal « Jarvis » (CONTRAT.md, étape 7). Le seul objet qui parle et qui écoute :
/// - file d'attente commune à toutes les sessions (questions d'abord, puis fins de tâche, ordre d'arrivée),
///   une seule session parle à la fois ; l'audio de l'élément suivant se prépare pendant la lecture ;
/// - mains libres (08/11/2026) : tant que le mode est actif, le micro écoute en continu (`EcouteContinue`) ;
///   chaque énoncé détecté passe par whisper, puis routage et livraison (`bt.transcription`) à la bonne session.
///   L'écoute se ferme pendant que Jarvis parle (pas d'écho), pendant une transcription et pendant une dictée de
///   la saisie ; une réponse vocale attend la fin de l'énoncé d'Eliot ;
/// - maintenir le raccourci global (⌥Espace) reste possible : parler tout de suite, ou couper la voix ;
/// - états envoyés aux pages (`bt.vocalEtat`) et au panneau (`jarvis.maj`). Le panneau ne s'ouvre plus jamais
///   seul (demande d'Eliot, 08/11/2026) : menu Vocal → Afficher le panneau, pour le diagnostic.
/// Tout se passe sur le fil principal.
final class MoteurVocal {
    static let shared = MoteurVocal()
    private init() {}

    static let raccourciParDefaut = "alt+space"
    /// Après la voix de Jarvis, l'écoute reprend ce délai plus tard (la fin du son ne doit pas être prise pour Eliot).
    static let repriseApresVoix: TimeInterval = 0.5
    static let repriseApresSon: TimeInterval = 0.35
    /// Un mot seul, en mains libres, n'est envoyé que s'il répond à une question dite ou suit de près la voix de Jarvis.
    static let delaiReplique: TimeInterval = 45
    /// Au-delà, « la session qui vient de parler » ne capte plus la dictée : elle va à la fenêtre au premier plan.
    static let fraicheurInterlocuteur: TimeInterval = 300
    static let dureeMaxAppui: TimeInterval = 90
    static let changement = Notification.Name("bt.vocal.changement")

    enum Priorite: String { case question, fin }

    final class Element {
        let numero: Int
        weak var session: Session?
        let projet: String, emoji: String
        let texte: String     // tel que reçu de la page (affichage)
        let aDire: String     // préfixé par le projet (« Cockpit : … »)
        let priorite: Priorite
        let questionId: String?
        let arrivee = Date()
        var audio: Synthese.Audio?
        var enPreparation = false
        /// Repères `[[n]]` (scène animée) : segments à dire, tour de la page (`cle`), étapes déjà envoyées.
        var segments: [(Int, String)]?
        var cle: String?
        /// Vrai tant que la page n'a pas signalé l'aperçu du tour prêt (`vocalPret`), 20 s au plus.
        var bloque = false
        var derniereEtape: Int?
        var etapeMax: Int { segments?.map { $0.0 }.max() ?? 0 }
        init(numero: Int, session: Session?, projet: String, emoji: String, texte: String, aDire: String, priorite: Priorite, questionId: String?) {
            self.numero = numero; self.session = session; self.projet = projet; self.emoji = emoji
            self.texte = texte; self.aDire = aDire; self.priorite = priorite; self.questionId = questionId
        }
        var sessionId: String { session?.sessionId ?? "" }
    }

    private(set) var actif = false
    private var file: [Element] = []
    private var enCours: Element?
    private var dernierDit: Element?
    private var enPause = false
    private var ecoute = false
    private var transcriptions = 0
    private var niveau: Float = 0
    /// Dernière session qui a parlé ou à qui Eliot a parlé.
    private weak var interlocuteur: Session?
    private var dateInterlocuteur = Date.distantPast
    /// À qui Eliot parle pendant l'écoute et la transcription (cible présumée, puis réelle).
    private weak var cible: Session?
    /// Question dite à voix haute et pas encore répondue, par session : la dictée suivante y répond.
    private var questionsDites: [ObjectIdentifier: String] = [:]
    private var derniereDictee: [String: Any]?
    private var erreur: String?
    private var compteur = 0
    private let micro = CaptureMicro()
    private var raccourciParler: RaccourciGlobal?
    // Écoute mains libres
    private let ecouteContinue = EcouteContinue()
    /// Eliot parle (énoncé détecté, pas encore fini) : la file attend. Un énoncé lâché en route (écoute fermée,
    /// micro rendu) efface son texte en direct.
    private var parleEliot = false {
        didSet { if oldValue && !parleEliot && directEcoute { abandonDirect("interrompu") } }
    }
    // Transcription en direct (bt.vocalDirect, 09/11/2026) : la page qui montre l'énoncé en cours et son numéro.
    private weak var pageDirect: Session?
    private var numeroDirect = 0
    /// L'énoncé est encore en cours (partiels attendus).
    private var directEcoute = false
    private var repriseA = Date.distantPast
    private var minuteurReprise: DispatchWorkItem?
    private var prochainEssaiEcoute = Date.distantPast
    private var finDerniereVoix = Date.distantPast
    private var gardeDuree: DispatchWorkItem?
    private var debutAppui = Date()
    private var demarre = false

    // Fin d'énoncé intelligente, raccord et coupure de parole (09/11/2026, « il répond à un message pas terminé »)
    /// Énoncé mains libres en cours de rassemblement : si Eliot reprend pendant la transcription, c'est le même
    /// énoncé ; les morceaux partent en un seul message quand plus aucune transcription n'est attendue.
    private final class Raccord {
        var morceaux: [String?] = []   // nil : transcription en cours
        var duree: Double = 0
        var dureeWhisper: TimeInterval = 0
        var finParole = Date()
        var echec: String?
        var suite = false              // commencé juste après un envoi à la même session (filet de la page)
        var numeroDirect = 0
        var attendus: Int { morceaux.filter { $0 == nil }.count }
        var texte: String { MoteurVocal.joindre(morceaux.compactMap { $0 }) }
    }
    private var raccord: Raccord?
    /// L'énoncé en cours appartient à `raccord` (repris pendant la transcription du précédent).
    private var enonceRaccorde = false
    /// Texte déjà montré en direct, mis devant les partiels d'une reprise (même bulle).
    private var prefixeDirect = ""
    private var texteDirect = ""
    private var attenteMontree = false
    private weak var derniereLivraison: Session?
    private var dateLivraison = Date.distantPast
    /// Eliot reprend moins de 3 s après un envoi : la page peut fusionner (si Claude n'a encore rien écrit).
    static let raccordApresEnvoi: TimeInterval = 3
    /// Réglage `BTCouperParole` : l'écoute reste ouverte pendant la voix de Jarvis, et Eliot peut la couper.
    var couperParole: Bool { Reglages.bool("BTCouperParole", defaut: true) }
    static func joindre(_ l: [String]) -> String {
        l.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: " ")
    }

    // Tests (pilote actif uniquement)
    var sourceSimulee: URL? {   // fichier audio à la place du micro (l'écoute continue repart sur le nouveau fichier)
        didSet {
            guard oldValue != sourceSimulee, ecouteContinue.enMarche else { return }
            ecouteContinue.arreter(); parleEliot = false
            DispatchQueue.main.async { [weak self] in self?.maj() }
        }
    }
    var muet = false          // volume 0 et pas de bips

    var etat: String {
        if !actif { return "inactif" }
        if ecoute || parleEliot { return "ecoute" }
        if transcriptions > 0 { return "transcription" }
        if enCours != nil { return "parle" }
        return "pret"
    }

    var combinaisonReglee: RaccourciGlobal.Combinaison {
        RaccourciGlobal.analyser(Reglages.texte("BTRaccourciParler") ?? "") ?? RaccourciGlobal.analyser(Self.raccourciParDefaut)!
    }

    var texteRaccourci: String { combinaisonReglee.texte }
    var raccourciPris: Bool { actif && raccourciParler.map { !$0.enregistre } ?? false }

    /// Réglage `BTMainsLibres` (menu Vocal → Écoute mains libres) : sinon, seulement ⌥Espace maintenu.
    var mainsLibres: Bool { Reglages.bool("BTMainsLibres", defaut: true) }

    // MARK: - Démarrage, marche / arrêt

    func demarrer() {
        guard !demarre else { return }
        demarre = true
        if PiloteDev.actif {
            let env = ProcessInfo.processInfo.environment
            muet = env["BT_DEV_MUET"] == "1"
            if let m = env["BT_DEV_MICRO"], m.hasPrefix("/") { sourceSimulee = URL(fileURLWithPath: m) }
        }
        micro.surNiveau = { [weak self] n in
            guard let self else { return }
            if let s = self.dicteePour { s.pousserDictee(["etat": "ecoute", "niveau": Double(n)]); return }
            guard self.ecoute else { return }
            self.niveau = n
            PanneauJarvis.shared.maj(self.etatPanneau())
        }
        ecouteContinue.surDebut = { [weak self] in self?.debutEnonce() }
        ecouteContinue.surFin = { [weak self] e in self?.finEnonce(e) }
        actif = Reglages.bool("BTModeVocal")
        if actif { installerRaccourciParler() }
        journal("vocal : mode \(actif ? "actif" : "coupé"), \(mainsLibres ? "mains libres" : "sans écoute continue"), raccourci \(texteRaccourci), micro \(sourceSimulee != nil ? "simulé" : AutorisationMicro.texte)\(muet ? ", muet" : "")")
        maj()
    }

    func activer(_ a: Bool, source: String) {
        guard a != actif else { maj(); return }
        actif = a
        Reglages.mettre(a, "BTModeVocal")
        journal("vocal : mode \(a ? "activé" : "coupé") (\(source))")
        if a {
            erreur = nil
            installerRaccourciParler()
            // la demande de macOS, une seule fois, au moment où Eliot allume le mode (pas en plein appui)
            if sourceSimulee == nil, AutorisationMicro.etat == .notDetermined {
                AutorisationMicro.demander { [weak self] ok in
                    if !ok { self?.erreur = Self.texteMicroRefuse }
                    self?.maj()
                }
            }
            prochainEssaiEcoute = .distantPast
        } else {
            toutArreter()
            raccourciParler?.retirer()
            PanneauJarvis.shared.masquer()   // mode coupé : le panneau quitte l'écran (demande d'Eliot, 07/11/2026)
        }
        maj()
    }

    /// Quitter l'app : silence, micro coupé, fichiers temporaires supprimés.
    func quitter() {
        toutArreter()
        raccourciParler?.retirer()
        Synthese.shared.toutNettoyer()
    }

    private func toutArreter() {
        Synthese.shared.arreter()
        if ecoute { micro.arreterSansResultat(); ecoute = false }
        ecouteContinue.arreter(); parleEliot = false
        minuteurReprise?.cancel(); minuteurReprise = nil
        gardeDuree?.cancel()
        for el in file { Synthese.shared.supprimer(el.audio) }
        if let el = enCours { Synthese.shared.supprimer(el.audio) }
        if let el = dernierDit { Synthese.shared.supprimer(el.audio) }
        file = []; enCours = nil; dernierDit = nil
        enPause = false; niveau = 0
        questionsDites = [:]
        cible = nil
    }

    func changerMainsLibres(_ a: Bool) {
        Reglages.mettre(a, "BTMainsLibres")
        journal("vocal : écoute mains libres \(a ? "activée" : "coupée")")
        prochainEssaiEcoute = .distantPast
        maj()
    }

    func changerRaccourci(_ cle: String) {
        guard let c = RaccourciGlobal.analyser(cle) else { journal("vocal : raccourci « \(cle) » non reconnu"); return }
        Reglages.mettre(c.cle, "BTRaccourciParler")
        if actif { installerRaccourciParler() }
        maj()
    }

    private func installerRaccourciParler() {
        let c = combinaisonReglee
        if let r = raccourciParler, r.combinaison == c, r.enregistre { return }
        raccourciParler?.retirer()
        let r = RaccourciGlobal(c) { [weak self] appui in
            if appui { self?.appui(source: "raccourci") } else { self?.relache(source: "raccourci") }
        }
        raccourciParler = r
        if r.enregistrer() { if erreur?.contains("déjà pris") == true { erreur = nil } }
        else {
            erreur = "\(c.texte) est déjà pris par une autre app : choisissez un autre raccourci dans le menu Vocal."
            notifier("Raccourci \(c.texte) indisponible", "Une autre app l'utilise. Menu Vocal → Raccourci pour parler.")
        }
    }

    static let texteMicroRefuse = "Micro refusé : System Settings → Privacy & Security → Microphone → Jarvis Terminal."

    // MARK: - Page → file d'attente

    /// Délai maximum d'attente de l'aperçu d'un vocal à repères avant de parler quand même.
    static let attenteApercuMax: TimeInterval = 20

    func ajouter(de s: Session, texte brut: String, priorite: Priorite, questionId: String?, cle: String? = nil, attendre: Bool = false) {
        guard actif else { journal("vocal : « \(priorite.rawValue) » de \(s.projet.nom) ignoré (mode coupé)"); return }
        let texte = String(brut.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1500))
        guard !texte.isEmpty else { return }
        if let q = questionId {   // nouvelle version de la même question (« Je n'ai pas compris… ») : remplace l'ancienne
            file.removeAll { el in
                let r = el.questionId == q && el.session === s
                if r { Synthese.shared.supprimer(el.audio) }
                return r
            }
        }
        compteur += 1
        var segments = Synthese.segments(texte)
        let affiche = segments == nil ? texte : Synthese.sansReperes(texte)
        let nom = doitAnnoncer(s) ? Self.nomCourt(s) : nil
        let aDire = Self.prefixer(affiche, nom: nom)
        if segments != nil, aDire != affiche { segments![0].1 = Self.prefixer(segments![0].1, nom: nom) }
        let el = Element(numero: compteur, session: s, projet: s.projet.nom, emoji: s.projet.emoji, texte: affiche,
                         aDire: aDire, priorite: priorite, questionId: questionId)
        el.segments = segments
        el.cle = cle
        if segments != nil, attendre {
            el.bloque = true
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.attenteApercuMax) { [weak self, weak el] in
                guard let self, let el, el.bloque else { return }
                el.bloque = false
                journal("vocal : n°\(el.numero) aperçu pas prêt après \(Int(Self.attenteApercuMax)) s, voix lancée quand même")
                self.maj(); self.avancer()
            }
        }
        inserer(el)
        journal("vocal : + \(priorite.rawValue) n°\(el.numero) de \(s.projet.nom)\(questionId.map { " (question \($0))" } ?? "") → \(file.count) en file")
        prefetch(); maj(); avancer()
    }

    /// Message de l'app elle-même (« Aucune session ouverte. »), dit sans préfixe, avant le reste.
    private func direSysteme(_ texte: String) {
        compteur += 1
        let el = Element(numero: compteur, session: nil, projet: "Jarvis Terminal", emoji: "🎙️", texte: texte, aDire: texte,
                         priorite: .question, questionId: nil)
        file.insert(el, at: 0)
        journal("vocal : message de l'app « \(texte) »")
        prefetch(); maj(); avancer()
    }

    /// Nom du projet dit seulement quand une AUTRE session prend la parole (09/11/2026, demande d'Eliot) :
    /// pas de nom pour la session à qui Eliot vient de parler (ou qui vient de parler), ni pour celle qui est devant.
    private func doitAnnoncer(_ s: Session) -> Bool {
        if let i = interlocuteur, i === s, Date().timeIntervalSince(dateInterlocuteur) < Self.fraicheurInterlocuteur { return false }
        if NSApp.isActive, s.fenetreDevant { return false }
        return true
    }

    /// Nom court et naturel : « ton autre discussion », « le terminal », sinon le nom du projet sans sa queue
    /// (« … For Claude », « … - … »).
    static func nomCourt(_ s: Session) -> String {
        if estDiscussion(s) { return "ton autre discussion" }
        return nomCourt(projet: s.projet.nom)
    }

    static func nomCourt(projet: String) -> String {
        let n = Routage.normaliser(projet)
        if n.contains("terminal") { return "le terminal" }
        var t = projet
        for sep in [" For ", " for ", " pour ", " - ", " — "] { if let r = t.range(of: sep) { t = String(t[..<r.lowerBound]) } }
        t = t.replacingOccurrences(of: "[-_]", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        return t.isEmpty ? projet : t
    }

    /// Avec un nom : « Cockpit : … » ou « Cockpit te demande : … ». Sans nom : la phrase seule, et
    /// « te demande … » (question écrite par la page) devient « Je te demande … ».
    static func prefixer(_ t: String, nom: String?) -> String {
        let demande = Routage.normaliser(t).hasPrefix("te demande")
        guard let nom, !nom.isEmpty else {
            guard demande else { return t }
            return "Je " + t.replacingOccurrences(of: "valider son plan", with: "valider mon plan")
        }
        let n = Routage.normaliser(nom)
        if Routage.normaliser(t).hasPrefix(n) { return t }
        if demande { return (nom.prefix(1).uppercased() + nom.dropFirst()) + " " + t }
        return (nom.prefix(1).uppercased() + nom.dropFirst()) + " : " + t
    }

    private func inserer(_ el: Element) {
        if el.priorite == .question, let i = file.firstIndex(where: { $0.priorite == .fin }) { file.insert(el, at: i) }
        else { file.append(el) }
    }

    func annuler(questionId q: String, session s: Session?) {
        var retire = 0
        file.removeAll { el in
            let r = el.questionId == q && (s == nil || el.session === s)
            if r { Synthese.shared.supprimer(el.audio); retire += 1 }
            return r
        }
        var coupe = false
        if let el = enCours, el.questionId == q, s == nil || el.session === s { Synthese.shared.arreter(); terminer(el); coupe = true }
        if let s, questionsDites[ObjectIdentifier(s)] == q { questionsDites[ObjectIdentifier(s)] = nil }
        if retire > 0 || coupe { journal("vocal : question \(q) retirée (\(retire) en file\(coupe ? ", voix coupée" : ""))") }
        maj(); avancer()
    }

    /// La page a rendu l'aperçu du tour `cle` (ou n'en aura pas) : sa voix peut partir.
    func apercuPret(de s: Session, cle: String) {
        var n = 0
        for el in file where el.session === s && el.cle == cle && el.bloque { el.bloque = false; n += 1 }
        if n > 0 { journal("vocal : aperçu prêt pour \(s.projet.nom), voix libérée") }
        maj(); avancer()
    }

    func sessionFermee(_ s: Session) {
        if dicteePour === s { dicteeFin(s, annuler: true) }
        file.removeAll { el in
            let r = el.session === s
            if r { Synthese.shared.supprimer(el.audio) }
            return r
        }
        if let el = enCours, el.session === s { Synthese.shared.arreter(); terminer(el) }
        questionsDites[ObjectIdentifier(s)] = nil
        if interlocuteur === s { interlocuteur = nil }
        if cible === s { cible = nil }
        maj(); avancer()
    }

    // MARK: - Lecture de la file

    private func avancer() {
        guard actif, enCours == nil, !ecoute, !parleEliot, transcriptions == 0, !enPause,
              let i = file.firstIndex(where: { !$0.bloque }) else { prefetch(); return }
        let el = file.remove(at: i)
        enCours = el
        if let s = el.session { interlocuteur = s; dateInterlocuteur = Date() }
        if el.priorite == .question, let q = el.questionId, let s = el.session { questionsDites[ObjectIdentifier(s)] = q }
        maj()
        lancer(el)
        prefetch()
    }

    private func lancer(_ el: Element) {
        guard enCours === el else { return }
        guard let a = el.audio else { preparer(el); return }   // rappelé quand l'audio est prêt
        var surEtape: ((Int) -> Void)?
        if el.segments != nil {
            el.derniereEtape = nil
            surEtape = { [weak el] n in
                guard let el, n != el.derniereEtape else { return }
                el.derniereEtape = n
                el.session?.envoyerVocalEtape(n, cle: el.cle)
            }
            surEtape?(0)   // (re)départ : l'aperçu revient à l'étape 0
        }
        if !Synthese.shared.jouer(a, volume: muet ? 0 : 1, surEtape: surEtape, fini: { [weak self] in self?.finLecture(el) }) { finLecture(el) }
    }

    private func preparer(_ el: Element) {
        guard el.audio == nil, !el.enPreparation else { return }
        el.enPreparation = true
        Environnement.charger { env in
            Synthese.shared.preparer(el.aDire, segments: el.segments, env: env) { [weak self] a in
                el.enPreparation = false
                guard let self else { return }
                guard self.enCours === el || self.dernierDit === el || self.file.contains(where: { $0 === el }) else {
                    Synthese.shared.supprimer(a); return   // retiré entre-temps
                }
                el.audio = a
                if a == nil {
                    journal("vocal : aucune voix disponible pour n°\(el.numero), élément sauté")
                    self.erreur = "Aucune voix disponible (edge-tts et say en échec)."
                    if self.enCours === el { self.terminer(el); self.maj(); self.avancer() }
                    return
                }
                if self.enCours === el { self.lancer(el) }
            }
        }
    }

    /// L'élément en cours et les trois suivants se préparent pendant la lecture : edge-tts répond en 1 s
    /// en général, mais parfois en 5 s ; un seul élément d'avance laissait des blancs.
    private func prefetch() {
        guard actif else { return }
        if let el = enCours, el.audio == nil { preparer(el) }
        for p in file.prefix(3) { preparer(p) }
    }

    private func finLecture(_ el: Element) {
        guard enCours === el else { return }
        terminer(el)
        maj(); avancer()
    }

    private func terminer(_ el: Element) {
        // Voix coupée, passée ou finie : l'aperçu va à sa dernière étape (jamais d'animation laissée en plan).
        if el.segments != nil, el.derniereEtape != nil, el.derniereEtape != el.etapeMax {
            el.derniereEtape = el.etapeMax
            el.session?.envoyerVocalEtape(el.etapeMax, cle: el.cle)
        }
        if enCours === el { enCours = nil; finDerniereVoix = Date(); differerEcoute(Self.repriseApresVoix) }
        if let d = dernierDit, d !== el { Synthese.shared.supprimer(d.audio); d.audio = nil }
        dernierDit = el
    }

    // MARK: - Panneau : passer, rejouer, couper, reprendre

    /// Ce qui est dit s'arrête et la file passe au suivant (en pause : retire le premier de la file).
    func passer() {
        if let el = enCours { Synthese.shared.arreter(); terminer(el) }
        else if enPause, !file.isEmpty { Synthese.shared.supprimer(file.removeFirst().audio) }
        enPause = false
        journal("vocal : passer")
        maj(); avancer()
    }

    /// Redit le dernier élément (ou reprend du début celui en cours).
    func rejouer() {
        guard actif else { return }
        let el: Element
        if let c = enCours { Synthese.shared.arreter(); el = c }
        else if let d = dernierDit { el = d }
        else { return }
        enPause = false
        enCours = el
        if let s = el.session { interlocuteur = s; dateInterlocuteur = Date() }
        journal("vocal : rejouer n°\(el.numero)")
        maj(); lancer(el)
    }

    /// Silence tout de suite ; la file attend (« reprendre », « passer », « rejouer » ou la prochaine dictée).
    func couper() {
        if let el = enCours { Synthese.shared.arreter(); terminer(el) }
        enPause = true
        journal("vocal : couper (file en pause, \(file.count) en attente)")
        maj()
    }

    func reprendre() {
        enPause = false
        maj(); avancer()
    }

    // MARK: - Parler : appui et relâchement

    func appui(source: String) {
        guard actif, !ecoute, dicteePour == nil else { return }
        if let el = enCours {   // un appui pendant que l'app parle coupe la voix
            Synthese.shared.arreter()
            terminer(el)
            journal("vocal : voix coupée par l'appui")
        }
        if sourceSimulee == nil {
            switch AutorisationMicro.etat {
            case .authorized: break
            case .notDetermined:
                erreur = "Autorisez le micro dans la fenêtre de macOS, puis maintenez de nouveau \(texteRaccourci)."
                AutorisationMicro.demander { [weak self] ok in
                    self?.erreur = ok ? nil : Self.texteMicroRefuse
                    self?.maj()
                }
                maj(); avancer(); return
            default:
                erreur = Self.texteMicroRefuse
                son(.echec); maj(); avancer(); return
            }
        }
        cible = ciblePresumee()
        // le micro passe de l'écoute continue à l'appui (un énoncé commencé est abandonné : l'appui reprend de zéro)
        ecouteContinue.arreter(); parleEliot = false
        let url = Synthese.shared.dossier.appendingPathComponent("dictee-" + UUID().uuidString.prefix(8).lowercased() + ".wav")
        do { try micro.demarrer(vers: url, source: sourceSimulee) }
        catch {
            journal("vocal : micro impossible — \(error)")
            erreur = "Micro : \(error)"
            son(.echec); maj(); avancer(); return
        }
        erreur = nil
        ecoute = true
        enPause = false   // parler relance la file après la dictée
        debutAppui = Date()
        niveau = 0
        son(.debut)
        commencerDirect(source: "raccourci") { [weak self] in self?.micro.echantillons() ?? [] }
        let garde = DispatchWorkItem { [weak self] in self?.relache(source: "durée maximale") }
        gardeDuree = garde
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.dureeMaxAppui, execute: garde)
        journal("vocal : écoute (\(source)), cible présumée \(cible?.projet.nom ?? "aucune")")
        maj()
    }

    func relache(source: String) {
        guard ecoute else { return }
        ecoute = false
        gardeDuree?.cancel(); gardeDuree = nil
        niveau = 0
        guard let r = micro.arreter() else { abandonDirect("micro"); maj(); avancer(); return }
        let tenu = Date().timeIntervalSince(debutAppui)
        journal("vocal : relâché (\(source)) après \(String(format: "%.2f", tenu)) s : \(String(format: "%.2f", r.duree)) s d'audio, niveau max \(String(format: "%.2f", r.niveauMax))")
        if r.duree < 0.4 {   // simple tape : la voix est coupée, rien à transcrire
            abandonDirect("court")
            try? FileManager.default.removeItem(at: r.url)
            cible = nil
            maj(); avancer(); return
        }
        if r.niveauMax < 0.12 {
            abandonDirect("silence")
            try? FileManager.default.removeItem(at: r.url)
            erreur = "Rien entendu (micro muet ?)."
            cible = nil
            son(.echec); maj(); avancer(); return
        }
        transcriptionDirecte()
        transcriptions += 1
        maj()
        if let d = PiloteDev.dossier {   // tests : la dernière dictée reste lisible pour le diagnostic
            let copie = URL(fileURLWithPath: d + "/derniere-dictee.wav")
            try? FileManager.default.removeItem(at: copie)
            try? FileManager.default.copyItem(at: r.url, to: copie)
        }
        transcrireEtRouter(r.url, duree: r.duree, mainsLibres: false)
    }

    /// Whisper, filtre, puis routage. `transcriptions` a déjà été incrémenté par l'appelant.
    private func transcrireEtRouter(_ url: URL, duree: Double, mainsLibres ml: Bool) {
        let vocabulaire = RegistreSessions.shared.sessions.filter { !$0.estFermee }.map(\.projet.nom)
        let finParole = Date()
        let numero = numeroDirect   // l'énoncé montré en direct ; un appui pendant la transcription en ouvre un autre
        Environnement.charger { env in
            Transcription.transcrire(url, dureeAudio: duree, vocabulaire: vocabulaire, env: env) { [weak self] res in
                try? FileManager.default.removeItem(at: url)
                guard let self else { return }
                self.transcriptions -= 1
                let direct = numero == self.numeroDirect
                guard self.actif else { if direct { self.abandonDirect("mode coupé") }; self.maj(); return }
                switch res {
                case .failure(let e):
                    self.erreur = "Transcription : \(e)"
                    self.son(.echec)
                case .success(let t):
                    let replique = !self.questionsDites.isEmpty || Date().timeIntervalSince(self.finDerniereVoix) < Self.delaiReplique
                    if let raison = Self.aIgnorer(t.texte, mainsLibres: ml, replique: replique) {
                        journal("vocal : « \(extrait(t.texte, 80)) » ignoré (\(raison))")
                        if !ml { self.erreur = "Rien compris."; self.son(.echec) }   // en mains libres : silence, rien à signaler
                    } else {
                        self.erreur = nil
                        self.router(t.texte, latence: Date().timeIntervalSince(finParole), dureeWhisper: t.duree, direct: direct)
                    }
                }
                // rien livré à la page qui montrait l'énoncé (filtré, erreur, autre session) : son texte s'efface
                if direct { self.abandonDirect("non livré") }
                if self.transcriptions == 0 && !self.ecoute && !self.parleEliot { self.cible = nil }
                self.maj(); self.avancer()
            }
        }
    }

    // MARK: - Écoute mains libres

    /// Ce que whisper rend sur du bruit, ou ce qu'on dit à quelqu'un d'autre : pas envoyé. Renvoie la raison.
    /// Mains libres : un mot seul n'est gardé que s'il répond à Jarvis (question dite, ou voix de Jarvis récente).
    static func aIgnorer(_ texte: String, mainsLibres: Bool, replique: Bool) -> String? {
        let mots = Routage.mots(texte)
        if mots.isEmpty { return "vide" }
        if mots.count <= 3, mots.allSatisfy({ Self.remplissage.contains($0) }) { return "remplissage" }
        if mainsLibres, mots.count == 1, !replique { return "un seul mot, sans question ni voix de Jarvis récente" }
        return nil
    }

    static let remplissage: Set<String> = ["euh", "heu", "hum", "hmm", "mmh", "mh", "ah", "oh", "eh", "bah", "ben", "hein",
                                           "merci", "beaucoup", "bon", "voila", "alors", "donc", "bref", "ouais", "pff"]

    /// Ouvre, ferme, démarre ou arrête l'écoute continue selon l'état. Appelée à chaque `maj()`.
    private func ajusterEcoute() {
        let microOk = sourceSimulee != nil || AutorisationMicro.etat == .authorized
        let doitTourner = actif && mainsLibres && microOk && dicteePour == nil && !ecoute && !micro.enCours
        if !doitTourner {
            if ecouteContinue.enMarche { ecouteContinue.arreter() }
            parleEliot = false
            if actif && mainsLibres && !microOk && sourceSimulee == nil && AutorisationMicro.etat != .notDetermined {
                erreur = Self.texteMicroRefuse
            }
            return
        }
        if !ecouteContinue.enMarche {
            guard Date() >= prochainEssaiEcoute else { return }
            ecouteContinue.surPause = { [weak self] p in self?.pauseEnonce(p) }
            ecouteContinue.surReprise = { [weak self] in self?.repriseEnonce() }
            // anti-écho : niveau joué, sauf au casque (le micro ne l'entend pas : coupure plus réactive)
            ecouteContinue.niveauEcho = { SortieAudio.casque() ? nil : Synthese.shared.niveauSortie() }
            do { try ecouteContinue.demarrer(source: sourceSimulee); if erreur?.hasPrefix("Micro") == true { erreur = nil } }
            catch {
                journal("écoute : micro impossible — \(error)")
                erreur = "Micro : \(error)"
                prochainEssaiEcoute = Date().addingTimeInterval(15)   // pas de nouvel essai à chaque maj()
                return
            }
        }
        // 09/11/2026 : ouverte pendant la transcription (Eliot reprend : même énoncé) et, avec `BTCouperParole`,
        // pendant la voix de Jarvis ; jamais fermée en plein énoncé.
        let voix = enCours != nil || Synthese.shared.parle
        let ouvrir = parleEliot || (Date() >= repriseA && (!voix || couperParole))
        ecouteContinue.ouvrir(ouvrir)
        if !ouvrir { parleEliot = false }
        if let r = raccord, !parleEliot, r.attendus == 0 {   // énoncé lâché en route : ce qui est transcrit part
            enonceRaccorde = false
            DispatchQueue.main.async { [weak self] in self?.finirRaccord() }
        }
    }

    /// Ferme l'écoute au moins `d` secondes (fin de la voix de Jarvis, son de l'app), puis la rouvre.
    private func differerEcoute(_ d: TimeInterval) {
        guard !parleEliot else { return }   // Eliot parle (il a coupé Jarvis) : on ne lui coupe pas le micro
        let a = Date().addingTimeInterval(d)
        guard a > repriseA else { return }
        repriseA = a
        ecouteContinue.ouvrir(false)
        minuteurReprise?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.minuteurReprise = nil; self?.maj() }
        minuteurReprise = w
        DispatchQueue.main.asyncAfter(deadline: .now() + d + 0.02, execute: w)
    }

    /// Libère le micro pour la dictée de la saisie (Espace maintenu), qui a la priorité ; l'écoute continue
    /// reprend d'elle-même au `maj()` qui suit la fin de la dictée (ou tout de suite si elle n'a pas démarré).
    func libererMicroPourDictee() {
        guard ecouteContinue.enMarche else { return }
        ecouteContinue.arreter(); parleEliot = false
        DispatchQueue.main.async { [weak self] in self?.maj() }
    }

    private func debutEnonce() {
        guard actif, !parleEliot else { return }
        parleEliot = true
        interrompreParEliot()
        enPause = false   // parler relance la file après la dictée
        attenteMontree = false
        let audio: () -> [Int16] = { [weak self] in self?.ecouteContinue.echantillonsEnonce() ?? [] }
        if let r = raccord {
            // reprise pendant la transcription du morceau précédent : même énoncé, même bulle, même cible
            enonceRaccorde = true
            if r.numeroDirect == numeroDirect && !directEcoute {
                prefixeDirect = texteDirect
                directEcoute = true
                envoyerDirect(["etat": "reprise"])
                demarrerPartiels(audio)
            }
            journal("vocal : Eliot reprend pendant la transcription, même énoncé")
        } else {
            cible = ciblePresumee()
            let r = Raccord()
            r.suite = cible != nil && cible === derniereLivraison && Date().timeIntervalSince(dateLivraison) <= Self.raccordApresEnvoi
            raccord = r
            enonceRaccorde = true
            commencerDirect(source: "mainsLibres", extra: r.suite ? ["suite": true] : [:], audio: audio)
            r.numeroDirect = numeroDirect
            journal("vocal : parole détectée, cible présumée \(cible?.projet.nom ?? "aucune")\(r.suite ? ", suite du message envoyé" : "")")
        }
        maj()
    }

    /// Eliot parle par-dessus Jarvis : la voix s'arrête net, le reste de ce message est abandonné (la file attend
    /// la fin de son énoncé, puis reprend avec les messages suivants).
    func interrompreParEliot() {
        if let el = enCours {
            Synthese.shared.arreter(); terminer(el)
            journal("vocal : Eliot coupe la parole à Jarvis (sortie \(SortieAudio.nom()))")
        } else if Synthese.shared.parle {
            Synthese.shared.arreter()
        }
    }

    /// Silence de `silencePause` dans l'énoncé : texte frais de whisper-server, puis verdict (phrase finie : coupe
    /// à `silenceComplet` ; inachevée : attend jusqu'à `silenceInacheve` ; pas de texte à temps : `silenceFin`).
    private func pauseEnonce(_ p: DecoupeurEnonces.Pause) {
        guard parleEliot else { return }
        let reg = ParametresEcoute.depuis(Reglages.d)
        let delai = max(0.3, reg.silenceComplet - reg.silencePause - 0.05)
        let debut = Date()
        DicteeDirecte.shared.texteFrais(min: p.echantillonsParole, delai: delai) { [weak self] t in
            guard let self, self.parleEliot else { return }
            let attente = String(format: "%.2f", Date().timeIntervalSince(debut))
            guard let t, !t.trimmingCharacters(in: .whitespaces).isEmpty else {
                journal("vocal : pause \(p.numero), pas de texte à temps (\(attente) s) : fin à \(reg.silenceFin) s")
                return
            }
            let raison = FinPhrase.inachevee(t)
            let pris = self.ecouteContinue.verdict(pause: p.numero, inacheve: raison != nil)
            journal("vocal : pause \(p.numero), « …\(String(t.suffix(40))) » \(raison.map { "inachevé (\($0))" } ?? "fini") en \(attente) s\(pris ? "" : ", trop tard")")
            if raison != nil && pris {
                self.attenteMontree = true
                self.envoyerDirect(["etat": "attente"])
            }
        }
    }

    private func repriseEnonce() {
        guard parleEliot, attenteMontree else { return }
        attenteMontree = false
        envoyerDirect(["etat": "reprise"])
    }

    private func finEnonce(_ e: DecoupeurEnonces.Enonce) {
        guard parleEliot else { return }
        transcriptionDirecte()   // avant parleEliot = false : l'énoncé est fini, pas abandonné
        parleEliot = false
        enonceRaccorde = false
        attenteMontree = false
        journal("vocal : fin d'énoncé, \(String(format: "%.2f", e.duree)) s d'audio, \(String(format: "%.2f", e.voix)) s de voix, \(e.pauses) pause(s) reprise(s), clos après \(String(format: "%.1f", e.silence)) s de silence, max \(Int(e.niveauMaxDb)) dB, bruit \(Int(e.bruitDb)) dB\(e.coupe ? ", coupé à la durée maximale" : "")")
        let r = raccord ?? Raccord()
        raccord = r
        let url = Synthese.shared.dossier.appendingPathComponent("ecoute-" + UUID().uuidString.prefix(8).lowercased() + ".wav")
        do { try DecoupeurEnonces.ecrireWAV(e.echantillons, vers: url) }
        catch {
            journal("vocal : énoncé non écrit — \(error)")
            maj(); finirRaccord(); return
        }
        if let d = PiloteDev.dossier {   // tests : le dernier énoncé reste lisible pour le diagnostic
            let copie = URL(fileURLWithPath: d + "/dernier-enonce.wav")
            try? FileManager.default.removeItem(at: copie)
            try? FileManager.default.copyItem(at: url, to: copie)
        }
        let i = r.morceaux.count
        r.morceaux.append(nil)
        r.duree += e.duree
        r.finParole = Date()
        transcriptions += 1
        maj()
        let vocabulaire = RegistreSessions.shared.sessions.filter { !$0.estFermee }.map(\.projet.nom)
        Environnement.charger { env in
            Transcription.transcrire(url, dureeAudio: e.duree, vocabulaire: vocabulaire, env: env) { [weak self] res in
                try? FileManager.default.removeItem(at: url)
                guard let self else { return }
                self.transcriptions -= 1
                switch res {
                case .failure(let err): r.morceaux[i] = ""; r.echec = "\(err)"
                case .success(let t): r.morceaux[i] = t.texte; r.dureeWhisper += t.duree
                }
                guard self.raccord === r else { self.maj(); return }
                self.finirRaccord()
            }
        }
    }

    /// Plus rien d'attendu (ni transcription, ni énoncé raccordé en cours) : un seul message part.
    private func finirRaccord() {
        guard let r = raccord, r.attendus == 0, !(parleEliot && enonceRaccorde) else { maj(); avancer(); return }
        raccord = nil
        let direct = r.numeroDirect == numeroDirect && !directEcoute
        defer {
            if direct { abandonDirect("non livré") }   // livré : `finirDirect` a déjà rendu la page
            if transcriptions == 0 && !ecoute && !parleEliot { cible = nil }
            maj(); avancer()
        }
        guard !r.morceaux.isEmpty else { return }
        guard actif else { return }
        let texte = r.texte
        if texte.isEmpty, let e = r.echec { erreur = "Transcription : \(e)"; son(.echec); return }
        let replique = !questionsDites.isEmpty || Date().timeIntervalSince(finDerniereVoix) < Self.delaiReplique
        if let raison = Self.aIgnorer(texte, mainsLibres: true, replique: replique) {
            journal("vocal : « \(extrait(texte, 80)) » ignoré (\(raison))")
            return
        }
        erreur = nil
        if r.morceaux.count > 1 { journal("vocal : \(r.morceaux.count) morceaux raccordés en un message") }
        router(texte, latence: Date().timeIntervalSince(r.finParole), dureeWhisper: r.dureeWhisper, direct: direct, suite: r.suite)
    }

    // MARK: - Dictée dans la saisie (Espace maintenu, comme dans Claude Code ; 08/11/2026)
    // Indépendante du mode Jarvis : le texte va dans la saisie de la session, Eliot le relit et l'envoie.
    // Page → Swift : `dictee {action: "debut"|"fin"|"annuler"}` ; Swift → page : `bt.dictee({etat, niveau?, texte?, erreur?})`
    // avec etat = ecoute | transcription | fini | erreur | annule.

    private weak var dicteePour: Session?
    private var gardeDictee: DispatchWorkItem?

    func dicteeDebut(_ s: Session) {
        demarrer()
        libererMicroPourDictee()   // l'écoute mains libres du mode Jarvis rend le micro à la dictée
        if dicteePour != nil || ecoute || micro.enCours { s.pousserDictee(["etat": "erreur", "erreur": "Le micro est déjà pris."]); return }
        if let el = enCours { Synthese.shared.arreter(); terminer(el) }   // parler coupe Jarvis
        if sourceSimulee == nil {
            switch AutorisationMicro.etat {
            case .authorized: break
            case .notDetermined:
                s.pousserDictee(["etat": "erreur", "erreur": "Autorise le micro dans la fenêtre de macOS, puis maintiens de nouveau Espace."])
                AutorisationMicro.demander { _ in }
                return
            default:
                s.pousserDictee(["etat": "erreur", "erreur": Self.texteMicroRefuse]); return
            }
        }
        let url = Synthese.shared.dossier.appendingPathComponent("saisie-" + UUID().uuidString.prefix(8).lowercased() + ".wav")
        do { try micro.demarrer(vers: url, source: sourceSimulee) }
        catch {
            journal("dictée : micro impossible — \(error)")
            s.pousserDictee(["etat": "erreur", "erreur": "Micro : \(error)"]); return
        }
        dicteePour = s
        debutAppui = Date()
        let garde = DispatchWorkItem { [weak self, weak s] in if let s { self?.dicteeFin(s, annuler: false) } }
        gardeDictee = garde
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.dureeMaxAppui, execute: garde)
        s.pousserDictee(["etat": "ecoute", "niveau": 0])
        DicteeDirecte.shared.commencer(pour: s) { [weak self] in self?.micro.echantillons() ?? [] }
        journal("dictée : écoute pour \(s.projet.nom)")
        maj()
    }

    func dicteeFin(_ s: Session, annuler: Bool) {
        guard let d = dicteePour, d === s else { return }
        dicteePour = nil
        gardeDictee?.cancel(); gardeDictee = nil
        DicteeDirecte.shared.arreter()
        guard let r = micro.arreter() else { s.pousserDictee(["etat": "annule"]); maj(); return }
        journal("dictée : relâchée après \(String(format: "%.2f", Date().timeIntervalSince(debutAppui))) s, \(String(format: "%.2f", r.duree)) s d'audio, niveau max \(String(format: "%.2f", r.niveauMax))\(annuler ? ", annulée" : "")")
        if annuler || r.duree < 0.3 {
            try? FileManager.default.removeItem(at: r.url)
            s.pousserDictee(["etat": "annule"]); maj(); return
        }
        if r.niveauMax < 0.12 {
            try? FileManager.default.removeItem(at: r.url)
            s.pousserDictee(["etat": "erreur", "erreur": "Rien entendu : le micro ne capte aucun son."]); maj(); return
        }
        s.pousserDictee(["etat": "transcription"])
        let vocabulaire = RegistreSessions.shared.sessions.filter { !$0.estFermee }.map(\.projet.nom)
        Environnement.charger { env in
            Transcription.transcrire(r.url, dureeAudio: r.duree, vocabulaire: vocabulaire, env: env) { [weak s] res in
                try? FileManager.default.removeItem(at: r.url)
                guard let s else { return }
                switch res {
                case .failure(let e): s.pousserDictee(["etat": "erreur", "erreur": "Transcription : \(e)"])
                case .success(let t):
                    journal("dictée : « \(extrait(t.texte, 80)) » (whisper \(String(format: "%.2f", t.duree)) s)")
                    s.pousserDictee(t.texte.isEmpty ? ["etat": "erreur", "erreur": "Rien compris."] : ["etat": "fini", "texte": t.texte])
                }
            }
        }
        maj()
    }

    // MARK: - Transcription en direct vers la page (bt.vocalDirect, 09/11/2026)
    // Pendant un énoncé (mains libres ou ⌥Espace), whisper-server retranscrit en boucle l'audio déjà capté et la
    // page de la cible présumée affiche les mots en direct. Puis : « transcription » (énoncé fini, whisper-cli
    // tourne), « fini » (texte retenu, juste avant bt.transcription) ou « annule » (filtré, bruit, autre session).

    private func commencerDirect(source: String, extra: [String: Any] = [:], audio: @escaping () -> [Int16]) {
        if pageDirect != nil || directEcoute { abandonDirect("relance") }
        numeroDirect += 1
        pageDirect = cible   // sans page, les partiels tournent quand même (verdicts de fin d'énoncé)
        directEcoute = true
        prefixeDirect = ""; texteDirect = ""
        var d = extra
        d["etat"] = "debut"; d["source"] = source
        envoyerDirect(d)
        demarrerPartiels(audio)
    }

    private func demarrerPartiels(_ audio: @escaping () -> [Int16]) {
        let n = numeroDirect
        DicteeDirecte.shared.commencer(audio: audio) { [weak self] t in
            guard let self, self.directEcoute, self.numeroDirect == n else { return }
            self.texteDirect = Self.joindre([self.prefixeDirect, t])
            self.envoyerDirect(["etat": "partiel", "texte": self.texteDirect])
        }
    }

    private func transcriptionDirecte() {
        guard directEcoute else { return }
        directEcoute = false
        DicteeDirecte.shared.arreter()
        envoyerDirect(["etat": "transcription"])
    }

    private func abandonDirect(_ raison: String) {
        if directEcoute { directEcoute = false; DicteeDirecte.shared.arreter() }
        guard pageDirect != nil else { return }
        envoyerDirect(["etat": "annule", "raison": raison])
        pageDirect = nil
    }

    /// Texte retenu et livré à `s` : la page qui montrait l'énoncé le fige (sa bulle devient celle du message) ;
    /// livré à une autre session, elle l'efface.
    private func finirDirect(livreA s: Session, texte: String, questionId: String?) {
        guard let p = pageDirect else { return }
        guard p === s else { abandonDirect("ailleurs"); return }
        var d: [String: Any] = ["etat": "fini", "texte": texte]
        if let q = questionId { d["questionId"] = q }
        envoyerDirect(d)
        pageDirect = nil
    }

    private func envoyerDirect(_ d: [String: Any]) {
        guard let s = pageDirect, !s.estFermee, !s.dansTerminal else { return }
        var a = d
        a["id"] = numeroDirect
        s.vueDev.appelerFonction("vocalDirect", a) { _ in }
    }

    // MARK: - Routage de la dictée

    private var sessionsOuvertes: [Session] { RegistreSessions.shared.sessions.filter { !$0.estFermee && !$0.dansTerminal } }

    private func interlocuteurRecent() -> Session? {
        guard let s = interlocuteur, !s.estFermee, !s.dansTerminal,
              Date().timeIntervalSince(dateInterlocuteur) < Self.fraicheurInterlocuteur else { return nil }
        return preferer(s, parmi: sessionsOuvertes.filter { $0.projet.nom == s.projet.nom })
    }

    /// Plusieurs sessions du même projet (les discussions : même dossier, même nom) : si Eliot en a affiché une
    /// autre depuis le dernier échange vocal, c'est à elle qu'il parle, pas à celle qui a parlé avant (09/11/2026).
    private func preferer(_ i: Session, parmi l: [Session]) -> Session {
        guard let p = premierPlan(l), p !== i, p.derniereActivation > dateInterlocuteur else { return i }
        return p
    }

    static func estDiscussion(_ s: Session) -> Bool { s.cwd == cheminReel(Entrees.dossierDiscussions) }

    /// La fenêtre au premier plan si l'app est devant, sinon la dernière fenêtre de session regardée.
    private func premierPlan(_ l: [Session]) -> Session? {
        if NSApp.isActive, let k = l.first(where: { $0.fenetreDevant }) { return k }
        return l.max { $0.derniereActivation < $1.derniereActivation }
    }

    private func ciblePresumee() -> Session? { interlocuteurRecent() ?? premierPlan(sessionsOuvertes) }

    /// Plusieurs sessions du même projet : celle qui a parlé en dernier, sinon la dernière regardée.
    private func meilleure(_ l: [Session]) -> Session? {
        if let i = interlocuteur, l.contains(where: { $0 === i }) { return preferer(i, parmi: l) }
        return premierPlan(l)
    }

    private func router(_ texte: String, latence: TimeInterval, dureeWhisper: TimeInterval, direct: Bool = false, suite: Bool = false) {
        let ouvertes = sessionsOuvertes
        var dest: Session?
        var aEnvoyer = texte
        var raison = ""
        // Les discussions (toutes dans ~/Claude-Discussions) ne se nomment que « Discussion » : le nom du dossier
        // ferait prendre « Claude, … » pour elles.
        let candidats = ouvertes.map { Self.estDiscussion($0) ? [$0.projet.nom] : [$0.projet.nom, ($0.cwd as NSString).lastPathComponent] }
        if let c = Routage.nomEnTete(texte, candidats: candidats) {
            let nom = ouvertes[c.index].projet.nom
            dest = meilleure(ouvertes.filter { $0.projet.nom == nom })
            aEnvoyer = Routage.sansEnTete(texte, mots: c.mots)
            raison = "nom « \(c.nom) » (\(String(format: "%.2f", c.score)))"
        } else {
            // un projet connu sans session ouverte, nommé franchement (suivi d'une pause) : on le dit
            let registre = Routage.projetsDuRegistre()
            if let c = Routage.nomEnTete(texte, candidats: registre.map { [$0.nom] + ($0.id.isEmpty ? [] : [$0.id]) }),
               c.score >= 0.85, Routage.jetons(texte)[c.mots - 1].suiviDePonctuation,
               Routage.normaliser(registre[c.index].nom) != "jarvis" {
                let nom = registre[c.index].nom
                derniereDictee = ["texte": texte, "projet": nom, "emoji": "", "sessionId": NSNull(), "date": iso8601.string(from: Date())]
                journal("vocal : « \(extrait(texte, 80)) » → projet \(nom) sans session ouverte")
                son(.echec)
                direSysteme("Aucune session \(nom) n'est ouverte.")
                return
            }
            // « Jarvis, … » sans session Jarvis ouverte, ou « Claude, … » : simple appel, on le retire
            if let c = Routage.nomEnTete(texte, candidats: [["Jarvis"], ["Claude"]]) { aEnvoyer = Routage.sansEnTete(texte, mots: c.mots) }
            if let s = interlocuteurRecent() { dest = s; raison = "vient de parler" }
            else if let s = premierPlan(ouvertes) { dest = s; raison = "premier plan" }
        }
        guard let s = dest else {
            journal("vocal : « \(extrait(texte, 80)) » → aucune session ouverte")
            son(.echec)
            direSysteme("Aucune session ouverte.")
            return
        }
        guard !aEnvoyer.isEmpty else { journal("vocal : nom seul (« \(texte) »), rien à envoyer"); return }
        let qid = questionsDites.removeValue(forKey: ObjectIdentifier(s))
        cible = s
        interlocuteur = s; dateInterlocuteur = Date()
        derniereDictee = ["texte": aEnvoyer, "projet": s.projet.nom, "emoji": s.projet.emoji, "sessionId": s.sessionId,
                          "date": iso8601.string(from: Date())]
        journal("vocal : « \(extrait(aEnvoyer, 80)) » → \(s.projet.nom) [\(raison)]\(qid.map { " réponse à \($0)" } ?? "") ; relâché → livré \(String(format: "%.2f", latence)) s (whisper \(String(format: "%.2f", dureeWhisper)) s)")
        if direct { finirDirect(livreA: s, texte: aEnvoyer, questionId: qid) }   // juste avant bt.transcription
        let estSuite = suite && s === derniereLivraison
        if estSuite { journal("vocal : suite du message précédent (la page fusionne si Claude n'a rien écrit)") }
        s.livrerTranscription(aEnvoyer, questionId: qid, suite: estSuite)
        derniereLivraison = s; dateLivraison = Date()
        son(.fin)
    }

    // MARK: - États vers les pages et le panneau

    private var sessionEnLigne: Session? {
        if let el = enCours { return el.session }
        if ecoute || transcriptions > 0 { return cible }
        return nil
    }

    func etatPage(pour s: Session) -> [String: Any] {
        var e: [String: Any] = ["actif": actif, "etat": etat, "enLigne": sessionEnLigne === s,
                                "mainsLibres": mainsLibres, "ecouteOuverte": actif && ecouteContinue.enMarche]
        if actif, let er = erreur { e["erreur"] = er }
        return e
    }

    func etatPanneau() -> [String: Any] {
        var enLigne: Any = NSNull()
        if let el = enCours {
            enLigne = ["sessionId": el.sessionId, "projet": el.projet, "emoji": el.emoji, "texte": el.texte, "priorite": el.priorite.rawValue]
        } else if ecoute || transcriptions > 0, let s = cible {
            enLigne = ["sessionId": s.sessionId, "projet": s.projet.nom, "emoji": s.projet.emoji, "texte": ""]
        }
        let f: [[String: Any]] = file.map { el in
            var o: [String: Any] = ["sessionId": el.sessionId, "projet": el.projet, "emoji": el.emoji, "texte": el.texte,
                                    "priorite": el.priorite.rawValue]
            if let q = el.questionId { o["questionId"] = q }
            return o
        }
        return ["actif": actif, "etat": etat, "niveau": Double((niveau * 100).rounded() / 100), "enLigne": enLigne, "file": f,
                // ajouts de la coque (facultatifs pour le panneau)
                "enPause": enPause, "raccourci": texteRaccourci, "raccourciPris": raccourciPris,
                "mainsLibres": mainsLibres, "ecouteOuverte": ecouteContinue.enMarche,
                "micro": sourceSimulee != nil ? "simule" : AutorisationMicro.texte, "voix": Synthese.shared.moteurPrevu,
                "derniere": derniereDictee ?? NSNull(), "erreur": erreur ?? NSNull()]
    }

    private func maj() {
        ajusterEcoute()
        DicteeDirecte.shared.garder(actif && mainsLibres)   // partiels rapides dès le premier énoncé
        for s in RegistreSessions.shared.sessions where !s.estFermee { s.envoyerVocalEtat(etatPage(pour: s)) }
        PanneauJarvis.shared.maj(etatPanneau())
        NotificationCenter.default.post(name: Self.changement, object: self)
    }

    /// Pour le pilote de test : état complet, avec l'interne utile au diagnostic.
    func diagnostic() -> [String: Any] {
        var d = etatPanneau()
        d["interne"] = ["enCours": enCours?.numero ?? NSNull(), "dernierDit": dernierDit?.numero ?? NSNull(),
                        "interlocuteur": interlocuteur?.projet.nom ?? NSNull(), "cible": cible?.projet.nom ?? NSNull(),
                        "questionsDites": Array(questionsDites.values), "transcriptions": transcriptions,
                        "raccourciEnregistre": raccourciParler?.enregistre ?? false, "statutRaccourci": Int(raccourciParler?.statut ?? 0),
                        "panneauVisible": PanneauJarvis.shared.visible, "parle": Synthese.shared.parle,
                        "parleEliot": parleEliot, "ecouteEnMarche": ecouteContinue.enMarche,
                        "ecouteOuverte": ecouteContinue.ouvertePourDiagnostic,
                        "audioPret": file.map { $0.audio?.moteur ?? ($0.enPreparation ? "en préparation" : "rien") }] as [String: Any]
        return d
    }

    // MARK: - Sons et notifications

    private enum Son { case debut, fin, echec }

    private func son(_ s: Son) {
        guard !muet, Reglages.bool("BTSonsVocal", defaut: true) else { return }
        differerEcoute(Self.repriseApresSon)   // le son lui-même ne doit pas ouvrir un énoncé
        let nom: String
        switch s { case .debut: nom = "Tink"; case .fin: nom = "Pop"; case .echec: nom = "Basso" }
        NSSound(named: NSSound.Name(nom))?.play()
    }

    private func notifier(_ titre: String, _ message: String) {
        if PiloteDev.actif { journal("vocal : notification non envoyée (pilote) : \(titre) — \(message)"); return }
        Environnement.charger { env in
            guard let tn = Environnement.notifier(env) ?? Environnement.trouver("terminal-notifier", env, connus: ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"]) else { return }
            DispatchQueue.global().async { _ = executer(tn, ["-title", "Jarvis Terminal", "-subtitle", titre, "-message", message, "-group", "bt-vocal"], env: env, delai: 10) }
        }
    }
}

// MARK: - Menu « Vocal »

/// Menu de la barre : mode Jarvis, écoute mains libres, passer / rejouer / couper, raccourci pour parler, micro,
/// et le panneau Jarvis (diagnostic : il ne s'ouvre que d'ici).
final class MenuVocal: NSObject, NSMenuDelegate {
    static let shared = MenuVocal()
    private let menu = NSMenu(title: "Vocal")

    static let raccourcisProposes: [String] = ["alt+space", "ctrl+alt+space", "shift+alt+space", "ctrl+space", "f13"]

    func element() -> NSMenuItem {
        menu.delegate = self
        menu.autoenablesItems = false
        let i = NSMenuItem()
        i.submenu = menu
        return i
    }

    func menuNeedsUpdate(_ m: NSMenu) {
        let v = MoteurVocal.shared
        m.removeAllItems()
        let mode = NSMenuItem(title: "Mode Jarvis", action: #selector(basculerMode), keyEquivalent: "")
        mode.target = self; mode.state = v.actif ? .on : .off
        m.addItem(mode)
        let ml = NSMenuItem(title: "Écoute mains libres", action: #selector(basculerMainsLibres), keyEquivalent: "")
        ml.target = self; ml.state = v.mainsLibres ? .on : .off
        ml.toolTip = "Le micro écoute tant que le mode Jarvis est actif. Sinon, maintiens \(v.texteRaccourci) pour parler."
        m.addItem(ml)
        m.addItem(.separator())
        for (t, s) in [("Passer", #selector(passer)), ("Rejouer", #selector(rejouer)), ("Couper la voix", #selector(couper))] {
            let i = NSMenuItem(title: t, action: s, keyEquivalent: ""); i.target = self; i.isEnabled = v.actif; m.addItem(i)
        }
        m.addItem(.separator())
        let sous = NSMenu(title: "Raccourci pour parler")
        let actuel = v.combinaisonReglee.cle
        for cle in Self.raccourcisProposes {
            guard let c = RaccourciGlobal.analyser(cle) else { continue }
            let i = NSMenuItem(title: "Maintenir " + c.texte, action: #selector(choisirRaccourci(_:)), keyEquivalent: "")
            i.target = self; i.representedObject = c.cle; i.state = c.cle == actuel ? .on : .off
            sous.addItem(i)
        }
        if !Self.raccourcisProposes.contains(actuel) {
            let i = NSMenuItem(title: "Maintenir " + v.texteRaccourci + " (réglé à la main)", action: nil, keyEquivalent: "")
            i.state = .on; i.isEnabled = false; sous.addItem(i)
        }
        sous.addItem(.separator())
        let aide = NSMenuItem(title: "Autre : defaults write \(BUNDLE_ID) BTRaccourciParler \"ctrl+alt+k\"", action: nil, keyEquivalent: "")
        aide.isEnabled = false
        sous.addItem(aide)
        let r = NSMenuItem(title: "Raccourci pour parler : " + v.texteRaccourci + (v.raccourciPris ? " (déjà pris !)" : ""), action: nil, keyEquivalent: "")
        r.submenu = sous
        m.addItem(r)
        let etatMicro: String
        switch AutorisationMicro.etat {
        case .authorized: etatMicro = "autorisé"
        case .notDetermined: etatMicro = "pas encore demandé"
        default: etatMicro = "refusé"
        }
        let micro = NSMenuItem(title: "Micro : " + etatMicro + (v.sourceSimulee != nil ? " (simulé pour les tests)" : ""), action: nil, keyEquivalent: "")
        micro.isEnabled = false
        m.addItem(micro)
        // Choix du micro (09/11/2026), bascule à chaud. Le micro branché (AirPods) passe la sortie en mode appel (HFP).
        for (titre, mode) in [("Micro : Mac", ChoixMicro.Mode.mac), ("Micro : celui qui est branché", ChoixMicro.Mode.branche)] {
            let i = NSMenuItem(title: titre, action: #selector(choisirMicro(_:)), keyEquivalent: "")
            i.target = self; i.representedObject = mode.rawValue; i.state = ChoixMicro.mode == mode ? .on : .off
            if mode == .branche, let nom = ChoixMicro.nomChoisi(), ChoixMicro.mode == .branche { i.title += " (\(nom))" }
            m.addItem(i)
        }
        if AutorisationMicro.etat == .denied || AutorisationMicro.etat == .restricted {
            let o = NSMenuItem(title: "Ouvrir les réglages du micro…", action: #selector(ouvrirReglagesMicro), keyEquivalent: "")
            o.target = self; m.addItem(o)
        }
        m.addItem(.separator())
        let p = NSMenuItem(title: PanneauJarvis.shared.visible ? "Masquer le panneau Jarvis" : "Afficher le panneau Jarvis (diagnostic)",
                           action: #selector(basculerPanneau), keyEquivalent: "")
        p.target = self
        m.addItem(p)
    }

    @objc private func basculerMode() { MoteurVocal.shared.activer(!MoteurVocal.shared.actif, source: "menu") }
    @objc private func basculerPanneau() { PanneauJarvis.shared.basculer() }
    @objc private func basculerMainsLibres() { MoteurVocal.shared.changerMainsLibres(!MoteurVocal.shared.mainsLibres) }
    @objc private func passer() { MoteurVocal.shared.passer() }
    @objc private func rejouer() { MoteurVocal.shared.rejouer() }
    @objc private func couper() { MoteurVocal.shared.couper() }
    @objc private func choisirRaccourci(_ i: NSMenuItem) { if let c = i.representedObject as? String { MoteurVocal.shared.changerRaccourci(c) } }
    @objc private func ouvrirReglagesMicro() { AutorisationMicro.ouvrirReglages() }
    @objc private func choisirMicro(_ i: NSMenuItem) {
        guard let r = i.representedObject as? String, let mode = ChoixMicro.Mode(rawValue: r) else { return }
        ChoixMicro.mode = mode
        journal("vocal : micro → \(mode == .mac ? "Mac" : "branché")")
    }
}
