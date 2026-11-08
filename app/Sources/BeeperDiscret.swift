import AppKit

/// L'envoi vers Jarvis passe par l'API locale de Beeper Desktop (localhost:23373), qui n'existe que si Beeper
/// tourne. Quand il est fermé, on le lance sans fenêtre ni focus (`open -g -j`), on attend que l'API réponde,
/// et on le recache si Electron affiche quand même sa fenêtre ou prend le premier plan (demande d'Eliot,
/// 08/11/2026). Si l'API ne répond pas à temps, l'appelant affiche l'échec : jamais de repli par le bot.
enum BeeperDiscret {
    static let bundle = "com.automattic.beeper.desktop"
    /// Sonde sans jeton : n'importe quelle réponse HTTP (401 compris) veut dire que l'API écoute.
    private static let sonde = URL(string: "http://localhost:23373/v1/accounts")!

    static func tourne() -> Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: bundle).isEmpty
    }

    /// Lance Beeper en arrière-plan, caché, puis appelle `fini(true)` dès que l'API répond, `fini(false)` après `delai`.
    /// Toujours rappelé sur la file principale.
    static func lancer(delai: TimeInterval = 30, fini: @escaping (Bool) -> Void) {
        // Beeper déjà ouvert (par Eliot) : on n'y touche jamais, ni `open -j` qui le cacherait, ni surveillance
        // (bug du 12/11/2026 : un délai de l'API cachait Beeper pendant qu'Eliot l'utilisait). On attend juste l'API.
        if tourne() {
            journal("beeper : déjà ouvert, API injoignable — attente sans toucher à la fenêtre")
            attendreAPI(delai: delai, arreter: { _ in }, fini: fini)
            return
        }
        let devant = NSWorkspace.shared.frontmostApplication
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        p.arguments = ["-g", "-j", "-b", bundle]   // -g : pas de premier plan ; -j : lancé caché
        do { try p.run() } catch {
            journal("beeper : lancement impossible — \(error.localizedDescription)")
            DispatchQueue.main.async { fini(false) }
            return
        }
        // Electron ignore parfois -g / -j et se met devant avec sa fenêtre : on réagit à l'événement même
        // (activation, lancement) et, en filet, toutes les 0,2 s, jusqu'à 6 s après que l'API est prête.
        let centre = NSWorkspace.shared.notificationCenter
        var jetons: [NSObjectProtocol] = []
        for nom in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.didLaunchApplicationNotification] {
            jetons.append(centre.addObserver(forName: nom, object: nil, queue: .main) { n in
                let a = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
                if a?.bundleIdentifier == bundle { garderDerriere(devant) }
            })
        }
        let filet = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in garderDerriere(devant) }
        func arreterSurveillance(apres d: TimeInterval) {
            DispatchQueue.main.asyncAfter(deadline: .now() + d) {
                filet.invalidate()
                jetons.forEach { centre.removeObserver($0) }
                jetons.removeAll()
            }
        }
        // Surveillance courte : 3 s après que l'API répond, puis plus jamais. Beeper redevient l'affaire d'Eliot.
        attendreAPI(delai: delai, arreter: { ok in arreterSurveillance(apres: ok ? 3 : 0) }, fini: fini)
    }

    /// Sonde l'API toutes les 0,5 s jusqu'à `delai` ; `arreter(ok)` puis `fini(ok)` sur la file principale.
    private static func attendreAPI(delai: TimeInterval, arreter: @escaping (Bool) -> Void, fini: @escaping (Bool) -> Void) {
        let debut = Date(), limite = debut.addingTimeInterval(delai)
        func tic() {
            sonder { ok in
                DispatchQueue.main.async {
                    if ok {
                        journal("beeper : API prête en \(Int(Date().timeIntervalSince(debut))) s")
                        arreter(true)
                        fini(true)
                    } else if Date() < limite {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: tic)
                    } else {
                        journal("beeper : API toujours muette après \(Int(delai)) s")
                        arreter(false)
                        fini(false)
                    }
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: tic)
    }

    private static func sonder(_ r: @escaping (Bool) -> Void) {
        let req = URLRequest(url: sonde, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
        URLSession.shared.dataTask(with: req) { _, rep, _ in r(rep is HTTPURLResponse) }.resume()
    }

    /// Cache Beeper, et rend le premier plan à l'app qui l'avait si Beeper l'a pris.
    static func garderDerriere(_ devant: NSRunningApplication?) {
        for app in NSRunningApplication.runningApplications(withBundleIdentifier: bundle) {
            if app.isActive, let d = devant, d.bundleIdentifier != bundle, !d.isTerminated {
                d.activate(options: [])
            }
            if !app.isHidden { app.hide() }
        }
    }
}
