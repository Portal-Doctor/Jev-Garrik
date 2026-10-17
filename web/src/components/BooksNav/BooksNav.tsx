"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import styles from "./BooksNav.module.css";

const NAV_KEY = "books-nav";
const GROUP_KEY = "books-nav-group";

const MenuCtx = createContext<{ open: boolean; toggle: () => void }>({
  open: true,
  toggle: () => {},
});

export function useBooksMenu() {
  return useContext(MenuCtx);
}

type GroupId = "p6" | "coinbase" | "tax";

function groupDefault(id: GroupId, pathname: string): boolean {
  if (id === "p6") return pathname === "/p6" || pathname.startsWith("/p6/");
  if (id === "coinbase") return pathname === "/paper" || pathname.startsWith("/paper/");
  return pathname.startsWith("/tax");
}

function readGroup(id: GroupId): boolean | null {
  try {
    const raw = window.localStorage.getItem(GROUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed[id] === "boolean" ? parsed[id] : null;
  } catch {
    return null;
  }
}

function saveGroup(id: GroupId, open: boolean) {
  try {
    const raw = window.localStorage.getItem(GROUP_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const next: Record<string, boolean> = {};
    if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "boolean") next[key] = value;
      }
    }
    next[id] = open;
    window.localStorage.setItem(GROUP_KEY, JSON.stringify(next));
  } catch {
    /* The menu still toggles when storage is blocked. */
  }
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

function Group({ id, label, pathname, children }: { id: GroupId; label: string; pathname: string; children: React.ReactNode }) {
  const active = groupDefault(id, pathname);
  const [open, setOpen] = useState(active);
  useEffect(() => {
    if (active) {
      setOpen(true);
      return;
    }
    const stored = readGroup(id);
    if (stored != null) setOpen(stored);
  }, [active, id]);
  return (
    <details
      className={styles.group}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        saveGroup(id, next);
      }}
    >
      <summary className={styles.summary}>{label}</summary>
      {children}
    </details>
  );
}

export default function BooksNav({ drawer }: { drawer: boolean }) {
  const { open, toggle } = useBooksMenu();
  const pathname = usePathname() ?? "";
  const onOverview = pathname === "/";
  const onP6 = pathname === "/p6";
  const onCoinbase = pathname === "/paper";
  const onCoinbasePnl = pathname === "/paper/report";
  const onBacktest = pathname === "/paper/backtest";
  const onTax = pathname === "/tax";
  const onCoinbaseTax = pathname === "/tax/paper";

  if (!open && !drawer) {
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
    <nav id="books-nav" className={`${styles.nav} ${drawer ? styles.navOpen : ""}`} aria-label="Books">
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

      <Group id="p6" label="P6 paper" pathname={pathname}>
        <Link href="/p6" className={itemClass(onP6, styles.subItem)} aria-current={onP6 ? "page" : undefined}>
          Overview
        </Link>
      </Group>

      <Group id="coinbase" label="Coinbase engine" pathname={pathname}>
        <Link href="/paper" className={itemClass(onCoinbase, styles.subItem)} aria-current={onCoinbase ? "page" : undefined}>
          Live view
        </Link>
        <Link href="/paper/report" className={itemClass(onCoinbasePnl, styles.subItem)} aria-current={onCoinbasePnl ? "page" : undefined}>
          P&L report
        </Link>
        <Link href="/paper/backtest" className={itemClass(onBacktest, styles.subItem)} aria-current={onBacktest ? "page" : undefined}>
          Backtest
        </Link>
      </Group>

      <Group id="tax" label="Tax" pathname={pathname}>
        <Link href="/tax" className={itemClass(onTax, styles.subItem)} aria-current={onTax ? "page" : undefined}>
          Summary
        </Link>
        <Link href="/tax/paper" className={itemClass(onCoinbaseTax, styles.subItem)} aria-current={onCoinbaseTax ? "page" : undefined}>
          Coinbase worksheet
        </Link>
      </Group>
    </nav>
  );
}

export function BooksShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const scroll = pathname === "/" || pathname.startsWith("/tax") || pathname.endsWith("/report");
  const p6 = pathname === "/p6" || pathname.startsWith("/p6/");
  const [open, setOpen] = useState(true);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    if (window.localStorage.getItem(NAV_KEY) === "hidden") setOpen(false);
  }, []);

  useEffect(() => {
    setDrawer(false);
  }, [pathname]);

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
        <button type="button" className={styles.menuBtn} aria-expanded={drawer} aria-controls="books-nav" onClick={() => setDrawer(true)}>
          Menu
        </button>
        {drawer ? (
          <button type="button" className={styles.scrim} aria-label="Close menu" onClick={() => setDrawer(false)} />
        ) : null}
        <BooksNav drawer={drawer} />
        <div className={`${styles.stage} ${scroll ? styles.stageScroll : ""} ${p6 ? styles.stagePage : ""}`}>{children}</div>
      </div>
    </MenuCtx.Provider>
  );
}
