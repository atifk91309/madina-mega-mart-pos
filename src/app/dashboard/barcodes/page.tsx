"use client";
import { useEffect, useState } from "react";
import { getDb, generateCustomBarcode, getAllCategories, type Product } from "@/lib/db";
import JsBarcode from "jsbarcode";

function normalizeBarcode(v: string): string {
  return v.trim().toUpperCase().replace(/[\s-]/g, "");
}

function escapeLike(q: string) {
  return q.replace(/[\\%_]/g, (c) => "\\" + c);
}

// ✅ Naam / code seedha HTML me nahi - < > & escape, warna print tootega
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function makeBarcodeSvg(code: string, height: number): string {
  const tmp = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  tmp.setAttribute("class", "bc");
  try {
    JsBarcode(tmp, code, { format: "CODE128", width: 2.2, height, displayValue: false, margin: 6 });
  } catch {
    return "";
  }
  return tmp.outerHTML;
}

export default function BarcodesPage() {
  const [list, setList] = useState<Product[]>([]);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("All");
  const [categories, setCategories] = useState<string[]>(["All"]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [codes, setCodes] = useState<Record<number, string>>({});
  const [msg, setMsg] = useState("");
  const [printing, setPrinting] = useState(false);
  const [generating, setGenerating] = useState<number | null>(null);

  // ✅ DB se filter + LIMIT - 30,000 products ek saath nahi aayenge
  async function load(q = search, cat = catFilter) {
    const db = await getDb();
    let where = "WHERE 1=1";
    const params: unknown[] = [];
    if (q.trim()) {
      const like = `%${escapeLike(q.trim())}%`;
      where += " AND (name LIKE $1 ESCAPE '\\' OR barcode LIKE $1 ESCAPE '\\')";
      params.push(like);
    }
    if (cat !== "All") {
      where += ` AND category = $${params.length + 1}`;
      params.push(cat);
    }
    const all = await db.select<Product[]>(`SELECT * FROM products ${where} ORDER BY id DESC LIMIT 200`, params);
    setList(all);
    const m: Record<number, string> = {};
    all.forEach((p) => { if (p.barcode && p.barcode.trim() !== "" && p.barcode !== "—") m[p.id] = p.barcode; });
    setCodes((prev) => ({ ...m, ...prev }));
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load("", "All");
    // ✅ Categories poori DB se - sirf pehle 200 me se nahi
    void getAllCategories().then((c) => setCategories(["All", ...c])).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = list.filter((p) => selectedIds.includes(p.id));

  // ✅ Preview - npm wali JsBarcode, CDN nahi
  useEffect(() => {
    selected.forEach((p) => {
      const code = codes[p.id];
      if (!code) return;
      const el = document.getElementById(`bc-${p.id}`);
      if (el instanceof SVGElement) {
        try { JsBarcode(el, code, { format: "CODE128", width: 2.2, height: 56, displayValue: false, margin: 6 }); } catch { /* ignore */ }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, codes]);

  function toggle(p: Product) {
    setSelectedIds((prev) => prev.includes(p.id) ? prev.filter((id) => id !== p.id) : [...prev, p.id]);
  }

  // ✅ MAD- wala strong code + DB collision check (space + dash dono)
  async function handleGen(p: Product) {
    if (generating !== null) return;
    setGenerating(p.id);
    try {
      const db = await getDb();
      let code = "";
      for (let i = 0; i < 5; i++) {
        const cand = generateCustomBarcode();
        const dup = await db.select<{ id: number }[]>(
          "SELECT id FROM products WHERE REPLACE(REPLACE(UPPER(TRIM(barcode)), '-', ''), ' ', '') = $1 AND id != $2 LIMIT 1",
          [normalizeBarcode(cand), p.id]
        );
        if (dup.length === 0) { code = cand; break; }
      }
      if (!code) return alert("Barcode nahi bana — dobara Gen dabao");
      setCodes((prev) => ({ ...prev, [p.id]: code }));
      if (!selectedIds.includes(p.id)) setSelectedIds((prev) => [...prev, p.id]);
      setMsg(`✅ ${p.name} ka code ban gaya: ${code} — Print se pehle Save karna mat bhoolna`);
      setTimeout(() => setMsg(""), 4000);
    } finally { setGenerating(null); }
  }

  // ✅ Save se pehle duplicate check - warna UNIQUE crash pe aadhi save hoti
  async function saveAll() {
    if (selected.length === 0) return alert("Pehle koi product select karo");
    const db = await getDb();
    const seen = new Set<string>();
    for (const p of selected) {
      const code = (codes[p.id] || "").trim();
      if (!code) continue;
      const norm = normalizeBarcode(code);
      if (seen.has(norm)) return alert(`⛔ "${p.name}" ka code doosre selected product se mil raha hai — dobara Gen dabao`);
      seen.add(norm);
      const dup = await db.select<{ id: number; name: string }[]>(
        "SELECT id, name FROM products WHERE REPLACE(REPLACE(UPPER(TRIM(barcode)), '-', ''), ' ', '') = $1 AND id != $2 LIMIT 1",
        [norm, p.id]
      );
      if (dup.length > 0) return alert(`⛔ "${code}" pehle se "${dup[0].name}" pe hai! ${p.name} ke liye dobara Gen dabao`);
    }
    for (const p of selected) {
      const code = codes[p.id];
      if (code) await db.execute("UPDATE products SET barcode=$1 WHERE id=$2", [code, p.id]);
    }
    setMsg(`✅ ${selected.length} products ke barcode save ho gaye`);
    void load(search, catFilter);
    setTimeout(() => setMsg(""), 4000);
  }

  function printStickers() {
    if (selected.length === 0) return alert("Pehle product select karo");
    const missing = selected.filter((p) => !codes[p.id]);
    if (missing.length > 0) return alert(`${missing[0].name} ka Gen dabao — Uska code nahi bana`);
    setPrinting(true);

    // ✅ OFFLINE PRINT: Barcode pehle se SVG bana ke iframe me daalo - CDN ki zaroorat nahi
    const labels = selected.map((p) => `
      <div class="label">
        <div class="pname">${escapeHtml(p.name)}</div>
        ${makeBarcodeSvg(codes[p.id], 52)}
        <div class="code">${escapeHtml(codes[p.id])}</div>
        <div class="price">Rs ${p.price}</div>
      </div>
    `).join("");

    const old = document.getElementById("barcode-print-frame");
    if (old) old.remove();

    const iframe = document.createElement("iframe");
    iframe.id = "barcode-print-frame";
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    document.body.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) { setPrinting(false); return alert("Print nahi khula — Dobara try karo"); }

    doc.open();
    doc.write(`<html><head><meta charset="utf-8"><title>Barcodes - Madina Mart</title><style>
      @page{size:A4;margin:8mm}
      body{margin:0;font-family:Arial}
      .sheet{display:flex;flex-wrap:wrap}
      .label{width:62mm;height:42mm;border:1px dashed #bbb;padding:2mm;text-align:center;box-sizing:border-box;overflow:hidden;margin:1mm;break-inside:avoid;page-break-inside:avoid}
      .pname{font-size:11px;font-weight:900;margin-bottom:1mm;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .bc{width:100%;height:52px;display:block;margin:0 auto}
      .code{font-size:11px;font-weight:900;letter-spacing:1px;margin-top:1mm}
      .price{font-size:11px;font-weight:900;margin-top:0.5mm}
    </style></head><body><div class="sheet">${labels}</div></body></html>`);
    doc.close();
    setTimeout(() => {
      try { iframe.contentWindow?.focus(); iframe.contentWindow?.print(); } catch { /* ignore */ }
    }, 500);
    setTimeout(() => { iframe.remove(); setPrinting(false); }, 3000);
  }

  return (
    <div className="p-7 max-w-6xl mx-auto">
      <h2 className="text-2xl font-black tracking-tight flex items-center gap-2">🏷️ Barcode Generator</h2>
      <p className="text-slate-500 text-sm mt-1">Manyari • Mobile Accessories • A4 pe 18 stickers (3 x 6) • Strong Barcode - sasta printer pe bhi scan hoga</p>

      <div className="flex gap-2 mt-4">
        <div className="relative flex-1">
          <input value={search} onChange={(e) => { setSearch(e.target.value); void load(e.target.value, catFilter); }} placeholder="🔍 Search name or barcode..." className="w-full bg-white border px-4 py-3 pr-10 rounded-xl outline-none focus:ring-2 focus:ring-emerald-500 text-sm" />
          {search && <button onClick={() => { setSearch(""); void load("", catFilter); }} className="absolute right-2 top-1/2 -translate-y-1/2 bg-slate-100 w-6 h-6 rounded-full text-xs font-black">✕</button>}
        </div>
        <select value={catFilter} onChange={(e) => { setCatFilter(e.target.value); void load(search, e.target.value); }} className="bg-white border px-3 py-3 rounded-xl text-sm font-bold outline-none">
          {categories.map((c) => <option key={c} value={c}>{c === "All" ? "All (Manyari + Mobile)" : c}</option>)}
        </select>
      </div>

      <div className="flex justify-between items-center mt-3">
        <p className="text-xs text-slate-500">Showing {list.length} (max 200) • Selected {selected.length}</p>
        <div className="flex gap-3">
          <button onClick={() => setSelectedIds([])} className="text-xs font-bold text-slate-500">Clear All</button>
          <button onClick={() => { setSearch(""); setCatFilter("All"); void load("", "All"); }} className="text-xs font-bold text-red-500">Clear</button>
        </div>
      </div>

      {msg && <p className="text-emerald-600 font-bold text-sm mt-2">{msg}</p>}

      <div className="grid grid-cols-3 gap-4 mt-3">
        {list.map((p) => {
          const isSel = selectedIds.includes(p.id);
          const code = codes[p.id];
          return (
            <div key={p.id} className={`bg-white rounded-2xl border-2 p-4 ${isSel ? "border-slate-900" : "border-slate-200"}`}>
              <div className="flex justify-between items-start">
                <div>
                  <p className="font-black text-sm">{p.name}</p>
                  <p className="text-[11px] text-slate-400">{p.category || "General"} • Rs. {p.price}</p>
                </div>
                <span className="text-[11px] text-slate-400">{code ? code : "No barcode"}</span>
              </div>
              <div className="flex gap-2 mt-3">
                <button onClick={() => toggle(p)} className={`flex-1 py-2.5 rounded-xl font-bold text-xs ${isSel ? "bg-slate-900 text-white" : "bg-slate-100"}`}>
                  {isSel ? "✓ Selected" : "Select"}
                </button>
                <button onClick={() => void handleGen(p)} disabled={generating === p.id} className="bg-emerald-500 text-white px-4 py-2.5 rounded-xl font-bold text-xs disabled:opacity-50">{generating === p.id ? "..." : "Gen"}</button>
              </div>
            </div>
          );
        })}
      </div>
      {list.length === 0 && <p className="bg-white border rounded-2xl p-8 text-center text-slate-400 mt-3 text-sm">Koi product nahi mila</p>}

      {selected.length > 0 && (
        <>
          <button onClick={printStickers} disabled={printing} className="w-full bg-slate-900 text-white py-3.5 rounded-2xl font-black mt-4 disabled:opacity-60">
            {printing ? "⏳ Print khul raha hai..." : `🖨️ Print Stickers (${selected.length}) - A4`}
          </button>
          <button onClick={() => void saveAll()} className="w-full bg-emerald-600 text-white py-3 rounded-2xl font-bold text-sm mt-2">💾 Save All Barcodes to Products</button>

          <div className="bg-white rounded-2xl border p-5 mt-4">
            <div className="grid grid-cols-3 gap-4">
              {selected.map((p) => (
                <div key={p.id} className="border rounded-xl p-4 text-center flex flex-col gap-0">
                  <p className="text-[11px] font-bold leading-tight mb-2">{p.name}</p>
                  {codes[p.id] ? <svg id={`bc-${p.id}`} className="mx-auto w-full block m-0"></svg> : <p className="text-xs text-red-500 py-4">Gen dabao</p>}
                  <p className="text-[11px] font-bold mt-0">{codes[p.id] || "—"}</p>
                  <p className="text-[11px] text-slate-500 mt-1">Rs {p.price} - {codes[p.id] || "—"}</p>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-400 mt-3 text-center">💡 Print dialog me Destination me <b>Save as PDF</b> select karo → PC pe save → Phir print karke chipkao</p>
          </div>
        </>
      )}
    </div>
  );
}