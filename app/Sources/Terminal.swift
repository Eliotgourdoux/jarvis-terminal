import AppKit

/// « Ouvrir dans le terminal » : la commande arrive au script en argv, jamais collée dans le source
/// AppleScript (aucun échappement AppleScript possible à rater). L'échappement shell est fait par shq.
enum Terminal {
    private static let script = """
    on run argv
      set cmd to item 1 of argv
      set premiere to (item 2 of argv) is "premiere"
      tell application "Terminal"
        activate
        if premiere then
          -- Terminal vient d'être lancé : il ouvre sa fenêtre par défaut, on s'en sert au lieu d'en créer une 2e
          repeat 50 times
            if (count of windows) > 0 then exit repeat
            delay 0.1
          end repeat
          if (count of windows) > 0 then
            do script cmd in selected tab of front window
          else
            do script cmd
          end if
        else
          do script cmd
        end if
      end tell
      return "ok"
    end run
    """

    /// À appeler hors du fil principal. Renvoie (succès, détail).
    static func ouvrir(_ commande: String) -> (Bool, String) {
        let tourne = !NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Terminal").isEmpty
        let (code, out) = executer("/usr/bin/osascript", ["-e", script, commande, tourne ? "fenetre" : "premiere"], delai: 20)
        let o = out.trimmingCharacters(in: .whitespacesAndNewlines)
        return (code == 0 && o == "ok", code == 0 ? o : "osascript code \(code) (Automatisation → Terminal refusée ?)")
    }
}
