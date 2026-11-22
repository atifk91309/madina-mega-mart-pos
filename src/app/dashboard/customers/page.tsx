"use client";
import { useEffect, useState } from "react";
import { getDb, addKhataPayment, deleteCustomerKhata, type Customer, type KhataEntry } from "@/lib/db";

type SaleRow = { id: number; total: number; customer_id: number | null; type: string; created_at: string };
type ItemRow = { sale_id: number; product_name: string; qty: number; price: number };

type CustomerFull = Customer & {
  sales: (SaleRow & { items: ItemRow[] })[];
  wusool: KhataEntry[];
  returns: KhataEntry[];
  totalBill: number;
  totalPaid: number;
};

export default function CustomersPage() {
  const [list, setList] = useState<CustomerFull[]>([]);
  const [pay, setPay] = useState<Record<number, string>>({});
  const [expanded, setExpanded] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [printing, setPrinting] = useState(false);
  const [paying, setPaying] = useState<number | null>(null);

  async function load() {
    const db = await getDb();
    const custs = await db.select<Customer[]>("SELECT * FROM customers ORDER BY total_udhar DESC, id DESC");
    const sales = await db.select<SaleRow[]>("SELECT * FROM sales WHERE customer_id IS NOT NULL ORDER BY id DESC");
    // ✅ FIX: Saare sale_items nahi, sirf in customers ki sales ke items - IN query
    const saleIds = sales.map((s) => s.id);
    const items: ItemRow[] = [];
for (let i = 0; i < saleIds.length; i += 900) {
  const chunk = saleIds.slice(i, i + 900);
  const rows = await db.select<ItemRow[]>(
    `SELECT * FROM sale_items WHERE sale_id IN (${chunk.map((_, j) => `$${j + 1}`).join(",")})`,
    chunk
  );
  items.push(...rows);
}
    const khata = await db.select<KhataEntry[]>("SELECT * FROM khata ORDER BY id DESC");

    // ✅ FIX: Map se O(1) lookup - 1000 customers pe bhi foran khulega
    const itemsBySale = new Map<number, ItemRow[]>();
    for (const it of items) {
      const arr = itemsBySale.get(it.sale_id) ?? [];
      arr.push(it);
      itemsBySale.set(it.sale_id, arr);
    }
    const salesByCust = new Map<number, (SaleRow & { items: ItemRow[] })[]>();
    for (const s of sales) {
      if (s.customer_id == null) continue;
      const arr = salesByCust.get(s.customer_id) ?? [];
      arr.push({ ...s, items: itemsBySale.get(s.id) ?? [] });
      salesByCust.set(s.customer_id, arr);
    }
    const khataByCust = new Map<number, KhataEntry[]>();
    for (const k of khata) {
      const arr = khataByCust.get(k.customer_id) ?? [];
      arr.push(k);
      khataByCust.set(k.customer_id, arr);
    }

    const full: CustomerFull[] = custs.map((c) => {
      const mySales = salesByCust.get(c.id) ?? [];
      const myKhata = khataByCust.get(c.id) ?? [];
      const totalBill = myKhata.filter((k) => k.type === "udhar").reduce((a, k) => a + k.amount, 0);
      const myWusool = myKhata.filter((k) => (k.type === "paid" || k.type === "wusool") && !k.note?.startsWith("Return"));
      const myReturns = myKhata.filter((k) => k.note?.startsWith("Return"));
      const totalPaid = myWusool.reduce((a, k) => a + k.amount, 0);
      return { ...c, sales: mySales, wusool: myWusool, returns: myReturns, totalBill, totalPaid };
    });
    setList(full);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, []);

  async function addPayment(id: number, amount: number, current: number) {
  if (paying !== null) return;
  if (!amount || amount <= 0) return alert("Wusool amount likho");
  if (amount > current) return alert(`Payment more than Udhar! Baqi Rs ${current} hai`);
  if (!confirm(`Rs ${amount} Wusool karna hai? Baqi Rs ${current - amount} reh jayega.`)) return;
  setPaying(id);
  try {
    const remaining = await addKhataPayment(id, amount);
    setPay((prev) => ({ ...prev, [id]: "" }));
    alert(`✅ Rs ${amount} Wusool ho gaya — Baqi Rs ${remaining}`);
    void load();
  } catch (e) {
    alert("Wusool fail: " + String(e));
  } finally { setPaying(null); }
}

  async function handleDeleteCustomer(id: number, name: string) {
  if (!confirm(`⚠️ ${name} ka Khata DELETE karna hai?\n\nIs se Customer + Uska Khata History delete ho jayega.\nSales History (Bills) delete NAHI hogi.\n\nPakka Delete karna hai?`)) return;
  if (!confirm(`Last Confirm: ${name} ko hamesha ke liye delete kar dun?`)) return;
  try {
    await deleteCustomerKhata(id);
    alert(`✅ ${name} ka Khata delete ho gaya`);
    void load();
  } catch (err) {
    alert("Delete failed: " + String(err));
  }
}

  async function printCustomer(c: CustomerFull) {
    if (printing) return;
    setPrinting(true);
    const itemsHtml = c.sales.flatMap((s) => s.items).map((it) => `<tr><td style="border:2px solid #000; padding:3px 4px; text-align:left; font-weight:900;">${it.product_name.toUpperCase()}</td><td style="border:2px solid #000; padding:3px 4px; text-align:center; font-weight:900;">${it.qty}</td><td style="border:2px solid #000; padding:3px 4px; text-align:right; font-weight:900;">${it.price}</td><td style="border:2px solid #000; padding:3px 4px; text-align:right; font-weight:900;">${it.price * it.qty}</td></tr>`).join("");
    const wusoolHtml = c.wusool.map((w) => `<tr><td style="border:2px solid #000; padding:3px 4px; font-weight:900;">${new Date(w.created_at).toLocaleDateString("en-GB")}</td><td style="border:2px solid #000; padding:3px 4px; font-weight:900;">WUSOOL</td><td style="border:2px solid #000; padding:3px 4px; text-align:right; font-weight:900;">${w.amount}</td></tr>`).join("");
    const returnHtml = c.returns.map((w) => `<tr><td style="border:2px solid #000; padding:3px 4px; font-weight:900;">${new Date(w.created_at).toLocaleDateString("en-GB")}</td><td style="border:2px solid #000; padding:3px 4px; font-weight:900;">RETURN - ${w.note?.replace("Return ", "") ?? ""}</td><td style="border:2px solid #000; padding:3px 4px; text-align:right; font-weight:900;">-${w.amount}</td></tr>`).join("");
    const totalReturn = c.returns.reduce((a, k) => a + k.amount, 0);
    const html = `<html><head><meta charset="utf-8"><title>Khata #${c.id}</title><style>@page { size: 80mm auto; margin: 0; } * { margin:0; padding:0; box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; } body { font-family: Arial, Helvetica, sans-serif; font-weight:900; width:72mm; margin:0 auto; font-size:13px; color:#000; background:#fff; } h1 { font-size:24px; text-align:center; font-weight:900; } .center { text-align:center; font-weight:900; line-height:1.4; margin-top:3px; } table { width:100%; border-collapse:collapse; border:2px solid #000; margin-top:6px; } th, td { border:2px solid #000; padding:3px 4px; font-weight:900; } .tot { margin-top:6px; font-weight:900; font-size:14px; line-height:1.6; } .thanks { text-align:center; font-weight:900; margin-top:10px; }</style></head><body><h1>MADINA MEGA MART</h1><p class="center">SHEWA<br/>KHATA SLIP<br/>Customer: ${c.name.toUpperCase()} (#${c.id})<br/>Phone: ${c.phone || "-"}<br/>Date: ${new Date().toLocaleDateString("en-GB")}</p><div class="tot">Total Bill: Rs ${c.totalBill}<br/>Total Wusool: Rs ${c.totalPaid}<br/>Total Return: Rs ${totalReturn}<br/><b>Remaining Udhar: Rs ${c.total_udhar}</b></div><table><tr><th style="text-align:left">Item</th><th>Qty</th><th style="text-align:right">Price</th><th style="text-align:right">Amount</th></tr>${itemsHtml || `<tr><td colspan="4" style="text-align:center">Koi item nahi</td></tr>`}</table>${c.wusool.length > 0 || c.returns.length > 0 ? `<table><tr><th>Date</th><th style="text-align:left">Detail</th><th style="text-align:right">Amount</th></tr>${wusoolHtml}${returnHtml}</table>` : ""}<p class="thanks">THANK YOU</p></body></html>`;
    await new Promise<void>((resolve) => {
      const old = document.getElementById("print-frame");
      if (old) old.remove();
      const iframe = document.createElement("iframe");
      iframe.id = "print-frame";
      iframe.title = `Khata #${c.id}`;
      iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
      iframe.srcdoc = html;
      document.body.appendChild(iframe);
      iframe.onload = () => {
        setTimeout(() => {
          try { iframe.contentWindow?.focus(); iframe.contentWindow?.print(); } catch { /* ignore */ }
          setTimeout(() => { iframe.remove(); resolve(); }, 1500);
        }, 400);
      };
      setTimeout(() => { if (document.getElementById("print-frame")) { iframe.remove(); resolve(); } }, 5000);
    });
    setPrinting(false);
  }

  const totalUdhar = list.reduce((s, c) => s + c.total_udhar, 0);
  const pendingCount = list.filter((c) => c.total_udhar > 0).length;
  const paidCount = list.filter((c) => c.total_udhar <= 0 && c.totalBill > 0).length;

  const q = search.trim().toLowerCase();
  const filtered = !q
    ? list
    : list.filter((c) => c.name.toLowerCase().includes(q) || (c.phone || "").includes(q) || String(c.id).includes(q));

  return (
    <div className="p-6 max-w-4xl mx-auto w-full">
      <div className="bg-white rounded-2xl border px-5 py-4 flex justify-between items-center">
        <div>
          <h1 className="font-black flex items-center gap-2">📒 Madina Mega Mart Shewa - Khata</h1>
          <p className="text-xs text-slate-500 mt-0.5">{pendingCount} pending • {paidCount} paid • Total {list.length}</p>
        </div>
        <span className="font-black text-red-500">Rs {totalUdhar.toLocaleString()}</span>
      </div>

      <input
        className="w-full bg-white border px-4 py-3 rounded-xl mt-3 outline-none focus:ring-2 focus:ring-emerald-500 text-sm"
        placeholder="🔍 Search customer name / village / phone..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <p className="text-[11px] text-slate-500 mt-2">💡 Naya Khata banane ke liye yahan form nahi — <b>POS Sale → Udhar → Naam likho</b> → Auto Khata ban jayega</p>

      <div className="space-y-3 mt-3">
        {filtered.map((c) => (
          <div key={c.id} className="bg-white rounded-2xl border overflow-hidden">
            <div onClick={() => setExpanded(expanded === c.id ? null : c.id)} className="w-full px-5 py-4 flex justify-between items-start text-left cursor-pointer hover:bg-slate-50">
              <div>
                <p className="font-black text-sm">{c.name} <span className="text-slate-400 font-bold text-xs">#{c.id}</span></p>
                <p className="text-[11px] text-slate-500 mt-0.5">{c.phone || "No Phone"} • {c.sales.length} Bills</p>
                <p className="text-xs mt-1"><span className="text-red-500 font-bold">Rs {c.total_udhar.toLocaleString()}</span> <span className="text-slate-500">Bill Rs {c.totalBill.toLocaleString()} Paid Rs {c.totalPaid.toLocaleString()}{c.returns.length > 0 ? ` Return Rs ${c.returns.reduce((a, k) => a + k.amount, 0).toLocaleString()}` : ""}</span></p>
              </div>
              <div className="flex gap-2 items-center shrink-0" onClick={(e) => e.stopPropagation()}>
                {c.total_udhar <= 0 ? (
                  <>
                    <span className="px-4 py-2 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700">✅ Clear</span>
                    <button
                      onClick={() => void handleDeleteCustomer(c.id, c.name)}
                      className="bg-red-50 text-red-600 border border-red-200 px-3 py-2 rounded-full text-xs font-bold hover:bg-red-600 hover:text-white transition"
                    >
                      🗑️ Delete
                    </button>
                  </>
                ) : (
                  <span className="px-4 py-2 rounded-full text-xs font-bold bg-slate-900 text-white">Wusool</span>
                )}
              </div>
            </div>

            {expanded === c.id && (
              <div className="px-5 pb-4 border-t pt-3">
                <p className="font-black text-sm">🛒 Items Bought ({c.sales.reduce((a, s) => a + s.items.length, 0)})</p>
                <div className="space-y-2 mt-2">
                  {c.sales.flatMap((s) => s.items).map((it, idx) => (
                    <div key={idx} className="flex justify-between items-center bg-slate-50 rounded-xl px-3 py-2">
                      <div><p className="font-bold text-sm">{it.product_name}</p><p className="text-[11px] text-slate-500">Qty {it.qty} • Rs {it.price}/pcs • other</p><p className="text-[11px] text-slate-400">Bill #{it.sale_id}</p></div>
                      <b className="text-sm">Rs {it.price * it.qty}</b>
                    </div>
                  ))}
                  {c.sales.length === 0 && <p className="text-slate-400 text-sm">Koi sale record nahi — Opening Udhar tha</p>}
                </div>

                <div className="mt-4">
                  <p className="font-bold text-sm">Wusool History - {c.name}</p>
                  <div className="space-y-1 mt-2">
                    {c.wusool.map((w) => (
                      <div key={w.id} className="flex justify-between text-sm bg-emerald-50 rounded-lg px-3 py-2">
                        <span className="text-emerald-700 font-bold">Rs {w.amount.toLocaleString()}</span>
                        <span className="text-xs text-slate-500">{new Date(w.created_at).toLocaleString("en-GB")} <button onClick={() => void printCustomer(c)} disabled={printing} className="bg-slate-900 text-white px-2 py-0.5 rounded text-[10px] ml-1 disabled:opacity-50">Print</button></span>
                      </div>
                    ))}
                    {c.wusool.length === 0 && <p className="text-slate-400 text-sm">Abhi tak koi Wusool nahi hua</p>}
                  </div>
                </div>

                {c.returns.length > 0 && (
                  <div className="mt-3">
                    <p className="font-bold text-sm">↩️ Return History</p>
                    <div className="space-y-1 mt-2">
                      {c.returns.map((w) => (
                        <div key={w.id} className="flex justify-between text-sm bg-red-50 rounded-lg px-3 py-2">
                          <span className="text-red-700 font-bold">- Rs {w.amount.toLocaleString()} • {w.note}</span>
                          <span className="text-xs text-slate-500">{new Date(w.created_at).toLocaleString("en-GB")}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex gap-2 mt-4">
                  <input
                    className="flex-1 bg-slate-50 border px-3 py-2.5 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500"
                    placeholder="Wusool Amount — e.g 100"
                    type="number"
                    value={pay[c.id] || ""}
                    onChange={(e) => setPay((prev) => ({ ...prev, [c.id]: e.target.value }))}
                  />
                  <button onClick={() => void addPayment(c.id, Number(pay[c.id] || 0), c.total_udhar)} disabled={paying === c.id} className="bg-slate-900 text-white px-5 py-2.5 rounded-xl font-bold text-sm disabled:opacity-50">{paying === c.id ? "Saving..." : "Wusool"}</button>
                  <button onClick={() => void printCustomer(c)} disabled={printing} className="bg-slate-100 px-4 py-2.5 rounded-xl font-bold text-sm disabled:opacity-50">🖨️ Print</button>
                </div>
                <div className="flex justify-between text-sm mt-3">
                  <span className="font-bold">Total Paid: Rs {c.totalPaid.toLocaleString()}</span>
                  <span className="font-bold text-red-500">Remaining: Rs {c.total_udhar.toLocaleString()}</span>
                </div>

                {c.total_udhar <= 0 && (
                  <div className="mt-4 bg-red-50 border border-red-100 rounded-xl p-3 flex justify-between items-center">
                    <p className="text-xs text-red-600 font-bold">Udhar Clear hai — Khata rakhna hai ya delete karna hai?</p>
                    <div className="flex gap-2">
                      <button onClick={() => setExpanded(null)} className="bg-white border px-3 py-2 rounded-xl font-bold text-xs">Keep as it is</button>
                      <button onClick={() => void handleDeleteCustomer(c.id, c.name)} className="bg-red-600 text-white px-3 py-2 rounded-xl font-bold text-xs">🗑️ Delete Khata</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="bg-white rounded-2xl border p-10 text-center mt-3">
          <p className="text-4xl">📒</p>
          <p className="font-bold mt-2">Koi Khata nahi mila</p>
          <p className="text-slate-500 text-sm">Sale Page → Udhar → Naam likh ke Sale karo — Yahan auto Khata ban jayega.<br />Khata Page se customer add nahi hota.</p>
          <a href="/dashboard/sales" className="inline-block bg-slate-900 text-white px-5 py-2.5 rounded-xl font-bold text-sm mt-3">→ POS Sale pe jao</a>
        </div>
      )}
    </div>
  );
}