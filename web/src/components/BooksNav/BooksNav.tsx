"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import styles from "./BooksNav.module.css";

const NAV_KEY = "books-nav";

const MenuCtx = createContext<{ open: boolean; toggle: () => void }>({
  open: true,
  toggle: () => {},
});

export function useBooksMenu() {
  return useContext(MenuCtx);
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <rect x="2.75" y="3.5" width="14.5" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 3.5v13" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d={open ? "M12.4 8.1 10 10l2.4 1.9" : "M10 8.1 12.4 10 10 11.9"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function itemClass(active: boolean, extra?: string): string {
  return `${extra ?? styles.item} ${active ? styles.active : ""}`;
}

export default function BooksNav() {
  const { open, toggle } = useBooksMenu();
  const pathname = usePathname() ?? "";
  const onOverview = pathname === "/";
  const onCoinbase = pathname === "/paper";
  const onCoinbasePnl = pathname === "/paper/report";
  const onTax = pathname === "/tax";
  const onCoinbaseTax = pathname === "/tax/paper";

  if (!open) {
    return (
      <div className={styles.rail}>
        <button
          type="button"
          className={styles.toggle}
          onClick={toggle}
          aria-expanded={false}
          aria-controls="books-nav"
          aria-label="Show side menu"
          title="Show side menu"
        >
          <MenuIcon open={false} />
        </button>
      </div>
    );
  }

  return (
    <nav id="books-nav" className={styles.nav} aria-label="Books">
      <div className={styles.navTop}>
        <Link href="/" className={styles.brand}>
          <span className={styles.brandName}>Paper books</span>
          <span className={styles.brandSub}>no capital at risk</span>
        </Link>
        <button
          type="button"
          className={styles.toggle}
          onClick={toggle}
          aria-expanded={true}
          aria-controls="books-nav"
          aria-label="Hide side menu"
          title="Hide side menu"
        >
          <MenuIcon open={true} />
        </button>
      </div>

      <Link href="/" className={itemClass(onOverview)} aria-current={onOverview ? "page" : undefined}>
        Overview
      </Link>
      <Link href="/paper" className={itemClass(onCoinbase)} aria-current={onCoinbase ? "page" : undefined}>
        Coinbase
      </Link>

      <div className={styles.group}>
        <span className={styles.groupLabel}>P&amp;L</span>
        <Link
          href="/paper/report"
          className={itemClass(onCoinbasePnl, styles.subItem)}
          aria-current={onCoinbasePnl ? "page" : undefined}
        >
          Coinbase
        </Link>
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>Tax</span>
        <Link href="/tax" className={itemClass(onTax, styles.subItem)} aria-current={onTax ? "page" : undefined}>
          Summary
        </Link>
        <Link
          href="/tax/paper"
          className={itemClass(onCoinbaseTax, styles.subItem)}
          aria-current={onCoinbaseTax ? "page" : undefined}
        >
          Coinbase
        </Link>
      </div>
    </nav>
  );
}

export function BooksShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const scroll =
    pathname === "/" ||
    pathname.startsWith("/tax") ||
    pathname.endsWith("/report");
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (window.localStorage.getItem(NAV_KEY) === "hidden") setOpen(false);
  }, []);

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      window.localStorage.setItem(NAV_KEY, next ? "open" : "hidden");
      return next;
    });
  };

  return (
    <MenuCtx.Provider value={{ open, toggle }}>
      <div className={`${styles.shell} ${open ? "" : styles.shellWide}`}>
        <BooksNav />
        <div className={`${styles.stage} ${scroll ? styles.stageScroll : ""}`}>{children}</div>
      </div>
    </MenuCtx.Provider>
  );
}
