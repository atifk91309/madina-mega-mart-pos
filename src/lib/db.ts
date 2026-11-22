import Database from "@tauri-apps/plugin-sql";

export interface Product {
  id: number;
  name: string;
  price: number;
  cost: number;
  barcode: string;
  stock: number;
  category?: string;
  company?: string;
}

export interface Customer {
  id: number;
  name: string;
  phone: string;
  total_udhar: number;
}

export interface Sale {
  id: number;
  total: number;
  cash: number;
  change_amt: number;
  customer_id: number | null;
  type: string;
  created_at: string;
  profit?: number;
}

export interface SaleItem {
  id: number;
  sale_id: number;
  product_id?: number;
  product_name: string;
  qty: number;
  price: number;
  cost?: number;
}

export interface KhataEntry {
  id: number;
  customer_id: number;
  amount: number;
  note: string;
  type: string;
  created_at: string;
}

// ---------- Helpers ----------
export function nowLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function escapeLike(q: string) {
  return q.replace(/[\\%_]/g, (c) => "\\" + c);
}

// ---------- Custom Barcode ----------
export function generateCustomBarcode(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, "0");
  return `MAD-${ts}${rand}`.slice(0, 14);
}

export function normalizeBarcode(b: string): string {
  return (b || "").trim().toUpperCase().replace(/[\s-]/g, "");
}

export async function ensureBarcode(productId: number, barcode: string): Promise<string> {
  return withWrite(async () => {
    const db = await getDb();
    const code = normalizeBarcode(barcode);
    if (!code) return "";
    await db.execute("UPDATE products SET barcode = $1 WHERE id = $2", [code, productId]);
    return code;
  });
}

// ---------- DB Singleton + Write Queue (LOCK FIX - NO any) ----------
let dbPromise: Promise<Database> | null = null;

let writeQueue: Promise<unknown> = Promise.resolve();
export function withWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run: Promise<T> = writeQueue.then(() => fn(), () => fn());
  writeQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export async function getDb(): Promise<Database> {
  if (!dbPromise) dbPromise = initDb();
  return dbPromise;
}

