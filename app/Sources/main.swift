import AppKit

// Better Terminal : une fenêtre par session Claude Code, l'interface est une page web (ui/),
// la coque ne fait que relayer. Une seule instance : les lancements suivants lui passent la main.

signal(SIGPIPE, SIG_IGN)   // écrire dans le stdin d'un claude mort ne doit pas tuer l'app

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var commande: Entrees.Commande = .rien
    private var urlRecue = false

    init(commande: Entrees.Commande) { self.commande = commande }

    func applicationWillFinishLaunching(_ n: Notification) {
        construireMenu()
        _ = Jeton.valeur
        creerDossier(DOSSIER_SESSIONS)
        creerDossier(DOSSIER_QUESTIONS)
        RegistreSessions.nettoyerEtatsOrphelins()
        Environnement.charger { _ in }   // à l'avance : ~1 s pour un zsh interactif
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        journal("lancement (pid \(getpid()), \(Bundle.main.bundlePath))")
        PiloteDev.demarrer()   // tests d'intégration seulement : ne fait rien sans BT_DEV_PILOTE
        MoteurVocal.shared.demarrer()   // mode Jarvis : raccourci global, écoute mains libres, état mémorisé
        switch commande {
        case .session(let d): Entrees.ouvrir(d)
        case .url(let u): Entrees.traiter(u)
        case .erreur(let e): Entrees.alerte("Lancement impossible", e)
        case .rien: break
        }
        // lancé sans rien (Dock, Finder) : on propose un dossier, sauf si une URL est arrivée entre-temps
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [self] in
            if RegistreSessions.shared.sessions.isEmpty && !urlRecue && !PiloteDev.actif {
                if !RegistreSessions.rouvrirDernieres() { Entrees.choisirDossier() }
            }
        }
        QuitterMaintenu.installer()   // ⌘Q à maintenir, comme Chrome
        installerRaccourcisFenetre()
    }

    func application(_ app: NSApplication, open urls: [URL]) {
        urlRecue = true
        urls.forEach(Entrees.traiter)
    }

    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows visibles: Bool) -> Bool {
        if !visibles {
            if RegistreSessions.shared.sessions.isEmpty {
                if !RegistreSessions.rouvrirDernieres() { Entrees.choisirDossier() }
            } else { FenetrePrincipale.shared.montrer() }
        }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ n: Notification) { MoteurVocal.shared.quitter() }

    /// Quitter ferme tout : chaque processus s'arrête proprement (5 s au plus), puis l'app sort.
    func applicationShouldTerminate(_ app: NSApplication) -> NSApplication.TerminateReply {
        if RegistreSessions.shared.sessions.isEmpty { return .terminateNow }
        RegistreSessions.shared.memoriser()
        RegistreSessions.shared.quitte = true
        journal("quitter : arrêt de \(RegistreSessions.shared.sessions.count) session(s)")
        var repondu = false
        let repondre = { if !repondu { repondu = true; app.reply(toApplicationShouldTerminate: true) } }
        RegistreSessions.shared.toutArreter(repondre)
        // Repli par minuteur de boucle (modes communs, donc aussi pendant terminateLater) plutôt que par la file
        // principale : il sort même si un appelant a lancé terminate depuis un bloc de cette file.
        let repli = Timer(timeInterval: 7, repeats: false) { _ in
            if !repondu { journal("quitter : arrêt trop long, sortie forcée") }
            repondre()
        }
        RunLoop.main.add(repli, forMode: .common)
        return .terminateLater
    }

    /// fn+Ctrl (raccourcis de fenêtre de macOS : fn+Ctrl+F remplir, fn+Ctrl+C centrer, flèches…).
    /// La vue web garde Ctrl+F pour l'édition de texte (« caractère suivant ») et l'avalait :
    /// on donne la main au menu Fenêtre d'abord, avec un repli maison pour Remplir et Centrer.
    private func installerRaccourcisFenetre() {
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
            let m = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
            // Passer d'une session à l'autre, avant que la page ne voie la touche :
            // ⌘1…⌘9, ⌃Tab / ⌃⇧Tab (⌘⇧] / ⌘⇧[ passent par le menu : il lit le caractère, juste en AZERTY).
            if e.window === FenetrePrincipale.shared.window {
                let p = FenetrePrincipale.shared
                let sans = m.subtracting([.function, .numericPad, .capsLock])
                if sans == .command, let c = e.charactersIgnoringModifiers, let n = Int(c), (1...9).contains(n) {
                    p.choisir(numero: n); return nil
                }
                if e.keyCode == 48, sans == .control { p.decaler(1); return nil }
                if e.keyCode == 48, sans == [.control, .shift] { p.decaler(-1); return nil }
            }
            guard m.contains(.control), m.contains(.function), !m.contains(.command), !m.contains(.option) else { return e }
            if NSApp.mainMenu?.performKeyEquivalent(with: e) == true { return nil }
            guard let w = NSApp.keyWindow, let ecran = w.screen?.visibleFrame else { return e }
            switch e.charactersIgnoringModifiers?.lowercased() {
            case "f": w.setFrame(ecran, display: true, animate: true); return nil
            case "c": w.center(); return nil
            default: return e
            }
        }
    }

    // MARK: Menus

    @objc func nouvelleSession(_ s: Any?) { Entrees.choisirDossier() }

    @objc func rechargerPage(_ s: Any?) {
        FenetrePrincipale.shared.selection?.recharger()
    }

    /// ⌘W : dans la fenêtre principale, ferme la session affichée ; ailleurs (panneau Jarvis…), ferme la fenêtre.
    @objc func fermerSession(_ s: Any?) {
        if let w = NSApp.keyWindow, w !== FenetrePrincipale.shared.window { w.performClose(nil); return }
        FenetrePrincipale.shared.fermerSelection()
    }

    @objc func afficherSessions(_ s: Any?) { FenetrePrincipale.shared.montrer() }
    @objc func sessionSuivante(_ s: Any?) { FenetrePrincipale.shared.decaler(1) }
    @objc func sessionPrecedente(_ s: Any?) { FenetrePrincipale.shared.decaler(-1) }

    private func construireMenu() {
        let barre = NSMenu()
        func menu(_ titre: String, _ items: [NSMenuItem]) {
            let m = NSMenu(title: titre); items.forEach(m.addItem)
            let i = NSMenuItem(); i.submenu = m; barre.addItem(i)
        }
        func item(_ t: String, _ a: Selector?, _ k: String, _ mods: NSEvent.ModifierFlags = .command, cible: AnyObject? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: t, action: a, keyEquivalent: k); i.keyEquivalentModifierMask = mods; i.target = cible; return i
        }
        let nom = "Jarvis Terminal"
        menu(nom, [
            item("À propos de \(nom)", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
            .separator(),
            item("Masquer \(nom)", #selector(NSApplication.hide(_:)), "h"),
            item("Masquer les autres", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Tout afficher", #selector(NSApplication.unhideAllApplications(_:)), ""),
            .separator(),
            item("Quitter \(nom)", #selector(NSApplication.terminate(_:)), "q"),
        ])
        menu("Fichier", [
            item("Nouvelle session…", #selector(nouvelleSession(_:)), "n", cible: self),
            .separator(),
            item("Fermer la session", #selector(fermerSession(_:)), "w", cible: self),
        ])
        // indispensable pour ⌘C / ⌘V / ⌘A dans la vue web
        menu("Édition", [
            item("Annuler", Selector(("undo:")), "z"),
            item("Rétablir", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Couper", #selector(NSText.cut(_:)), "x"),
            item("Copier", #selector(NSText.copy(_:)), "c"),
            item("Coller", #selector(NSText.paste(_:)), "v"),
            item("Tout sélectionner", #selector(NSText.selectAll(_:)), "a"),
        ])
        // pas d'élément « Rechercher » : ⌘F reste à la page
        menu("Présentation", [
            item("Recharger la page", #selector(rechargerPage(_:)), "r", cible: self),
            item("Plein écran", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        barre.addItem(MenuVocal.shared.element())   // Vocal : mode Jarvis, mains libres, raccourci pour parler, panneau (diagnostic)
        let fenetres = NSMenu(title: "Fenêtre")
        [item("Réduire", #selector(NSWindow.performMiniaturize(_:)), "m"),
         item("Zoom", #selector(NSWindow.performZoom(_:)), ""),
         .separator(),
         item("Afficher les sessions", #selector(afficherSessions(_:)), "0", cible: self),
         item("Session suivante", #selector(sessionSuivante(_:)), "]", [.command, .shift], cible: self),
         item("Session précédente", #selector(sessionPrecedente(_:)), "[", [.command, .shift], cible: self),
         .separator(),
         item("Tout ramener au premier plan", #selector(NSApplication.arrangeInFront(_:)), "")].forEach(fenetres.addItem)
        let f = NSMenuItem(); f.submenu = fenetres; barre.addItem(f)
        NSApp.windowsMenu = fenetres
        NSApp.mainMenu = barre
    }
}

// MARK: - Démarrage

let app = NSApplication.shared
let commande = Entrees.depuisArguments(Array(CommandLine.arguments.dropFirst()))

// Une seule instance : si l'app tourne déjà, on lui transmet la demande (URL + jeton) et on s'arrête.
if let autre = NSRunningApplication.runningApplications(withBundleIdentifier: BUNDLE_ID)
    .first(where: { $0.processIdentifier != getpid() }) {
    var url: URL?
    switch commande {
    case .session(let d): url = Entrees.url(d)
    case .url(let u): url = u
    default: break
    }
    if let u = url, let b = autre.bundleURL {
        var fini = false
        NSWorkspace.shared.open([u], withApplicationAt: b, configuration: NSWorkspace.OpenConfiguration()) { _, e in
            if let e { FileHandle.standardError.write(Data("transmission impossible : \(e.localizedDescription)\n".utf8)) }
            fini = true
        }
        let limite = Date().addingTimeInterval(5)
        while !fini && Date() < limite { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
    } else {
        autre.activate()
    }
    exit(0)
}

let delegue = AppDelegate(commande: commande)
app.delegate = delegue
app.setActivationPolicy(.regular)
app.run()
