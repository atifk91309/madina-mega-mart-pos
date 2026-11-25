"use client"; 
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

export default function LicenseScreen({ onUnlock }: { onUnlock: () => void }) {
  const [machineId, setMachineId] = useState("Loading...");
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    invoke<string>("get_my_machine_id").then(setMachineId).catch(() => setMachineId("UNKNOWN-PC-0000"));
  }, []);

  const copyId = async () => {
    try { await navigator.clipboard.writeText(machineId); alert("Machine ID Copy Ho Gaya!"); }
    catch { alert(machineId); }
  };

  const activate = async () => {
    if (!key.trim()) { setError("Pehle Key Daalo"); return; }
    setLoading(true); setError("");
    try {
      const expiry = await invoke<string>("verify_license", { key: key.trim().toUpperCase() });
      localStorage.setItem("license_key", key.trim().toUpperCase());
      alert(`Mubarak Ho! License ${expiry} Tak Active Hai`);
      onUnlock();
    } catch (e: unknown) {
      setError(typeof e === "string" ? e : "Ghalat Key");
    } finally { setLoading(false); }
  };

  // ✅ FIXED - Tauri me window.open nahi chalta, opener chalta hai
  const whatsapp = async () => {
    const msg = encodeURIComponent(`Assalam o Alaikum! Mujhe Madina Mart POS ki Key Chahiye.\nMeri Machine ID: ${machineId}`);
    const url = `https://wa.me/923445099345?text=${msg}`;
    try {
      await openUrl(url);
    } catch {
      window.open(url, "_blank");
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="bg-emerald-600 p-6 text-center">
          <h1 className="text-white text-2xl font-bold">🕌 Madina Mart</h1>
          <p className="text-emerald-100 text-sm">POS System - License Activation</p>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="text-sm font-semibold text-gray-700">Step 1 - Apki Machine ID</label>
            <div className="flex gap-2 mt-1">
              <input readOnly value={machineId} className="flex-1 border rounded-lg px-3 py-2 bg-gray-50 font-mono font-bold text-center text-sm" />
              <button onClick={copyId} className="bg-gray-800 text-white px-3 rounded-lg text-sm">Copy</button>
            </div>
            <p className="text-xs text-gray-500 mt-1">Ye ID WhatsApp pe bhejo, hum Key bhej denge.</p>
          </div>
          <div>
            <label className="text-sm font-semibold text-gray-700">Step 2 - License Key Daalo</label>
            <input value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="MAD-XXXX-XXXX-20271231" className="w-full border rounded-lg px-3 py-2 mt-1 font-mono font-bold text-center tracking-wider" />
            {error && <p className="text-red-600 text-sm mt-2 text-center font-semibold">⚠️ {error}</p>}
          </div>
          <button onClick={activate} disabled={loading} className="w-full bg-emerald-600 hover:bg-emerald-700 text-white py-3 rounded-lg font-bold">
            {loading ? "Checking..." : "✅ Activate Karo"}
          </button>
          <button onClick={whatsapp} className="w-full bg-green-500 hover:bg-green-600 text-white py-3 rounded-lg font-bold">
            💬 WhatsApp Pe Key Mangwao
          </button>
          <p className="text-center text-xs text-gray-400">Price: Rs 25,000 / Saal • 1 Saal Support Free</p>
          
        </div>
      </div>
    </div>
  );
}