async function initDb(): Promise<Database> {
  const db = await Database.load("sqlite:madina.db");

  await db.execute(`PRAGMA journal_mode = WAL`);
  await db.execute(`PRAGMA synchronous = NORMAL`);
  await db.execute(`PRAGMA busy_timeout = 5000`);
  await db.execute(`PRAGMA cache_size = -64000`);
  await db.execute(`PRAGMA foreign_keys = ON`);

  await db.execute(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, price REAL, cost REAL, barcode TEXT, stock INTEGER,
    category TEXT DEFAULT 'General', company TEXT DEFAULT ''
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, phone TEXT, total_udhar REAL DEFAULT 0
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    total REAL, cash REAL, change_amt REAL,
    customer_id INTEGER, type TEXT DEFAULT 'cash',
    profit REAL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sale_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER, product_id INTEGER, product_name TEXT, qty INTEGER, price REAL, cost REAL DEFAULT 0
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS khata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER, amount REAL, note TEXT,
    type TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  async function addColumnIfMissing(table: string, column: string, def: string) {
    try {
      const cols = await db.select<{ name: string }[]>(`PRAGMA table_info(${table})`);
      const exists = cols.some((c) => c.name === column);
      if (!exists) {
        await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      }
    } catch { /* ignore */ }
  }

  await addColumnIfMissing("sales", "created_at", "TEXT DEFAULT CURRENT_TIMESTAMP");
  await addColumnIfMissing("sales", "cash", "REAL DEFAULT 0");
  await addColumnIfMissing("sales", "change_amt", "REAL DEFAULT 0");
  await addColumnIfMissing("sales", "customer_id", "INTEGER");
  await addColumnIfMissing("sales", "type", "TEXT DEFAULT 'cash'");
  await addColumnIfMissing("sales", "total", "REAL DEFAULT 0");
  await addColumnIfMissing("sales", "profit", "REAL DEFAULT 0");
  await addColumnIfMissing("customers", "total_udhar", "REAL DEFAULT 0");
  await addColumnIfMissing("customers", "phone", "TEXT");
  await addColumnIfMissing("khata", "created_at", "TEXT DEFAULT CURRENT_TIMESTAMP");
  await addColumnIfMissing("khata", "note", "TEXT DEFAULT ''");
  await addColumnIfMissing("khata", "type", "TEXT DEFAULT 'udhar'");
  await addColumnIfMissing("products", "category", "TEXT DEFAULT 'General'");
  await addColumnIfMissing("products", "company", "TEXT DEFAULT ''");
  await addColumnIfMissing("sale_items", "product_id", "INTEGER");
  await addColumnIfMissing("sale_items", "cost", "REAL DEFAULT 0");

  await db.execute(`CREATE INDEX IF NOT EXISTS idx_products_name ON products(name)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_khata_customer ON khata(customer_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name)`);
  await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode_unique ON products(barcode) WHERE barcode IS NOT NULL AND barcode != ''`);

  return db;
}

// ---------- Bulk Import ----------
export async function bulkImportProducts(
  rows: { name: string; price: number; cost: number; barcode: string; stock: number; category?: string; company?: string }[]
) {
  return withWrite(async () => {
    const db = await getDb();
     
    try {
      for (const r of rows) {
        if (!r.name?.trim()) continue;
        const code = normalizeBarcode(r.barcode || "");
        await db.execute(
          `INSERT INTO products (name, price, cost, barcode, stock, category, company)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT(barcode) WHERE barcode != '' DO UPDATE SET
             name=excluded.name, price=excluded.price, cost=excluded.cost,
             stock=excluded.stock, category=excluded.category, company=excluded.company`,
          [r.name.trim(), r.price || 0, r.cost || 0, code, r.stock || 0, r.category || "General", r.company || ""]
        );
      }
      
    } catch (e) {
      
      throw e;
    }
  });
}

// ---------- Search ----------
export async function searchProductsFast(q: string, limit = 100): Promise<Product[]> {
  const db = await getDb();
  const term = q.trim();
  if (!term) {
    return db.select<Product[]>("SELECT * FROM products ORDER BY id DESC LIMIT $1", [limit]);
  }
  const code = normalizeBarcode(term);
  const exact = await db.select<Product[]>("SELECT * FROM products WHERE REPLACE(UPPER(barcode), '-', '') = $1 LIMIT 1", [code]);
  if (exact.length > 0) return exact;

  if (/^[0-9A-Z-]+$/.test(code)) {
    const prefix = await db.select<Product[]>(
      "SELECT * FROM products WHERE REPLACE(UPPER(barcode), '-', '') LIKE $1 ESCAPE '\\' LIMIT $2",
      [`${escapeLike(code)}%`, limit]
    );
    if (prefix.length > 0) return prefix;
  }

  const like = `%${escapeLike(term)}%`;
  return db.select<Product[]>(
    "SELECT * FROM products WHERE name LIKE $1 ESCAPE '\\' OR category LIKE $2 ESCAPE '\\' ORDER BY name LIMIT $3",
    [like, like, limit]
  );
}

// ---------- Atomic Sale ----------
export async function saveSaleAtomic(args: {
  items: { product_id: number; product_name: string; qty: number; price: number; cost: number }[];
  total: number; cash: number; change_amt: number;
  customer_id: number | null; type: string; profit: number;
  khataAmount?: number; khataNote?: string;
}): Promise<number> {
  return withWrite(async () => {
    const db = await getDb();
      for (const it of args.items) {
    const row = await db.select<{ stock: number }[]>(
      "SELECT stock FROM products WHERE id=$1",
      [it.product_id]
    );
    if ((row[0]?.stock ?? 0) < it.qty) {
      throw new Error(`Stock kam hai: ${it.product_name}`);
    }
  }
    try {
      const res = await db.execute(
        "INSERT INTO sales (total, cash, change_amt, customer_id, type, profit, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [args.total, args.cash, args.change_amt, args.customer_id, args.type, args.profit, nowLocal()]
      );
      const saleId = Number(res.lastInsertId ?? 0);
      if (!saleId) throw new Error("Sale insert failed");

      for (const it of args.items) {
        await db.execute(
          "INSERT INTO sale_items (sale_id, product_id, product_name, qty, price, cost) VALUES ($1,$2,$3,$4,$5,$6)",
          [saleId, it.product_id, it.product_name, it.qty, it.price, it.cost]
        );
        const upd = await db.execute(
          "UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1",
          [it.qty, it.product_id]
        );
        if ((upd.rowsAffected ?? 1) === 0) throw new Error(`Stock kam hai: ${it.product_name}`);
      }

      if (args.type === "udhar" && args.customer_id && (args.khataAmount ?? 0) > 0) {
        await db.execute(
          "INSERT INTO khata (customer_id, amount, note, type, created_at) VALUES ($1,$2,$3,'udhar',$4)",
          [args.customer_id, args.khataAmount, args.khataNote || "", nowLocal()]
        );
        await db.execute(
          "UPDATE customers SET total_udhar = total_udhar + $1 WHERE id = $2",
          [args.khataAmount, args.customer_id]
        );
      }

      
      return saleId;
    } catch (e) {
      
      throw e;
    }
  });
}

export async function getDashboardStats() {
  const db = await getDb();
  const prodCount = await db.select<{ c: number }[]>("SELECT COUNT(*) as c FROM products");
  const stockVal = await db.select<{ v: number }[]>("SELECT COALESCE(SUM(price * stock), 0) as v FROM products");
  const today = await db.select<{ s: number; p: number; b: number }[]>(
    "SELECT COALESCE(SUM(total),0) as s, COALESCE(SUM(profit),0) as p, COUNT(*) as b FROM sales WHERE date(created_at) = date('now','localtime')"
  );
  const low = await db.select<{ c: number }[]>("SELECT COUNT(*) as c FROM products WHERE stock <= 5");
  const udhar = await db.select<{ u: number }[]>("SELECT COALESCE(SUM(total_udhar),0) as u FROM customers");
  return {
    products: prodCount[0]?.c ?? 0,
    stockValue: stockVal[0]?.v ?? 0,
    todaySale: today[0]?.s ?? 0,
    todayProfit: today[0]?.p ?? 0,
    todayBills: today[0]?.b ?? 0,
    lowStock: low[0]?.c ?? 0,
    udhar: udhar[0]?.u ?? 0,
  };
}

export async function getOrCreateCustomer(name: string, phone = ""): Promise<number> {
  return withWrite(async () => {
    const db = await getDb();
    const clean = name.trim();
    const found = await db.select<Customer[]>("SELECT * FROM customers WHERE LOWER(name) = LOWER($1) LIMIT 1", [clean]);
    if (found.length > 0) return found[0].id;
    const res = await db.execute("INSERT INTO customers (name, phone, total_udhar) VALUES ($1,$2,0)", [clean, phone]);
    return Number(res.lastInsertId ?? 0);
  });
}

export async function getAllCategories(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ category: string }[]>(
    "SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != '' ORDER BY category"
  );
  const fromDb = rows.map(r => r.category);
  const defaults = ["General", "Mobile Accessories", "Manyari", "Cosmetics", "Other"];
  return [...new Set([...defaults, ...fromDb])];
}

// ---------- Backup Helpers ----------

export async function checkpointDb(): Promise<void> {
  return withWrite(async () => {
    const db = await getDb();
    await db.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  });
}

// ---------- Restore Backup - Ek hi Transaction me ----------
export interface BackupData {
  products?: Array<Record<string, unknown>>;
  customers?: Array<Record<string, unknown>>;
  sales?: Array<Record<string, unknown>>;
  sale_items?: Array<Record<string, unknown>>;
  khata?: Array<Record<string, unknown>>;
}

// ---------- Products Write - Queue se ----------

export async function saveProduct(p: { id?: number | null; name: string; price: number; cost: number; barcode: string; stock: number; category: string; company: string }): Promise<void> {
  return withWrite(async () => {
    const db = await getDb();
    if (p.id) {
      await db.execute("UPDATE products SET name=$1, price=$2, cost=$3, barcode=$4, stock=$5, category=$6, company=$7 WHERE id=$8", [p.name, p.price, p.cost, p.barcode, p.stock, p.category, p.company, p.id]);
    } else {
      await db.execute("INSERT INTO products (name, price, cost, barcode, stock, category, company) VALUES ($1,$2,$3,$4,$5,$6,$7)", [p.name, p.price, p.cost, p.barcode, p.stock, p.category, p.company]);
    }
  });
}

export async function deleteProduct(id: number): Promise<void> {
  return withWrite(async () => {
    const db = await getDb();
    await db.execute("DELETE FROM products WHERE id=$1", [id]);
  });
}

// ---------- Return - Ek hi Transaction me ----------
export async function processReturn(args: { saleId: number; itemId: number; productId: number | null; productName: string; qty: number; itemQty: number; price: number; cost: number; saleType: string; customerId: number | null; saleTotal: number; saleProfit: number }): Promise<void> {
  return withWrite(async () => {
    const db = await getDb();
    const refund = args.price * args.qty;
    const profitToCut = Math.max(0, (args.price - args.cost) * args.qty);

     
    try {
      if (args.productId) {
        await db.execute("UPDATE products SET stock = stock + $1 WHERE id=$2", [args.qty, args.productId]);
      } else {
        await db.execute("UPDATE products SET stock = stock + $1 WHERE name=$2", [args.qty, args.productName]);
      }

      if (args.saleType === "udhar" && args.customerId) {
        await db.execute("UPDATE customers SET total_udhar = MAX(0, total_udhar - $1) WHERE id=$2", [refund, args.customerId]);
        await db.execute("INSERT INTO khata (customer_id, amount, note, type, created_at) VALUES ($1,$2,$3,'paid', datetime('now','localtime'))", [args.customerId, refund, `Return Sale #${args.saleId} - ${args.productName} x${args.qty}`]);
      }

      if (args.qty >= args.itemQty) {
        await db.execute("DELETE FROM sale_items WHERE id=$1", [args.itemId]);
      } else {
        await db.execute("UPDATE sale_items SET qty = qty - $1 WHERE id=$2", [args.qty, args.itemId]);
      }

      const newTotal = args.saleTotal - refund;
      const newProfit = Math.max(0, args.saleProfit - profitToCut);
      // ✅ FIX: Full Return pe Sale DELETE mat karo - total 0 karke saboot rakho
      if (newTotal <= 0) {
        await db.execute("UPDATE sales SET total=$1, profit=$2, change_amt=$3 WHERE id=$4", [0, 0, 0, args.saleId]);
      } else {
        // Cash ka change dobara nikalna ho to sale ka cash yahan se lo - simple: change = max(0, cash - newTotal)
        const s = await db.select<{ cash: number }[]>("SELECT cash FROM sales WHERE id=$1", [args.saleId]);
        const newChange = args.saleType === "cash" ? Math.max(0, (s[0]?.cash ?? 0) - newTotal) : 0;
        await db.execute("UPDATE sales SET total=$1, profit=$2, change_amt=$3 WHERE id=$4", [newTotal, newProfit, newChange, args.saleId]);
      }

      
    } catch (e) {
      
      throw e;
    }
  });
}

