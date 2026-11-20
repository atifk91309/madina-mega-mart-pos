"use client";
import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getDb, searchProductsFast, getOrCreateCustomer, type Product, type Customer } from "@/lib/db";

type CartItem = { p: Product; qty: number | ""; price: number | "" };
type Receipt = { id: number; items: CartItem[]; total: number; cash: number; change: number; type: string; customerName: string; date: string };
type SaleRow = { id: number; total: number; cash: number; change_amt: number; customer_id: number | null; type: string; profit: number; created_at: string };
type ItemRow = { sale_id: number; product_name: string; qty: number; price: number };
type RecentSale = SaleRow & { items: ItemRow[]; customerName: string };
type Period = "today" | "weekly" | "monthly" | "all";
type PaperSize = "80mm" | "58mm"; 
const PAGE_SIZE = 12;

function normalizeBarcode(v: string): string {
  return v.trim().toUpperCase().replace(/[\s-]/g, "");
}
function barcodesMatch(a: string, b: string): boolean {
  const x = normalizeBarcode(a);
  const y = normalizeBarcode(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const xNoZero = x.replace(/^0+/, "");
  const yNoZero = y.replace(/^0+/, "");
  return xNoZero !== "" && xNoZero === yNoZero;
}

function cleanScan(v: string): string {
  const q = v.trim();
  if (/^\d+$/.test(q) && q.length > 13) return q.slice(-13);
  // ✅ Custom: TAH-6889-GHJTAH-6889-GHJ -> TAH-6889-GHJ
  if (q.length > 6 && q.length % 2 === 0) {
    const half = q.slice(0, q.length / 2);
    if (q === half + half) return half;
  }
  if (q.length > 13) {
    const first = q.slice(0, 13);
    if (q.startsWith(first + first)) return first;
  }
  return q;
} 
 

function SalesPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const cleanMode = searchParams.get("clean") === "1";
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [qtyMap, setQtyMap] = useState<Record<number, string>>({});
  const [priceMap, setPriceMap] = useState<Record<number, string>>({});
  const [search, setSearch] = useState("");  
  const [lastScanned, setLastScanned] = useState<Product | null>(null);
  const [paid, setPaid] = useState("");
  const [saleType, setSaleType] = useState<"cash" | "udhar">("cash");
  const [udharName, setUdharName] = useState("");
  const [udharPhone, setUdharPhone] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [recent, setRecent] = useState<RecentSale[]>([]);
  const [period, setPeriod] = useState<Period>("today");
  const [todaySale, setTodaySale] = useState(0);
  const [todayProfit, setTodayProfit] = useState(0);
  const [expandedSale, setExpandedSale] = useState<number | null>(null);
  const [returnQty, setReturnQty] = useState<Record<string, number>>({});
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [paperSize, setPaperSize] = useState<PaperSize>("80mm");
  const [printing, setPrinting] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const displayedProducts = products.slice(0, visibleCount);
   

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
    try {
      const db = await getDb();
      setProducts(await searchProductsFast("", 200));
      setCustomers(await db.select<Customer[]>("SELECT * FROM customers"));
       
      void loadRecent(period);
      const t = await db.select<{ s: number; p: number }[]>("SELECT COALESCE(SUM(total),0) as s, COALESCE(SUM(profit),0) as p FROM sales WHERE date(created_at) = date('now','localtime')");
      setTodaySale(t[0]?.s ?? 0);
      setTodayProfit(t[0]?.p ?? 0);
    } catch (e) { console.error(e); }
  }
  async function loadRecent(p: Period) {
    try {
      const db = await getDb();
      let where = "";
      if (p === "today") where = "WHERE date(created_at) = date('now','localtime')";
      if (p === "weekly") where = "WHERE date(created_at) >= date('now','localtime','-7 days')";
      if (p === "monthly") where = "WHERE date(created_at) >= date('now','localtime','-1 month')";
      const rows = await db.select<SaleRow[]>(`SELECT * FROM sales ${where} ORDER BY id DESC LIMIT 20`);
      const custs = await db.select<Customer[]>("SELECT * FROM customers");
      const list: RecentSale[] = [];
      for (const s of rows) {
        const items = await db.select<ItemRow[]>("SELECT * FROM sale_items WHERE sale_id=$1", [s.id]);
        const customerName = s.customer_id ? custs.find((c) => c.id === s.customer_id)?.name ?? "Unknown" : "Walk-in";
        list.push({ ...s, items, customerName });
      }
      setRecent(list);
    } catch (e) { console.error(e); }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);
  useEffect(() => { void loadRecent(period); }, [period]);

  async function searchProducts(q: string) {
    q = cleanScan(q);
    setSearch(q);
    setVisibleCount(PAGE_SIZE);
    const all = await searchProductsFast(q, 200);
    if (normalizeBarcode(q)) {
      const barcodeFirst = [...all].sort((a, b) => {
        const aMatch = barcodesMatch(a.barcode || "", q) ? 0 : 1;
        const bMatch = barcodesMatch(b.barcode || "", q) ? 0 : 1;
        return aMatch - bMatch;
      });
       setProducts(barcodeFirst);
      return;
    }
    setProducts(all);
  }
   

  function findByBarcode(q: string, list: Product[]): Product | null {
    const exact = list.find((p) => barcodesMatch(p.barcode || "", q));
    if (exact) return exact;
    const partial = list.find((p) => normalizeBarcode(p.barcode || "").includes(normalizeBarcode(q)) && normalizeBarcode(q).length >= 4);
    if (partial) return partial;
    return null;
  }

  async function handleSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
  if (e.key !== "Enter") return;
  const q = cleanScan(search.trim());
  if (!q) return;

  const isBarcode = /^\d+$/.test(q) || /^[A-Z0-9]+(-[A-Z0-9]+)+$/i.test(q) || /^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{6,}$/i.test(q);

  const results = await searchProductsFast(q, 20);
  const db = await getDb();
  const byBarcode = await db.select<Product[]>("SELECT * FROM products WHERE REPLACE(UPPER(TRIM(barcode)), '-', '') = $1 LIMIT 5", [normalizeBarcode(q)]);
  const combined = [...byBarcode, ...results.filter((r) => !byBarcode.some((b) => b.id === r.id))];
  const exact = findByBarcode(q, combined);

  // ✅ 1. Barcode scan hua to seedha Cart me
  if (isBarcode && exact) {
    if (exact.stock <= 0) return alert(`⛔ ${exact.name} Out of Stock hai`);
    const inCart = Number(cart.find((c) => c.p.id === exact.id)?.qty || 0);
    if (inCart + (numQty(exact.id) || 1) > exact.stock) return alert(`⛔ ${exact.name} ka sirf ${exact.stock - inCart} bacha hai`);
    add(exact, numQty(exact.id) || 1);
    setLastScanned(exact); // ✅ Product yahan safe hai
    setSearch(""); // ✅ Box khaali karo taake agli scan chipke nahi
    setProducts([exact]);
    setTimeout(() => document.getElementById("pos-search")?.focus(), 0);
    return;
  }

  // ✅ 2. Naam likha to sirf neeche dikhao, Cart me mat dalo
  if (!isBarcode) {
    setLastScanned(null);
    setProducts(results);
    return;
  }

  // ✅ 3. Barcode na mile to sirf alert, koi redirect nahi
  if (results.length === 0) {
    alert(`⛔ Barcode "${q}" nahi mila`);
    setSearch("");
    setProducts(await searchProductsFast("", 200));
    return;
  }

  if (isBarcode && !exact) {
  alert(`⛔ Barcode "${q}" nahi mila`);
  setSearch("");
  setLastScanned(null);
  setProducts(await searchProductsFast("", 200));
  return;
}
}



  const getQtyText = (id: number) => qtyMap[id] ?? "1";
  const getPriceText = (p: Product) => priceMap[p.id] ?? String(p.price);
  const numQty = (id: number) => Number(qtyMap[id] ?? 1) || 0;
  const numPrice = (p: Product) => Number(priceMap[p.id] ?? p.price) || 0;
  const bumpQty = (id: number, d: number) => {
    const cur = Number(qtyMap[id] ?? 1) || 1;
    setQtyMap((m) => ({ ...m, [id]: String(Math.max(1, cur + d)) }));
  };

  const add = (p: Product, qty = 1) => {
    if (p.stock <= 0) return alert(`⛔ ${p.name} Out of Stock hai — Pehle Stock Add karo`);
    const q = qty || 1;
    const price = numPrice(p) || p.price;
    const inCart = Number(cart.find((c) => c.p.id === p.id)?.qty || 0);
    if (inCart + q > p.stock) return alert(`⛔ ${p.name} ka sirf ${p.stock - inCart} bacha hai`);
    const f = cart.find((c) => c.p.id === p.id);
    if (f) setCart(cart.map((c) => (c.p.id === p.id ? { ...c, qty: Number(c.qty || 0) + q, price } : c)));
    else setCart([...cart, { p, qty: q, price }]);
  };
  const removeOne = (id: number) => setCart(cart.map((c) => (c.p.id === id ? { ...c, qty: Number(c.qty || 0) - 1 } : c)).filter((c) => Number(c.qty || 0) > 0));
  const removeAll = (id: number) => setCart(cart.filter((c) => c.p.id !== id));
  const setCartPrice = (id: number, v: string) => setCart(cart.map((c) => (c.p.id === id ? { ...c, price: v === "" ? "" : Number(v) } : c)));
  const setCartQty = (id: number, v: string, stock: number) => setCart(cart.map((c) => (c.p.id === id ? { ...c, qty: v === "" ? "" : Math.max(1, Math.min(stock, Number(v) || 1)) } : c)));

  const total = cart.reduce((s, c) => s + Number(c.price || 0) * Number(c.qty || 0), 0);
  const profit = cart.reduce((s, c) => s + (Number(c.price || 0) - c.p.cost) * Number(c.qty || 0), 0);
  const change = Number(paid || 0) === 0 ? 0 : Number(paid || 0) - total;

  async function checkout() {
    if (checkingOut) return;
    if (cart.length === 0) return alert("Cart empty");
    if (cart.some((c) => Number(c.qty || 0) <= 0 || Number(c.price || 0) <= 0)) return alert("Cart me Qty / Price khaali hai — pehle likho");
    const finalUdharName = udharName.trim() || udharPhone.trim();
    if (saleType === "udhar" && !finalUdharName) return alert("Udhar ke liye Customer Name likho - UPAR wale box me");
    if (saleType === "cash" && Number(paid || 0) > 0 && Number(paid) < total) return alert("Cash kam hai! Cash Total se zyada ya barabar hona chahiye");
    setCheckingOut(true);
    try {
      const db = await getDb();
      for (const c of cart) {
        const fresh = await db.select<{ stock: number }[]>("SELECT stock FROM products WHERE id=$1", [c.p.id]);
        const realStock = fresh[0]?.stock ?? c.p.stock;
        if (Number(c.qty || 0) > realStock) return alert(`⛔ ${c.p.name} ka stock kam hai — Stock: ${realStock}, Cart me: ${c.qty}`);
      }
      const cashVal = saleType === "cash" ? (Number(paid || 0) === 0 ? total : Number(paid)) : 0;
      const changeVal = saleType === "cash" ? Math.max(0, cashVal - total) : 0;
      let custId: number | null = null;
      let custName = "Walk-in Customer";
      if (saleType === "udhar") {
        const phoneToSave = udharName.trim() ? udharPhone : "";
        custId = await getOrCreateCustomer(finalUdharName, phoneToSave);
        custName = finalUdharName;
        setCustomers(await db.select<Customer[]>("SELECT * FROM customers"));
      }
      const res = await db.execute("INSERT INTO sales (total, cash, change_amt, customer_id, type, profit, created_at) VALUES ($1,$2,$3,$4,$5,$6, datetime('now','localtime'))", [total, cashVal, changeVal, custId, saleType, profit]);
      const saleId = Number(res.lastInsertId ?? 0);
      for (const c of cart) {
        await db.execute("INSERT INTO sale_items (sale_id, product_name, qty, price) VALUES ($1,$2,$3,$4)", [saleId, c.p.name, Number(c.qty || 0), Number(c.price || 0)]);
        await db.execute("UPDATE products SET stock = stock - $1 WHERE id=$2", [Number(c.qty || 0), c.p.id]);
      }
      if (saleType === "udhar" && custId) {
        await db.execute("UPDATE customers SET total_udhar = total_udhar + $1 WHERE id=$2", [total, custId]);
        await db.execute("INSERT INTO khata (customer_id, amount, note, type, created_at) VALUES ($1,$2,$3,'udhar', datetime('now','localtime'))", [custId, total, `Sale #${saleId}`]);
      }
      setReceipt({ id: saleId, items: [...cart], total, cash: cashVal, change: changeVal, type: saleType, customerName: custName, date: new Date().toLocaleString() });
      setCart([]); setPaid(""); setUdharName(""); setUdharPhone(""); setQtyMap({}); setPriceMap({}); setLastScanned(null);
      void load();
    } finally {
      setCheckingOut(false);
    }
  }

  async function handlePartialReturn(sale: RecentSale, item: ItemRow, qty: number) {
    if (qty <= 0) return alert("Return Qty 1 ya zyada likho");
    if (qty > item.qty) return alert(`Sirf ${item.qty} hi return ho sakta hai`);
    if (!confirm(`${item.product_name} x${qty} Return karna hai? Stock wapis ayega.`)) return;
    const db = await getDb();
    const refund = item.price * qty;
    const prod = await db.select<{ cost: number }[]>("SELECT cost FROM products WHERE name=$1 LIMIT 1", [item.product_name]);
    const cost = prod[0]?.cost ?? item.price;
    const profitToCut = Math.max(0, (item.price - cost) * qty);
    await db.execute("UPDATE products SET stock = stock + $1 WHERE name=$2", [qty, item.product_name]);
    if (sale.type === "udhar" && sale.customer_id) {
      await db.execute("UPDATE customers SET total_udhar = MAX(0, total_udhar - $1) WHERE id=$2", [refund, sale.customer_id]);
      await db.execute("INSERT INTO khata (customer_id, amount, note, type, created_at) VALUES ($1,$2,$3,'paid', datetime('now','localtime'))", [sale.customer_id, refund, `Return Sale #${sale.id} - ${item.product_name} x${qty}`]);
    }
    if (qty >= item.qty) await db.execute("DELETE FROM sale_items WHERE sale_id=$1 AND product_name=$2", [sale.id, item.product_name]);
    else await db.execute("UPDATE sale_items SET qty = qty - $1 WHERE sale_id=$2 AND product_name=$3", [qty, sale.id, item.product_name]);
    const newTotal = sale.total - refund;
    const newProfit = Math.max(0, sale.profit - profitToCut);
    const newChange = sale.type === "cash" ? Math.max(0, sale.cash - newTotal) : 0;
    if (newTotal <= 0) { await db.execute("DELETE FROM sale_items WHERE sale_id=$1", [sale.id]); await db.execute("DELETE FROM sales WHERE id=$1", [sale.id]); }
    else await db.execute("UPDATE sales SET total=$1, profit=$2, change_amt=$3 WHERE id=$4", [newTotal, newProfit, newChange, sale.id]);
    alert(`✅ ${item.product_name} x${qty} Return ho gaya — Rs ${refund} customer ko WAPIS do${sale.type === "cash" ? ` (Change ab Rs ${newChange} hoga)` : ""}`);
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

  function buildReceiptHtml(receiptData: { id: number; items: { name: string; qty: number; price: number }[]; total: number; cash: number; change: number; type: string; customerName: string; date: string; isReprint?: boolean }) {
    const is58 = paperSize === "58mm";
    const pageW = is58 ? "58mm" : "80mm";
    const bodyW = is58 ? "46mm" : "72mm";
    const h1Size = is58 ? "15px" : "26px";
    const h2Size = is58 ? "13px" : "21px";
    const baseSize = is58 ? "10px" : "14px";
    const tableFont = is58 ? "9px" : "12px";
    const boxFont = is58 ? "9px" : "12px";
    const totalFont = is58 ? "10px" : "13px";
    const cellPad = is58 ? "1px 1px" : "3px 4px";
    const boxPad = is58 ? "2px 1px" : "4px 2px";
    const fmt = (n: number) => Number(n || 0).toFixed(2);
    const itemsHtml = receiptData.items.map((c) => `<tr><td style="border:${is58 ? "1px" : "2px"} solid #000; padding:${cellPad}; text-align:left; font-weight:900; word-break:break-word; overflow-wrap:break-word;">${c.name.toUpperCase()}</td><td style="border:${is58 ? "1px" : "2px"} solid #000; padding:${cellPad}; text-align:center; font-weight:900;">${fmt(Number(c.qty || 0))}</td><td style="border:${is58 ? "1px" : "2px"} solid #000; padding:${cellPad}; text-align:right; font-weight:900;">${fmt(Number(c.price || 0))}</td><td style="border:${is58 ? "1px" : "2px"} solid #000; padding:${cellPad}; text-align:right; font-weight:900;">${fmt(Number(c.price || 0) * Number(c.qty || 0))}</td></tr>`).join("");
    const totalQty = receiptData.items.reduce((s, c) => s + Number(c.qty || 0), 0);
    const d = new Date(receiptData.date);
    const shortDate = is58
      ? `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getFullYear()).slice(2)}`
      : d.toLocaleDateString("en-GB");
    const shortTime = is58
      ? `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() >= 12 ? "PM" : "AM"}`
      : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const counterLabel = is58 ? "No." : "Counter";
    const itemLabel = is58 ? "Item" : "Description";
    return `<html><head><meta charset="utf-8"><title>Bill #${receiptData.id}${receiptData.isReprint ? " - Reprint" : ""}</title><style>@page { size: ${pageW} auto; margin: 0; } * { margin:0; padding:0; box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; } body { font-family: Arial, Helvetica, sans-serif; font-weight:900; width: ${bodyW}; margin: 0 auto; font-size: ${baseSize}; color: #000; background:#fff; letter-spacing:0; } b, strong, th, td { font-weight:900; color:#000; } h1 { font-size: ${h1Size}; line-height:1.15; text-align:center; font-weight:900; letter-spacing:0; word-break:break-word; } h2 { font-size: ${h2Size}; line-height:1.1; text-align:center; font-weight:900; margin-top:2px; } .addr { text-align:center; font-size: ${is58 ? "9px" : "12px"}; font-weight:900; line-height:1.3; margin-top:2px; word-break:break-word; } .box { border: ${is58 ? "1px" : "2px"} solid #000; margin-top: ${is58 ? "5px" : "7px"}; border-collapse: collapse; width:100%; table-layout:fixed; } .box td { border: ${is58 ? "1px" : "2px"} solid #000; text-align:center; padding:${boxPad}; font-weight:900; font-size:${boxFont}; word-break:break-word; overflow-wrap:break-word; } .box td.val { font-weight:900; font-size:${boxFont}; } .cust { margin: ${is58 ? "3px" : "5px"} 0; font-weight:900; font-size:${is58 ? "10px" : "13px"}; word-break:break-word; } table.grid { width:100%; border-collapse: collapse; border: ${is58 ? "1px" : "2px"} solid #000; table-layout:fixed; } table.grid th { border: ${is58 ? "1px" : "2px"} solid #000; padding:${cellPad}; font-weight:900; font-size:${tableFont}; word-break:break-word; } table.grid td { border: ${is58 ? "1px" : "2px"} solid #000; padding:${cellPad}; font-size:${tableFont}; font-weight:900; word-break:break-word; overflow-wrap:break-word; } table.grid th:nth-child(1), table.grid td:nth-child(1) { width:${is58 ? "38%" : "44%"}; } table.grid th:nth-child(2), table.grid td:nth-child(2) { width:${is58 ? "14%" : "16%"}; } table.grid th:nth-child(3), table.grid td:nth-child(3) { width:${is58 ? "23%" : "20%"}; } table.grid th:nth-child(4), table.grid td:nth-child(4) { width:${is58 ? "25%" : "20%"}; } table.totals { width:100%; border-collapse: collapse; border: ${is58 ? "1px" : "2px"} solid #000; border-top:none; table-layout:fixed; } table.totals td { border: ${is58 ? "1px" : "2px"} solid #000; padding:${is58 ? "2px 2px" : "4px"}; font-weight:900; font-size:${totalFont}; word-break:break-word; } table.totals td:first-child { width:${is58 ? "52%" : "60%"}; } table.totals td:last-child { width:${is58 ? "48%" : "40%"}; } .items-line { font-weight:900; margin-top:${is58 ? "3px" : "5px"}; font-size:${is58 ? "10px" : "13px"}; } .thanks { text-align:center; font-weight:900; font-size:${is58 ? "11px" : "15px"}; line-height:1.3; margin-top:${is58 ? "6px" : "9px"}; }</style></head><body><h1>MADINA MEGA MART</h1><h2>SHEWA</h2><div class="addr">Ghulam Khel Chowk opp HabibMetro Bank<br/>0311-6144691 - 0345-9500176</div><table class="box"><colgroup><col style="width:${is58 ? "26%" : "28%"}"><col style="width:${is58 ? "30%" : "26%"}"><col style="width:${is58 ? "20%" : "22%"}"><col style="width:${is58 ? "24%" : "24%"}"></colgroup><tr><td>Date</td><td>Time</td><td>Bill #</td><td>${counterLabel}</td></tr><tr><td class="val">${shortDate}</td><td class="val">${shortTime}</td><td class="val">${receiptData.id}</td><td class="val">1</td></tr></table><div class="cust">Customer: ${receiptData.type === "udhar" ? receiptData.customerName.toUpperCase() : "CASH"}${receiptData.isReprint ? " (REPRINT)" : ""}</div><table class="grid"><tr><th style="text-align:left">${itemLabel}</th><th>Qty</th><th style="text-align:right">Price</th><th style="text-align:right">Amount</th></tr>${itemsHtml}</table><table class="totals"><tr><td>Sub Total</td><td style="text-align:right">${fmt(receiptData.total)}</td></tr><tr><td><b>Grand Total</b></td><td style="text-align:right"><b>${fmt(receiptData.total)}</b></td></tr><tr><td>Payment</td><td style="text-align:right">${receiptData.type === "cash" ? fmt(receiptData.cash) : "0.00"}</td></tr><tr><td>Change</td><td style="text-align:right">${receiptData.type === "cash" ? fmt(receiptData.change) : "0.00"}</td></tr></table><div class="items-line">Items : ${totalQty}</div><div class="thanks">THANK YOU<br/>FOR YOUR<br/>KIND VISIT.</div></body></html>`;
  }

  function printReceipt() {
    if (!receipt) return;
    const html = buildReceiptHtml({ id: receipt.id, items: receipt.items.map((c) => ({ name: c.p.name, qty: Number(c.qty || 0), price: Number(c.price || 0) })), total: receipt.total, cash: receipt.cash, change: receipt.change, type: receipt.type, customerName: receipt.customerName, date: receipt.date });
    void openPrintWindow(html, `Bill #${receipt.id}`);
  }

  function printOldBill(sale: RecentSale) {
    const html = buildReceiptHtml({ id: sale.id, items: sale.items.map((c) => ({ name: c.product_name, qty: Number(c.qty || 0), price: Number(c.price || 0) })), total: sale.total, cash: sale.cash, change: sale.change_amt, type: sale.type, customerName: sale.customerName, date: sale.created_at, isReprint: true });
    void openPrintWindow(html, `Bill #${sale.id} - Reprint`);
  }

  const periodPill = (active: boolean) => `px-3 py-1 rounded-full text-xs font-bold ${active ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`;

  return (
    <>
      {cleanMode && <style>{`aside{display:none !important;}`}</style>}
      <div className="p-4 flex gap-4 no-print">
        <div className="flex-2">
          <div className="flex justify-between items-center mb-3">
            <h2 className="text-xl font-black tracking-tight flex items-center gap-2">🛒 Madina Mega Mart Shewa - POS</h2>
            <div className="flex gap-2 items-center">
              <label className="bg-white border px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-1">🖨️ Printer:
                <select value={paperSize} onChange={(e) => changePaperSize(e.target.value as PaperSize)} className="outline-none bg-transparent font-black cursor-pointer">
                  <option value="80mm">80mm</option>
                  <option value="58mm">58mm</option>
                </select>
              </label>
              <span className="bg-slate-900 text-white px-3 py-1.5 rounded-full text-xs font-bold">Sale Rs {todaySale.toLocaleString()} &nbsp; Profit Rs {todayProfit.toLocaleString()}</span>
            </div>
          </div>
          <div className="flex gap-2 mb-2">
            <div className="relative flex-1">
              <input
                id="pos-search"
                className="w-full bg-white border px-4 py-3 pr-10 rounded-xl outline-none focus:ring-2 focus:ring-emerald-500 text-sm"
                placeholder="🔍 Scan barcode or name - Madina Mart"
                value={search}
                onChange={(e) => {
                  if (/^[a-zA-Z ]+$/.test(e.target.value)) setLastScanned(null);
                  void searchProducts(e.target.value);
                }}
                onKeyDown={handleSearchKey}
                autoFocus
              />
              {search && (
                <button
                  type="button"
                  onClick={() => {
                    setLastScanned(null);
                    void searchProducts("");
                    setTimeout(() => document.getElementById("pos-search")?.focus(), 0);
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 bg-slate-100 w-6 h-6 rounded-full text-xs font-black hover:bg-slate-200"
                >
                  ✕
                </button>
              )}
            </div>
             
             
            <button
              type="button"
              onClick={() => router.push(cleanMode ? "/dashboard/sales" : "/dashboard/sales?clean=1")}
              className="bg-slate-900 text-white px-4 py-3 rounded-xl font-black text-sm whitespace-nowrap shrink-0"
            >
              {cleanMode ? "⬅️ Full POS" : "🧹 Clean POS"}
            </button>
          </div>
          <p className="text-xs text-slate-500 mb-3">📍 Madina Mega Mart Shewa — {paperSize} Bill — 100% Offline • No Internet Needed</p>

          {/* ✅ CLEAN MODE: grid gayab, sirf Scan hint */}
          {cleanMode && (
  <div className="bg-white rounded-2xl border overflow-hidden mt-1">
    {!search.trim() && !lastScanned ? (
      <div className="p-8 text-center">
        <p className="text-4xl">📷</p>
        <p className="font-black mt-2 text-lg">Scan ya Search karo</p>
        <p className="text-sm text-slate-500">Upar naam ya barcode likho — neeche table me product aa jayega, phir Add dabao</p>
      </div>
    ) : !lastScanned && displayedProducts.length === 0 ? (
      <p className="p-8 text-center text-slate-400 text-sm">Koi product nahi mila — naam / barcode dobara likho</p>
    ) : (
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-900 text-white text-left">
            <th className="px-3 py-3">Product</th>
            <th className="px-3 py-3 text-center w-20">Stock</th>
            <th className="px-3 py-3 text-center w-24">Price</th>
            <th className="px-3 py-3 text-center w-20">Qty</th>
            <th className="px-3 py-3 text-center w-24"></th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {(lastScanned ? [lastScanned] : displayedProducts).slice(0, 20).map((p) => {
            const outOfStock = p.stock <= 0;
            return (
              <tr key={p.id} className={outOfStock ? "opacity-50" : ""}>
                <td className="px-3 py-3">
                  <p className="font-black">{p.name}</p>
                  <p className="text-[11px] text-slate-500">{p.category || "General"}{p.barcode ? ` • 🏷️ ${p.barcode}` : ""}</p>
                </td>
                <td className="px-3 py-3 text-center font-bold">{outOfStock ? <span className="text-red-600 text-xs">OUT</span> : p.stock}</td>
                <td className="px-3 py-3 text-center">
                  <input
                    type="number"
                    value={getPriceText(p)}
                    onChange={(e) => setPriceMap((m) => ({ ...m, [p.id]: e.target.value }))}
                    onFocus={(e) => e.target.select()}
                    className="bg-amber-100 w-20 text-center px-2 py-1.5 rounded-lg font-black outline-none"
                  />
                </td>
                <td className="px-3 py-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <button onClick={() => bumpQty(p.id, -1)} className="bg-slate-100 w-7 h-7 rounded font-black">-</button>
                    <input
                      type="number"
                      min={1}
                      value={getQtyText(p.id)}
                      onChange={(e) => setQtyMap((m) => ({ ...m, [p.id]: e.target.value }))}
                      onFocus={(e) => e.target.select()}
                      className="w-12 text-center border rounded py-1 font-bold outline-none"
                    />
                    <button onClick={() => bumpQty(p.id, 1)} className="bg-slate-100 w-7 h-7 rounded font-black">+</button>
                  </div>
                </td>
                <td className="px-3 py-3 text-center">
                  <button
                    onClick={() => add(p, numQty(p.id) || 1)}
                    disabled={outOfStock}
                    className={`px-4 py-2 rounded-lg font-black text-sm ${outOfStock ? "bg-slate-200 text-slate-400" : "bg-slate-900 text-white"}`}
                  >
                    {outOfStock ? "Out" : "➕ Add"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    )}
    {search.trim() && displayedProducts.length > 0 && (
      <p className="px-3 py-2 text-[11px] text-slate-400 bg-slate-50 border-t">
        {displayedProducts.length} product mile — sirf jo search kiya wahi dikh raha hai
      </p>
    )}
  </div>
)}

          {!cleanMode && (
            <>
              <p className="text-xs text-slate-500 mb-2">Showing {displayedProducts.length} of {products.length}</p>
              <div className="grid grid-cols-2 gap-3">
                {displayedProducts.map((p) => {
                  const outOfStock = p.stock <= 0;
                  const cartQty = Number(cart.find((c) => c.p.id === p.id)?.qty || 0);
                  const left = p.stock - cartQty;
                  const qtyExceeds = numQty(p.id) > Math.max(0, left);
                  const disabled = outOfStock || qtyExceeds || numPrice(p) <= 0;
                  const curPrice = numPrice(p);
                  return (
                  <div key={p.id} className={`bg-white p-4 rounded-2xl border ${outOfStock ? "opacity-60" : ""}`}>
                    <div className="flex justify-between"><b className="text-sm">{p.name}</b><span className="text-[11px] text-slate-400">{p.category || "General"}</span></div>
                    <p className="text-[11px] text-slate-500 mt-0.5">{p.company || p.category || "General"} • Stock {p.stock} {p.stock <= 5 && p.stock > 0 ? "(Low)" : ""} • Buy {p.cost}</p>
                    {p.barcode && <p className="text-[11px] text-slate-500 mt-0.5">🏷️ Barcode: <span className="font-mono font-bold text-slate-700">{p.barcode}</span></p>}
                    {outOfStock ? (<p className="text-[11px] font-black text-red-600 bg-red-50 px-2 py-1 rounded mt-1 inline-block">⛔ OUT OF STOCK — Pehle Stock Add karo</p>) : left <= 5 ? (<p className="text-[11px] font-bold text-amber-600 mt-1">⚠️ Sirf {left} bacha hai</p>) : null}
                    <div className="flex justify-between items-center mt-2">
                      <span className="text-xs text-slate-500">Sell Rs. <input type="number" value={getPriceText(p)} onChange={(e) => setPriceMap((m) => ({ ...m, [p.id]: e.target.value }))} onFocus={(e) => e.target.select()} placeholder={String(p.price)} className="bg-amber-100 px-2 py-1 rounded font-black text-slate-900 w-20 text-center outline-none focus:ring-2 focus:ring-amber-500" /></span>
                      <span className={`text-xs font-bold ${curPrice - p.cost < 0 ? "text-red-600" : "text-emerald-600"}`}>Profit {curPrice - p.cost} {curPrice - p.cost < 0 && curPrice > 0 ? "⚠️ Loss!" : ""}</span>
                    </div>
                    <div className="flex gap-2 mt-3">
                      <div className="flex items-center border rounded-lg overflow-hidden">
                        <button onClick={() => bumpQty(p.id, -1)} disabled={outOfStock} className="px-2 py-1.5 bg-slate-100 font-black disabled:opacity-40">-</button>
                        <input type="number" min={1} value={getQtyText(p.id)} onChange={(e) => setQtyMap((m) => ({ ...m, [p.id]: e.target.value }))} onFocus={(e) => e.target.select()} placeholder="1" className="w-14 text-center text-sm font-bold outline-none bg-white py-1.5" />
                        <button onClick={() => bumpQty(p.id, 1)} disabled={outOfStock} className="px-2 py-1.5 bg-slate-100 font-black disabled:opacity-40">+</button>
                      </div>
                      <button onClick={() => add(p, numQty(p.id) || 1)} disabled={disabled} className={`flex-1 py-2 rounded-lg text-sm font-bold ${disabled ? "bg-slate-300 text-slate-500 cursor-not-allowed" : "bg-slate-900 text-white hover:bg-black"}`}>
                        {outOfStock ? "Out of Stock" : qtyExceeds ? `Sirf ${Math.max(0, left)} Left` : `Add Rs.${curPrice * (numQty(p.id) || 0)}`}
                      </button>
                    </div>
                  </div>
                  );
                })}
              </div>
              {products.length === 0 && <p className="text-center text-slate-400 mt-10">No product found — try different name / barcode</p>}
              {visibleCount < products.length && (
                <button onClick={() => setVisibleCount((v) => v + PAGE_SIZE)} className="w-full bg-white border-2 border-dashed border-slate-300 hover:border-slate-900 hover:bg-slate-50 py-3.5 rounded-2xl font-black text-sm mt-4">
                  ↓ Load More — {products.length - visibleCount} aur products hain ({displayedProducts.length} / {products.length})
                </button>
              )}
              {visibleCount >= products.length && products.length > PAGE_SIZE && (
                <button onClick={() => { setVisibleCount(PAGE_SIZE); window.scrollTo({ top: 0, behavior: "smooth" }); }} className="w-full bg-slate-100 py-3 rounded-2xl font-bold text-sm mt-4">
                  ↑ Show Less — Wapis pehle 12 pe jao
                </button>
              )}
            </>
          )}
        </div>

        <div className="w-95 shrink-0 space-y-3">
          <div className="bg-white p-4 rounded-2xl border">
            <div className="flex justify-between items-center mb-2">
              <h3 className="font-black">🛒 Cart ({cart.length}) - Rs.{total.toLocaleString()}</h3>
              <span className="bg-slate-900 text-white px-2 py-1 rounded text-[11px] font-bold">Print {paperSize}</span>
            </div>
            <p className="text-[11px] text-slate-400 mb-2">Scan barcode to add - Madina Mart Shewa</p>
            {saleType === "udhar" ? (
              <div className="space-y-2 mb-2">
                <input className="w-full bg-amber-50 border border-amber-200 px-3 py-2.5 rounded-xl text-sm outline-none focus:ring-2 focus:ring-amber-500" placeholder="👤 ① YAHAN Naam likho — e.g Salim" value={udharName} onChange={(e) => setUdharName(e.target.value)} list="udhar-customers" />
                <datalist id="udhar-customers">{customers.map((c) => <option key={c.id} value={c.name} />)}</datalist>
                <input className="w-full bg-slate-50 border px-3 py-2.5 rounded-xl text-sm outline-none" placeholder="📞 ② Phone (optional) — sirf number" value={udharPhone} onChange={(e) => setUdharPhone(e.target.value)} />
                <p className="text-[11px] text-slate-500">Purana naam likhoge to usi khate me jayega • Naya naam likhoge to naya khata ban jayega</p>
              </div>
            ) : (<input className="w-full bg-slate-50 border px-3 py-2.5 rounded-xl mb-2 text-sm" value="Walk-in" readOnly />)}
            <div className="flex gap-2 mb-3">
              <button onClick={() => setSaleType("cash")} className={`flex-1 py-2 rounded-xl font-bold text-sm ${saleType === "cash" ? "bg-slate-900 text-white" : "bg-slate-100"}`}>Cash</button>
              <button onClick={() => setSaleType("udhar")} className={`flex-1 py-2 rounded-xl font-bold text-sm ${saleType === "udhar" ? "bg-slate-900 text-white" : "bg-slate-100"}`}>Udhar</button>
            </div>
            <div className="max-h-45 overflow-y-auto divide-y">
              {cart.map((c) => (
                <div key={c.p.id} className="flex justify-between items-center py-2 text-sm gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-bold">{c.p.name}</p>
                    <p className="text-[11px] text-slate-500">Qty <input type="number" min={1} value={c.qty} onChange={(e) => setCartQty(c.p.id, e.target.value, c.p.stock)} onFocus={(e) => e.target.select()} className="w-12 text-center border rounded outline-none font-bold" /> @ Rs <input type="number" value={c.price} onChange={(e) => setCartPrice(c.p.id, e.target.value)} onFocus={(e) => e.target.select()} className="w-16 text-center border rounded outline-none font-bold" /></p>
                  </div>
                  <span className="flex gap-1 items-center shrink-0"><b>Rs {Number(c.price || 0) * Number(c.qty || 0)}</b><button onClick={() => removeOne(c.p.id)} className="bg-red-100 text-red-600 px-2 rounded">-</button><button onClick={() => removeAll(c.p.id)} className="text-slate-400 text-xs">✕</button></span>
                </div>
              ))}
              {cart.length === 0 && <p className="text-slate-400 text-center py-4 text-sm">Cart empty</p>}
            </div>
            {saleType === "cash" && (<><input className="w-full bg-slate-50 border px-3 py-2.5 rounded-xl mt-2 text-sm" placeholder="Cash Received" type="number" value={paid} onChange={(e) => setPaid(e.target.value)} /><p className="mt-1 text-sm font-bold">Change: <span className={change >= 0 ? "text-emerald-600" : "text-red-500"}>Rs {change}</span> • Profit: Rs {profit}</p></>)}
            <button onClick={() => void checkout()} disabled={checkingOut} className="w-full bg-slate-900 hover:bg-black text-white py-3 rounded-xl font-black mt-2 text-sm disabled:opacity-50">{checkingOut ? "⏳ Saving..." : `Sell Rs ${total} • Profit ${profit} • Print`}</button>
            <button onClick={() => setCart([])} className="w-full bg-slate-100 py-2 rounded-xl mt-2 text-sm font-bold">Clear Cart</button>
          </div>
          {!cleanMode && (
          <div className="bg-white p-4 rounded-2xl border">
            <div className="flex gap-1 mb-3">
              <button onClick={() => setPeriod("today")} className={periodPill(period === "today")}>Today</button>
              <button onClick={() => setPeriod("weekly")} className={periodPill(period === "weekly")}>Weekly</button>
              <button onClick={() => setPeriod("monthly")} className={periodPill(period === "monthly")}>Monthly</button>
              <button onClick={() => setPeriod("all")} className={periodPill(period === "all")}>All</button>
            </div>
            <div className="space-y-3 max-h-100 overflow-y-auto">
              {recent.map((s) => (
                <div key={s.id} className="border rounded-xl overflow-hidden">
                  <div onClick={() => setExpandedSale(expandedSale === s.id ? null : s.id)} className="w-full flex justify-between items-center px-3 py-2 text-left bg-slate-50 cursor-pointer">
                    <div><p className="font-black text-xs">Bill #{s.id} • {new Date(s.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p><p className="text-[11px] text-slate-500">Profit {s.profit} • {s.type === "udhar" ? s.customerName : "Paid"}</p></div>
                    <div className="text-right flex items-center gap-2">
                      <div><p className="font-black text-xs">Rs {s.total}</p><p className="text-[11px] text-slate-400">{expandedSale === s.id ? "▲ Hide" : "▼ Items"}</p></div>
                      <button onClick={(e) => { e.stopPropagation(); printOldBill(s); }} disabled={printing} className="bg-slate-900 text-white px-2 py-1.5 rounded-lg text-[11px] font-bold shrink-0 disabled:opacity-50">🖨️ Print</button>
                    </div>
                  </div>
                  {expandedSale === s.id && (<div className="divide-y">{s.items.map((it, idx) => { const key = `${s.id}-${it.product_name}`; const rq = returnQty[key] ?? 1; return (<div key={idx} className="px-3 py-2"><div className="flex justify-between items-center"><div><p className="font-bold text-xs">{it.product_name}</p><p className="text-[11px] text-slate-500">Qty {it.qty} x Rs {it.price} = Rs {it.qty * it.price}</p></div><b className="text-xs">Rs {it.qty * it.price}</b></div><div className="flex gap-1.5 mt-2 items-center"><div className="flex items-center border rounded-lg overflow-hidden"><button onClick={() => setReturnQty((m) => ({ ...m, [key]: Math.max(1, rq - 1) }))} className="px-2 py-1 bg-slate-100 font-black text-xs">-</button><span className="px-2 text-xs font-bold">{rq} / {it.qty}</span><button onClick={() => setReturnQty((m) => ({ ...m, [key]: Math.min(it.qty, rq + 1) }))} className="px-2 py-1 bg-slate-100 font-black text-xs">+</button></div><button onClick={() => void handlePartialReturn(s, it, rq)} className="flex-1 bg-red-50 text-red-600 py-1.5 rounded-lg text-[11px] font-bold">↩ Return x{rq}</button><button onClick={() => void handlePartialReturn(s, it, it.qty)} className="bg-slate-100 px-2 py-1.5 rounded-lg text-[11px] font-bold">All {it.qty}</button></div></div>); })}</div>)}
                  {expandedSale !== s.id && (<div className="px-3 py-2 space-y-0.5">{s.items.map((it, idx) => (<p key={idx} className="text-xs text-slate-600">• {it.product_name} <b>x{it.qty}</b> — Rs {it.qty * it.price}</p>))}</div>)}
                </div>
              ))}
              {recent.length === 0 && <p className="text-slate-400 text-center text-sm py-4">No recent sales</p>}
            </div>
          </div>
          )}
        </div>
      </div>

      {receipt && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 no-print">
          <div className="bg-white rounded-2xl p-2 max-w-sm w-full">
            <div className="bg-white p-2 text-black font-mono text-[11px] leading-tight w-70 mx-auto whitespace-nowrap overflow-hidden">
              <h2 className="text-[24px] font-black text-center leading-none whitespace-nowrap">MADINA MEGA MART</h2>
              <p className="text-[19px] font-black text-center leading-none mt-1">SHEWA</p>
              <p className="text-[10.5px] text-center mt-1 leading-tight whitespace-nowrap">Ghulam Khel Chowk opp HabibMetro Bank<br/>0311-6144691 - 0345-9500176</p>
              <table className="w-full border-[1.2px] border-black border-collapse mt-2 text-center table-fixed"><colgroup><col style={{width:"28%"}} /><col style={{width:"26%"}} /><col style={{width:"22%"}} /><col style={{width:"24%"}} /></colgroup><tbody><tr className="font-black"><td className="border-[1.2px] border-black p-1">Date</td><td className="border-[1.2px] border-black p-1">Time</td><td className="border-[1.2px] border-black p-1">Bill #</td><td className="border-[1.2px] border-black p-1">Counter</td></tr><tr><td className="border-[1.2px] border-black p-1">{new Date(receipt.date).toLocaleDateString("en-GB")}</td><td className="border-[1.2px] border-black p-1">{new Date(receipt.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td><td className="border-[1.2px] border-black p-1">{receipt.id}</td><td className="border-[1.2px] border-black p-1">1</td></tr></tbody></table>
              <p className="mt-1 font-bold">Customer: {receipt.type === "udhar" ? receipt.customerName.toUpperCase() : "CASH"}</p>
              <table className="w-full border-[1.2px] border-black border-collapse mt-1 table-fixed"><colgroup><col style={{width:"44%"}} /><col style={{width:"16%"}} /><col style={{width:"20%"}} /><col style={{width:"20%"}} /></colgroup><thead><tr><th className="border-[1.2px] border-black text-left p-1">Description</th><th className="border-[1.2px] border-black text-center p-1">Qty</th><th className="border-[1.2px] border-black text-right p-1">Price</th><th className="border-[1.2px] border-black text-right p-1">Amount</th></tr></thead><tbody>{receipt.items.map((c,i) => (<tr key={i}><td className="border-[1.2px] border-black p-1 uppercase truncate">{c.p.name}</td><td className="border-[1.2px] border-black p-1 text-center">{Number(c.qty || 0).toFixed(2)}</td><td className="border-[1.2px] border-black p-1 text-right">{Number(c.price || 0).toFixed(2)}</td><td className="border-[1.2px] border-black p-1 text-right">{(Number(c.price || 0)*Number(c.qty || 0)).toFixed(2)}</td></tr>))}</tbody></table>
              <table className="w-full border-[1.2px] border-black border-t-0 border-collapse table-fixed"><colgroup><col style={{width:"60%"}} /><col style={{width:"40%"}} /></colgroup><tbody><tr><td className="border-[1.2px] border-black p-1 font-bold">Sub Total</td><td className="border-[1.2px] border-black p-1 text-right font-bold">{receipt.total.toFixed(2)}</td></tr><tr><td className="border-[1.2px] border-black p-1 font-black">Grand Total</td><td className="border-[1.2px] border-black p-1 text-right font-black">{receipt.total.toFixed(2)}</td></tr><tr><td className="border-[1.2px] border-black p-1 font-bold">Payment</td><td className="border-[1.2px] border-black p-1 text-right font-bold">{receipt.type==="cash"?receipt.cash.toFixed(2):"0.00"}</td></tr><tr><td className="border-[1.2px] border-black p-1 font-bold">Change</td><td className="border-[1.2px] border-black p-1 text-right font-bold">{receipt.type==="cash"?receipt.change.toFixed(2):"0.00"}</td></tr></tbody></table>
              <p className="font-black mt-1">Items : {receipt.items.reduce((s,c)=>s+Number(c.qty || 0),0)}</p>
              <p className="text-center font-black mt-2 text-[13px] leading-tight">THANK YOU<br/>FOR YOUR<br/>KIND VISIT.</p>
            </div>
            <div className="flex gap-2 p-2"><button onClick={printReceipt} disabled={printing} className="flex-1 bg-slate-900 text-white py-3 rounded-xl font-bold disabled:opacity-50">{printing ? "⏳ Printing..." : `🖨️ Print (${paperSize})`}</button><button onClick={() => { setReceipt(null); setTimeout(() => void load(), 100); }} className="flex-1 bg-emerald-600 text-white py-3 rounded-xl font-bold">✅ Done</button></div>
          </div>
        </div>
      )}
    </>
  );
}

export default function SalesPage() {
  return (
    <Suspense fallback={<div className="p-4 font-bold">Loading POS...</div>}>
      <SalesPageInner />
    </Suspense>
  );
}