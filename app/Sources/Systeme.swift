import Foundation
import Darwin

/// Relevé de la machine pour le pied de la barre des sessions (btop en miniature, demande d'Eliot du 15/11/2026) :
/// CPU, RAM (comme « Mémoire utilisée » du Moniteur d'activité, plus la part des processus claude) et disque.
/// À appeler toujours depuis la même file série : le CPU se calcule par différence avec le relevé précédent.
final class Systeme {
    static let shared = Systeme()
    private var ticksPrecedents: (actif: UInt64, total: UInt64)?
    private var disqueCache: (t: Date, valeur: [String: Any])?

    func releve() -> [String: Any] {
        var r: [String: Any] = ["ram": ram()]
        if let c = cpu() { r["cpu"] = c }
        if let d = disque() { r["disque"] = d }
        return r
    }

    // MARK: CPU — part du temps non oisif depuis le relevé précédent, tous cœurs confondus
    private func cpu() -> Double? {
        var info = host_cpu_load_info()
        var n = mach_msg_type_number_t(MemoryLayout<host_cpu_load_info_data_t>.stride / MemoryLayout<integer_t>.stride)
        let k = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(n)) { host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, $0, &n) }
        }
        guard k == KERN_SUCCESS else { return nil }
        let t = info.cpu_ticks   // (user, system, idle, nice)
        let actif = UInt64(t.0) + UInt64(t.1) + UInt64(t.3)
        let total = actif + UInt64(t.2)
        defer { ticksPrecedents = (actif, total) }
        guard let p = ticksPrecedents, total > p.total, actif >= p.actif else { return nil }
        return min(100, Double(actif - p.actif) / Double(total - p.total) * 100)
    }

    // MARK: RAM
    private func ram() -> [String: Any] {
        var r: [String: Any] = ["total": Double(ProcessInfo.processInfo.physicalMemory)]
        var s = vm_statistics64()
        var n = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.stride / MemoryLayout<integer_t>.stride)
        var page: vm_size_t = 0
        host_page_size(mach_host_self(), &page)
        let k = withUnsafeMutablePointer(to: &s) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(n)) { host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &n) }
        }
        if k == KERN_SUCCESS {
            let p = UInt64(page)
            let interne = UInt64(s.internal_page_count), purgeable = UInt64(s.purgeable_count)
            let apps = (interne > purgeable ? interne - purgeable : 0) * p
            let cablee = UInt64(s.wire_count) * p
            let compressee = UInt64(s.compressor_page_count) * p
            r["utilisee"] = Double(apps + cablee + compressee)
            r["apps"] = Double(apps)
            r["cablee"] = Double(cablee)
            r["compressee"] = Double(compressee)
        }
        var swap = xsw_usage(), taille = MemoryLayout<xsw_usage>.size
        if sysctlbyname("vm.swapusage", &swap, &taille, nil, 0) == 0 { r["swap"] = Double(swap.xsu_used) }
        var niveau: Int32 = 0, tn = MemoryLayout<Int32>.size
        if sysctlbyname("kern.memorystatus_vm_pressure_level", &niveau, &tn, nil, 0) == 0 { r["pression"] = Int(niveau) }
        r["claude"] = claude()
        return r
    }

    /// Empreinte mémoire cumulée des processus « claude » (sessions de l'app comme du Terminal).
    private func claude() -> [String: Any] {
        let n = proc_listallpids(nil, 0)
        guard n > 0 else { return ["octets": 0, "nombre": 0] }
        var pids = [pid_t](repeating: 0, count: Int(n) + 64)
        let m = pids.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, Int32($0.count)) }
        var octets: UInt64 = 0, nombre = 0
        // L'exécutable s'appelle « 2.1.319 » (~/.local/bin/claude → ~/.local/share/claude/versions/2.1.319) : on lit le chemin.
        var chemin = [CChar](repeating: 0, count: 4096)
        for pid in pids.prefix(Int(max(0, m))) where pid > 0 {
            guard proc_pidpath(pid, &chemin, UInt32(chemin.count)) > 0 else { continue }
            let c = String(cString: chemin)
            guard c.contains("/claude/versions/") || c.hasSuffix("/claude") else { continue }
            var ru = rusage_info_v2()
            let ok = withUnsafeMutablePointer(to: &ru) {
                $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V2, $0) }
            }
            if ok == 0 { octets += ru.ri_phys_footprint; nombre += 1 }
        }
        return ["octets": Double(octets), "nombre": nombre]
    }

    // MARK: Disque — le volume du dossier personnel, espace libre « important » (celui du Finder), relu toutes les 30 s
    private func disque() -> [String: Any]? {
        if let c = disqueCache, Date().timeIntervalSince(c.t) < 30 { return c.valeur }
        let u = URL(fileURLWithPath: NSHomeDirectory())
        guard let v = try? u.resourceValues(forKeys: [.volumeTotalCapacityKey, .volumeAvailableCapacityForImportantUsageKey,
                                                      .volumeAvailableCapacityKey, .volumeLocalizedNameKey]),
              let total = v.volumeTotalCapacity, total > 0 else { return nil }
        let libre = v.volumeAvailableCapacityForImportantUsage.map { Double($0) } ?? Double(v.volumeAvailableCapacity ?? 0)
        let valeur: [String: Any] = ["total": Double(total), "libre": min(Double(total), libre), "nom": v.volumeLocalizedName ?? ""]
        disqueCache = (Date(), valeur)
        return valeur
    }
}