// ---------- Khata - Wusool + Delete - Queue + Transaction ----------
export async function addKhataPayment(customerId: number, amount: number): Promise<number> {
  return withWrite(async () => {
    const db = await getDb();
     
    try {
      const fresh = await db.select<{ total_udhar: number }[]>("SELECT total_udhar FROM customers WHERE id=$1", [customerId]);
      const realUdhar = fresh[0]?.total_udhar ?? 0;
      if (amount <= 0) throw new Error("Wusool amount likho");
      if (amount > realUdhar) throw new Error(`Baqi sirf Rs ${realUdhar} hai`);
      await db.execute("UPDATE customers SET total_udhar = MAX(0, total_udhar - $1) WHERE id=$2", [amount, customerId]);
      await db.execute("INSERT INTO khata (customer_id, amount, note, type, created_at) VALUES ($1,$2,'Payment Received','paid', datetime('now','localtime'))", [customerId, amount]);
      
      return Math.max(0, realUdhar - amount);
    } catch (e) {
      
      throw e;
    }
  });
}

export async function deleteCustomerKhata(customerId: number): Promise<void> {
  return withWrite(async () => {
    const db = await getDb();
     
    try {
      const check = await db.select<{ total_udhar: number }[]>("SELECT total_udhar FROM customers WHERE id=$1", [customerId]);
      if ((check[0]?.total_udhar ?? 0) > 0) throw new Error("Udhar baqi hai — pehle Wusool karo, phir Delete hoga");
      await db.execute("DELETE FROM khata WHERE customer_id=$1", [customerId]);
      await db.execute("DELETE FROM customers WHERE id=$1", [customerId]);
      
    } catch (e) {
      
      throw e;
    }
  });
}
 

