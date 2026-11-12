/**
 * Large-title navigation, iOS style.
 *
 * The big title scrolls with the page; once it passes under the bar, the bar
 * frosts over and shows a small centred title instead.
 */
"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

interface NavbarProps {
  title: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  subtitle?: ReactNode;
}

export function Navbar({ title, leading, trailing, subtitle }: NavbarProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [scrolled, setScrolled] = useState(false);

  // Step 1: watch the large title; when it leaves the viewport top, frost the bar.
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setScrolled(!entry.isIntersecting), {
      rootMargin: "-56px 0px 0px 0px",
      threshold: 0,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <header className="navbar" data-scrolled={scrolled}>
        <div className="navbar__leading">{leading}</div>
        <div className="navbar__title" aria-hidden={!scrolled}>
          {title}
        </div>
        <div className="navbar__trailing">{trailing}</div>
      </header>
      <h1 ref={titleRef} className="large-title">
        {title}
      </h1>
      {subtitle && <p className="screen-subtitle">{subtitle}</p>}
    </>
  );
}
