"use client";
import { useEffect, useMemo, useState } from "react";
import { getDb, type Sale, type SaleItem } from "@/lib/db";

type SaleWithItems = Sale & { items: SaleItem[]; customerName: string };
type Period = "today" | "weekly" | "monthly" | "all";
type TypeFilter = "all" | "cash" | "udhar";
type PaperSize = "80mm" | "58mm";

export default function History() {
  const [sales, setSales] = useState<SaleWithItems[]>([]);
  const [udharPending, setUdharPending] = useState(0);
  const [period, setPeriod] = useState<Period>("weekly");
  const [filter, setFilter] = useState<TypeFilter>("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [returnQty, setReturnQty] = useState<Record<string, number>>({});
  const [paperSize, setPaperSize] = useState<PaperSize>("80mm");
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("madina-paper-size");
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved === "58mm" || saved === "80mm") setPaperSize(saved);
    } catch { /* ignore */ }
  }, []);

  function changePaperSize(v: PaperSize) {
    setPaperSize(v);
    try { localStorage.setItem("madina-paper-size", v); } catch { /* ignore */ }
  }

  async function load() {
    const db = await getDb();
    const rows = await db.select<Sale[]>("SELECT * FROM sales ORDER BY id DESC LIMIT 500");
    const customers = await db.select<{ id: number; name: string }[]>("SELECT id, name FROM customers");
    // ✅ FIX: 500 queries nahi, 1 query - saare items ek saath
    const allItems: SaleItem[] = rows.length
      ? await db.select<SaleItem[]>(`SELECT * FROM sale_items WHERE sale_id IN (${rows.map((_, i) => `$${i + 1}`).join(",")})`, rows.map((s) => s.id))
      : [];
    const bySale = new Map<number, SaleItem[]>();
    for (const it of allItems) {
      const arr = bySale.get(it.sale_id) ?? [];
      arr.push(it);
      bySale.set(it.sale_id, arr);
    }
    const withItems: SaleWithItems[] = rows.map((s) => ({
      ...s,
      items: bySale.get(s.id) ?? [],
      customerName: s.customer_id ? customers.find((c) => c.id === s.customer_id)?.name ?? "Unknown" : "Walk-in",
    }));
    setSales(withItems);
    const u = await db.select<{ t: number }[]>("SELECT COALESCE(SUM(total_udhar),0) as t FROM customers");
    setUdharPending(u[0]?.t ?? 0);
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, []);

  // ✅ FIX: MAX(0) + Khata created_at localtime
  async function handlePartialReturn(sale: SaleWithItems, item: SaleItem, qty: number) {
  if (qty <= 0 || qty > item.qty) return alert(`Sirf 1 se ${item.qty} tak return ho sakta hai`);
  if (!confirm(`${item.product_name} x${qty} Return karna hai? Stock wapis ayega.`)) return;
  const db = await getDb();
  const refund = item.price * qty;
  // ✅ Cost item me pehle se hai — naam se DB me dhoondne ki zaroorat nahi
  const profitToCut = Math.max(0, (item.price - (item.cost ?? item.price)) * qty);
  const newTotal = sale.total - refund;
  const newChange = sale.type === "cash" ? Math.max(0, sale.cash - newTotal) : 0;

  await db.execute("BEGIN TRANSACTION");
  try {
    // ✅ Stock + sale_items — ID se, naam se nahi
    await db.execute("UPDATE products SET stock = stock + $1 WHERE id=$2", [qty, item.product_id]);
    if (sale.type === "udhar" && sale.customer_id) {
      await db.execute("UPDATE customers SET total_udhar = MAX(0, total_udhar - $1) WHERE id=$2", [refund, sale.customer_id]);
      await db.execute("INSERT INTO khata (customer_id, amount, note, type, created_at) VALUES ($1,$2,$3,'paid', datetime('now','localtime'))", [sale.customer_id, refund, `Return Sale #${sale.id} - ${item.product_name} x${qty}`]);
    }
    if (qty >= item.qty) await db.execute("DELETE FROM sale_items WHERE sale_id=$1 AND product_id=$2", [sale.id, item.product_id]);
    else await db.execute("UPDATE sale_items SET qty = qty - $1 WHERE sale_id=$2 AND product_id=$3", [qty, sale.id, item.product_id]);

    // ✅ Full Return pe Sale DELETE mat karo — total 0 karke saboot rakho
    if (newTotal <= 0) {
      await db.execute("UPDATE sales SET total=$1, profit=$2, change_amt=$3 WHERE id=$4", [0, 0, 0, sale.id]);
    } else {
      await db.execute("UPDATE sales SET total=$1, profit=$2, change_amt=$3 WHERE id=$4", [newTotal, Math.max(0, (sale.profit ?? 0) - profitToCut), newChange, sale.id]);
    }
    await db.execute("COMMIT");
  } catch (e) {
    await db.execute("ROLLBACK");
    alert("Return fail: " + String(e));
    return;
  }
  alert(`✅ ${item.product_name} x${qty} Return — Rs ${refund} customer ko WAPIS do${sale.type === "cash" ? ` (Change ab Rs ${newChange} hoga)` : ""}`);
  setReturnQty({});
  void load();
}

  async function openPrintWindow(html: string, title: string) {
    if (printing) return;
    setPrinting(true);
    await new Promise<void>((resolve) => {
      const old = document.getElementById("print-frame");
      if (old) old.remove();
      const iframe = document.createElement("iframe");
      iframe.id = "print-frame";
      iframe.title = title;
      iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
      iframe.srcdoc = html;
      document.body.appendChild(iframe);
      iframe.onload = () => {
        setTimeout(() => {
          try {
            iframe.contentWindow?.focus();
            iframe.contentWindow?.print();
          } catch { /* ignore */ }
          setTimeout(() => { iframe.remove(); resolve(); }, 1500);
        }, 400);
      };
      setTimeout(() => { if (document.getElementById("print-frame")) { iframe.remove(); resolve(); } }, 5000);
    });
    setPrinting(false);
  }

  function printOldBill(sale: SaleWithItems) {
    const is58 = paperSize === "58mm";
    const pageW = is58 ? "58mm" : "80mm";
    // ✅ 80mm waisa hi - 72mm | 58mm patla - 46mm
    const bodyW = is58 ? "46mm" : "72mm";
    const h1Size = is58 ? "15px" : "26px";
    const h2Size = is58 ? "13px" : "21px";
    const baseSize = is58 ? "10px" : "14px";
    const tableFont = is58 ? "9px" : "12px";
    const boxFont = is58 ? "9px" : "12px";
    const totalFont = is58 ? "10px" : "13px";
    const cellPad = is58 ? "1px 1px" : "3px 4px";
    const boxPad = is58 ? "2px 1px" : "4px 2px";
    // ✅ .00 RAKHA HAI
    const fmt = (n: number) => Number(n || 0).toFixed(2);
    const itemsHtml = sale.items.map((c) => `<tr><td style="border:${is58 ? "1px" : "2px"} solid #000; padding:${cellPad}; text-align:left; font-weight:900; word-break:break-word; overflow-wrap:break-word;">${c.product_name.toUpperCase()}</td><td style="border:${is58 ? "1px" : "2px"} solid #000; padding:${cellPad}; text-align:center; font-weight:900;">${fmt(Number(c.qty || 0))}</td><td style="border:${is58 ? "1px" : "2px"} solid #000; padding:${cellPad}; text-align:right; font-weight:900;">${fmt(Number(c.price || 0))}</td><td style="border:${is58 ? "1px" : "2px"} solid #000; padding:${cellPad}; text-align:right; font-weight:900;">${fmt(Number(c.price || 0) * Number(c.qty || 0))}</td></tr>`).join("");
    const totalQty = sale.items.reduce((s, c) => s + Number(c.qty || 0), 0);
    const d = new Date(sale.created_at);
    // ✅ 58mm: Date chhoti + Time 6:25 PM | 80mm: waisa hi
    const shortDate = is58
      ? `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getFullYear()).slice(2)}`
      : d.toLocaleDateString("en-GB");
    const shortTime = is58
      ? `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() >= 12 ? "PM" : "AM"}`
      : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const counterLabel = is58 ? "No." : "Counter";
    const itemLabel = is58 ? "Item" : "Description";
    const html = `<html><head><meta charset="utf-8"><title>Bill #${sale.id} - Reprint</title><style>@page { size: ${pageW} auto; margin: 0; } * { margin:0; padding:0; box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; } body { font-family: Arial, Helvetica, sans-serif; font-weight:900; width: ${bodyW}; margin: 0 auto; font-size: ${baseSize}; color: #000; background:#fff; letter-spacing:0; } b, strong, th, td { font-weight:900; color:#000; } h1 { font-size: ${h1Size}; line-height:1.15; text-align:center; font-weight:900; letter-spacing:0; word-break:break-word; } h2 { font-size: ${h2Size}; line-height:1.1; text-align:center; font-weight:900; margin-top:2px; } .addr { text-align:center; font-size: ${is58 ? "9px" : "12px"}; font-weight:900; line-height:1.3; margin-top:2px; word-break:break-word; } .box { border: ${is58 ? "1px" : "2px"} solid #000; margin-top: ${is58 ? "5px" : "7px"}; border-collapse: collapse; width:100%; table-layout:fixed; } .box td { border: ${is58 ? "1px" : "2px"} solid #000; text-align:center; padding:${boxPad}; font-weight:900; font-size:${boxFont}; word-break:break-word; overflow-wrap:break-word; } .box td.val { font-weight:900; font-size:${boxFont}; } .cust { margin: ${is58 ? "3px" : "5px"} 0; font-weight:900; font-size:${is58 ? "10px" : "13px"}; word-break:break-word; } table.grid { width:100%; border-collapse: collapse; border: ${is58 ? "1px" : "2px"} solid #000; table-layout:fixed; } table.grid th { border: ${is58 ? "1px" : "2px"} solid #000; padding:${cellPad}; font-weight:900; font-size:${tableFont}; word-break:break-word; } table.grid td { border: ${is58 ? "1px" : "2px"} solid #000; padding:${cellPad}; font-size:${tableFont}; font-weight:900; word-break:break-word; overflow-wrap:break-word; } table.grid th:nth-child(1), table.grid td:nth-child(1) { width:${is58 ? "38%" : "44%"}; } table.grid th:nth-child(2), table.grid td:nth-child(2) { width:${is58 ? "14%" : "16%"}; } table.grid th:nth-child(3), table.grid td:nth-child(3) { width:${is58 ? "23%" : "20%"}; } table.grid th:nth-child(4), table.grid td:nth-child(4) { width:${is58 ? "25%" : "20%"}; } table.totals { width:100%; border-collapse: collapse; border: ${is58 ? "1px" : "2px"} solid #000; border-top:none; table-layout:fixed; } table.totals td { border: ${is58 ? "1px" : "2px"} solid #000; padding:${is58 ? "2px 2px" : "4px"}; font-weight:900; font-size:${totalFont}; word-break:break-word; } table.totals td:first-child { width:${is58 ? "52%" : "60%"}; } table.totals td:last-child { width:${is58 ? "48%" : "40%"}; } .items-line { font-weight:900; margin-top:${is58 ? "3px" : "5px"}; font-size:${is58 ? "10px" : "13px"}; } .thanks { text-align:center; font-weight:900; font-size:${is58 ? "11px" : "15px"}; line-height:1.3; margin-top:${is58 ? "6px" : "9px"}; }</style></head><body><h1>MADINA MEGA MART</h1><h2>SHEWA</h2><div class="addr">Ghulam Khel Chowk opp HabibMetro Bank<br/>0311-6144691 - 0345-9500176</div><table class="box"><colgroup><col style="width:${is58 ? "26%" : "28%"}"><col style="width:${is58 ? "30%" : "26%"}"><col style="width:${is58 ? "20%" : "22%"}"><col style="width:${is58 ? "24%" : "24%"}"></colgroup><tr><td>Date</td><td>Time</td><td>Bill #</td><td>${counterLabel}</td></tr><tr><td class="val">${shortDate}</td><td class="val">${shortTime}</td><td class="val">${sale.id}</td><td class="val">1</td></tr></table><div class="cust">Customer: ${sale.type === "udhar" ? sale.customerName.toUpperCase() : "CASH"} (REPRINT)</div><table class="grid"><tr><th style="text-align:left">${itemLabel}</th><th>Qty</th><th style="text-align:right">Price</th><th style="text-align:right">Amount</th></tr>${itemsHtml}</table><table class="totals"><tr><td>Sub Total</td><td style="text-align:right">${fmt(sale.total)}</td></tr><tr><td><b>Grand Total</b></td><td style="text-align:right"><b>${fmt(sale.total)}</b></td></tr><tr><td>Payment</td><td style="text-align:right">${sale.type === "cash" ? fmt(sale.cash) : "0.00"}</td></tr><tr><td>Change</td><td style="text-align:right">${sale.type === "cash" ? fmt(sale.change_amt) : "0.00"}</td></tr></table><div class="items-line">Items : ${totalQty}</div><div class="thanks">THANK YOU<br/>FOR YOUR<br/>KIND VISIT.</div></body></html>`;
    void openPrintWindow(html, `Bill #${sale.id} - Reprint`);
  }

  const filtered = useMemo(() => {
    const now = new Date();
    const start = new Date(now);
    if (period === "today") start.setHours(0, 0, 0, 0);
    if (period === "weekly") start.setDate(now.getDate() - 7);
    if (period === "monthly") start.setMonth(now.getMonth() - 1);
    return sales.filter((s) => {
      if (period !== "all") {
        const d = new Date(s.created_at);
        if (!Number.isNaN(d.getTime()) && d < start) return false;
      }
      if (filter !== "all" && s.type !== filter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        const inItems = s.items.some((i) => i.product_name.toLowerCase().includes(q));
        const inCust = s.customerName.toLowerCase().includes(q);
        const inId = String(s.id).includes(q);
        if (!inItems && !inCust && !inId) return false;
      }
      return true;
    });
  }, [sales, period, filter, search]);

  const groups = useMemo(() => {
    const map = new Map<string, { label: string; sales: SaleWithItems[] }>();
    for (const s of filtered) {
      const d = new Date(s.created_at);
      const key = Number.isNaN(d.getTime()) ? "Unknown" : d.toLocaleDateString("en-CA");
      const label = Number.isNaN(d.getTime()) ? s.created_at : d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
      if (!map.has(key)) map.set(key, { label, sales: [] });
      map.get(key)!.sales.push(s);
    }
    return [...map.values()];
  }, [filtered]);

  const totalSale = filtered.reduce((a, s) => a + s.total, 0);
  const totalProfit = filtered.reduce((a, s) => a + (s.profit ?? 0), 0);
  const periodLabel = period === "today" ? "TODAY" : period === "weekly" ? "WEEKLY" : period === "monthly" ? "MONTHLY" : "ALL TIME";
  const pill = (active: boolean) =>
    `px-4 py-1.5 rounded-full text-sm font-bold transition ${active ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`;

  return (
    <div className="p-6 max-w-5xl mx-auto w-full">
      <div className="bg-red-50 border border-red-100 rounded-xl px-4 py-3 flex items-center gap-2 text-sm font-bold text-red-800 mb-4">
        <span>📒</span> Total Udhar Pending (sab customers ka): Rs {udharPending.toLocaleString()}
      </div>

      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-black tracking-tight flex items-center gap-2">🧾 Madina Mart Sales History</h1>
          <p className="text-slate-500 text-xs font-bold mt-1 tracking-wide">
            {periodLabel} • {filtered.length} sales • Rs {totalSale.toLocaleString()} • Profit Rs {totalProfit.toLocaleString()}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <label className="bg-white border px-3 py-2 rounded-full text-xs font-bold flex items-center gap-1">🖨️ Printer:
            <select value={paperSize} onChange={(e) => changePaperSize(e.target.value as PaperSize)} className="outline-none bg-transparent font-black cursor-pointer">
              <option value="80mm">80mm</option>
              <option value="58mm">58mm</option>
            </select>
          </label>
          <a href="/dashboard/sales" className="bg-slate-900 text-white px-4 py-2 rounded-full text-sm font-bold hover:bg-black">+ New Sale</a>
        </div>
      </div>

      <div className="bg-white rounded-2xl border p-4 mt-4">
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setPeriod("today")} className={pill(period === "today")}>Today</button>
          <button onClick={() => setPeriod("weekly")} className={pill(period === "weekly")}>Weekly</button>
          <button onClick={() => setPeriod("monthly")} className={pill(period === "monthly")}>Monthly</button>
          <button onClick={() => setPeriod("all")} className={pill(period === "all")}>All</button>
        </div>
        <div className="flex gap-2 mt-3">
          <button onClick={() => setFilter("all")} className={pill(filter === "all")}>All</button>
          <button onClick={() => setFilter("cash")} className={pill(filter === "cash")}>Cash</button>
          <button onClick={() => setFilter("udhar")} className={pill(filter === "udhar")}>Udhar</button>
        </div>
        <input
          className="w-full bg-slate-50 border px-4 py-3 rounded-xl mt-3 outline-none focus:ring-2 focus:ring-emerald-500 text-sm"
          placeholder="🔍 Search product / customer / barcode..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="mt-4 space-y-4">
        {groups.map((g) => {
          const dayTotal = g.sales.reduce((a, s) => a + s.total, 0);
          const dayProfit = g.sales.reduce((a, s) => a + (s.profit ?? 0), 0);
          return (
            <div key={g.label} className="bg-white rounded-2xl border overflow-hidden">
              <div className="flex justify-between items-center px-5 py-3 border-b bg-slate-50/60">
                <span className="font-black text-sm">{g.label} • {g.sales.length} sales</span>
                <span className="text-xs font-bold text-slate-500">Rs {dayTotal.toLocaleString()} Profit <span className="text-emerald-600">+{dayProfit.toLocaleString()}</span></span>
              </div>
              <div className="divide-y">
                {g.sales.map((s) => (
                  <div key={s.id} className="px-5 py-3">
                    <button onClick={() => setExpanded(expanded === s.id ? null : s.id)} className="w-full flex justify-between items-start text-left">
                      <div className="flex-1 min-w-0">
                        <div className="space-y-0.5">
                          {s.items.map((it, idx) => (
                            <p key={idx} className="font-bold text-sm truncate">• {it.product_name} <b>x{it.qty}</b> — Rs {(it.price * it.qty).toLocaleString()}</p>
                          ))}
                          {s.items.length === 0 && <p className="font-bold text-sm">Sale #{s.id}</p>}
                        </div>
                        <p className="text-xs text-slate-500 mt-1">
                          Rs {s.total.toLocaleString()} • Profit Rs {(s.profit ?? 0).toLocaleString()} • {new Date(s.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} • {s.type === "udhar" ? s.customerName : "other"} • {expanded === s.id ? "▲ Hide" : "▼ Return / Details"}
                        </p>
                      </div>
                      <div className="text-right shrink-0 ml-4 flex flex-col items-end gap-1">
                        <p className="font-black text-sm">Rs {s.total.toLocaleString()}</p>
                        <p className="text-[11px] text-slate-400">Bill #{s.id}</p>
                      </div>
                    </button>
                    <div className="flex gap-2 mt-2">
                      <button onClick={() => printOldBill(s)} disabled={printing} className="flex-1 bg-slate-900 text-white py-2 rounded-xl text-xs font-bold hover:bg-black disabled:opacity-50">🖨️ Print Bill #{s.id}</button>
                      <button onClick={() => setExpanded(expanded === s.id ? null : s.id)} className="flex-1 bg-slate-100 py-2 rounded-xl text-xs font-bold">{expanded === s.id ? "▲ Hide Details" : "▼ Return / Details"}</button>
                    </div>
                    {expanded === s.id && (
                      <div className="mt-2 bg-slate-50 rounded-xl p-3 text-xs space-y-2">
                        {s.items.map((it, idx) => {
                          const key = `${s.id}-${it.product_id}`;
                          const rq = returnQty[key] ?? 1;
                          return (
                            <div key={idx} className="bg-white rounded-lg p-2 border">
                              <div className="flex justify-between"><span className="font-bold">{it.product_name} x{it.qty}</span><b>Rs {(it.price * it.qty).toLocaleString()}</b></div>
                              <p className="text-slate-500">Qty {it.qty} x Rs {it.price}</p>
                              <div className="flex gap-1.5 mt-1 items-center">
                                <div className="flex items-center border rounded-lg overflow-hidden"><button onClick={() => setReturnQty((m) => ({ ...m, [key]: Math.max(1, rq - 1) }))} className="px-2 py-1 bg-slate-100 font-black">-</button><span className="px-2 font-bold">{rq}/{it.qty}</span><button onClick={() => setReturnQty((m) => ({ ...m, [key]: Math.min(it.qty, rq + 1) }))} className="px-2 py-1 bg-slate-100 font-black">+</button></div>
                                <button onClick={() => void handlePartialReturn(s, it, rq)} className="flex-1 bg-red-50 text-red-600 py-1.5 rounded-lg font-bold">↩ Return x{rq}</button>
                                <button onClick={() => void handlePartialReturn(s, it, it.qty)} className="bg-slate-100 px-2 py-1.5 rounded-lg font-bold">All {it.qty}</button>
                              </div>
                            </div>
                          );
                        })}
                        <div className="flex justify-between pt-1 border-t font-bold"><span>Cash: Rs {s.cash.toLocaleString()} | Change: Rs {s.change_amt.toLocaleString()}</span><span>{s.type.toUpperCase()}</span></div>
                        <button onClick={() => printOldBill(s)} disabled={printing} className="w-full bg-slate-900 text-white py-2.5 rounded-xl font-bold disabled:opacity-50">{printing ? "⏳ Printing..." : `🖨️ Is Bill Ko Dobara Print Karo (${paperSize})`}</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {groups.length === 0 && (
        <div className="bg-white rounded-2xl border p-10 text-center mt-4">
          <p className="text-4xl">🧾</p>
          <p className="font-bold mt-2">No sales found</p>
          <p className="text-slate-500 text-sm">Is period me koi sale nahi hui, ya search match nahi hua.</p>
        </div>
      )}
    </div>
  );
}