export async function restoreBackup(data: BackupData): Promise<{ pCount: number; sCount: number; kCount: number; skippedKhata: number }> {
  return withWrite(async () => {
    const db = await getDb();
    let pCount = 0;
    let sCount = 0;
    let kCount = 0;
    let skippedKhata = 0;

    
    try {
      if (Array.isArray(data.products)) {
        for (const p of data.products) {
          const name = String(p.name ?? "");
          if (!name.trim()) continue;
          const barcode = normalizeBarcode(String(p.barcode ?? ""));
          const existing = barcode
            ? await db.select<{ id: number }[]>("SELECT id FROM products WHERE REPLACE(UPPER(barcode), '-', '') = $1 LIMIT 1", [barcode])
            : await db.select<{ id: number }[]>("SELECT id FROM products WHERE name = $1 AND (barcode IS NULL OR barcode = '') LIMIT 1", [name]);
          if (existing.length > 0) {
            await db.execute(
              "UPDATE products SET name=$1, price=$2, cost=$3, barcode=$4, stock=$5, category=$6, company=$7 WHERE id=$8",
              [name, Number(p.price ?? 0), Number(p.cost ?? 0), barcode, Number(p.stock ?? 0), String(p.category || "General"), String(p.company || ""), existing[0].id]
            );
          } else {
            await db.execute(
              "INSERT INTO products (name, price, cost, barcode, stock, category, company) VALUES ($1,$2,$3,$4,$5,$6,$7)",
              [name, Number(p.price ?? 0), Number(p.cost ?? 0), barcode, Number(p.stock ?? 0), String(p.category || "General"), String(p.company || "")]
            );
          }
          pCount++;
        }
      }

      if (Array.isArray(data.customers)) {
        for (const c of data.customers) {
          await db.execute("INSERT OR IGNORE INTO customers (id, name, phone, total_udhar) VALUES ($1,$2,$3,$4)", [Number(c.id), String(c.name ?? ""), String(c.phone ?? ""), Number(c.total_udhar ?? 0)]);
        }
      }

      if (Array.isArray(data.sales)) {
        for (const s of data.sales) {
          const exists = await db.select<{ id: number }[]>("SELECT id FROM sales WHERE id=$1 LIMIT 1", [Number(s.id)]);
          if (exists.length === 0) {
            await db.execute("INSERT INTO sales (id, total, cash, change_amt, customer_id, type, profit, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [Number(s.id), Number(s.total ?? 0), Number(s.cash ?? 0), Number(s.change_amt ?? 0), s.customer_id == null ? null : Number(s.customer_id), String(s.type || "cash"), Number(s.profit ?? 0), String(s.created_at ?? "")]);
            sCount++;
          }
        }
      }

      if (Array.isArray(data.sale_items)) {
        for (const it of data.sale_items) {
          const exists = await db.select<{ sale_id: number }[]>("SELECT sale_id FROM sale_items WHERE sale_id=$1 AND product_name=$2 LIMIT 1", [Number(it.sale_id), String(it.product_name ?? "")]);
          if (exists.length === 0) {
            await db.execute(
              "INSERT INTO sale_items (sale_id, product_id, product_name, qty, price, cost) VALUES ($1,$2,$3,$4,$5,$6)",
              [Number(it.sale_id), it.product_id == null ? null : Number(it.product_id), String(it.product_name ?? ""), Number(it.qty ?? 0), Number(it.price ?? 0), Number(it.cost ?? 0)]
            );
          }
        }
      }

      if (Array.isArray(data.khata)) {
        for (const k of data.khata) {
          if (k.id) {
            const byId = await db.select<{ id: number }[]>("SELECT id FROM khata WHERE id=$1 LIMIT 1", [Number(k.id)]);
            if (byId.length > 0) { skippedKhata++; continue; }
          }
          const dup = await db.select<{ id: number }[]>(
            "SELECT id FROM khata WHERE customer_id=$1 AND amount=$2 AND type=$3 AND COALESCE(note,'')=$4 AND COALESCE(created_at,'')=$5 LIMIT 1",
            [Number(k.customer_id), Number(k.amount ?? 0), String(k.type || "udhar"), String(k.note || ""), String(k.created_at || "")]
          );
          if (dup.length === 0) {
            await db.execute("INSERT INTO khata (id, customer_id, amount, note, type, created_at) VALUES ($1,$2,$3,$4,$5,$6)", [k.id == null ? null : Number(k.id), Number(k.customer_id), Number(k.amount ?? 0), String(k.note || ""), String(k.type || "udhar"), String(k.created_at || new Date().toISOString())]);
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

      
      return { pCount, sCount, kCount, skippedKhata };
    } catch (e) {
      
      throw e;
    }
  });
}