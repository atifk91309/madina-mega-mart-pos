"use client";
import { useEffect, useRef, useState } from "react";
import { getDb, bulkImportProducts, getAllCategories, saveProduct, deleteProduct, type Product } from "@/lib/db";

const DEFAULT_CATEGORIES = ["General", "Mobile Accessories", "Manyari", "Cosmetics", "Other"];

type ImportRow = { name: string; price: number; cost: number; barcode: string; stock: number; category: string; company: string };
type JsonProduct = Record<string, unknown>;

function toStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

function toNum(v: unknown): number {
  const n = typeof v === "string" ? Number(v.trim()) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

function pick(obj: JsonProduct, ...keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function normalizeBarcode(v: string): string {
  return v.trim().toUpperCase().replace(/[\s-]/g, "");
}

function escapeLike(q: string) {
  return q.replace(/[\\%_]/g, (c) => "\\" + c);
}

export default function ProductsPage() {
  const [list, setList] = useState<Product[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [stockValue, setStockValue] = useState(0);
  const [stockSellValue, setStockSellValue] = useState(0);
  const [search, setSearch] = useState("");
  const [allCategories, setAllCategories] = useState<string[]>(DEFAULT_CATEGORIES);
  const [catFilter, setCatFilter] = useState<string>("All");
  const [page, setPage] = useState(0);
  const [form, setForm] = useState({ name: "", price: "", cost: "", barcode: "", stock: "", category: "General", company: "" });
  const [editId, setEditId] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState("");
  const [barcodeNotice, setBarcodeNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const jsonRef = useRef<HTMLInputElement>(null);
  const PAGE_SIZE = 50;

  useEffect(() => {
    try {
      const b = new URLSearchParams(window.location.search).get("barcode");
      if (b) {
        const clean = b.trim();
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setForm((f) => ({ ...f, barcode: clean }));
        setBarcodeNotice(`🏷️ Sales se aaya barcode: ${clean} — Ab sirf Naam + Price likho aur Save karo`);
        window.history.replaceState({}, "", window.location.pathname);
        setTimeout(() => document.querySelector<HTMLInputElement>('input[placeholder*="Product Name"]')?.focus(), 300);
      }
    } catch { /* ignore */ }
  }, []);

  async function loadCategories() {
    try {
      const cats = await getAllCategories();
      setAllCategories(cats);
    } catch { /* ignore */ }
  }

  async function load(p = page, q = search, cat = catFilter) {
    const db = await getDb();
    const offset = p * PAGE_SIZE;
    let where = "WHERE 1=1";
    const params: unknown[] = [];
    if (q.trim()) {
      const raw = q.trim();
      const like = `%${escapeLike(raw)}%`;
      // Barcode ke liye normalized version - MAD- -> MAD, space khatam
      const barcodeLike = `%${escapeLike(normalizeBarcode(raw))}%`;
      where += " AND (name LIKE $1 ESCAPE '\\' OR REPLACE(REPLACE(UPPER(TRIM(barcode)), '-', ''), ' ', '') LIKE $2 ESCAPE '\\' OR category LIKE $3 ESCAPE '\\')";
      params.push(like, barcodeLike, like);
    }
    if (cat !== "All") {
      where += ` AND category = $${params.length + 1}`;
      params.push(cat);
    }
    setList(await db.select<Product[]>(`SELECT * FROM products ${where} ORDER BY id DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`, params));
    const c = await db.select<{ c: number }[]>(`SELECT COUNT(*) as c FROM products ${where}`, params);
    setTotalCount(c[0]?.c ?? 0);
    const v = await db.select<{ v: number; s: number }[]>("SELECT COALESCE(SUM(cost*stock),0) as v, COALESCE(SUM(price*stock),0) as s FROM products");
    setStockValue(v[0]?.v ?? 0);
    setStockSellValue(v[0]?.s ?? 0);
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void loadCategories(); void load(page, search, catFilter); }, [page, catFilter]);
  async function onSearch(q: string) { setSearch(q); setPage(0); void load(0, q, catFilter); }
  function onCat(c: string) { setCatFilter(c); setPage(0); void load(0, search, c); }
  function clearSearch() { void onSearch(""); }

  async function save() {
    if (saving) return;
    if (!form.name || !form.price) return alert("Name & Price required");
    const cleanCat = form.category.trim() || "General";
    const cleanBarcode = normalizeBarcode(form.barcode.trim());
    if (cleanBarcode) {
      const db = await getDb();
      const dup = await db.select<{ id: number; name: string }[]>(
        "SELECT id, name FROM products WHERE REPLACE(REPLACE(UPPER(TRIM(barcode)), '-', ''), ' ', '') = $1 LIMIT 1",
        [normalizeBarcode(cleanBarcode)]
      );
      if (dup.length > 0 && dup[0].id !== editId) {
        return alert(`⛔ Ye barcode pehle se "${dup[0].name}" pe hai!\n\nDo products ka barcode ek jaisa nahi ho sakta. Alag barcode scan karo.`);
      }
    }
    setSaving(true);
    try {
      // FIX: direct db.execute ki jagah queue wala saveProduct
      await saveProduct({
        id: editId,
        name: form.name,
        price: Number(form.price),
        cost: Number(form.cost || 0),
        barcode: cleanBarcode,
        stock: Number(form.stock || 0),
        category: cleanCat,
        company: form.company,
      });
      setForm({ name: "", price: "", cost: "", barcode: "", stock: "", category: "General", company: "" }); setEditId(null); setBarcodeNotice("");
      void load(); void loadCategories();
    } finally { setSaving(false); }
  }
  function edit(p: Product) { setEditId(p.id); setBarcodeNotice(""); setForm({ name: p.name, price: String(p.price), cost: String(p.cost), barcode: p.barcode, stock: String(p.stock), category: p.category || "General", company: p.company || "" }); window.scrollTo({ top: 0, behavior: "smooth" }); }

  async function del(id: number, name: string) {
    const db = await getDb();
    const used = await db.select<{ c: number }[]>(
      "SELECT COUNT(*) as c FROM sale_items WHERE product_id=$1", [id]
    );
    if ((used[0]?.c ?? 0) > 0) {
      return alert(`⛔ "${name}" delete nahi ho sakta — iski ${used[0]?.c} sale history hai.\n\nAgar bechna band karna hai to Stock 0 kar do, Edit se. Delete karne se purana hisaab kharab ho jayega.`);
    }
    // FIX: confirm + queue wala deleteProduct
     await deleteProduct(id);
    alert(`"${name}" deleted successfully`);
    void load(); void loadCategories();
  }

  function downloadTemplate() {
    const csv = "name,price,cost,barcode,stock,category,company\nLAYS CHIPS,200,180,8901234567890,100,General,Lays\nPEPSI 500ML,120,100,8901234567891,50,General,Pepsi\n";
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "products-template.csv"; a.click();
    URL.revokeObjectURL(url);
  }
  function downloadJsonTemplate() {
    const json = JSON.stringify([
      { name: "LAYS CHIPS", price: 200, cost: 180, barcode: "8901234567890", stock: 100, category: "General", company: "Lays" },
      { name: "PEPSI 500ML", price: 120, cost: 100, barcode: "8901234567891", stock: 50, category: "General", company: "Pepsi" }
    ], null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "products-template.json"; a.click();
    URL.revokeObjectURL(url);
  }

  function parseCSV(text: string): ImportRow[] {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];
    const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const idx = (n: string) => header.indexOf(n);
    const rows: ImportRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols: string[] = []; let cur = "", inQ = false;
      for (const ch of lines[i]) { if (ch === '"') inQ = !inQ; else if (ch === "," && !inQ) { cols.push(cur); cur = ""; } else cur += ch; }
      cols.push(cur);
      const name = (cols[idx("name")] || "").trim();
      if (!name) continue;
      rows.push({ name, price: Number((cols[idx("price")] || "0").trim()) || 0, cost: Number((cols[idx("cost")] || "0").trim()) || 0, barcode: (cols[idx("barcode")] || "").trim(), stock: Number((cols[idx("stock")] || "0").trim()) || 0, category: (cols[idx("category")] || "General").trim() || "General", company: (cols[idx("company")] || "").trim() });
    }
    return rows;
  }

  function parseJSON(text: string): ImportRow[] {
    const data: unknown = JSON.parse(text);
    let raw: unknown[] = [];
    if (Array.isArray(data)) raw = data;
    else if (typeof data === "object" && data !== null) {
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj.products)) raw = obj.products;
      else if (Array.isArray(obj.data)) raw = obj.data;
      else if (Array.isArray(obj.items)) raw = obj.items;
      else throw new Error("JSON me products array nahi mila");
    } else throw new Error("JSON me products array nahi mila");
    return raw.map((item) => {
      const r = (typeof item === "object" && item !== null ? item : {}) as JsonProduct;
      return {
        name: toStr(pick(r, "name", "product_name", "ProductName", "title")).trim(),
        price: toNum(pick(r, "price", "sale_price", "salePrice", "Price")),
        cost: toNum(pick(r, "cost", "cost_price", "costPrice", "purchase_price")),
        barcode: toStr(pick(r, "barcode", "bar_code", "Barcode", "sku", "code")).trim(),
        stock: toNum(pick(r, "stock", "qty", "quantity", "Stock")),
        category: toStr(pick(r, "category", "Category", "cat")) || "General",
        company: toStr(pick(r, "company", "Company", "brand", "Brand")),
      };
    }).filter((r) => r.name);
  }

  async function importRows(rows: ImportRow[], label: string) {
    if (rows.length === 0) return alert("File empty ya format galat hai.");
    if (!confirm(`${rows.length} products import karein? Duplicate barcode auto-update hoga.`)) return;
    setImporting(true);
    try {
      for (let i = 0; i < rows.length; i += 1000) {
        await bulkImportProducts(rows.slice(i, i + 1000));
        setImportMsg(`Imported ${Math.min(i + 1000, rows.length)} / ${rows.length}...`);
      }
      setImportMsg(`✅ ${rows.length} products (${label}) imported successfully!`);
      void load(0, ""); void loadCategories();
      setTimeout(() => setImportMsg(""), 5000);
    } catch (err) { alert("Import failed: " + String(err)); }
    finally { setImporting(false); }
  }

  async function handleCsvFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    try { const rows = parseCSV(await file.text()); await importRows(rows, "CSV"); }
    catch (err) { alert("CSV Error: " + String(err)); }
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleJsonFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    setImportMsg("Reading JSON...");
    try { const rows = parseJSON(await file.text()); await importRows(rows, "JSON"); }
    catch (err) { alert("JSON Error: " + String(err) + "\n\nSahi format:\n[ {\"name\":\"LAYS\",\"price\":200,\"cost\":180,\"barcode\":\"123\",\"stock\":100} ]"); }
    if (jsonRef.current) jsonRef.current.value = "";
  }

  const input = "bg-slate-50 border px-4 py-3 rounded-xl outline-none focus:ring-2 focus:ring-emerald-500 w-full text-sm";
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const catPill = (active: boolean) => `px-4 py-1.5 rounded-full text-xs font-bold whitespace-nowrap ${active ? "bg-slate-900 text-white" : "bg-white border text-slate-600 hover:bg-slate-100"}`;
  const filterList = ["All", ...allCategories];
  return (
    <div className="p-7">
      <div className="flex justify-between items-end gap-4">
        <div><h2 className="text-3xl font-black tracking-tight">Products</h2><p className="text-slate-500 mt-1">{totalCount.toLocaleString()} products • Stock Value (Buy) Rs {stockValue.toLocaleString()} • Sell Rs {stockSellValue.toLocaleString()} • Page {page + 1} / {totalPages} {catFilter !== "All" ? `• ${catFilter}` : ""}</p></div>
        <div className="relative w-80 shrink-0">
          <input
            className="bg-white border px-4 py-3 pr-10 rounded-xl w-full outline-none focus:ring-2 focus:ring-emerald-500"
            placeholder="🔍 Search product / barcode..."
            value={search}
            onChange={(e) => void onSearch(e.target.value)}
          />
          {search && (
            <button
              onClick={clearSearch}
              title="Clear Search"
              className="absolute right-2 top-1/2 -translate-y-1/2 bg-slate-100 hover:bg-red-100 hover:text-red-600 text-slate-500 w-6 h-6 rounded-full text-xs font-black flex items-center justify-center transition"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1 mt-4">
        {filterList.map((c) => (
          <button key={c} onClick={() => onCat(c)} className={catPill(catFilter === c)}>{c}</button>
        ))}
      </div>

      <div className="bg-slate-900 text-white p-5 rounded-2xl mt-4">
        <div className="flex justify-between items-start gap-4">
          <div><h3 className="font-black text-lg">📥 Bulk Import — CSV / JSON — 30,000 in 1 Minute</h3><p className="text-slate-400 text-sm mt-1">JSON file ho to JSON Import dabao • CSV ho to CSV Import • Duplicate barcode auto-update • Category + Company bhi import hogi</p>{importMsg && <p className="text-emerald-400 font-bold text-sm mt-1">{importMsg}</p>}</div>
          <div className="flex gap-2 shrink-0 flex-wrap justify-end">
            <button onClick={downloadTemplate} className="bg-white text-slate-900 px-3 py-2.5 rounded-xl font-bold text-xs">⬇️ CSV Template</button>
            <button onClick={downloadJsonTemplate} className="bg-white text-slate-900 px-3 py-2.5 rounded-xl font-bold text-xs">⬇️ JSON Template</button>
            <button onClick={() => fileRef.current?.click()} disabled={importing} className="bg-emerald-500 px-4 py-2.5 rounded-xl font-bold text-xs disabled:opacity-50">{importing ? "Importing..." : "📥 Import CSV"}</button>
            <button onClick={() => jsonRef.current?.click()} disabled={importing} className="bg-blue-500 px-4 py-2.5 rounded-xl font-bold text-xs disabled:opacity-50">📄 Import JSON</button>
            <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleCsvFile} />
            <input ref={jsonRef} type="file" accept=".json,application/json" className="hidden" onChange={handleJsonFile} />
          </div>
        </div>
      </div>

      <div className="bg-white p-5 rounded-2xl border mt-4">
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-black">{editId ? "✏️ Edit Product" : "➕ Add New Product - Madina Mega Mart Shewa"}</h3>
        </div>
        {barcodeNotice && <p className="bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2 rounded-xl text-sm font-bold mb-3">{barcodeNotice}</p>}
        <div className="grid grid-cols-5 gap-3">
          <input className={`${input} col-span-2`} placeholder="Product Name * e.g Shan Masala" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className={input} list="madina-categories" placeholder="Category - Type karo e.g. Kiryana" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
          <datalist id="madina-categories">
            {allCategories.map((c) => (<option key={c} value={c} />))}
          </datalist>
          <input className={input} placeholder="Company (optional)" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          <input className={`${input} bg-amber-50`} placeholder="Barcode (scan gun se) - khaali bhi chhor sakte ho" value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} />
        </div>
        <div className="grid grid-cols-5 gap-3 mt-3">
          <input className={`${input} bg-emerald-50`} placeholder="Sale Price *" type="number" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
          <input className={input} placeholder="Cost Price" type="number" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} />
          <input className={input} placeholder="Stock" type="number" value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} />
          <div className="col-span-2 flex items-center text-xs font-bold text-slate-500">
            {form.price && form.cost && Number(form.price) < Number(form.cost) ? <span className="text-red-500">⚠️ Sell &lt; Buy — Loss hoga!</span> : form.price && form.cost ? <span className="text-emerald-600">Profit Rs {Number(form.price) - Number(form.cost)}</span> : "Profit auto dikhega"}
          </div>
        </div>
        <div className="flex gap-2 mt-3"><button onClick={() => void save()} disabled={saving} className="bg-emerald-600 text-white px-8 py-3 rounded-xl font-bold disabled:opacity-50">{saving ? "Saving..." : editId ? "Update Product" : "+ Add Product"}</button>{editId && <button onClick={() => { setEditId(null); setBarcodeNotice(""); setForm({ name: "", price: "", cost: "", barcode: "", stock: "", category: "General", company: "" }); }} className="bg-slate-100 px-6 py-3 rounded-xl font-bold">Cancel</button>}</div>
      </div>

      <div className="bg-white rounded-2xl border mt-4 overflow-hidden">
        <table className="w-full text-sm"><thead><tr className="bg-slate-50 text-left text-slate-500"><th className="px-5 py-3 font-bold">Product</th><th className="px-3 py-3 font-bold">Category</th><th className="px-3 py-3 font-bold">Barcode</th><th className="px-3 py-3 font-bold">Price</th><th className="px-3 py-3 font-bold">Cost</th><th className="px-3 py-3 font-bold">Profit</th><th className="px-3 py-3 font-bold">Stock</th><th className="px-3 py-3 font-bold">Total Buy</th><th className="px-3 py-3 font-bold text-right">Action</th></tr></thead>
          <tbody>{list.map((p) => (
            <tr key={p.id} className="border-t hover:bg-slate-50"><td className="px-5 py-3 font-bold">{p.name}<p className="text-[11px] text-slate-400 font-normal">{p.company || ""}</p></td><td className="px-3 py-3"><span className={`px-2 py-1 rounded-full text-[11px] font-bold ${p.category === "Cosmetics" ? "bg-pink-100 text-pink-700" : p.category === "Manyari" ? "bg-purple-100 text-purple-700" : p.category === "Mobile Accessories" ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-600"}`}>{p.category || "General"}</span></td><td className="px-3 py-3 text-slate-500 font-mono text-xs">{p.barcode || "—"}</td><td className="px-3 py-3 font-bold text-emerald-600">Rs {p.price}</td><td className="px-3 py-3">Rs {p.cost}</td><td className="px-3 py-3 text-blue-600 font-bold">Rs {p.price - p.cost}</td><td className="px-3 py-3"><span className={`px-2.5 py-1 rounded-full text-xs font-bold ${p.stock <= 0 ? "bg-red-100 text-red-700" : p.stock <= 5 ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>{p.stock <= 0 ? "Out of Stock" : `${p.stock} in stock`}</span></td><td className="px-3 py-3 font-bold text-slate-700">Rs {(p.cost * Math.max(0, p.stock)).toLocaleString()}</td><td className="px-3 py-3 text-right"><button onClick={() => edit(p)} className="bg-blue-50 text-blue-700 px-3 py-1.5 rounded-lg font-bold mr-2">Edit</button><button onClick={() => void del(p.id, p.name)} className="bg-red-50 text-red-600 px-3 py-1.5 rounded-lg font-bold">Delete</button></td></tr>
          ))}</tbody></table>
        {list.length === 0 && <p className="p-8 text-center text-slate-400">No products found — {catFilter !== "All" ? `Is category (${catFilter}) me koi product nahi` : "Add karo ya Import karo"}</p>}
        <div className="flex justify-between items-center p-4 border-t">
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="bg-slate-100 px-4 py-2 rounded-lg font-bold disabled:opacity-40">← Previous</button>
          <span className="font-bold text-sm">Page {page + 1} / {totalPages} • Showing {list.length} of {totalCount.toLocaleString()}</span>
          <button disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)} className="bg-slate-100 px-4 py-2 rounded-lg font-bold disabled:opacity-40">Next →</button>
        </div>
      </div>
    </div>
  );
}