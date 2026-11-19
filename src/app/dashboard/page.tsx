"use client";
import { useEffect, useState } from "react";
import { getDb, type Product, type Customer, type Sale } from "@/lib/db";
import { invoke } from "@tauri-apps/api/core";
import Link from "next/link";

type Stats = { products: number; stockValue: number; stockSellValue: number; todaySale: number; todayProfit: number; monthSale: number; monthProfit: number; yearSale: number; yearProfit: number; lowStock: number; udhar: number; todayBills: number; monthBills: number; yearBills: number };
type ItemRow = { sale_id: number; product_name: string; qty: number; price: number };
type RecentSale = Sale & { items: ItemRow[]; customerName: string };
type TopItem = { name: string; qty: number; total: number };
type Period = "today" | "weekly" | "monthly" | "all";

export default function Dashboard() {
  const [s, setS] = useState<Stats>({ products: 0, stockValue: 0, stockSellValue: 0, todaySale: 0, todayProfit: 0, monthSale: 0, monthProfit: 0, yearSale: 0, yearProfit: 0, lowStock: 0, udhar: 0, todayBills: 0, monthBills: 0, yearBills: 0 });
  const [low, setLow] = useState<Product[]>([]);
  const [recent, setRecent] = useState<RecentSale[]>([]);
  const [top, setTop] = useState<TopItem[]>([]);
  const [topPeriod, setTopPeriod] = useState<Period>("monthly");
  const [expandedSale, setExpandedSale] = useState<number | null>(null);
  const [returnQty, setReturnQty] = useState<Record<string, number>>({});
  const [backupMsg, setBackupMsg] = useState("");
  const [lastBackup, setLastBackup] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);

  async function load() {
    const db = await getDb();
    const p = await db.select<Product[]>("SELECT * FROM products");
    // ✅ FIX: Har jagah date('now','localtime') - raat 7 ke baad bhi Today sahi rahega
    const todaySales = await db.select<Sale[]>("SELECT * FROM sales WHERE date(created_at) = date('now','localtime')");
    const monthSales = await db.select<Sale[]>("SELECT * FROM sales WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m','now','localtime')");
    const yearSales = await db.select<Sale[]>("SELECT * FROM sales WHERE strftime('%Y', created_at) = strftime('%Y','now','localtime')");
    const c = await db.select<Customer[]>("SELECT * FROM customers");
    setS({
      products: p.length,
      stockValue: p.reduce((a, x) => a + x.cost * Math.max(0, x.stock), 0),
      stockSellValue: p.reduce((a, x) => a + x.price * Math.max(0, x.stock), 0),
      todaySale: todaySales.reduce((a, x) => a + x.total, 0),
      todayProfit: todaySales.reduce((a, x) => a + (x.profit ?? 0), 0),
      monthSale: monthSales.reduce((a, x) => a + x.total, 0),
      monthProfit: monthSales.reduce((a, x) => a + (x.profit ?? 0), 0),
      yearSale: yearSales.reduce((a, x) => a + x.total, 0),
      yearProfit: yearSales.reduce((a, x) => a + (x.profit ?? 0), 0),
      lowStock: p.filter((x) => x.stock <= 5).length,
      udhar: c.reduce((a, x) => a + x.total_udhar, 0),
      todayBills: todaySales.length,
      monthBills: monthSales.length,
      yearBills: yearSales.length,
    });
    setLow(p.filter((x) => x.stock <= 5).sort((a, b) => a.stock - b.stock).slice(0, 5));
    const rows = await db.select<Sale[]>("SELECT * FROM sales WHERE date(created_at) = date('now','localtime') ORDER BY id DESC LIMIT 10");
    const list: RecentSale[] = [];
    for (const sale of rows) {
      const items = await db.select<ItemRow[]>("SELECT * FROM sale_items WHERE sale_id=$1", [sale.id]);
      list.push({ ...sale, items, customerName: sale.customer_id ? c.find((x) => x.id === sale.customer_id)?.name ?? "Unknown" : "Walk-in" });
    }
    setRecent(list);
    void loadTop(topPeriod);
  }

  async function loadTop(p: Period) {
    const db = await getDb();
    let where = "";
    if (p === "today") where = "WHERE date(s.created_at) = date('now','localtime')";
    if (p === "weekly") where = "WHERE date(s.created_at) >= date('now','localtime','-7 days')";
    if (p === "monthly") where = "WHERE strftime('%Y-%m', s.created_at) = strftime('%Y-%m','now','localtime')";
    const rows = await db.select<TopItem[]>(`SELECT si.product_name as name, SUM(si.qty) as qty, SUM(si.qty * si.price) as total FROM sale_items si JOIN sales s ON s.id = si.sale_id ${where} GROUP BY si.product_name ORDER BY qty DESC LIMIT 5`);
    setTop(rows);
  }

  function markBackupDone(label: string) {
    const now = new Date().toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    setLastBackup(now);
    try { localStorage.setItem("madina-last-backup", now); } catch { /* ignore */ }
    setBackupMsg(`✅ ${label} — Sambhal ke rakho`);
    setTimeout(() => setBackupMsg(""), 5000);
  }

  async function handleNativeBackup() {
    if (backupBusy) return;
    setBackupBusy(true);
    try {
      const db = await getDb();
      await db.execute("PRAGMA wal_checkpoint(TRUNCATE)");
      const path = await invoke<string>("backup_db");
      markBackupDone(`DB Backup ho gaya: ${path}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err ?? "");
      if (msg.includes("Cancelled")) {
      } else {
        alert("DB Backup failed: " + msg);
      }
    } finally {
      setBackupBusy(false);
    }
  }

  async function exportBackupJSON() {
    try {
      const db = await getDb();
      const products = await db.select("SELECT * FROM products ORDER BY id");
      const customers = await db.select("SELECT * FROM customers ORDER BY id");
      const sales = await db.select("SELECT * FROM sales ORDER BY id");
      const sale_items = await db.select("SELECT * FROM sale_items ORDER BY id");
      const khata = await db.select("SELECT * FROM khata ORDER BY id");
      const backup = { app: "Madina Mega Mart", version: 1, exportedAt: new Date().toISOString(), products, customers, sales, sale_items, khata };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `madina-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      markBackupDone("JSON Backup Download ho gaya");
    } catch (err) { alert("Backup failed: " + String(err)); }
  }

  async function handleBackupRestore(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!confirm("⚠️ RESTORE: Backup ka data merge hoga. Jo pehle se hai wo dobara nahi aayega, Udhar overwrite nahi hoga. Continue?")) { e.target.value = ""; return; }
    try {
      const data = JSON.parse(await file.text());
      const db = await getDb();
      let pCount = 0, sCount = 0, kCount = 0, skippedKhata = 0;

      if (Array.isArray(data.products)) {
        for (const p of data.products) {
          const existing = p.barcode
            ? await db.select<{ id: number }[]>("SELECT id FROM products WHERE REPLACE(UPPER(barcode), '-', '') = $1 LIMIT 1", [(p.barcode || "").trim().toUpperCase().replace(/[\s-]/g, "")])
            : await db.select<{ id: number }[]>("SELECT id FROM products WHERE name = $1 AND (barcode IS NULL OR barcode = '') LIMIT 1", [p.name]);
          if (existing.length > 0) {
            await db.execute("UPDATE products SET name=$1, price=$2, cost=$3, category=$4, company=$5 WHERE id=$6", [p.name, p.price, p.cost, p.category || "General", p.company || "", existing[0].id]);
          } else {
            await db.execute("INSERT INTO products (name, price, cost, barcode, stock, category, company) VALUES ($1,$2,$3,$4,$5,$6,$7)", [p.name, p.price, p.cost, p.barcode || "", p.stock, p.category || "General", p.company || ""]);
          }
          pCount++;
        }
      }

      if (Array.isArray(data.customers)) {
        for (const c of data.customers) {
          await db.execute("INSERT OR IGNORE INTO customers (id, name, phone, total_udhar) VALUES ($1,$2,$3,$4)", [c.id, c.name, c.phone || "", c.total_udhar || 0]);
        }
      }

      if (Array.isArray(data.sales)) {
        for (const s of data.sales) {
          const exists = await db.select<{ id: number }[]>("SELECT id FROM sales WHERE id=$1 LIMIT 1", [s.id]);
          if (exists.length === 0) {
            await db.execute("INSERT INTO sales (id, total, cash, change_amt, customer_id, type, profit, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [s.id, s.total, s.cash, s.change_amt, s.customer_id, s.type, s.profit ?? 0, s.created_at]);
            sCount++;
          }
        }
      }

      if (Array.isArray(data.sale_items)) {
        for (const it of data.sale_items) {
          const exists = await db.select<{ sale_id: number }[]>("SELECT sale_id FROM sale_items WHERE sale_id=$1 AND product_name=$2 LIMIT 1", [it.sale_id, it.product_name]);
          if (exists.length === 0) {
            await db.execute("INSERT INTO sale_items (sale_id, product_name, qty, price) VALUES ($1,$2,$3,$4)", [it.sale_id, it.product_name, it.qty, it.price]);
          }
        }
      }

      if (Array.isArray(data.khata)) {
        for (const k of data.khata) {
          if (k.id) {
            const byId = await db.select<{ id: number }[]>("SELECT id FROM khata WHERE id=$1 LIMIT 1", [k.id]);
            if (byId.length > 0) { skippedKhata++; continue; }
          }
          const dup = await db.select<{ id: number }[]>(
            "SELECT id FROM khata WHERE customer_id=$1 AND amount=$2 AND type=$3 AND COALESCE(note,'')=$4 AND COALESCE(created_at,'')=$5 LIMIT 1",
            [k.customer_id, k.amount, k.type || "udhar", k.note || "", k.created_at || ""]
          );
          if (dup.length === 0) {
            await db.execute("INSERT INTO khata (id, customer_id, amount, note, type, created_at) VALUES ($1,$2,$3,$4,$5,$6)", [k.id, k.customer_id, k.amount, k.note || "", k.type || "udhar", k.created_at || new Date().toISOString()]);
            kCount++;
          } else {
            skippedKhata++;
          }
        }
      }

      const allCustomers = await db.select<{ id: number }[]>("SELECT id FROM customers");
      for (const cust of allCustomers) {
        const sums = await db.select<{ udhar: number; paid: number }[]>(
          "SELECT COALESCE(SUM(CASE WHEN type='udhar' THEN amount ELSE 0 END),0) as udhar, COALESCE(SUM(CASE WHEN type='paid' THEN amount ELSE 0 END),0) as paid FROM khata WHERE customer_id=$1",
          [cust.id]
        );
        const correctUdhar = Math.max(0, (sums[0]?.udhar || 0) - (sums[0]?.paid || 0));
        await db.execute("UPDATE customers SET total_udhar=$1 WHERE id=$2", [correctUdhar, cust.id]);
      }

      alert(`✅ Restore ho gaya!\nProducts checked: ${pCount}\nSales nayi aayi: ${sCount} (baaki pehle se thi)\nKhata nayi aayi: ${kCount}, Duplicate skip ki: ${skippedKhata}\n\nUdhar Khata se dobara calculate kar diya hai.`);
      window.location.reload();
    } catch (err) { alert("Restore failed: " + String(err)); }
    e.target.value = "";
  }

   
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    try { setLastBackup(localStorage.getItem("madina-last-backup") || ""); } catch { /* ignore */ }
    void load();
  }, []);

  useEffect(() => { void loadTop(topPeriod); }, [topPeriod]);

    async function handlePartialReturn(sale: RecentSale, item: ItemRow, qty: number) {
    if (qty <= 0 || qty > item.qty) return alert(`Sirf 1 se ${item.qty} tak return ho sakta hai`);
    if (!confirm(`${item.product_name} x${qty} Return karna hai? Stock wapis ayega.`)) return;
    const db = await getDb();
    const refund = item.price * qty;
    const prod = await db.select<{ cost: number }[]>("SELECT cost FROM products WHERE name=$1 LIMIT 1", [item.product_name]);
    const profitToCut = Math.max(0, (item.price - (prod[0]?.cost ?? item.price)) * qty);
    await db.execute("UPDATE products SET stock = stock + $1 WHERE name=$2", [qty, item.product_name]);
    if (sale.type === "udhar" && sale.customer_id) {
      await db.execute("UPDATE customers SET total_udhar = MAX(0, total_udhar - $1) WHERE id=$2", [refund, sale.customer_id]);
      await db.execute("INSERT INTO khata (customer_id, amount, note, type, created_at) VALUES ($1,$2,$3,'paid', datetime('now','localtime'))", [sale.customer_id, refund, `Return Sale #${sale.id} - ${item.product_name} x${qty}`]);
    }
    if (qty >= item.qty) await db.execute("DELETE FROM sale_items WHERE sale_id=$1 AND product_name=$2", [sale.id, item.product_name]);
    else await db.execute("UPDATE sale_items SET qty = qty - $1 WHERE sale_id=$2 AND product_name=$3", [qty, sale.id, item.product_name]);
    const newTotal = sale.total - refund;
    // ✅ FIX: Change dobara nikalo - Cash sale pe 1800 - 1400 = 400
    const newChange = sale.type === "cash" ? Math.max(0, sale.cash - newTotal) : 0;
    if (newTotal <= 0) {
      await db.execute("DELETE FROM sale_items WHERE sale_id=$1", [sale.id]);
      await db.execute("DELETE FROM sales WHERE id=$1", [sale.id]);
    } else {
      await db.execute("UPDATE sales SET total=$1, profit=$2, change_amt=$3 WHERE id=$4", [newTotal, Math.max(0, (sale.profit ?? 0) - profitToCut), newChange, sale.id]);
    }
    alert(`✅ ${item.product_name} x${qty} Return — Rs ${refund} customer ko WAPIS do${sale.type === "cash" ? ` (Change ab Rs ${newChange} hoga)` : ""}`);
    setReturnQty({});
    void load();
  }

  const card = "bg-white p-5 rounded-2xl border shadow-sm";
  const cards = [
    { label: "Today Sale", value: `Rs ${s.todaySale.toLocaleString()}`, sub: `${s.todayBills} bills today`, icon: "💰", color: "text-emerald-600 bg-emerald-50" },
    { label: "Today Profit", value: `Rs ${s.todayProfit.toLocaleString()}`, sub: "Profit on today's sales", icon: "📈", color: "text-blue-600 bg-blue-50" },
    { label: "Month Sale", value: `Rs ${s.monthSale.toLocaleString()}`, sub: `${s.monthBills} bills • Profit Rs ${s.monthProfit.toLocaleString()}`, icon: "📅", color: "text-indigo-600 bg-indigo-50" },
    { label: "This Year Sale", value: `Rs ${s.yearSale.toLocaleString()}`, sub: `${s.yearBills} bills • Profit Rs ${s.yearProfit.toLocaleString()}`, icon: "🏆", color: "text-violet-600 bg-violet-50" },
    { label: "Total Udhar", value: `Rs ${s.udhar.toLocaleString()}`, sub: "Pending from customers", icon: "📒", color: "text-red-600 bg-red-50" },
    { label: "Total Products", value: `${s.products}`, sub: `${s.lowStock} low stock items`, icon: "📦", color: "text-slate-700 bg-slate-100" },
    { label: "Stock Value (Buy)", value: `Rs ${s.stockValue.toLocaleString()}`, sub: `Sell Rs ${s.stockSellValue.toLocaleString()} • Profit Rs ${(s.stockSellValue - s.stockValue).toLocaleString()}`, icon: "🏪", color: "text-purple-600 bg-purple-50" },
    { label: "Low Stock Alert", value: `${s.lowStock} items`, sub: "Stock 5 or less", icon: "⚠️", color: "text-amber-600 bg-amber-50" },
  ];
  const pill = (active: boolean) => `px-3 py-1 rounded-full text-xs font-bold ${active ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`;

  const yearSaleCost = Math.max(0, s.yearSale - s.yearProfit);
  const saleProfitPct = s.yearSale > 0 ? Math.round((s.yearProfit / s.yearSale) * 100) : 0;
  const saleCostPct = 100 - saleProfitPct;
  const stockProfit = Math.max(0, s.stockSellValue - s.stockValue);
  const stockBuyPct = s.stockSellValue > 0 ? Math.round((s.stockValue / s.stockSellValue) * 100) : 0;
  const stockProfitPct = 100 - stockBuyPct;

  return (
    <div className="p-7">
      <div className="flex justify-between items-end">
        <div><h2 className="text-3xl font-black tracking-tight">Dashboard</h2><p className="text-slate-500 mt-1">Madina Mega Mart • Shewa — Today Overview • {new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</p></div>
        <Link href="/dashboard/sales" className="bg-slate-900 text-white px-5 py-3 rounded-xl font-bold">+ New Sale →</Link>
      </div>
      <div className="grid grid-cols-3 gap-4 mt-6">
        {cards.map((c) => (
          <div key={c.label} className={card}>
            <div className="flex justify-between"><p className="text-slate-500 text-sm font-medium">{c.label}</p><span className={`w-9 h-9 rounded-xl flex items-center justify-center ${c.color}`}>{c.icon}</span></div>
            <p className="text-3xl font-black mt-2 tracking-tight">{c.value}</p>
            <p className="text-slate-400 text-xs mt-1">{c.sub}</p>
          </div>
        ))}
      </div>

      <div className="bg-slate-900 text-white p-5 rounded-2xl mt-4 flex justify-between items-center gap-4 flex-wrap">
        <div>
          <h3 className="font-black text-lg">💾 Data Backup — Safe Rakho</h3>
          <p className="text-slate-400 text-sm mt-1">Har hafte Backup le lo — PC kharab / Windows dobara ho to bhi data wapis aa jayega</p>
          <p className="text-emerald-400 text-xs font-bold mt-1">Backup me: Products + Customers + Sales + Khata — Sab kuch {lastBackup ? `• Last Backup: ${lastBackup}` : ""}</p>
          {backupMsg && <p className="text-emerald-400 font-bold text-sm mt-1">{backupMsg}</p>}
        </div>
        <div className="flex gap-2 shrink-0 flex-wrap">
          <button onClick={() => void handleNativeBackup()} disabled={backupBusy} className="bg-blue-500 disabled:opacity-50 px-5 py-3 rounded-xl font-bold text-sm">{backupBusy ? "⏳ Backup ho raha..." : "💾 DB Backup (.db)"}</button>
          <button onClick={() => void exportBackupJSON()} className="bg-emerald-500 px-5 py-3 rounded-xl font-bold text-sm">📄 JSON Backup</button>
          <label className="bg-amber-500 text-black px-5 py-3 rounded-xl font-bold text-sm cursor-pointer">♻️ Restore Backup
            <input type="file" accept=".json" className="hidden" onChange={handleBackupRestore} />
          </label>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mt-4">
        <div className="bg-white rounded-2xl border p-5 flex items-center gap-5">
          <div
            className="w-28 h-28 rounded-full shrink-0 flex items-center justify-center"
            style={{ background: `conic-gradient(#10b981 0% ${saleProfitPct}%, #0f172a ${saleProfitPct}% 100%)` }}
          >
            <div className="w-16 h-16 bg-white rounded-full flex flex-col items-center justify-center text-center px-1">
              <b className="text-xs leading-tight">Rs {s.yearSale.toLocaleString()}</b>
              <span className="text-[10px] text-slate-400">Year Sale</span>
            </div>
          </div>
          <div className="flex-1">
            <h3 className="font-black">🍩 Sales Breakdown</h3>
            <p className="text-xs text-slate-400">Is saal ki total sale ka %</p>
            <p className="text-xs mt-2 flex items-center gap-2"><span className="w-3 h-3 bg-emerald-500 rounded-full inline-block shrink-0"></span> Profit — Rs {s.yearProfit.toLocaleString()} ({saleProfitPct}%)</p>
            <p className="text-xs mt-1 flex items-center gap-2"><span className="w-3 h-3 bg-slate-900 rounded-full inline-block shrink-0"></span> Cost — Rs {yearSaleCost.toLocaleString()} ({saleCostPct}%)</p>
          </div>
        </div>

        <div className="bg-white rounded-2xl border p-5 flex items-center gap-5">
          <div
            className="w-28 h-28 rounded-full shrink-0 flex items-center justify-center"
            style={{ background: `conic-gradient(#22c55e 0% ${stockProfitPct}%, #7c3aed ${stockProfitPct}% 100%)` }}
          >
            <div className="w-16 h-16 bg-white rounded-full flex flex-col items-center justify-center text-center px-1">
              <b className="text-xs leading-tight">Rs {s.stockSellValue.toLocaleString()}</b>
              <span className="text-[10px] text-slate-400">Sell Value</span>
            </div>
          </div>
          <div className="flex-1">
            <h3 className="font-black">🍩 Stock Breakdown</h3>
            <p className="text-xs text-slate-400">Poore stock ka % — Kitna laga, kitna bachega</p>
            <p className="text-xs mt-2 flex items-center gap-2"><span className="w-3 h-3 bg-purple-600 rounded-full inline-block shrink-0"></span> Buy Cost — Rs {s.stockValue.toLocaleString()} ({stockBuyPct}%)</p>
            <p className="text-xs mt-1 flex items-center gap-2"><span className="w-3 h-3 bg-green-500 rounded-full inline-block shrink-0"></span> Profit — Rs {stockProfit.toLocaleString()} ({stockProfitPct}%)</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mt-4">
        <Link href="/dashboard/sales" className="bg-emerald-600 hover:bg-emerald-700 text-white p-7 rounded-2xl flex items-center gap-4 transition"><span className="text-5xl">🛒</span><span><span className="block text-2xl font-black">Start New Sale</span><span className="text-emerald-100 text-sm">Cash & Udhar • Print Receipt</span></span></Link>
        <Link href="/dashboard/products" className="bg-slate-900 hover:bg-slate-800 text-white p-7 rounded-2xl flex items-center gap-4 transition"><span className="text-5xl">📦</span><span><span className="block text-2xl font-black">Manage Products</span><span className="text-slate-400 text-sm">Add • Edit • Stock • Barcode</span></span></Link>
      </div>

      <div className="grid grid-cols-2 gap-4 mt-4">
        <div className="bg-white rounded-2xl border p-5">
          <div className="flex justify-between items-center"><h3 className="font-black text-lg">Today Recent Sales</h3><span className="bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full text-[11px] font-bold">{s.todayBills} today</span></div>
          <div className="space-y-3 mt-3 max-h-105 overflow-y-auto">
            {recent.map((sale) => (
              <div key={sale.id} className="border rounded-xl overflow-hidden">
                <button onClick={() => setExpandedSale(expandedSale === sale.id ? null : sale.id)} className="w-full flex justify-between px-3 py-2 bg-slate-50 text-left">
                  <div><p className="font-black text-xs">Bill #{sale.id} • {new Date(sale.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p><p className="text-[11px] text-slate-500">Profit {sale.profit ?? 0} • {sale.type === "udhar" ? sale.customerName : "Paid"}</p></div>
                  <div className="text-right"><p className="font-black text-xs">Rs {sale.total}</p><p className="text-[11px] text-slate-400">{expandedSale === sale.id ? "▲ Hide" : "▼ Items"}</p></div>
                </button>
                {expandedSale === sale.id ? (
                  <div className="divide-y">
                    {sale.items.map((it, idx) => {
                      const key = `${sale.id}-${it.product_name}`;
                      const rq = returnQty[key] ?? 1;
                      return (
                        <div key={idx} className="px-3 py-2">
                          <div className="flex justify-between"><p className="font-bold text-xs">{it.product_name}</p><b className="text-xs">Rs {it.qty * it.price}</b></div>
                          <p className="text-[11px] text-slate-500">Qty {it.qty} x Rs {it.price}</p>
                          <div className="flex gap-1.5 mt-1 items-center">
                            <div className="flex items-center border rounded-lg overflow-hidden"><button onClick={() => setReturnQty((m) => ({ ...m, [key]: Math.max(1, rq - 1) }))} className="px-2 py-1 bg-slate-100 font-black text-xs">-</button><span className="px-2 text-xs font-bold">{rq}/{it.qty}</span><button onClick={() => setReturnQty((m) => ({ ...m, [key]: Math.min(it.qty, rq + 1) }))} className="px-2 py-1 bg-slate-100 font-black text-xs">+</button></div>
                            <button onClick={() => void handlePartialReturn(sale, it, rq)} className="flex-1 bg-red-50 text-red-600 py-1.5 rounded-lg text-[11px] font-bold">↩ Return x{rq}</button>
                            <button onClick={() => void handlePartialReturn(sale, it, it.qty)} className="bg-slate-100 px-2 py-1.5 rounded-lg text-[11px] font-bold">All {it.qty}</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="px-3 py-2 space-y-0.5">{sale.items.map((it, idx) => (<p key={idx} className="text-xs text-slate-600">• {it.product_name} <b>x{it.qty}</b> — Rs {it.qty * it.price}</p>))}</div>
                )}
              </div>
            ))}
            {recent.length === 0 && <p className="text-slate-400 py-4 text-sm">Aaj koi sale nahi</p>}
          </div>
        </div>

        <div className="space-y-4">
          <div className="bg-white rounded-2xl border p-5">
            <div className="flex justify-between items-center"><h3 className="font-black text-lg">⚠️ Low Stock — Needs Restock</h3><Link href="/dashboard/products" className="text-xs font-bold bg-slate-100 px-2 py-1 rounded">Manage</Link></div>
            {low.length === 0 ? <p className="text-slate-400 py-4 text-sm">All products have good stock ✅</p> : low.map((p) => (
              <div key={p.id} className="flex justify-between py-2.5 border-b last:border-0"><span className="font-medium">{p.name}</span><span className={`font-bold ${p.stock <= 0 ? "text-red-600" : "text-amber-600"}`}>{p.stock <= 0 ? "Out of Stock" : `Only ${p.stock} left`} • Rs {p.price}</span></div>
            ))}
            <Link href="/dashboard/products" className="text-emerald-600 font-bold text-sm">View all products →</Link>
          </div>
          <div className="bg-white rounded-2xl border p-5">
            <div className="flex justify-between items-center"><h3 className="font-black text-lg">🏆 Top Selling</h3><div className="flex gap-1"><button onClick={() => setTopPeriod("today")} className={pill(topPeriod === "today")}>Today</button><button onClick={() => setTopPeriod("weekly")} className={pill(topPeriod === "weekly")}>Weekly</button><button onClick={() => setTopPeriod("monthly")} className={pill(topPeriod === "monthly")}>Monthly</button><button onClick={() => setTopPeriod("all")} className={pill(topPeriod === "all")}>All</button></div></div>
            <div className="space-y-2 mt-3">
              {top.map((t, i) => (<div key={t.name} className="flex justify-between text-sm"><p className="font-bold text-xs">{i + 1}. {t.name} • {t.qty} pcs</p><b className="text-xs">Rs.{t.total.toLocaleString()}</b></div>))}
              {top.length === 0 && <p className="text-slate-400 text-sm">Is period me koi sale nahi</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}