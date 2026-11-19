"use client";
import { useEffect, useState } from "react";
import { getDb } from "@/lib/db";

type TopItem = { name: string; qty: number; total: number; profit: number; stock: number; price: number; cost: number };
type Period = "today" | "weekly" | "monthly" | "all";

export default function TopSellingPage() {
  const [top, setTop] = useState<TopItem[]>([]);
  const [period, setPeriod] = useState<Period>("monthly");
  const [search, setSearch] = useState("");

  async function load(p: Period) {
    const db = await getDb();
    let where = "";
    // ✅ FIX: localtime har jagah
    if (p === "today") where = "WHERE date(s.created_at) = date('now','localtime')";
    if (p === "weekly") where = "WHERE date(s.created_at) >= date('now','localtime','-7 days')";
    if (p === "monthly") where = "WHERE strftime('%Y-%m', s.created_at) = strftime('%Y-%m','now','localtime')";
    // ✅ FIX: Profit SQL me hi - sale wali price minus us waqt ka cost
    // si.cost purani sales me 0 hai, to us waqt products ka cost lo. Product delete ho gaya to bhi row rahegi (LEFT JOIN)
    const rows = await db.select<TopItem[]>(`
      SELECT si.product_name as name,
        SUM(si.qty) as qty,
        SUM(si.qty * si.price) as total,
        SUM(si.qty * (si.price - COALESCE(NULLIF(si.cost, 0), pr.cost, si.price))) as profit,
        COALESCE(MAX(pr.stock), 0) as stock,
        COALESCE(MAX(pr.price), MAX(si.price)) as price,
        COALESCE(MAX(pr.cost), 0) as cost
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      LEFT JOIN products pr ON pr.name = si.product_name
      ${where}
      GROUP BY si.product_name ORDER BY qty DESC LIMIT 50
    `);
    setTop(rows.map((r) => ({ ...r, profit: Math.max(0, r.profit ?? 0) })));
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(period); }, [period]);

  const filtered = top.filter((t) => !search.trim() || t.name.toLowerCase().includes(search.toLowerCase()));
  const totalQty = filtered.reduce((a, t) => a + t.qty, 0);
  const totalSale = filtered.reduce((a, t) => a + t.total, 0);
  const totalProfit = filtered.reduce((a, t) => a + t.profit, 0);
  const pill = (active: boolean) => `px-4 py-1.5 rounded-full text-sm font-bold ${active ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`;
  const maxQty = Math.max(1, ...filtered.map((t) => t.qty));

  return (
    <div className="p-7 max-w-5xl mx-auto w-full">
      <h1 className="text-2xl font-black">🏆 Top Selling</h1>
      <p className="text-xs text-slate-500 mt-1">{filtered.length} products • {totalQty} pcs sold • Sale Rs {totalSale.toLocaleString()} • Profit Rs {totalProfit.toLocaleString()}</p>
      <div className="bg-white rounded-2xl border p-4 mt-4">
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setPeriod("today")} className={pill(period === "today")}>Today</button>
          <button onClick={() => setPeriod("weekly")} className={pill(period === "weekly")}>Weekly</button>
          <button onClick={() => setPeriod("monthly")} className={pill(period === "monthly")}>Monthly</button>
          <button onClick={() => setPeriod("all")} className={pill(period === "all")}>All</button>
        </div>
        <input className="w-full bg-slate-50 border px-4 py-3 rounded-xl mt-3 outline-none text-sm" placeholder="🔍 Search product..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="bg-white rounded-2xl border mt-4 overflow-hidden">
        {filtered.map((t, i) => (
          <div key={t.name} className="px-5 py-3 border-b last:border-0">
            <div className="flex justify-between items-center">
              <p className="font-bold text-sm">{i + 1}. {t.name} <span className="text-slate-400 font-normal text-xs">• Stock {t.stock}</span></p>
              <div className="text-right"><b className="text-sm">Rs {t.total.toLocaleString()}</b><p className="text-[11px] text-emerald-600 font-bold">Profit Rs {t.profit.toLocaleString()} • {t.qty} pcs</p></div>
            </div>
            <div className="h-2 bg-slate-100 rounded-full mt-2 overflow-hidden"><div className="h-full bg-emerald-500 rounded-full" style={{ width: `${Math.round((t.qty / maxQty) * 100)}%` }} /></div>
          </div>
        ))}
        {filtered.length === 0 && <p className="p-8 text-center text-slate-400">Is period me koi sale nahi</p>}
      </div>
    </div>
  );
}