"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";

const LINKS = [
  { href: "/dashboard", label: "Dashboard", icon: "📦" },
  { href: "/dashboard/sales", label: "POS Sale", icon: "🛒" },
  { href: "/dashboard/products", label: "Products", icon: "📦" },
  { href: "/dashboard/customers", label: "Khata / Udhar", icon: "📒" },
  { href: "/dashboard/history", label: "Sales History", icon: "📜" },
  { href: "/dashboard/top-selling", label: "Top Selling", icon: "🏆" },
  { href: "/dashboard/barcodes", label: "Barcode Print", icon: "🏷️" },
];

function DashboardLayoutInner({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const searchParams = useSearchParams();

  // ✅ CLEAN POS: /dashboard/sales?clean=1 ho to sidebar gayab
  const isCleanPOS = path === "/dashboard/sales" && searchParams.get("clean") === "1";

  // ✅ FIX: Click pe active link ka background rahega
  const isActive = (href: string) => {
    if (href === "/dashboard") return path === "/dashboard" || path === "/dashboard/";
    return path === href || path.startsWith(href + "/");
  };

  const linkCls = (href: string) =>
    `flex items-center gap-3 px-4 py-2.5 rounded-xl font-bold text-sm transition ${
      isActive(href) ? "bg-white text-slate-900" : "text-slate-300 hover:bg-white/10 hover:text-white"
    }`;

  return (
    <div className="flex min-h-screen bg-slate-100">
      {!isCleanPOS && (
        <aside className="w-60 shrink-0 bg-slate-900 text-white p-4 flex flex-col sticky top-0 h-screen">
          <div className="px-2 pb-4 border-b border-white/10">
            <p className="font-black text-lg leading-tight">🛒 Madina Mart</p>
            <p className="text-[11px] text-slate-400">Madina Mega Mart • Shewa • Offline</p>
          </div>
          <nav className="space-y-1 mt-4">
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} className={linkCls(l.href)} aria-current={isActive(l.href) ? "page" : undefined}>
                <span>{l.icon}</span> {l.label}
              </Link>
            ))}
          </nav>
          <div className="mt-auto pt-4 border-t border-white/10">
            <p className="text-[11px] text-slate-400 px-2">Madina Mega Mart Shewa<br />Ghulam Khel Chowk</p>
          </div>
        </aside>
      )}
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="flex min-h-screen bg-slate-100"><div className="flex-1 min-w-0">{children}</div></div>}>
      <DashboardLayoutInner>{children}</DashboardLayoutInner>
    </Suspense>
  );
}